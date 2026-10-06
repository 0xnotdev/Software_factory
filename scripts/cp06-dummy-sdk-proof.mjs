#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { closeSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cp06ReadOnlyCredentialStore } from "./cp06-readonly-credentials.mjs";
import { auditReadEvents } from "./cp06-worker-audit.mjs";
import { proveDummyWorkerOutcome } from "./cp06-dummy-outcome-proof.mjs";
import { importPinnedPiAi } from "./cp06-pi-dependency.mjs";
import {
  openAnchoredDirectory,
  readArtifactFile,
  writeArtifactFile,
  removeAnchoredEntry,
} from "./cp06-probe-fixture.mjs";
import { DUMMY_SDK_ORIGINAL } from "./cp06-dummy-originals.mjs";
import { createGuardedReadTool, openPinnedDirectory } from "./cp06-guarded-read.mjs";

const [piRootArg, proofRootArg] = process.argv.slice(2);
if (!piRootArg || !proofRootArg) process.exit(64);
const piRoot = resolve(piRootArg);
const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")));
const { module: ai, provenance: piAi } = await importPinnedPiAi(piRoot);
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("DUMMY proof forbids network");
};
const proofRoot = realpathSync(resolve(proofRootArg));
if (proofRoot !== resolve(proofRootArg) || readdirSync(proofRoot).length !== 0) process.exit(64);
const proofFd = openPinnedDirectory(proofRoot);
const proofAnchor = `/proc/${process.pid}/fd/${proofFd}`;
try {
  const authCases = [];
  for (const scenario of [
    { name: "expired", expires: 0, expected: "blocked" },
    { name: "near_expiry", expires: Date.now() + 60_000, expected: "blocked" },
    { name: "unexpired", expires: Date.now() + 600_000, expected: "resolved" },
  ]) {
    authCases.push(await authCase(scenario));
  }
  const worker = await fauxWorkerProof();
  const outcomeProof = await proveDummyWorkerOutcome({
    piRoot,
    directory: join(proofRoot, "DUMMY-outcome"),
    parentAnchor: proofAnchor,
  });
  assert.equal(networkCalls, 0);
  console.log(
    JSON.stringify({
      schema_version: 1,
      result: "pass",
      auth_cases: authCases,
      sdk_worker: worker,
      sdk_dependency: piAi,
      actual_sdk_outcomes: outcomeProof,
      fixture_origin: true,
      semantic_acceptance: false,
      network_calls: networkCalls,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  try {
    for (const entry of readdirSync(proofAnchor)) removeAnchoredEntry(proofAnchor, entry);
  } finally {
    closeSync(proofFd);
  }
}

async function authCase(scenario) {
  const providerId = "openai-codex";
  const path = join(proofAnchor, `DUMMY-${scenario.name}.json`);
  await writeFile(
    path,
    JSON.stringify({
      [providerId]: {
        type: "oauth",
        access: "DUMMY-ACCESS",
        refresh: "DUMMY-REFRESH",
        expires: scenario.expires,
      },
    }),
  );
  const before = sha256(await readFile(path));
  const store = await Cp06ReadOnlyCredentialStore.load({ path, providerId });
  const runtime = await sdk.ModelRuntime.create({
    credentials: store,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider(providerId);
  assert.ok(provider?.auth?.oauth);
  let refreshCallbacks = 0;
  let toAuthCalls = 0;
  provider.auth = {
    oauth: {
      async refresh() {
        refreshCallbacks += 1;
        return {
          type: "oauth",
          access: "DUMMY-NEW",
          refresh: "DUMMY-NEW",
          expires: Date.now() + 3_600_000,
        };
      },
      async toAuth(credential) {
        toAuthCalls += 1;
        assert.equal(credential.access, "DUMMY-ACCESS");
        return { apiKey: "DUMMY-RESOLVED" };
      },
    },
  };
  let result = "resolved";
  try {
    const resolved = await runtime.getAuth(providerId, { minOAuthValidityMs: 300_000 });
    assert.ok(resolved);
  } catch {
    result = "blocked";
  }
  assert.equal(result, scenario.expected);
  assert.equal(refreshCallbacks, 0);
  assert.equal(toAuthCalls, scenario.expected === "resolved" ? 1 : 0);
  assert.equal(sha256(await readFile(path)), before);
  return {
    scenario: scenario.name,
    result,
    refresh_callbacks: refreshCallbacks,
    to_auth_calls: toAuthCalls,
    credential_store: store.audit(),
    persistence_operations: 0,
    source_unchanged: true,
  };
}

async function fauxWorkerProof() {
  const workerDirectory = openAnchoredDirectory(proofAnchor, "DUMMY-worker");
  try {
    const workerRoot = join(proofRoot, "DUMMY-worker");
    const originalPath = join(workerRoot, "DUMMY-original.md");
    const authPath = join(workerDirectory.anchor, "DUMMY-auth.json");
    const original = DUMMY_SDK_ORIGINAL;
    writeArtifactFile(join(workerDirectory.anchor, "DUMMY-original.md"), original);
    const guardedRead = createGuardedReadTool({
      sdk,
      root: workerRoot,
      expectedOriginalPath: originalPath,
    });
    for (const range of [{ offset: 1, limit: 2_000 }, { offset: 1 }, { limit: 2_000 }]) {
      await assert.rejects(
        guardedRead.tool.execute("DUMMY-ranged-read", { path: originalPath, ...range }),
        /without offset or limit/,
      );
    }
    const faux = ai.fauxProvider({
      provider: "DUMMY-readonly",
      models: [{ id: "DUMMY-model" }],
      tokensPerSecond: 100_000,
    });
    const providerId = faux.provider.id;
    await writeFile(
      authPath,
      JSON.stringify({
        [providerId]: {
          type: "oauth",
          access: "DUMMY-ACCESS",
          refresh: "DUMMY-REFRESH",
          expires: Date.now() + 600_000,
        },
      }),
    );
    const store = await Cp06ReadOnlyCredentialStore.load({ path: authPath, providerId });
    let refreshCallbacks = 0;
    faux.provider.auth = {
      oauth: {
        async refresh() {
          refreshCallbacks += 1;
          throw new Error("DUMMY refresh must not run");
        },
        async toAuth() {
          return { apiKey: "DUMMY-RESOLVED" };
        },
      },
    };
    const runtime = await sdk.ModelRuntime.create({
      credentials: store,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const model = runtime.getModel(providerId, "DUMMY-model");
    assert.ok(model);
    faux.setResponses([
      ai.fauxAssistantMessage(
        ai.fauxToolCall("read", { path: originalPath }, { id: "DUMMY-read" }),
        {
          stopReason: "toolUse",
        },
      ),
      ai.fauxAssistantMessage("DUMMY complete", { stopReason: "stop" }),
    ]);
    const resourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Use only read and read the supplied DUMMY original exactly once.",
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const { session } = await sdk.createAgentSession({
      cwd: workerRoot,
      agentDir: workerRoot,
      model,
      modelRuntime: runtime,
      resourceLoader,
      tools: ["read"],
      customTools: [guardedRead.tool],
      sessionManager: sdk.SessionManager.inMemory(workerRoot),
      settingsManager: sdk.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });
    const events = [];
    const unsubscribe = session.subscribe((event) => events.push(structuredClone(event)));
    try {
      await session.prompt(`Read ${originalPath} exactly once.`, { expandPromptTemplates: false });
    } finally {
      unsubscribe();
      session.dispose();
    }
    const audit = auditReadEvents(events, {
      root: workerRoot,
      expectedOriginalPath: originalPath,
      expectedOriginal: original,
      decisiveText: ["request-supplied owner fields are ignored"],
    });
    assert.equal(audit.ok, true);
    assert.deepEqual(session.getActiveToolNames(), ["read"]);
    assert.equal(session.sessionFile, undefined);
    assert.equal(refreshCallbacks, 0);
    return {
      active_tools: session.getActiveToolNames(),
      in_memory_session: session.sessionFile === undefined,
      event_count: events.length,
      event_sha256: sha256(JSON.stringify(events)),
      read_audit: audit.summary,
      refresh_callbacks: refreshCallbacks,
      credential_store: store.audit(),
    };
  } finally {
    workerDirectory.close();
  }
}

async function writeFile(path, bytes) {
  writeArtifactFile(path, bytes);
}

async function readFile(path) {
  return readArtifactFile(path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
