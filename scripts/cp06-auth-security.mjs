import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { resolvePinnedPiAi } from "./cp06-pi-dependency.mjs";
import { resolvePinnedPiInstall } from "./cp06-pi-install.mjs";
import { openProbeOutput } from "./cp06-probe-fixture.mjs";

export class Cp06IsolationUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = "Cp06IsolationUnsupportedError";
    this.code = "CP06_ISOLATION_UNSUPPORTED";
  }
}

export async function runCp06SecurityPreflight(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const outputRoot = resolve(options.outputRoot ?? join(root, ".factory/state/cp06-auth-security"));
  const output = openProbeOutput({ root, outputRoot, create: true });
  let binaries;
  try {
    const prerequisites = verifyIsolationPrerequisites({
      root,
      spawnSyncImpl: options.spawnSyncImpl,
    });
    binaries = compileIsolationHelpers({
      root,
      outputRoot,
      anchoredOutputRoot: output.anchor,
    });
    const pi = resolvePiPackage(root, options);
    const unsafe = await runIsolationProbe({
      root,
      outputRoot,
      mode: "unsafe-probe",
      binaries,
    });
    assertUnsafeControl(unsafe);
    const hardened = await runIsolationProbe({
      root,
      outputRoot,
      mode: "hardened-probe",
      binaries,
    });
    assertHardenedProof(hardened);
    const sdk = runDummySdkProof({
      root,
      helper: binaries.helper,
      piRoot: pi.root,
      expectedSdkDependency: pi.provenance.dependency,
    });
    const proof = {
      schema_version: 1,
      gate: "CP-06-read-only-auth-security",
      result: "pass",
      tested_sha: commandText(spawnSync, "git", ["rev-parse", "HEAD"], root),
      recorded_at: new Date().toISOString(),
      reviewer: options.reviewer ?? "Pi CP-06 read-only auth correction worker",
      command: "npm run proof:cp06:auth-security",
      exit_code: 0,
      pi_version: pi.version,
      pi_install: pi.provenance,
      platform: prerequisites,
      binaries: {
        seccomp_helper_sha256: sha256(readFileSync(binaries.helper)),
        syscall_probe_sha256: sha256(readFileSync(binaries.syscallProbe)),
      },
      unsafe_control: summarizeUnsafe(unsafe),
      hardened_child: summarizeHardened(hardened),
      dummy_sdk: sdk,
    };
    if (options.retainBinaries === true) {
      Object.defineProperty(proof, "retainedBinaries", { value: binaries });
      binaries = undefined;
    }
    return proof;
  } finally {
    binaries?.close?.();
    output.close();
  }
}

