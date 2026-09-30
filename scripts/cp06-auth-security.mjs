import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

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
  await mkdir(outputRoot, { recursive: true });
  const prerequisites = verifyIsolationPrerequisites({
    root,
    spawnSyncImpl: options.spawnSyncImpl,
  });
  const binaries = compileIsolationHelpers({ root, outputRoot });
  const pi = resolvePiPackage();
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
  const sdk = runDummySdkProof({ root, helper: binaries.helper, piRoot: pi.root });
  return {
    schema_version: 1,
    gate: "CP-06-read-only-auth-security",
    result: "pass",
    tested_sha: commandText(spawnSync, "git", ["rev-parse", "HEAD"], root),
    recorded_at: new Date().toISOString(),
    reviewer: options.reviewer ?? "Pi CP-06 read-only auth correction worker",
    command: "npm run proof:cp06:auth-security",
    exit_code: 0,
    pi_version: pi.version,
    platform: prerequisites,
    binaries: {
      seccomp_helper_sha256: sha256(readFileSync(binaries.helper)),
      syscall_probe_sha256: sha256(readFileSync(binaries.syscallProbe)),
    },
    unsafe_control: summarizeUnsafe(unsafe),
    hardened_child: summarizeHardened(hardened),
    dummy_sdk: sdk,
  };
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
  const helper = join(outputRoot, "cp06-seccomp-exec");
  const syscallProbe = join(outputRoot, "cp06-isolation-syscalls");
  checked(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(root, "scripts/cp06-seccomp-exec.c"),
      "-Wl,-l:libseccomp.so.2",
      "-o",
      helper,
    ],
    root,
  );
  checked(
    "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      join(root, "scripts/cp06-isolation-syscalls.c"),
      "-o",
      syscallProbe,
    ],
    root,
  );
  return { helper, syscallProbe };
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
  if (result.status !== 0) {
    const error = new Error(
      result.status === 73
        ? "CP-06 credential namespace setup is unsupported"
        : `CP-06 isolated SDK worker exited ${result.status ?? "without status"}`,
    );
    error.code = result.status === 73 ? "CP06_ISOLATION_UNSUPPORTED" : "CP06_WORKER_FAILED";
    error.exitCode = result.status ?? 70;
    error.stderr = result.stderr;
    throw error;
  }
  return parseCompactJson(result.stdout, "isolated SDK worker");
}

async function runIsolationProbe({ root, outputRoot, mode, binaries }) {
  const proofRoot = await mkdtemp(join(outputRoot, `DUMMY-${mode}-`));
  const source = join(proofRoot, "source", "DUMMY-auth.json");
  const target = join(proofRoot, "agent", "DUMMY-auth.json");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, "DUMMY ORIGINAL", { mode: 0o600 });
  try {
    const result = runNamespace({
      root,
      mode,
      source,
      target,
      helper: binaries.helper,
      syscallProbe: binaries.syscallProbe,
      childArgs: [],
      timeout: 90_000,
    });
    if (result.status !== 0) {
      throw unsupported(`${mode} failed: ${String(result.stderr).trim() || result.status}`);
    }
    return parseCompactJson(result.stdout, mode);
  } finally {
    await rm(proofRoot, { recursive: true, force: true });
  }
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
    resolve(options.target),
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

function assertUnsafeControl(proof) {
  assert(proof.mode === "unsafe-probe", "unsafe control mode mismatch");
  assert(proof.mount_ids_distinct === true, "unsafe control lacked distinct mounts");
  assert(proof.source_unchanged === false, "unsafe control did not mutate DUMMY source");
  assert(proof.child.remount_target_rw.exit === 0, "unsafe remount did not succeed");
  assert(proof.child.write_after_remount.exit === 0, "unsafe post-remount write failed");
  assert(proof.child.unmount_target.exit === 0, "unsafe unmount did not succeed");
  assert(proof.child.bind_parent_alias.exit === 0, "unsafe parent bind did not succeed");
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

function runDummySdkProof({ root, helper, piRoot }) {
  const result = spawnSync(
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
    throw unsupported(`DUMMY SDK proof failed: ${result.error?.message ?? result.stderr}`);
  }
  return parseCompactJson(result.stdout, "DUMMY SDK proof");
}

function resolvePiPackage() {
  const executable = realpathSync(findExecutable("pi"));
  const root = findPiPackageRoot(executable);
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = checked("pi", ["--version"], root).stdout.trim();
  if (
    metadata.name !== "@earendil-works/pi-coding-agent" ||
    metadata.version !== "0.85.1" ||
    version !== "0.85.1"
  ) {
    throw unsupported("exact Pi 0.85.1 is unavailable");
  }
  return { root, version };
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
  throw unsupported("Pi package root could not be resolved from its executable");
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
  throw unsupported(`required executable is unavailable: ${name}`);
}

function checked(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw unsupported(`required command failed: ${command}`);
  }
  return result;
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
