import { strict as assert } from "node:assert";
import { closeSync, constants, openSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertDestructiveCredentialWritesDenied,
  mountLiveCredentialReadOnly,
} from "../scripts/cp06-credential-isolation.mjs";

test("live credential mount pins one inode behind distinct read-only regular mounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-cp06-live-mount-test-"));
  const source = join(root, "auth-source.json");
  const target = join(root, "agent", "auth.json");
  const sourceBytes = '{"live":true}\n';
  await writeFile(source, sourceBytes);
  const sourceStat = await lstat(source, { bigint: true });
  const calls = [];
  let mountId = 40;
  const mountIds = new Map();
  const spawnSyncImpl = (command, args) => {
    calls.push([command, ...args]);
    if (command === "findmnt") {
      const path = args.at(-1);
      if (!mountIds.has(path)) mountIds.set(path, ++mountId);
      return {
        status: 0,
        stdout: JSON.stringify({
          filesystems: [
            {
              id: mountIds.get(path),
              target: path,
              "vfs-options": "ro,nosuid,nodev,noexec,relatime",
            },
          ],
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const lstatImpl = async (path, options) =>
    String(path).endsWith("/auth.json") ? sourceStat : lstat(path, options);
  try {
    const mount = await mountLiveCredentialReadOnly({
      root,
      source,
      target,
      spawnSyncImpl,
      lstatImpl,
    });
    try {
      assert.equal(await readFile(source, "utf8"), sourceBytes);
      assert.notEqual(mount.mountIds.source, mount.mountIds.target);
      const mountCallsOnly = calls.filter(([command]) => command === "mount");
      assert.match(mountCallsOnly[0][2], new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
      assert.equal(mountCallsOnly[0][2], mountCallsOnly[0][3]);
      assert.deepEqual(mountCallsOnly[1].slice(0, 3), [
        "mount",
        "-o",
        "remount,bind,ro,nosuid,nodev,noexec",
      ]);
      assert.match(mountCallsOnly[2][2], new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
      assert.equal(mountCallsOnly[2][2], mountCallsOnly[2][3]);
      assert.deepEqual(mountCallsOnly[3].slice(0, 3), [
        "mount",
        "-o",
        "remount,bind,ro,nosuid,nodev,noexec",
      ]);
      assert.equal(mount.parentMounts.length, 2);
      assert.equal(await mount.verifyIntegrity(), true);
      assert.match(mountCallsOnly[4][2], new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
      assert.match(
        mountCallsOnly[4][3],
        new RegExp(`^/proc/${process.pid}/fd/\\d+/auth-source\\.json$`),
      );
      assert.deepEqual(mountCallsOnly[5].slice(0, 3), [
        "mount",
        "-o",
        "remount,bind,ro,nosuid,nodev,noexec",
      ]);
      assert.match(
        mountCallsOnly[5][3],
        new RegExp(`^/proc/${process.pid}/fd/\\d+/auth-source\\.json$`),
      );
      assert.match(mountCallsOnly[6][2], new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
      assert.match(mountCallsOnly[6][3], new RegExp(`^/proc/${process.pid}/fd/\\d+/auth\\.json$`));
      assert.deepEqual(mountCallsOnly[7].slice(0, 3), [
        "mount",
        "-o",
        "remount,bind,ro,nosuid,nodev,noexec",
      ]);
      assert.match(mountCallsOnly[7][3], new RegExp(`^/proc/${process.pid}/fd/\\d+/auth\\.json$`));
    } finally {
      await mount.cleanup();
    }
    for (const [command, path] of calls.slice(-4)) {
      assert.equal(command, "umount");
      assert.match(path, new RegExp(`^/proc/${process.pid}/fd/\\d+`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credential mount consumes retained parent descriptors after path substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-cp06-retained-mount-test-"));
  const sourceDir = join(root, "source");
  const targetDir = join(root, "agent");
  const maliciousDir = join(root, "malicious");
  await mkdir(sourceDir);
  await mkdir(targetDir);
  await mkdir(maliciousDir);
  const source = join(sourceDir, "auth.json");
  const target = join(targetDir, "auth.json");
  await writeFile(source, "DUMMY original");
  await writeFile(join(maliciousDir, "auth.json"), "DUMMY malicious");
  const sourceFd = openSync(
    sourceDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const targetFd = openSync(
    targetDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const sourceAnchor = `/proc/${process.pid}/fd/${sourceFd}`;
  const targetAnchor = `/proc/${process.pid}/fd/${targetFd}`;
  const sourceStat = await lstat(source, { bigint: true });
  const calls = [];
  let mountId = 90;
  const mountIds = new Map();
  const spawnSyncImpl = (command, args) => {
    calls.push([command, ...args]);
    if (command === "findmnt") {
      const path = args.at(-1);
      if (!mountIds.has(path)) mountIds.set(path, ++mountId);
      return {
        status: 0,
        stdout: JSON.stringify({
          filesystems: [
            { id: mountIds.get(path), target: path, "vfs-options": "ro,nosuid,nodev,noexec" },
          ],
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const lstatImpl = async (path, options) =>
    String(path).endsWith("/auth.json") ? sourceStat : lstat(path, options);
  try {
    await rename(sourceDir, join(root, "source-moved"));
    await symlink(maliciousDir, sourceDir);
    const mount = await mountLiveCredentialReadOnly({
      root,
      source,
      target,
      sourceParentAnchor: sourceAnchor,
      targetParentAnchor: targetAnchor,
      sourceLeaf: "auth.json",
      targetLeaf: "auth.json",
      spawnSyncImpl,
      lstatImpl,
    });
    try {
      const mountCallsOnly = calls.filter(([command]) => command === "mount");
      assert.match(
        mountCallsOnly[4][3],
        new RegExp(`^/proc/${process.pid}/fd/${sourceFd}/auth\\.json$`),
      );
      assert.match(
        mountCallsOnly[6][3],
        new RegExp(`^/proc/${process.pid}/fd/${targetFd}/auth\\.json$`),
      );
      assert.equal(await readFile(join(maliciousDir, "auth.json"), "utf8"), "DUMMY malicious");
    } finally {
      await mount.cleanup();
    }
  } finally {
    closeSync(sourceFd);
    closeSync(targetFd);
    await rm(root, { recursive: true, force: true });
  }
});

test("mount setup failure reports cleanup failure instead of discarding it", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-cp06-cleanup-test-"));
  const source = join(root, "auth-source.json");
  const target = join(root, "agent", "auth.json");
  await writeFile(source, "DUMMY");
  let mountCalls = 0;
  const spawnSyncImpl = (command) => {
    if (command === "mount" && ++mountCalls === 2) {
      return { status: 32, stdout: "", stderr: "DUMMY remount failure" };
    }
    if (command === "umount") {
      return { status: 32, stdout: "", stderr: "DUMMY cleanup failure" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    await assert.rejects(
      mountLiveCredentialReadOnly({ root, source, target, spawnSyncImpl }),
      AggregateError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported isolation fails before credential access or provider work", async () => {
  const { verifyIsolationPrerequisites, Cp06IsolationUnsupportedError } =
    await import("../scripts/cp06-auth-security.mjs");
  let invocations = 0;
  assert.throws(
    () =>
      verifyIsolationPrerequisites({
        root: process.cwd(),
        spawnSyncImpl(command) {
          invocations += 1;
          return {
            status: command === "unshare" ? 1 : 0,
            stdout: "",
            stderr: "DUMMY namespaces unavailable",
          };
        },
      }),
    Cp06IsolationUnsupportedError,
  );
  assert.equal(invocations, 1);
});

test("destructive DUMMY proof requires denied write unlink rename symlink and hardlink", async () => {
  const calls = [];
  const protectedPaths = new Set(["/dummy/source-auth.json", "/dummy/target-auth.json"]);
  await assertDestructiveCredentialWritesDenied([...protectedPaths], {
    async writeFile(path) {
      calls.push(["write", path]);
      if (protectedPaths.has(path)) throw new Error("EROFS");
    },
    async rename(from, to) {
      calls.push(["rename", from, to]);
      if (protectedPaths.has(to)) throw new Error("EBUSY");
    },
    async unlink(path) {
      calls.push(["unlink", path]);
      if (protectedPaths.has(path)) throw new Error("EBUSY");
    },
    async symlink(from, to) {
      calls.push(["symlink", from, to]);
    },
    async link(from, to) {
      calls.push(["link", from, to]);
      throw new Error("EXDEV");
    },
    async rm(path) {
      calls.push(["rm", path]);
    },
  });
  assert.equal(calls.filter(([operation]) => operation === "rename").length, 2);
  assert.equal(calls.filter(([operation]) => operation === "unlink").length, 4);
  assert.equal(calls.filter(([operation]) => operation === "link").length, 2);
  assert.equal(calls.filter(([operation]) => operation === "symlink").length, 0);
});