export function verifyIsolationPrerequisites(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const spawn = options.spawnSyncImpl ?? spawnSync;
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw unsupported("CP-06 proof runner supports Linux x86-64 only");
  }
  const probes = [
    ["unshare", ["--user", "--map-root-user", "--mount", "--propagation", "private", "true"]],
    ["mount", ["--version"]],
    ["umount", ["--version"]],
    ["findmnt", ["--version"]],
    ["setpriv", ["--version"]],
    ["nsenter", ["--version"]],
    ["cc", ["--version"]],
  ];
  for (const [command, args] of probes) {
    const result = spawn(command, args, { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (result.error !== undefined || result.status !== 0) {
      throw unsupported(`required isolation probe failed: ${command}`);
    }
  }
  return {
    os: process.platform,
    architecture: process.arch,
    kernel: commandText(spawn, "uname", ["-r"], root),
    user_mount_namespace: true,
    libseccomp: true,
  };
}

export function compileIsolationHelpers(options) {
  const root = resolve(options.root);
  const outputRoot = resolve(options.outputRoot);
  const artifactRoot = mkdtempSync(join(options.anchoredOutputRoot ?? outputRoot, "helpers-"));
  const artifactFd = openSync(
    artifactRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const artifactAnchor = `/proc/${process.pid}/fd/${artifactFd}`;
  const helper = join(artifactAnchor, "cp06-seccomp-exec");
  const syscallProbe = join(artifactAnchor, "cp06-isolation-syscalls");
  const spawn = options.spawnSyncImpl ?? spawnSync;
  let helperFd;
  let syscallProbeFd;
  try {
    helperFd = compilePinnedArtifact({
      root,
      artifactAnchor,
      name: "cp06-seccomp-exec",
      source: join(root, "scripts/cp06-seccomp-exec.c"),
      extraArgs: ["-Wl,-l:libseccomp.so.2"],
      spawn,
    });
    syscallProbeFd = compilePinnedArtifact({
      root,
      artifactAnchor,
      name: "cp06-isolation-syscalls",
      source: join(root, "scripts/cp06-isolation-syscalls.c"),
      extraArgs: [],
      spawn,
    });
    let closed = false;
    closeSync(artifactFd);
    return {
      helper: `/proc/${process.pid}/fd/${helperFd}`,
      syscallProbe: `/proc/${process.pid}/fd/${syscallProbeFd}`,
      outputPaths: { helper, syscallProbe },
      close() {
        if (closed) return;
        closed = true;
        closeSync(helperFd);
        closeSync(syscallProbeFd);
      },
    };
  } catch (error) {
    if (helperFd !== undefined) closeSync(helperFd);
    if (syscallProbeFd !== undefined) closeSync(syscallProbeFd);
    closeSync(artifactFd);
    throw error;
  }
}

export async function runIsolatedWorker(options) {
  const result = runNamespace({
    root: options.root,
    mode: "worker",
    source: options.source,
    target: options.target,
    helper: options.binaries.helper,
    syscallProbe: options.binaries.syscallProbe,
    childArgs: [options.inputPath],
    timeout: options.timeout ?? 660_000,
    environment: options.environment,
  });
  if (result.status !== 0) throw namespaceWorkerError(result);
  return parseCompactJson(result.stdout, "isolated SDK worker");
}

export function namespaceWorkerError(result) {
  if (result.error?.code === "ETIMEDOUT") {
    const error = new Error("CP-06 isolated SDK worker timed out");
    error.code = "CP06_CHILD_TIMEOUT";
    error.stage = "timeout";
    error.exitCode = 70;
    error.workerFailure = {
      schema_version: 1,
      stage: "timeout",
      code: "CP06_CHILD_TIMEOUT",
      exit_code: 70,
      description: SUPERVISOR_FAILURE_DESCRIPTIONS.CP06_CHILD_TIMEOUT,
      causes: [],
    };
    return error;
  }
  const error = new Error(
    result.status === 73
      ? "CP-06 credential namespace setup is unsupported"
      : `CP-06 isolated SDK worker exited ${result.status ?? "without status"}`,
  );
  error.code = result.status === 73 ? "CP06_ISOLATION_UNSUPPORTED" : "CP06_WORKER_FAILED";
  error.stage = result.status === 73 ? "setup" : "namespace";
  error.exitCode = result.status ?? 70;
  try {
    const failure = JSON.parse(String(result.stderr).trim());
    if (isSupervisorFailure(failure, result.status)) {
      error.workerFailure = {
        schema_version: 1,
        stage: failure.stage,
        code: failure.code,
        exit_code: failure.exit_code,
        description: failure.description,
        causes: failure.causes.map((cause) => ({ ...cause })),
      };
      error.code = failure.code;
      error.stage = failure.stage;
    }
  } catch {}
  return error;
}

export async function runIsolationProbe({
  root,
  outputRoot,
  mode,
  binaries,
  runNamespaceImpl = runNamespace,
}) {
  const result = runNamespaceImpl({
    root,
    mode,
    source: outputRoot,
    target: "-",
    helper: binaries.helper,
    syscallProbe: binaries.syscallProbe,
    childArgs: [],
    timeout: 90_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    const failure = namespaceWorkerError(result);
    const error = unsupported(`${mode} failed: ${failure.code}`);
    error.workerFailure = failure.workerFailure;
    throw error;
  }
  return parseCompactJson(result.stdout, mode);
}

function runNamespace(options) {
  const args = [
    "--user",
    "--map-root-user",
    "--mount",
    "--propagation",
    "private",
    "--",
    process.execPath,
    join(options.root, "scripts/cp06-namespace-supervisor.mjs"),
    options.mode,
    resolve(options.source),
    options.mode === "worker" ? resolve(options.target) : "-",
    resolve(options.helper),
    resolve(options.syscallProbe),
    ...options.childArgs.map((value) => resolve(value)),
  ];
  return spawnSync("unshare", args, {
    cwd: options.root,
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: 1024 * 1024,
    env: options.environment ?? process.env,
  });
}

function isSupervisorFailure(value, status) {
  return (
    value?.schema_version === 1 &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") ===
      "causes,code,description,exit_code,schema_version,stage" &&
    value.exit_code === status &&
    typeof value.stage === "string" &&
    SUPERVISOR_FAILURE_CODES.get(value.code) === value.stage &&
    typeof value.description === "string" &&
    value.description === SUPERVISOR_FAILURE_DESCRIPTIONS[value.code] &&
    Array.isArray(value.causes) &&
    value.causes.every(
      (cause) =>
        cause !== null &&
        typeof cause === "object" &&
        !Array.isArray(cause) &&
        Object.keys(cause).sort().join(",") === "code,description,exit_code,stage" &&
        SUPERVISOR_FAILURE_CODES.get(cause.code) === cause.stage &&
        cause.description === SUPERVISOR_FAILURE_DESCRIPTIONS[cause.code] &&
        (cause.exit_code === null || Number.isSafeInteger(cause.exit_code)),
    )
  );
}

const SUPERVISOR_FAILURE_DESCRIPTIONS = {
  CP06_ISOLATION_SETUP_FAILED: "credential namespace setup failed",
  CP06_CREDENTIAL_SOURCE_MISSING: "credential source is missing",
  CP06_CHILD_LAUNCH_FAILED: "isolated child launch failed",
  CP06_CHILD_TIMEOUT: "isolated child timed out",
  CP06_AUTH_BLOCKED: "credential preflight blocked the child",
  CP06_CHILD_EXIT_FAILED: "isolated child exited unsuccessfully",
  CP06_SOURCE_IDENTITY_CHANGED: "credential source identity changed",
  CP06_CHILD_OUTPUT_INVALID: "isolated child output was invalid",
  CP06_CLEANUP_FAILED: "credential namespace cleanup failed",
  CP06_CREDENTIAL_CLEANUP_FAILED: "credential mount cleanup failed",
};
const SUPERVISOR_FAILURE_CODES = new Map([
  ["CP06_ISOLATION_SETUP_FAILED", "setup"],
  ["CP06_CREDENTIAL_SOURCE_MISSING", "missing-source"],
  ["CP06_CHILD_LAUNCH_FAILED", "launch"],
  ["CP06_CHILD_TIMEOUT", "timeout"],
  ["CP06_AUTH_BLOCKED", "child-exit"],
  ["CP06_CHILD_EXIT_FAILED", "child-exit"],
  ["CP06_SOURCE_IDENTITY_CHANGED", "source-integrity"],
  ["CP06_CHILD_OUTPUT_INVALID", "audit"],
  ["CP06_CLEANUP_FAILED", "cleanup"],
  ["CP06_CREDENTIAL_CLEANUP_FAILED", "cleanup"],
]);

function assertUnsafeControl(proof) {
  assert(proof.mode === "unsafe-probe", "unsafe control mode mismatch");
  assert(proof.mount_ids_distinct === true, "unsafe control lacked distinct mounts");
  assert(proof.source_unchanged === false, "unsafe control did not mutate DUMMY source");
  assert(proof.child.remount_target_rw.exit === 0, "unsafe remount did not succeed");
  assert(proof.child.write_after_remount.exit === 0, "unsafe post-remount write failed");
  assert(proof.child.unmount_target.exit === 0, "unsafe unmount did not succeed");
  assert(proof.child.bind_parent_alias.exit === 0, "unsafe parent bind did not succeed");
  assert(proof.child.scratch_write.exit === 0, "unsafe scratch path was not writable");
  assert(proof.child.alias_underlying_write.exit === 0, "unsafe alias write did not succeed");
  assert(
    proof.child.identity.status.CapEff !== "0000000000000000",
    "unsafe control unexpectedly had no capabilities",
  );
}

function assertHardenedProof(proof) {
  assert(proof.mode === "hardened-probe", "hardened proof mode mismatch");
  assert(proof.mount_ids_distinct === true, "hardened proof lacked distinct mounts");
  assert(proof.source_unchanged === true, "hardened child changed DUMMY source");
  const status = proof.child.identity.status;
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
    assert(status[name] === "0000000000000000", `${name} was not empty`);
  assert(status.NoNewPrivs === "1", "no_new_privs was not active");
  assert(status.Seccomp === "2", "seccomp filter mode was not active");
  for (const name of [
    "direct_write_target",
    "direct_write_source",
    "unlink_target",
    "unlink_source",
    "rename_over_target",
    "rename_over_source",
    "symlink_replacement",
    "symlink_source_replacement",
    "hardlink_target",
    "hardlink_source",
    "create_target_parent_entry",
    "create_source_parent_entry",
    "unlink_target_parent",
    "unlink_source_parent",
    "rename_target_parent",
    "rename_source_parent",
    "symlink_in_target_parent",
    "symlink_in_source_parent",
    "hardlink_into_target_parent",
    "hardlink_into_source_parent",
    "nested_user_mount_namespace",
    "nsenter_self",
    "nsenter_supervisor",
    "uid_change",
    "remount_target_rw",
    "write_after_remount",
    "unmount_target",
    "bind_parent_alias",
  ]) {
    assert(proof.child[name].exit !== 0, `${name} unexpectedly succeeded`);
  }
  assert(proof.child.source.unchanged === true, "hardened child source hash changed");
  assert(proof.child.alias_underlying_write.skipped === true, "alias write was attempted");
  assert(proof.child.scratch_write.exit === 0, "dedicated scratch path was not writable");
  assert(proof.parent_roots_read_only === true, "credential parent roots were not read-only");
  assert(proof.child.ordinary_node_child.exit === 0, "ordinary child process was blocked");
  assert(
    proof.child.ordinary_node_child.stdout === "DUMMY-child-ok",
    "ordinary child output wrong",
  );
  const syscalls = proof.child.direct_namespace_syscalls;
  assert(syscalls.exit === 0, "direct syscall probe failed to execute");
  for (const expected of [
    "setns=-1:1",
    "unshare=-1:1",
    "clone=-1:1",
    "clone3=-1:38",
    "mount=-1:1",
    "umount2=-1:1",
  ]) {
    assert(syscalls.stdout.includes(expected), `direct syscall was not filtered: ${expected}`);
  }
}

export function runDummySdkProof({
  root,
  helper,
  piRoot,
  spawnSyncImpl = spawnSync,
  expectedSdkDependency,
}) {
  const result = spawnSyncImpl(
    "unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "--propagation",
      "private",
      "--",
      "setpriv",
      "--no-new-privs",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--securebits=+noroot,+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked",
      "--",
      helper,
      process.execPath,
      "--experimental-import-meta-resolve",
      join(root, "scripts/cp06-dummy-sdk-proof.mjs"),
      piRoot,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const code =
      result.error?.code === "ETIMEDOUT"
        ? "CP06_DUMMY_SDK_TIMEOUT"
        : result.error !== undefined
          ? "CP06_DUMMY_SDK_LAUNCH_FAILED"
          : "CP06_DUMMY_SDK_CHILD_EXIT";
    throw unsupported(`DUMMY SDK proof failed: ${code}`);
  }
  const trustedDependency = expectedSdkDependency ?? resolvePinnedPiAi(piRoot).provenance;
  return validateDummySdkProof(
    parseCompactJson(result.stdout, "DUMMY SDK proof"),
    trustedDependency,
  );
}

export function validateDummySdkProof(proof, trustedDependency) {
  assertExactKeys(proof, [
    "actual_sdk_outcomes",
    "auth_cases",
    "fixture_origin",
    "network_calls",
    "result",
    "schema_version",
    "sdk_dependency",
    "sdk_worker",
    "semantic_acceptance",
  ]);
  assert(proof.schema_version === 1, "DUMMY SDK schema mismatch");
  assert(proof.result === "pass", "DUMMY SDK proof did not pass");
  assert(proof.fixture_origin === true, "DUMMY SDK fixture origin missing");
  assert(proof.semantic_acceptance === false, "DUMMY SDK semantic acceptance was claimed");
  assert(proof.network_calls === 0, "DUMMY SDK attempted network access");
  validateAuthCases(proof.auth_cases);
  validateSdkWorker(proof.sdk_worker);
  validateSdkDependency(proof.sdk_dependency, trustedDependency);
  validateOutcomeProof(proof.actual_sdk_outcomes, trustedDependency);
  return proof;
}

function validateAuthCases(cases) {
  assert(Array.isArray(cases) && cases.length === 3, "DUMMY SDK auth cases incomplete");
  const expected = new Map([
    ["expired", { result: "blocked", toAuth: 0, modifyDenials: 1 }],
    ["near_expiry", { result: "blocked", toAuth: 0, modifyDenials: 1 }],
    ["unexpired", { result: "resolved", toAuth: 1, modifyDenials: 0 }],
  ]);
  const seen = new Set();
  for (const entry of cases) {
    assertExactKeys(entry, [
      "credential_store",
      "persistence_operations",
      "refresh_callbacks",
      "result",
      "scenario",
      "source_unchanged",
      "to_auth_calls",
    ]);
    const expectation = expected.get(entry.scenario);
    assert(expectation !== undefined && !seen.has(entry.scenario), "DUMMY SDK auth case mismatch");
    seen.add(entry.scenario);
    assert(entry.result === expectation.result, "DUMMY SDK auth result mismatch");
    assert(entry.refresh_callbacks === 0, "DUMMY SDK refresh callback ran");
    assert(entry.to_auth_calls === expectation.toAuth, "DUMMY SDK toAuth count mismatch");
    assert(entry.persistence_operations === 0, "DUMMY SDK persistence occurred");
    assert(entry.source_unchanged === true, "DUMMY SDK auth source changed");
    validateCredentialAudit(entry.credential_store, {
      reads: 1,
      lists: 0,
      modify_denials: expectation.modifyDenials,
      delete_denials: 0,
    });
  }
}

function validateSdkWorker(worker) {
  assertExactKeys(worker, [
    "active_tools",
    "credential_store",
    "event_count",
    "event_sha256",
    "in_memory_session",
    "read_audit",
    "refresh_callbacks",
  ]);
  assert(
    Array.isArray(worker.active_tools) && worker.active_tools.join(",") === "read",
    "DUMMY SDK tools mismatch",
  );
  assert(worker.in_memory_session === true, "DUMMY SDK session was persisted");
  assert(
    Number.isSafeInteger(worker.event_count) && worker.event_count > 0,
    "DUMMY SDK event count missing",
  );
  assert(isSha256(worker.event_sha256), "DUMMY SDK event digest missing");
  assert(worker.refresh_callbacks === 0, "DUMMY SDK worker refresh callback ran");
  validateCredentialAudit(worker.credential_store, { modify_denials: 0, delete_denials: 0 });
  validateReadAudit(worker.read_audit, {
    toolCallId: "DUMMY-read",
    originalSuffix: "/DUMMY-original.md",
  });
}

function validateSdkDependency(dependency, trustedDependency) {
  assertExactKeys(dependency, [
    "entry",
    "entry_sha256",
    "manifest_sha256",
    "name",
    "package_sha256",
    "resolution",
    "root",
    "tarball_integrity",
    "version",
  ]);
  assertExactKeys(trustedDependency, [
    "entry",
    "entry_sha256",
    "manifest_sha256",
    "name",
    "package_sha256",
    "resolution",
    "root",
    "tarball_integrity",
    "version",
  ]);
  for (const [key, value] of Object.entries(trustedDependency)) {
    assert(dependency[key] === value, `DUMMY SDK dependency ${key} mismatch`);
  }
  for (const key of ["entry_sha256", "manifest_sha256", "package_sha256"]) {
    assert(isSha256(dependency[key]), "DUMMY SDK dependency digest missing");
  }
}

function validateOutcomeProof(outcomes, trustedDependency) {
  assertExactKeys(outcomes, ["cases", "fixture_origin", "semantic_acceptance"]);
  assert(outcomes.fixture_origin === true, "DUMMY outcome fixture origin missing");
  assert(outcomes.semantic_acceptance === false, "DUMMY outcome semantic acceptance was claimed");
  assert(Array.isArray(outcomes.cases), "DUMMY outcome cases missing");
  const expected = new Map([
    ["valid", [0, 1, 3]],
    ["fenced-valid", [0, 1, 3]],
    ["extra-before-fence", [75, 1, 3]],
    ["empty-gap", [75, 1, 3]],
    ["missing-gap", [75, 1, 3]],
    ["contradictory-gap", [75, 1, 3]],
    ["extra-evidence", [75, 1, 3]],
    ["constraint-pass", [75, 1, 3]],
    ["missing-reads", [75, 1, 3]],
    ["credential-read", [75, 1, 3]],
    ["symlink-read", [75, 1, 3]],
    ["earlier-assistant-claim", [75, 1, 3]],
    ["final-extra-channel", [75, 1, 4]],
    ["unexpected-tool-secret", [75, 1, 3]],
    ["expired", [75, 0, 0]],
    ["near-expiry", [75, 0, 0]],
    ["timeout", [70, 1, 2]],
  ]);
  const seen = new Set();
  for (const entry of outcomes.cases) {
    assert(
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
      "DUMMY outcome case malformed",
    );
    const [expectedExit, expectedRuntimeCreate, expectedToAuth] =
      expected.get(entry.scenario) ?? [];
    assert(
      expectedExit !== undefined && !seen.has(entry.scenario),
      "DUMMY outcome scenario mismatch",
    );
    const expectedKeys = [
      "default_storage",
      "exit",
      "expected_exit_code",
      "exit_code",
      "fixture_origin",
      "network",
      "refresh",
      "runtime_create",
      "scenario",
      "sdk_dependency",
      "source_unchanged",
      "to_auth",
    ];
    if (["valid", "fenced-valid"].includes(entry.scenario)) expectedKeys.push("read_audit");
    assertExactKeys(entry, expectedKeys);
    seen.add(entry.scenario);
    assert(
      entry.exit_code === expectedExit &&
        entry.expected_exit_code === expectedExit &&
        entry.exit === expectedExit,
      "DUMMY outcome exit mismatch",
    );
    assert(entry.fixture_origin === true, "DUMMY outcome fixture origin missing");
    validateSdkDependency(entry.sdk_dependency, trustedDependency);
    assert(entry.source_unchanged === true, "DUMMY outcome source changed");
    assert(
      entry.default_storage === 0 && entry.network === 0 && entry.refresh === 0,
      "DUMMY outcome side effect occurred",
    );
    assert(
      entry.runtime_create === expectedRuntimeCreate && entry.to_auth === expectedToAuth,
      "DUMMY outcome runtime/auth count mismatch",
    );
    if (["valid", "fenced-valid"].includes(entry.scenario)) {
      validateReadAudit(entry.read_audit, {
        toolCallId: "DUMMY-actual-worker-read",
        originalSuffix: "/docs/AUTH.md",
      });
    }
  }
  assert(seen.size === expected.size, "DUMMY outcome cases incomplete");
}

function validateCredentialAudit(audit, expected) {
  assertExactKeys(audit, ["delete_denials", "lists", "modify_denials", "reads"]);
  for (const key of ["delete_denials", "lists", "modify_denials", "reads"]) {
    assert(Number.isSafeInteger(audit[key]) && audit[key] >= 0, "DUMMY credential audit malformed");
    if (Object.hasOwn(expected, key)) {
      assert(audit[key] === expected[key], `DUMMY credential audit ${key} mismatch`);
    }
  }
  assert(audit.reads >= 1, "DUMMY credential audit omitted the credential read");
}

function validateReadAudit(audit, { toolCallId, originalSuffix }) {
  assertExactKeys(audit, [
    "completed_successfully",
    "end_event_index",
    "exact_original",
    "expected_sha256",
    "other_tool_calls",
    "other_tool_completions",
    "project_read_count",
    "project_read_paths",
    "read_count",
    "rejected_read_paths",
    "response_event_index",
    "returned_bytes",
    "returned_sha256",
    "start_event_index",
    "tool_call_id",
  ]);
  const isEmptyArray = (value) => Array.isArray(value) && value.length === 0;
  const isIndex = (value) => Number.isSafeInteger(value) && value >= 0;
  assert(
    audit.read_count === 1 &&
      audit.project_read_count === 1 &&
      Array.isArray(audit.project_read_paths) &&
      audit.project_read_paths.length === 1 &&
      typeof audit.project_read_paths[0] === "string" &&
      audit.project_read_paths[0].startsWith("/") &&
      audit.project_read_paths[0].endsWith(originalSuffix) &&
      isEmptyArray(audit.rejected_read_paths) &&
      isEmptyArray(audit.other_tool_calls) &&
      isEmptyArray(audit.other_tool_completions),
    "DUMMY read audit did not record exactly one original read",
  );
  assert(
    audit.completed_successfully === true && audit.exact_original === true,
    "DUMMY exact original read missing",
  );
  assert(
    isSha256(audit.expected_sha256) &&
      audit.returned_sha256 === audit.expected_sha256 &&
      Number.isSafeInteger(audit.returned_bytes) &&
      audit.returned_bytes > 0,
    "DUMMY read audit bytes mismatch",
  );
  assert(audit.tool_call_id === toolCallId, "DUMMY read audit tool call mismatch");
  assert(
    isIndex(audit.start_event_index) &&
      isIndex(audit.end_event_index) &&
      isIndex(audit.response_event_index) &&
      audit.start_event_index < audit.end_event_index &&
      audit.end_event_index < audit.response_event_index,
    "DUMMY read audit event order mismatch",
  );
}

function assertExactKeys(value, keys) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "DUMMY SDK proof object malformed",
  );
  assert(
    Object.keys(value).sort().join(",") === keys.slice().sort().join(","),
    "DUMMY SDK proof keys mismatch",
  );
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function resolvePiPackage(root, options) {
  try {
    return resolvePinnedPiInstall({
      projectRoot: root,
      packageRoot: options.piPackageRoot ?? process.env.CP06_PI_PACKAGE_ROOT,
      executable: options.piExecutable ?? process.env.CP06_PI_BIN,
      spawnSyncImpl: options.piSpawnSyncImpl,
      environment: options.environment,
    });
  } catch {
    throw unsupported("explicit task-local Pi 0.85.1 installation is unavailable");
  }
}

function compilePinnedArtifact({ root, artifactAnchor, name, source, extraArgs, spawn }) {
  const leaf = join(artifactAnchor, name);
  const fd = openSync(
    leaf,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o700,
  );
  let executionFd;
  try {
    fchmodSync(fd, 0o700);
    const pinned = fstatSync(fd, { bigint: true });
    const result = spawn(
      "cc",
      [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        source,
        ...extraArgs,
        "-o",
        "/proc/self/fd/3",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe", fd],
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw unsupported("required command failed: cc");
    }
    fchmodSync(fd, 0o700);
    const current = fstatSync(fd, { bigint: true });
    const named = lstatSync(leaf, { bigint: true });
    if (!current.isFile() || !sameInode(pinned, current) || !sameInode(pinned, named)) {
      throw unsupported("compiled helper identity changed");
    }
    executionFd = openSync(`/proc/${process.pid}/fd/${fd}`, constants.O_RDONLY);
    const executable = fstatSync(executionFd, { bigint: true });
    const executionLeaf = lstatSync(leaf, { bigint: true });
    if (
      !executable.isFile() ||
      !executionLeaf.isFile() ||
      !sameInode(pinned, executable) ||
      !sameInode(pinned, executionLeaf)
    ) {
      throw unsupported("compiled helper identity changed");
    }
    return executionFd;
  } catch (error) {
    if (executionFd !== undefined) closeSync(executionFd);
    throw error;
  } finally {
    closeSync(fd);
  }
}

function checked(command, args, cwd, spawn = spawnSync) {
  const result = spawn(command, args, { cwd, encoding: "utf8", timeout: 60_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw unsupported(`required command failed: ${command}`);
  }
  return result;
}

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function commandText(spawn, command, args, cwd) {
  const result = spawn(command, args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw unsupported(`required isolation probe failed: ${command}`);
  }
  return result.stdout.trim();
}

function parseCompactJson(value, label) {
  try {
    return JSON.parse(String(value).trim());
  } catch (cause) {
    throw unsupported(`${label} did not return compact JSON`, { cause });
  }
}

function summarizeUnsafe(proof) {
  return {
    retained_capabilities: proof.child.identity.status.CapEff,
    remount_succeeded: proof.child.remount_target_rw.exit === 0,
    unmount_succeeded: proof.child.unmount_target.exit === 0,
    parent_bind_succeeded: proof.child.bind_parent_alias.exit === 0,
    dummy_source_changed: !proof.source_unchanged,
  };
}

function summarizeHardened(proof) {
  return {
    capability_sets_zero: true,
    no_new_privs: true,
    seccomp_filter: true,
    ordinary_child_allowed: true,
    direct_writes_denied: true,
    replacement_denied: true,
    remount_unmount_denied: true,
    namespace_entry_creation_denied: true,
    uid_change_denied: true,
    alternate_parent_bind_denied: true,
    credential_parent_roots_read_only: proof.parent_roots_read_only,
    dedicated_scratch_writable: proof.child.scratch_write.exit === 0,
    dummy_source_unchanged: proof.source_unchanged,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`CP-06 security assertion failed: ${message}`);
}

function unsupported(message) {
  return new Cp06IsolationUnsupportedError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
