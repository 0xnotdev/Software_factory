#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditReadEvents, isExpectedOriginalReference } from "./cp06-worker-audit.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
if (process.env.CP06_MOUNT_ISOLATION_CHILD !== "1") {
  const isolated = spawnSync(
    "unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "--propagation",
      "private",
      "--",
      process.execPath,
      scriptPath,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CP06_MOUNT_ISOLATION_CHILD: "1" },
      timeout: 600_000,
    },
  );
  process.stdout.write(isolated.stdout ?? "");
  process.stderr.write(isolated.stderr ?? "");
  if (isolated.error !== undefined) throw isolated.error;
  process.exit(isolated.status ?? 1);
}
const outputRoot = resolve(root, process.env.CP06_OUTPUT ?? ".factory/state/cp06-correction");
const workerRoot = join(outputRoot, "worker");
const fixtureRoot = join(outputRoot, "ten-pack", "repo");
const initialPackPath = join(outputRoot, "ten-pack", "raw", "auth-worker-missing.pack.md");
const contractPath = join(root, "test/fixtures/cp06-context/cases/AUTH-worker-before.yaml");
const originalPath = join(fixtureRoot, "docs/AUTH.md");
await rm(workerRoot, { recursive: true, force: true });
await mkdir(workerRoot, { recursive: true });

const contract = await readFile(contractPath, "utf8");
const pack = await readFile(initialPackPath, "utf8");
const original = await readFile(originalPath);
const decisiveConstraint = "request-supplied owner fields are ignored";
const prompt = `You are a fresh task reviewer. You have no previous worker transcript. Review only the bounded handoff below. First inspect the task and pack. One concrete creation-time ownership rule was deliberately omitted from this handoff. Report MISSING_SOURCE, set missing_source to the exact canonical relative path docs/AUTH.md, and use the read tool exactly once, without offset or limit, on the supplied exact-original path; do not scan or read any other project file. Then return a concise JSON object with keys status, missing_source, reads, corrected_constraints, evidence_gaps, and broad_scan. Do not modify files.\n\nEXACT TASK CONTRACT\n---\n${contract}\n---\n\nBOUNDED PACK\n---\n${pack}\n---\n\nEXISTING DETERMINISTIC EVIDENCE\n---\nThe in-memory auth fixture currently reports absent/forged credentials as 401 and concealed cross-account GET/PUT/DELETE as 404 with unchanged state. Review whether the handoff states every decisive acceptance constraint; do not assume unshown creation semantics.\n---\n\nSUPPLIED EXACT-ORIGINAL PATH (read only if needed)\n${originalPath}\n`;

