#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
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
jsAttempt("create_target_parent_entry", () =>
  writeFileSync(join(dirname(target), "DUMMY-parent-entry"), "DUMMY parent replacement"),
);
jsAttempt("create_source_parent_entry", () =>
  writeFileSync(join(dirname(source), "DUMMY-parent-entry"), "DUMMY parent replacement"),
);
const replacement = join(proofRoot, "DUMMY-target-replacement");
writeFileSync(replacement, "DUMMY replacement");
jsAttempt("rename_over_target", () => renameSync(replacement, target));
const sourceReplacement = join(proofRoot, "DUMMY-source-replacement");
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
  jsAttempt("unlink_target_parent", () => rmdirSync(dirname(target)));
  jsAttempt("unlink_source_parent", () => rmdirSync(dirname(source)));
  jsAttempt("rename_target_parent", () =>
    renameSync(dirname(target), join(proofRoot, "DUMMY-renamed-target-parent")),
  );
  jsAttempt("rename_source_parent", () =>
    renameSync(dirname(source), join(proofRoot, "DUMMY-renamed-source-parent")),
  );
  jsAttempt("symlink_in_target_parent", () =>
    symlinkSync("/tmp/DUMMY-does-not-exist", join(dirname(target), "DUMMY-parent-symlink")),
  );
  jsAttempt("symlink_in_source_parent", () =>
    symlinkSync("/tmp/DUMMY-does-not-exist", join(dirname(source), "DUMMY-parent-symlink")),
  );
  jsAttempt("hardlink_into_target_parent", () =>
    linkSync(target, join(dirname(target), "DUMMY-parent-hardlink")),
  );
  jsAttempt("hardlink_into_source_parent", () =>
    linkSync(source, join(dirname(source), "DUMMY-parent-hardlink")),
  );
  const probeFd = openSync(syscallProbe, constants.O_RDONLY | constants.O_CLOEXEC);
  try {
    commandAttempt("direct_namespace_syscalls", "/proc/self/fd/3", [target], {
      stdio: ["ignore", "pipe", "pipe", probeFd],
    });
  } finally {
    closeSync(probeFd);
    closeSync(Number(syscallProbe.split("/").at(-1)));
  }
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
jsAttempt("scratch_write", () =>
  writeFileSync(join(proofRoot, "DUMMY-writable-scratch"), "DUMMY scratch"),
);
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
