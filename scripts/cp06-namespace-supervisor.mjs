#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mountLiveCredentialReadOnly } from "./cp06-credential-isolation.mjs";

const [mode, sourceArg, targetArg, helperArg, syscallProbeArg, ...childArgs] =
  process.argv.slice(2);
if (
  !["unsafe-probe", "hardened-probe", "worker"].includes(mode) ||
  !sourceArg ||
  !targetArg ||
  !helperArg ||
  !syscallProbeArg
) {
  process.stderr.write("invalid CP-06 namespace supervisor invocation\n");
  process.exit(64);
}
if (process.platform !== "linux" || process.arch !== "x64") {
  process.stderr.write("CP-06 isolation supports Linux x86-64 only\n");
  process.exit(73);
}

const root = resolve(new URL("..", import.meta.url).pathname);
const source = resolve(sourceArg);
const target = resolve(targetArg);
const helper = resolve(helperArg);
const syscallProbe = resolve(syscallProbeArg);
const beforeHash = sha256(readFileSync(source));
let mount;
let childResult;
let cleanupError;
try {
  mount = await mountLiveCredentialReadOnly({ root, source, target });
  const command = childCommand();
  childResult = spawnSync(command.command, command.args, {
    cwd: root,
    encoding: "utf8",
    env: childEnvironment(mode, target),
    timeout: mode === "worker" ? 600_000 : 60_000,
    maxBuffer: 1024 * 1024,
  });
} catch (error) {
  process.stderr.write(`CP-06 isolation setup failed: ${safeError(error)}\n`);
  process.exit(73);
} finally {
  try {
    mount?.cleanup();
  } catch (error) {
    cleanupError = error;
  }
}
const afterHash = sha256(readFileSync(source));
if (cleanupError !== undefined) {
  process.stderr.write(`CP-06 isolation cleanup failed: ${safeError(cleanupError)}\n`);
  process.exit(74);
}
if (childResult?.error !== undefined) {
  process.stderr.write(`CP-06 isolated child launch failed: ${safeError(childResult.error)}\n`);
  process.exit(70);
}
if (childResult?.status !== 0) {
  process.stderr.write(childResult?.stderr ?? "");
  process.stderr.write(`CP-06 isolated child exited ${childResult?.status ?? "without status"}\n`);
  process.exit(childResult?.status ?? 70);
}
if (mode === "worker" && beforeHash !== afterHash) {
  process.stderr.write("CP-06 credential source changed during worker execution\n");
  process.exit(74);
}

let childEvidence;
try {
  childEvidence = JSON.parse(String(childResult.stdout).trim());
} catch {
  process.stderr.write("CP-06 isolated child returned non-compact output\n");
  process.exit(70);
}
console.log(
  JSON.stringify({
    schema_version: 1,
    mode,
    source_unchanged: beforeHash === afterHash,
    mount_ids_distinct: mount.mountIds.source !== mount.mountIds.target,
    cleanup: "pass",
    child: childEvidence,
  }),
);

function childCommand() {
  if (mode === "unsafe-probe") {
    return {
      command: process.execPath,
      args: [
        resolve(root, "scripts/cp06-isolation-adversary.mjs"),
        "unsafe",
        source,
        target,
        syscallProbe,
        beforeHash,
        String(process.pid),
      ],
    };
  }
  const program =
    mode === "hardened-probe"
      ? [
          process.execPath,
          resolve(root, "scripts/cp06-isolation-adversary.mjs"),
          "hardened",
          source,
          target,
          syscallProbe,
          beforeHash,
          String(process.pid),
        ]
      : [process.execPath, resolve(root, "scripts/cp06-sdk-worker.mjs"), target, ...childArgs];
  return {
    command: "setpriv",
    args: [
      "--no-new-privs",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--securebits=+noroot,+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked",
      "--",
      helper,
      ...program,
    ],
  };
}

function childEnvironment(childMode, credentialTarget) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  if (childMode === "worker") {
    environment.CP06_CREDENTIAL_TARGET = credentialTarget;
    for (const name of [
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
    ]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
  }
  return environment;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeError(error) {
  if (error instanceof AggregateError) return error.errors.map(safeError).join("; ");
  return error instanceof Error ? error.message : String(error);
}
