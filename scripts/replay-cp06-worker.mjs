#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Cp06IsolationUnsupportedError,
  runCp06SecurityPreflight,
  runIsolatedWorker,
} from "./cp06-auth-security.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, process.env.CP06_OUTPUT ?? ".factory/state/cp06-correction");
const workerRoot = join(outputRoot, "worker");
const securityRoot = join(outputRoot, "auth-security");
const fixtureRoot = join(outputRoot, "ten-pack", "repo");
const initialPackPath = join(outputRoot, "ten-pack", "raw", "auth-worker-missing.pack.md");
const contractPath = join(root, "test/fixtures/cp06-context/cases/AUTH-worker-before.yaml");
const originalPath = join(fixtureRoot, "docs/AUTH.md");
const provider = "openai-codex";
const model = process.env.CP06_PI_MODEL ?? "gpt-5.6-sol";
const timeoutMs = 600_000;
const systemPrompt =
  "You are a bounded CP-06 reviewer. Use exactly the read tool, read only the supplied exact original once, return only the requested JSON, and do not attempt any file mutation or broad scan.";

await rm(workerRoot, { recursive: true, force: true });
await mkdir(workerRoot, { recursive: true });
let security;
try {
  // This DUMMY-only gate includes the unsafe control, hardened evaluated-child
  // attacks, vendor refresh counters, and offline SDK read audit. It completes
  // before the real credential path is opened or any provider request is made.
  security = await runCp06SecurityPreflight({
    root,
    outputRoot: securityRoot,
    reviewer: process.env.CP06_REVIEWER,
  });
} catch (error) {
  await recordBlocked(error, "dummy-security-preflight");
  if (error instanceof Cp06IsolationUnsupportedError) process.exit(73);
  throw error;
}

const workerInput = {
  schema_version: 1,
  root,
  fixture_root: fixtureRoot,
  contract_path: contractPath,
  pack_path: initialPackPath,
  original_path: originalPath,
  provider,
  model,
  timeout_ms: timeoutMs,
  system_prompt: systemPrompt,
};
const inputPath = join(workerRoot, "input.json");
await writeFile(inputPath, `${JSON.stringify(workerInput, null, 2)}\n`);
const evaluationHome = await mkdtemp(join(tmpdir(), "factory-cp06-sdk-worker-"));
const credentialTarget = join(evaluationHome, "pi-agent", "auth.json");
const credentialSource = resolve(
  process.env.CP06_PI_AUTH_FILE ??
    join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json"),
);
const binaries = {
  helper: join(securityRoot, "cp06-seccomp-exec"),
  syscallProbe: join(securityRoot, "cp06-isolation-syscalls"),
};
let isolated;
try {
  isolated = await runIsolatedWorker({
    root,
    source: credentialSource,
    target: credentialTarget,
    binaries,
    inputPath,
    timeout: timeoutMs + 60_000,
  });
} catch (error) {
  await recordBlocked(error, "isolated-sdk-worker");
  process.stderr.write(`${error.code ?? "CP06_WORKER_FAILED"}: ${error.message}\n`);
  process.exit(error.exitCode ?? 1);
} finally {
  await rm(evaluationHome, { recursive: true, force: true });
}
if (
  isolated.mode !== "worker" ||
  isolated.source_unchanged !== true ||
  isolated.mount_ids_distinct !== true ||
  isolated.cleanup !== "pass" ||
  isolated.child?.result !== "pass"
) {
  const error = new Error("isolated SDK worker omitted a required safety assertion");
  await recordBlocked(error, "isolated-sdk-worker-audit");
  throw error;
}

const testedSha = textCommand("git", ["rev-parse", "HEAD"]);
const manifest = {
  schema_version: 1,
  gate: "P-06-fresh-worker",
  tested_sha: testedSha,
  recorded_at: new Date().toISOString(),
  reviewer: process.env.CP06_REVIEWER ?? "Pi CP-06 read-only auth correction worker",
  worker: {
    pi_version: isolated.child.pi_version,
    interface: "public SDK with injected CredentialStore",
    provider,
    model,
    in_memory_session: isolated.child.session.in_memory,
    tools: isolated.child.session.active_tools,
    refresh_on_create: false,
    model_catalog_network: false,
  },
  bounded_handoff: {
    contract_path: relative(contractPath),
    contract_sha256: await fileHash(contractPath),
    pack_path: relative(initialPackPath),
    pack_sha256: await fileHash(initialPackPath),
    original_path: relative(originalPath),
    original_sha256: await fileHash(originalPath),
    deliberately_omitted_constraint_sha256: sha256("request-supplied owner fields are ignored"),
    evidence: "in-memory auth 401 and concealed non-mutating cross-account 404 observations",
  },
  isolation: {
    supported_platform: "Linux x86-64",
    dummy_security_preflight: security,
    source_and_target_distinct_read_only_mounts: isolated.mount_ids_distinct,
    evaluated_child_capabilities: "all sets empty",
    evaluated_child_no_new_privs: true,
    evaluated_child_seccomp: true,
    credential_store: "injected callback-denying read-only CredentialStore",
    oauth_preflight: isolated.child.oauth_preflight,
    credential_store_audit: isolated.child.credential_store,
    credential_source_unchanged: isolated.source_unchanged,
    cleanup: isolated.cleanup,
    destructive_real_source_probe: false,
    raw_transcript_retained: false,
  },
  event_stream: isolated.child.event_stream,
  command:
    "Pi 0.85.1 createAgentSession({modelRuntime: injectedReadOnlyRuntime, tools: ['read'], inMemorySession}) inside capability-free seccomp child",
  exit_code: 0,
  response_sha256: isolated.child.response_sha256,
  response: isolated.child.response,
  result: "pass",
  limitation:
    "Live model wording is nondeterministic. The proof runner is Linux x86-64 only and exits blocked before credential access/provider use when user/mount namespaces, libseccomp, exact Pi 0.85.1, or adequate unexpired OAuth validity are unavailable.",
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
    exit_code: 0,
    status: manifest.response.status,
    reads: manifest.event_stream.read_audit.project_read_paths,
    broad_scan: manifest.response.broad_scan,
  }),
);

async function recordBlocked(error, stage) {
  const status = {
    schema_version: 1,
    gate: "P-06-fresh-worker",
    result: "blocked",
    stage,
    code: error?.code ?? "CP06_WORKER_FAILED",
    recorded_at: new Date().toISOString(),
    raw_transcript_retained: false,
  };
  await writeFile(join(workerRoot, "blocked.json"), `${JSON.stringify(status, null, 2)}\n`);
}

function textCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed`);
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
