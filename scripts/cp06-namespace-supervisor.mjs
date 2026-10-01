#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mountLiveCredentialReadOnly } from "./cp06-credential-isolation.mjs";
import { withCleanup } from "./cp06-worker-lifecycle.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Injectable OS operations permit deterministic failure/cleanup tests without
// credentials, namespaces or an installed SDK in the ordinary unit suite.
export async function superviseCredentialChild(options, dependencies = {}) {
  const { mode, source, target, helper, syscallProbe, childArgs = [] } = options;
  if (
    !["unsafe-probe", "hardened-probe", "worker"].includes(mode) ||
    ![source, target, helper, syscallProbe].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  )
    throw failure("invalid CP-06 namespace supervisor invocation", 64);
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw failure("CP-06 isolation supports Linux x86-64 only", 73);
  }
  const mountCredential = dependencies.mount ?? mountLiveCredentialReadOnly;
  const spawn = dependencies.spawn ?? spawnSync;
  const beforeHash = sha256(readFileSync(source));
  let mount;
  const childResult = await withCleanup(
    async () => {
      try {
        mount = await mountCredential({ root, source, target });
      } catch (cause) {
        throw failure(`CP-06 isolation setup failed: ${safeError(cause)}`, 73, cause);
      }
      const command = childCommand({
        mode,
        source,
        target,
        helper,
        syscallProbe,
        childArgs,
        beforeHash,
      });
      const result = spawn(command.command, command.args, {
        cwd: root,
        encoding: "utf8",
        env: childEnvironment(mode, target),
        timeout: mode === "worker" ? 600_000 : 60_000,
        maxBuffer: 1024 * 1024,
      });
      // Throw inside the cleanup boundary so a cleanup error retains this cause.
      if (result.error !== undefined) {
        throw failure(
          `CP-06 isolated child launch failed: ${safeError(result.error)}`,
          70,
          result.error,
        );
      }
      if (result.status !== 0) {
        throw failure(
          `CP-06 isolated child exited ${result.status ?? "without status"}: ${String(result.stderr ?? "").trim()}`,
          result.status ?? 70,
        );
      }
      return result;
    },
    () => mount?.cleanup(),
  );

  const afterHash = sha256(readFileSync(source));
  if (mode === "worker" && beforeHash !== afterHash) {
    throw failure("CP-06 credential source changed during worker execution", 74);
  }
  let childEvidence;
  try {
    childEvidence = JSON.parse(String(childResult.stdout).trim());
  } catch {
    throw failure("CP-06 isolated child returned non-compact output", 70);
  }
  return {
    schema_version: 1,
    mode,
    source_unchanged: beforeHash === afterHash,
    mount_ids_distinct: mount.mountIds.source !== mount.mountIds.target,
    cleanup: "pass",
    child: childEvidence,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, source, target, helper, syscallProbe, ...childArgs] = process.argv.slice(2);
  try {
    console.log(
      JSON.stringify(
        await superviseCredentialChild({ mode, source, target, helper, syscallProbe, childArgs }),
      ),
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        schema_version: 1,
        code: error.code ?? "CP06_WORKER_FAILED",
        exit_code: error.exitCode ?? 70,
        message: safeError(error),
        causes:
          error instanceof AggregateError
            ? error.errors.map((cause) => ({
                code: cause?.code ?? "CP06_WORKER_FAILED",
                exit_code: cause?.exitCode ?? null,
              }))
            : [],
      })}\n`,
    );
    process.exitCode = error.exitCode ?? 70;
  }
}

function childCommand({ mode, source, target, helper, syscallProbe, childArgs, beforeHash }) {
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

function failure(message, exitCode, cause) {
  return Object.assign(new Error(message, { cause }), { exitCode, code: "CP06_WORKER_FAILED" });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeError(error) {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map(safeError).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}