const provider = process.env.CP06_PI_PROVIDER ?? "openai-codex";
const model = process.env.CP06_PI_MODEL ?? "gpt-5.6-sol";
const args = [
  "--provider",
  provider,
  "--model",
  model,
  "--thinking",
  "high",
  "--mode",
  "json",
  "--no-session",
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
  "--skill",
  "skills/factory",
  "--tools",
  "read",
  prompt,
];
const evaluationHome = await mkdtemp(join(tmpdir(), "factory-cp06-worker-"));
const evaluationAgentDir = join(evaluationHome, "pi-agent");
await mkdir(evaluationAgentDir);
const credentialSource = resolve(
  process.env.CP06_PI_AUTH_FILE ??
    join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json"),
);
const credentialHashBefore = await fileHash(credentialSource);
const mount = spawnSync("mount", ["--bind", credentialSource, credentialSource], {
  cwd: root,
  encoding: "utf8",
});
if (mount.status !== 0) {
  throw new Error(`read-only credential isolation unavailable: ${mount.stderr ?? "mount failed"}`);
}
const remount = spawnSync("mount", ["-o", "remount,bind,ro", credentialSource], {
  cwd: root,
  encoding: "utf8",
});
if (remount.status !== 0) {
  throw new Error(
    `read-only credential isolation unavailable: ${remount.stderr ?? "remount failed"}`,
  );
}
const evaluationCredential = join(evaluationAgentDir, "auth.json");
await symlink(credentialSource, evaluationCredential);
for (const target of [credentialSource, evaluationCredential]) {
  try {
    await writeFile(target, "unauthorized mutation");
    throw new Error(`read-only credential isolation permitted a write to ${target}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("read-only credential isolation permitted")
    ) {
      throw error;
    }
  }
}
let result;
let credentialHashAfter;
try {
  result = spawnSync("pi", args, {
    cwd: root,
    encoding: "utf8",
    env: isolatedPiEnvironment(evaluationHome, evaluationAgentDir),
    timeout: 600_000,
  });
  credentialHashAfter = await fileHash(credentialSource);
} finally {
  await rm(evaluationHome, { recursive: true, force: true });
}
if (credentialHashAfter !== credentialHashBefore) {
  throw new Error("fresh Pi worker modified the source credential file");
}
if (result.error !== undefined || result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  throw new Error(`fresh Pi worker exited ${result.status}`);
}
const events = parseEventStream(result.stdout ?? "");
const responseText = finalAssistantText(events);
const response = parseResponse(responseText);
const readAudit = auditReadEvents(events, {
  root,
  expectedOriginalPath: originalPath,
  expectedOriginal: original,
  decisiveText: [decisiveConstraint],
});
if (!readAudit.ok) {
  throw new Error(`fresh worker violated the event-stream read oracle: ${readAudit.reason}`);
}
const requiredConstraints = [
  /ownership comes only from the authenticated principal/i,
  /request-supplied owner fields? (?:are )?ignored/i,
];
const constraintText = Array.isArray(response.corrected_constraints)
  ? response.corrected_constraints.join(" ")
  : "";
if (
  response.status !== "MISSING_SOURCE" ||
  !isExpectedOriginalReference(response.missing_source, {
    root,
    referenceRoot: fixtureRoot,
    expectedOriginalPath: originalPath,
  }) ||
  response.broad_scan !== false ||
  !requiredConstraints.every((constraint) => constraint.test(constraintText))
) {
  throw new Error(
    `fresh worker response did not satisfy the targeted-read oracle: ${responseText}`,
  );
}

const testedSha = textCommand("git", ["rev-parse", "HEAD"]);
const manifest = {
  schema_version: 1,
  gate: "P-06-fresh-worker",
  tested_sha: testedSha,
  recorded_at: new Date().toISOString(),
  reviewer: process.env.CP06_REVIEWER ?? "Pi CP-06 correction worker",
  worker: {
    pi_version: textCommand("pi", ["--version"]),
    provider,
    model,
    no_session: true,
    no_context_files: true,
    mode: "json",
    tools: ["read"],
  },
  bounded_handoff: {
    contract_path: relative(contractPath),
    contract_sha256: await fileHash(contractPath),
    pack_path: relative(initialPackPath),
    pack_sha256: await fileHash(initialPackPath),
    original_path: relative(originalPath),
    original_sha256: await fileHash(originalPath),
    deliberately_omitted_constraint_sha256: sha256(decisiveConstraint),
    evidence: "in-memory auth 401 and concealed non-mutating cross-account 404 observations",
    prompt_sha256: sha256(prompt),
  },
  isolation: {
    disposable_home: true,
    disposable_pi_agent_dir: true,
    credential_mode:
      "Linux user/mount namespace; source bind-remounted read-only; direct and symlink writes denied; no copy",
    credential_source_unchanged: credentialHashAfter === credentialHashBefore,
    raw_transcript_retained: false,
  },
  event_stream: {
    sha256: sha256(result.stdout ?? ""),
    event_count: events.length,
    read_audit: readAudit.summary,
  },
  command:
    "pi --mode json --no-session --no-context-files --no-extensions --no-skills --skill skills/factory --tools read <bounded-handoff>",
  exit_code: result.status,
  output_sha256: sha256(responseText),
  stderr_sha256: sha256(result.stderr ?? ""),
  response,
  result: "pass",
  limitation:
    "Live model wording is nondeterministic; the script deterministically checks actual read tool-call events and required corrected constraints.",
};
const manifestPath = join(workerRoot, "evidence.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify({
    ok: true,
    gate: manifest.gate,
    tested_sha: testedSha,
    manifest_path: relative(manifestPath),
    manifest_sha256: await fileHash(manifestPath),
    exit_code: result.status,
    status: response.status,
    reads: readAudit.summary.project_read_paths,
    broad_scan: response.broad_scan,
  }),
);

function parseEventStream(output) {
  const events = [];
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Pi JSON event stream line ${index + 1} is not valid JSON: ${error.message}`);
    }
  }
  return events;
}

function finalAssistantText(events) {
  const agentEnd = events.findLast((event) => event.type === "agent_end");
  const messages = Array.isArray(agentEnd?.messages)
    ? agentEnd.messages
    : events
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
        .map((event) => event.message);
  const assistant = messages.findLast((message) => message.role === "assistant");
  if (assistant === undefined)
    throw new Error("Pi JSON event stream did not include a final assistant message");
  return messageText(assistant);
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function parseResponse(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced === null) throw new Error(`fresh worker did not return JSON: ${output}`);
    return JSON.parse(fenced[1]);
  }
}

function textCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

async function fileHash(path) {
  return sha256(await readFile(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isolatedPiEnvironment(home, agentDir) {
  const environment = {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}
