#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mountLiveCredentialReadOnly } from "./cp06-credential-isolation.mjs";
import { withCleanup } from "./cp06-worker-lifecycle.mjs";
import { createProbeFixture } from "./cp06-probe-fixture.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Injectable OS operations permit deterministic failure/cleanup tests without
// credentials, namespaces or an installed SDK in the ordinary unit suite.
export async function superviseCredentialChild(options, dependencies = {}) {
  const {
    mode,
    source: requestedSource,
    target: requestedTarget,
    helper,
    syscallProbe,
    childArgs = [],
  } = options;
  if (
    !["unsafe-probe", "hardened-probe", "worker"].includes(mode) ||
    ![requestedSource, requestedTarget, helper, syscallProbe].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  )
    throw failure("setup", "CP06_ISOLATION_SETUP_FAILED", 64);
  if (mode !== "worker" && (requestedTarget !== "-" || childArgs.length !== 0)) {
    throw failure("setup", "CP06_ISOLATION_SETUP_FAILED", 64);
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw failure("setup", "CP06_ISOLATION_SETUP_FAILED", 73);
  }
  const mountCredential = dependencies.mount ?? mountLiveCredentialReadOnly;
  const spawn = dependencies.spawn ?? spawnSync;
  let probe;
  if (mode !== "worker") {
    try {
      probe = await (dependencies.createProbeFixture ?? createProbeFixture)({
        root,
        outputRoot: requestedSource,
      });
    } catch (cause) {
      throw failure("setup", "CP06_ISOLATION_SETUP_FAILED", 73, cause);
    }
  }
  const source = probe?.source ?? requestedSource;
  const target = probe?.target ?? requestedTarget;
  const beforeHash = probe?.beforeHash ?? null;
  let mount;
  return await withCleanup(
    () =>
      withCleanup(
        async () => {
          try {
            mount = await mountCredential({
              root,
              source,
              target,
              protectParents: mode !== "unsafe-probe",
            });
          } catch (cause) {
            const missingSource = hasErrorCode(cause, "ENOENT");
            const setup = failure(
              missingSource ? "missing-source" : "setup",
              missingSource ? "CP06_CREDENTIAL_SOURCE_MISSING" : "CP06_ISOLATION_SETUP_FAILED",
              missingSource ? 70 : 73,
              cause,
            );
            if (cause instanceof AggregateError) {
              throw compoundFailure(
                setup,
                failure("cleanup", "CP06_CREDENTIAL_CLEANUP_FAILED", 74),
              );
            }
            throw setup;
          }
          const command = childCommand({
            mode,
            source,
            target,
            helper,
            syscallProbe,
            childArgs,
            beforeHash,
            probe: probe !== undefined,
          });
          let result;
          try {
            result = spawn(command.command, command.args, {
              cwd: probe?.cwd ?? root,
              encoding: "utf8",
              env: childEnvironment(mode, source, target),
              timeout: mode === "worker" ? 600_000 : 60_000,
              maxBuffer: 1024 * 1024,
            });
          } catch (cause) {
            throw failure("launch", "CP06_CHILD_LAUNCH_FAILED", 70, cause);
          }
          if (result.error !== undefined) {
            const timeout = result.error?.code === "ETIMEDOUT";
            throw failure(
              timeout ? "timeout" : "launch",
              timeout ? "CP06_CHILD_TIMEOUT" : "CP06_CHILD_LAUNCH_FAILED",
              70,
              result.error,
            );
          }
          if (result.status !== 0) {
            throw failure(
              "child-exit",
              result.status === 75 ? "CP06_AUTH_BLOCKED" : "CP06_CHILD_EXIT_FAILED",
              result.status ?? 70,
            );
          }

          let sourceUnchanged;
          try {
            sourceUnchanged =
              mode === "worker" ? await mount.verifyIntegrity() : probe.sourceUnchanged();
          } catch {
            sourceUnchanged = false;
          }
          if (!sourceUnchanged && mode !== "unsafe-probe") {
            throw failure("source-integrity", "CP06_SOURCE_IDENTITY_CHANGED", 74);
          }
          let childEvidence;
          try {
            childEvidence = JSON.parse(String(result.stdout).trim());
          } catch {
            throw failure("audit", "CP06_CHILD_OUTPUT_INVALID", 70);
          }
          return {
            schema_version: 1,
            mode,
            source_unchanged: sourceUnchanged,
            mount_ids_distinct: mount.mountIds.source !== mount.mountIds.target,
            parent_roots_read_only: mount.parentMounts.length > 0,
            cleanup: "pass",
            child: childEvidence,
          };
        },
        () => mount?.cleanup(),
      ),
    () => probe?.cleanup(),
  );
}

