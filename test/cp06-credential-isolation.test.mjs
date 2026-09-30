import { strict as assert } from "node:assert";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const spawnSyncImpl = (command, args) => {
    calls.push([command, ...args]);
    if (command === "findmnt") {
      const path = args.at(-1);
      return {
        status: 0,
        stdout: JSON.stringify({
          filesystems: [
            {
              id: ++mountId,
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
  const lstatImpl = async (path, options) => (path === target ? sourceStat : lstat(path, options));
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
      assert.match(calls[0][2], new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
      assert.deepEqual(calls[0].slice(0, 2), ["mount", "--bind"]);
      assert.equal(calls[0][3], source);
      assert.deepEqual(calls[1], ["mount", "-o", "remount,bind,ro,nosuid,nodev,noexec", source]);
      assert.match(calls[2][2], new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
      assert.equal(calls[2][3], target);
      assert.deepEqual(calls[3], ["mount", "-o", "remount,bind,ro,nosuid,nodev,noexec", target]);
    } finally {
      mount.cleanup();
    }
    assert.deepEqual(calls.slice(-2), [
      ["umount", target],
      ["umount", source],
    ]);
  } finally {
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
