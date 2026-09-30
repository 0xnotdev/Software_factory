#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const [securityMode, source, target, syscallProbe, expectedHash, supervisorPid] =
  process.argv.slice(2);
if (
  !["unsafe", "hardened"].includes(securityMode) ||
  ![source, target, syscallProbe, expectedHash, supervisorPid].every(Boolean)
)
  process.exit(64);
const proofRoot = dirname(dirname(target));
const results = {};

function jsAttempt(name, action) {
  try {
    action();
    results[name] = { exit: 0 };
  } catch (error) {
    results[name] = { exit: 1, code: error?.code ?? null };
  }
}

function commandAttempt(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000,
    ...options,
  });
  results[name] = {
    exit: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
  return result;
}

jsAttempt("direct_write_target", () => writeFileSync(target, "DUMMY BYPASS target"));
jsAttempt("direct_write_source", () => writeFileSync(source, "DUMMY BYPASS source"));
jsAttempt("unlink_target", () => unlinkSync(target));
jsAttempt("unlink_source", () => unlinkSync(source));
const replacement = join(dirname(target), "DUMMY-replacement");
writeFileSync(replacement, "DUMMY replacement");
jsAttempt("rename_over_target", () => renameSync(replacement, target));
const sourceReplacement = join(dirname(source), "DUMMY-source-replacement");
writeFileSync(sourceReplacement, "DUMMY source replacement");
jsAttempt("rename_over_source", () => renameSync(sourceReplacement, source));
jsAttempt("symlink_replacement", () => {
  try {
    unlinkSync(target);
  } catch {}
  symlinkSync("/tmp/DUMMY-does-not-exist", target);
});
jsAttempt("symlink_source_replacement", () => {
  try {
    unlinkSync(source);
  } catch {}
  symlinkSync("/tmp/DUMMY-does-not-exist", source);
});
jsAttempt("hardlink_target", () => linkSync(target, join(proofRoot, "DUMMY-hardlink")));
jsAttempt("hardlink_source", () => linkSync(source, join(proofRoot, "DUMMY-source-hardlink")));

if (securityMode === "hardened") {
  commandAttempt("direct_namespace_syscalls", syscallProbe, [target]);
} else {
  results.direct_namespace_syscalls = { exit: null, skipped: true };
}
commandAttempt("ordinary_node_child", process.execPath, [
  "-e",
  "process.stdout.write('DUMMY-child-ok')",
]);
commandAttempt("nested_user_mount_namespace", "unshare", [
  "--user",
  "--map-root-user",
  "--mount",
  "--propagation",
  "private",
  "true",
]);
commandAttempt("nsenter_self", "nsenter", ["-t", String(process.pid), "-m", "true"]);
commandAttempt("nsenter_supervisor", "nsenter", [
  "-t",
  supervisorPid,
  "-m",
  "mount",
  "-o",
  "remount,bind,rw",
  target,
]);
commandAttempt("uid_change", "setpriv", ["--reuid=1", "--regid=1", "--clear-groups", "id"]);
commandAttempt("remount_target_rw", "mount", ["-o", "remount,bind,rw", target]);
jsAttempt("write_after_remount", () => writeFileSync(target, "DUMMY BYPASS remount"));
const unmountTarget = commandAttempt("unmount_target", "umount", [target]);
if (unmountTarget.status === 0) {
  commandAttempt("restore_target_bind", "mount", ["--bind", source, target]);
} else {
  results.restore_target_bind = { exit: null, skipped: true };
}
const alias = join(proofRoot, "DUMMY-alias");
mkdirSync(alias, { recursive: true });
const bindParent = commandAttempt("bind_parent_alias", "mount", ["--bind", dirname(source), alias]);
if (bindParent.status === 0) {
  jsAttempt("alias_underlying_write", () =>
    writeFileSync(join(alias, source.split("/").at(-1)), "DUMMY BYPASS alias"),
  );
} else {
  results.alias_underlying_write = { exit: null, skipped: true };
}

const status = Object.fromEntries(
  readFileSync("/proc/self/status", "utf8")
    .split("\n")
    .filter((line) => /^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp):/.test(line))
    .map((line) => line.split(/:\s+/, 2)),
);
const finalBytes = readFileSync(source);
results.identity = { uid: process.getuid(), gid: process.getgid(), status };
results.source = {
  expected_sha256: expectedHash,
  final_sha256: createHash("sha256").update(finalBytes).digest("hex"),
  unchanged: createHash("sha256").update(finalBytes).digest("hex") === expectedHash,
};
console.log(JSON.stringify(results));