function childCommand({
  mode,
  source,
  target,
  helper,
  syscallProbe,
  childArgs,
  beforeHash,
  probe,
}) {
  const childSource = probe ? "source/DUMMY-auth.json" : source;
  const childTarget = probe ? "agent/DUMMY-auth.json" : target;
  if (mode === "unsafe-probe") {
    return {
      command: process.execPath,
      args: [
        resolve(root, "scripts/cp06-isolation-adversary.mjs"),
        "unsafe",
        childSource,
        childTarget,
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
          childSource,
          childTarget,
          syscallProbe,
          beforeHash,
          String(process.pid),
        ]
      : [
          process.execPath,
          "--experimental-import-meta-resolve",
          resolve(root, "scripts/cp06-sdk-worker.mjs"),
          target,
          ...childArgs,
        ];
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

function childEnvironment(childMode, credentialSource, credentialTarget) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  if (childMode === "worker") {
    environment.CP06_PROJECT_ROOT = root;
    environment.CP06_CREDENTIAL_SOURCE = credentialSource;
    environment.CP06_CREDENTIAL_TARGET = credentialTarget;
    for (const name of [
      "CP06_PI_PACKAGE_ROOT",
      "CP06_PI_BIN",
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

export function supervisorFailureRecord(error) {
  const failure = classifyFailure(error);
  return {
    schema_version: 1,
    stage: failure.stage,
    code: failure.code,
    exit_code: failure.exit_code,
    description: failure.description,
    causes:
      error instanceof AggregateError ? error.errors.map((cause) => classifyFailure(cause)) : [],
  };
}

function failure(stage, code, exitCode, cause) {
  return Object.assign(new Error(code, { cause }), { stage, exitCode, code });
}

function compoundFailure(primary, cleanup) {
  return Object.assign(new AggregateError([primary, cleanup], "CP06_CLEANUP_FAILED"), {
    stage: "cleanup",
    exitCode: 74,
    code: "CP06_CLEANUP_FAILED",
  });
}

function hasErrorCode(error, code) {
  if (error?.code === code) return true;
  return error instanceof AggregateError && error.errors.some((cause) => hasErrorCode(cause, code));
}

function classifyFailure(error) {
  const known = FAILURE_DESCRIPTIONS[error?.code];
  if (known !== undefined) {
    return {
      stage: error.stage ?? known.stage,
      code: error.code,
      exit_code: error.exitCode ?? null,
      description: known.description,
    };
  }
  if (error instanceof AggregateError) {
    return {
      stage: "cleanup",
      code: "CP06_CLEANUP_FAILED",
      exit_code: error.exitCode ?? 74,
      description: "credential namespace cleanup failed",
    };
  }
  return {
    stage: "cleanup",
    code: "CP06_CREDENTIAL_CLEANUP_FAILED",
    exit_code: error?.exitCode ?? null,
    description: "credential mount cleanup failed",
  };
}

const FAILURE_DESCRIPTIONS = {
  CP06_ISOLATION_SETUP_FAILED: {
    stage: "setup",
    description: "credential namespace setup failed",
  },
  CP06_CREDENTIAL_SOURCE_MISSING: {
    stage: "missing-source",
    description: "credential source is missing",
  },
  CP06_CHILD_LAUNCH_FAILED: { stage: "launch", description: "isolated child launch failed" },
  CP06_CHILD_TIMEOUT: { stage: "timeout", description: "isolated child timed out" },
  CP06_AUTH_BLOCKED: { stage: "child-exit", description: "credential preflight blocked the child" },
  CP06_CHILD_EXIT_FAILED: {
    stage: "child-exit",
    description: "isolated child exited unsuccessfully",
  },
  CP06_SOURCE_IDENTITY_CHANGED: {
    stage: "source-integrity",
    description: "credential source identity changed",
  },
  CP06_CHILD_OUTPUT_INVALID: { stage: "audit", description: "isolated child output was invalid" },
  CP06_CLEANUP_FAILED: { stage: "cleanup", description: "credential namespace cleanup failed" },
  CP06_CREDENTIAL_CLEANUP_FAILED: {
    stage: "cleanup",
    description: "credential mount cleanup failed",
  },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, source, target, helper, syscallProbe, ...childArgs] = process.argv.slice(2);
  try {
    console.log(
      JSON.stringify(
        await superviseCredentialChild({ mode, source, target, helper, syscallProbe, childArgs }),
      ),
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify(supervisorFailureRecord(error))}\n`);
    process.exitCode = error.exitCode ?? 70;
  }
}
