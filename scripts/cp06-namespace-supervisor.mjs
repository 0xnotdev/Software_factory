#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mountLiveCredentialReadOnly } from "./cp06-credential-isolation.mjs";
import { withCleanup } from "./cp06-worker-lifecycle.mjs";
import { createProbeFixture } from "./cp06-probe-fixture.mjs";
import {
  trustedWorkerProvenance,
  validateWorkerEvidence,
  workerEvidenceContext,
} from "./cp06-worker-evidence.mjs";

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
      const setup = failure("setup", "CP06_ISOLATION_SETUP_FAILED", 73, cause);
      if (cause instanceof AggregateError) {
        throw compoundFailure(setup, failure("cleanup", "CP06_CREDENTIAL_CLEANUP_FAILED", 74));
      }
      throw setup;
    }
  }
  let provenance;
  if (mode === "worker" && !dependencies.spawn) {
    try {
      provenance = trustedWorkerProvenance({
        root,
        environment: process.env,
        dummy: process.env.CP06_DUMMY_TRUSTED_PROVENANCE === "1",
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
            probe?.assertSafePaths?.();
            mount = await mountCredential({
              root,
              source,
              target,
              mountHelper: helper,
              protectParents: mode !== "unsafe-probe",
              sourceParentAnchor: probe?.credentialAnchors?.sourceParent,
              targetParentAnchor: probe?.credentialAnchors?.targetParent,
              sourceLeaf: probe?.credentialAnchors?.sourceLeaf,
              targetLeaf: probe?.credentialAnchors?.targetLeaf,
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
          if (probe !== undefined) {
            try {
              probe.assertSafePaths?.({ mounted: true });
            } catch (cause) {
              throw failure("source-integrity", "CP06_SOURCE_IDENTITY_CHANGED", 74, cause);
            }
          }
          let workerContext = dependencies.workerContext;
          if (mode === "worker" && !dependencies.spawn) {
            try {
              workerContext = workerEvidenceContext(childArgs[0], target, source, { provenance });
            } catch {
              throw failure("audit", "CP06_CHILD_OUTPUT_INVALID", 70);
            }
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
            const launch = (stdio) =>
              spawn(command.command, command.args, {
                cwd: probe?.cwd ?? root,
                encoding: "utf8",
                env: childEnvironment(mode, source, target),
                timeout: mode === "worker" ? 600_000 : 60_000,
                maxBuffer: 1024 * 1024,
                stdio,
              });
            if (dependencies.spawn) result = launch(undefined);
            else {
              const paths =
                mode === "unsafe-probe"
                  ? [syscallProbe]
                  : mode === "hardened-probe"
                    ? [helper, syscallProbe]
                    : [helper, childArgs[0]];
              const fds = [];
              try {
                for (const path of paths)
                  fds.push(openSync(path, constants.O_RDONLY | constants.O_CLOEXEC));
                result = launch(["pipe", "pipe", "pipe", ...fds]);
              } finally {
                for (const fd of fds) closeSync(fd);
              }
            }
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
          try {
            if (!validChildContract(mode, childEvidence)) throw new Error();
            if (mode === "worker") {
              validateWorkerEvidence(childEvidence, workerContext);
            }
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

const WORKER_CHILD_KEYS = [
  "credential_store",
  "event_stream",
  "model",
  "oauth_preflight",
  "pi_install",
  "pi_version",
  "provider",
  "raw_transcript_retained",
  "response",
  "response_sha256",
  "result",
  "schema_version",
  "session",
].join(",");

function validChildContract(mode, child) {
  if (!isPlainObject(child)) return false;
  if (mode !== "worker") {
    return (
      isPlainObject(child.identity) &&
      isPlainObject(child.identity.status) &&
      isPlainObject(child.source) &&
      typeof child.source.unchanged === "boolean" &&
      isPlainObject(child.direct_namespace_syscalls)
    );
  }
  return (
    Object.keys(child).sort().join(",") === WORKER_CHILD_KEYS &&
    child.schema_version === 1 &&
    child.result === "pass" &&
    child.pi_version === "0.85.1" &&
    child.raw_transcript_retained === false &&
    isPlainObject(child.pi_install) &&
    isPlainObject(child.credential_store) &&
    isPlainObject(child.response) &&
    typeof child.response_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(child.response_sha256) &&
    child.oauth_preflight?.refreshed === false &&
    child.session?.in_memory === true &&
    JSON.stringify(child.session?.active_tools) === '["read"]' &&
    child.event_stream?.read_audit?.exact_original === true &&
    child.event_stream.read_audit.read_count === 1
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
        "/proc/self/fd/3",
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
          "/proc/self/fd/4",
          beforeHash,
          String(process.pid),
        ]
      : [
          process.execPath,
          "--experimental-import-meta-resolve",
          resolve(root, "scripts/cp06-sdk-worker.mjs"),
          target,
          "/proc/self/fd/4",
          ...childArgs.slice(1),
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
      "/proc/self/fd/3",
      "--cp06-readonly-fd=4",
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
    causes: error instanceof AggregateError ? leafCauses(error).map(classifyFailure) : [],
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

function leafCauses(error, limit = 8) {
  const leaves = [];
  function visit(cause) {
    if (leaves.length >= limit) return;
    if (cause instanceof AggregateError && cause.errors.length > 0) {
      for (const nested of cause.errors) visit(nested);
    } else leaves.push(cause);
  }
  visit(error);
  return leaves;
}

function safeExitCode(error) {
  return Number.isSafeInteger(error?.exitCode) && error.exitCode >= 1 && error.exitCode <= 255
    ? error.exitCode
    : null;
}

function classifyFailure(error) {
  const known = FAILURE_DESCRIPTIONS[error?.code];
  if (known !== undefined) {
    return {
      stage: known.stage,
      code: error.code,
      exit_code: safeExitCode(error),
      description: known.description,
    };
  }
  if (error instanceof AggregateError) {
    return {
      stage: "cleanup",
      code: "CP06_CLEANUP_FAILED",
      exit_code: safeExitCode(error) ?? 74,
      description: "credential namespace cleanup failed",
    };
  }
  return {
    stage: "cleanup",
    code: "CP06_CREDENTIAL_CLEANUP_FAILED",
    exit_code: safeExitCode(error),
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
  const [mode, source, target, inheritedHelper, inheritedProbe, ...childArgs] =
    process.argv.slice(2);
  const [helper, syscallProbe] = [inheritedHelper, inheritedProbe].map((path) =>
    /^\/proc\/self\/fd\/\d+$/u.test(path ?? "")
      ? `/proc/${process.pid}/fd/${path.slice("/proc/self/fd/".length)}`
      : path,
  );
  try {
    console.log(
      JSON.stringify(
        await superviseCredentialChild({
          mode,
          source,
          target,
          helper,
          syscallProbe,
          childArgs: childArgs.map((path) =>
            /^\/proc\/self\/fd\/\d+$/u.test(path)
              ? `/proc/${process.pid}/fd/${path.slice("/proc/self/fd/".length)}`
              : path,
          ),
        }),
      ),
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify(supervisorFailureRecord(error))}\n`);
    process.exitCode = error.exitCode ?? 70;
  }
}
