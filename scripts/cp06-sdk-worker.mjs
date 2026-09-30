#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cp06AuthBlockedError, Cp06ReadOnlyCredentialStore } from "./cp06-readonly-credentials.mjs";
import { auditReadEvents, isExpectedOriginalReference } from "./cp06-worker-audit.mjs";

const [credentialTargetArg, inputPathArg] = process.argv.slice(2);
if (!credentialTargetArg || !inputPathArg) process.exit(64);

try {
  const credentialTarget = resolve(credentialTargetArg);
  const input = JSON.parse(await readFile(resolve(inputPathArg), "utf8"));
  validateInput(input);
  const pi = resolvePiPackage();
  const sdk = await import(pathToFileURL(join(pi.root, "dist/index.js")));
  assertSdkSurface(sdk);

  const contract = await readFile(input.contract_path, "utf8");
  const pack = await readFile(input.pack_path, "utf8");
  const original = await readFile(input.original_path);
  const prompt = buildPrompt({ contract, pack, originalPath: input.original_path });
  const store = await Cp06ReadOnlyCredentialStore.load({
    path: credentialTarget,
    providerId: input.provider,
  });
  const minOAuthValidityMs = input.timeout_ms + 300_000;
  const validity = store.assertUsableOAuth({ minValidityMs: minOAuthValidityMs });

  const runtime = await sdk.ModelRuntime.create({
    credentials: store,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = runtime.getModel(input.provider, input.model);
  if (model === undefined) throw blocked("configured Pi model is not built in to Pi 0.85.1");
  const auth = await runtime.getAuth(model, { minOAuthValidityMs });
  if (auth === undefined) throw blocked("expected OAuth provider did not resolve authentication");

  const resourceLoader = emptyResourceLoader(sdk, input.system_prompt);
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: {
      enabled: false,
      maxRetries: 0,
      provider: { timeoutMs: input.timeout_ms, maxRetries: 0, maxRetryDelayMs: 0 },
    },
    defaultProjectTrust: "never",
    enableAnalytics: false,
    enableInstallTelemetry: false,
  });
  const { session, extensionsResult } = await sdk.createAgentSession({
    cwd: input.root,
    agentDir: dirname(credentialTarget),
    model,
    modelRuntime: runtime,
    resourceLoader,
    tools: ["read"],
    sessionManager: sdk.SessionManager.inMemory(input.root),
    settingsManager,
    thinkingLevel: "high",
  });
  if ((extensionsResult.extensions?.length ?? 0) !== 0 || session.sessionFile !== undefined) {
    throw blocked("SDK worker unexpectedly loaded an extension or persistent session");
  }
  if (JSON.stringify(session.getActiveToolNames()) !== JSON.stringify(["read"])) {
    throw blocked("SDK worker active tool set is not exactly read");
  }

  const events = [];
  const unsubscribe = session.subscribe((event) => events.push(structuredClone(event)));
  let timedOut = false;
  let timer;
  try {
    await Promise.race([
      session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          void session.abort();
          reject(new Error("CP06_WORKER_TIMEOUT"));
        }, input.timeout_ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (timedOut || session.isStreaming) await session.abort();
    unsubscribe();
    session.dispose();
  }

  const responseText = finalAssistantText(events);
  const response = parseResponse(responseText);
  const readAudit = auditReadEvents(events, {
    root: input.root,
    expectedOriginalPath: input.original_path,
    expectedOriginal: original,
    decisiveText: ["request-supplied owner fields are ignored"],
  });
  if (!readAudit.ok) {
    throw blocked(`SDK event audit failed: ${readAudit.reason}`);
  }
  const corrected = Array.isArray(response.corrected_constraints)
    ? response.corrected_constraints.join(" ")
    : "";
  if (
    response.status !== "MISSING_SOURCE" ||
    !isExpectedOriginalReference(response.missing_source, {
      root: input.root,
      referenceRoot: input.fixture_root,
      expectedOriginalPath: input.original_path,
    }) ||
    response.broad_scan !== false ||
    !/ownership comes only from the authenticated principal/i.test(corrected) ||
    !/request-supplied owner fields? (?:are )?ignored/i.test(corrected)
  ) {
    throw blocked("SDK worker response did not satisfy the targeted-read oracle");
  }

  console.log(
    JSON.stringify({
      schema_version: 1,
      result: "pass",
      pi_version: pi.version,
      provider: input.provider,
      model: input.model,
      oauth_preflight: {
        minimum_validity_ms: minOAuthValidityMs,
        remaining_validity_ms: validity.remainingValidityMs,
        refreshed: false,
      },
      credential_store: store.audit(),
      session: { in_memory: true, active_tools: session.getActiveToolNames() },
      event_stream: {
        sha256: sha256(JSON.stringify(events)),
        event_count: events.length,
        read_audit: readAudit.summary,
      },
      response,
      response_sha256: sha256(responseText),
      raw_transcript_retained: false,
    }),
  );
} catch (error) {
  if (error instanceof Cp06AuthBlockedError || error?.code === "CP06_AUTH_BLOCKED") {
    process.stderr.write(`CP06_AUTH_BLOCKED: ${error.message}\n`);
    process.exit(75);
  }
  process.stderr.write(`CP06_WORKER_FAILED: ${safeMessage(error)}\n`);
  process.exit(70);
}

function validateInput(input) {
  if (input?.schema_version !== 1) throw blocked("worker input schema is unsupported");
  for (const key of ["root", "fixture_root", "contract_path", "pack_path", "original_path"])
    if (typeof input[key] !== "string" || !input[key].startsWith("/")) {
      throw blocked(`worker input ${key} must be absolute`);
    }
  if (input.provider !== "openai-codex") throw blocked("worker provider must be openai-codex");
  if (typeof input.model !== "string" || input.model.length === 0) {
    throw blocked("worker model is missing");
  }
  if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1_000) {
    throw blocked("worker timeout is invalid");
  }
  if (typeof input.system_prompt !== "string" || input.system_prompt.length === 0) {
    throw blocked("worker system prompt is missing");
  }
}

function resolvePiPackage() {
  const piExecutable = findExecutable("pi");
  const cli = realpathSync(piExecutable);
  const packageRoot = findPiPackageRoot(cli);
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const version = spawnSync(piExecutable, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (
    metadata.name !== "@earendil-works/pi-coding-agent" ||
    metadata.version !== "0.85.1" ||
    version.status !== 0 ||
    version.stdout.trim() !== "0.85.1"
  ) {
    throw blocked("exact Pi 0.85.1 is required");
  }
  return { root: packageRoot, version: metadata.version };
}

function findPiPackageRoot(executable) {
  let directory = dirname(executable);
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (metadata.name === "@earendil-works/pi-coding-agent") return directory;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw blocked("Pi package root could not be resolved from its executable");
}

function findExecutable(name) {
  for (const directory of String(process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw blocked("Pi executable is unavailable");
}

function assertSdkSurface(sdk) {
  for (const name of [
    "ModelRuntime",
    "createAgentSession",
    "createExtensionRuntime",
    "SessionManager",
    "SettingsManager",
  ]) {
    if (sdk[name] === undefined) throw blocked(`Pi SDK export is unavailable: ${name}`);
  }
}

function emptyResourceLoader(sdk, systemPrompt) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function buildPrompt({ contract, pack, originalPath }) {
  return `You are a fresh task reviewer. You have no previous worker transcript. Review only the bounded handoff below. First inspect the task and pack. One concrete creation-time ownership rule was deliberately omitted from this handoff. Report MISSING_SOURCE, set missing_source to the exact canonical relative path docs/AUTH.md, and use the read tool exactly once, without offset or limit, on the supplied exact-original path; do not scan or read any other project file. Then return a concise JSON object with keys status, missing_source, reads, corrected_constraints, evidence_gaps, and broad_scan. Do not modify files.\n\nEXACT TASK CONTRACT\n---\n${contract}\n---\n\nBOUNDED PACK\n---\n${pack}\n---\n\nEXISTING DETERMINISTIC EVIDENCE\n---\nThe in-memory auth fixture currently reports absent/forged credentials as 401 and concealed cross-account GET/PUT/DELETE as 404 with unchanged state. Review whether the handoff states every decisive acceptance constraint; do not assume unshown creation semantics.\n---\n\nSUPPLIED EXACT-ORIGINAL PATH (read only if needed)\n${originalPath}\n`;
}

function finalAssistantText(events) {
  const messages = events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message);
  const assistant = messages.at(-1);
  if (assistant === undefined)
    throw blocked("SDK event stream omitted the final assistant message");
  if (typeof assistant.content === "string") return assistant.content;
  return Array.isArray(assistant.content)
    ? assistant.content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
    : "";
}

function parseResponse(output) {
  try {
    return JSON.parse(output.trim());
  } catch {
    const fenced = output.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced === null) throw blocked("SDK worker did not return the required JSON response");
    return JSON.parse(fenced[1]);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function blocked(message) {
  return new Cp06AuthBlockedError(message);
}

function safeMessage(error) {
  if (error?.message === "CP06_WORKER_TIMEOUT") return "worker timed out and was aborted";
  return error instanceof Error ? error.message : String(error);
}
