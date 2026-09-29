import { strict as assert } from "node:assert";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertDestructiveCredentialWritesDenied,
  mountLiveCredentialReadOnly,
} from "../scripts/cp06-credential-isolation.mjs";

test("live credential mount uses a regular target without source writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-cp06-live-mount-test-"));
  const source = join(root, "auth-source.json");
  const target = join(root, "agent", "auth.json");
  const sourceBytes = '{"live":true}\n';
  await writeFile(source, sourceBytes);
  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push([command, ...args]);
    if (command === "findmnt") return { status: 0, stdout: "ro,nosuid,nodev\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    const mount = await mountLiveCredentialReadOnly({ root, source, target, spawnSyncImpl });
    try {
      assert.equal(await readFile(source, "utf8"), sourceBytes);
      assert.equal((await lstat(target)).isFile(), true);
      assert.equal((await lstat(target)).isSymbolicLink(), false);
      assert.deepEqual(calls.slice(0, 4), [
        ["mount", "--bind", source, source],
        ["mount", "-o", "remount,bind,ro", source],
        ["mount", "--bind", source, target],
        ["mount", "-o", "remount,bind,ro", target],
      ]);
    } finally {
      mount.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("destructive dummy proof requires denied atomic replacement", async () => {
  const calls = [];
  const protectedPaths = new Set(["/dummy/source-auth.json", "/dummy/target-auth.json"]);
  await assertDestructiveCredentialWritesDenied([...protectedPaths], {
    async writeFile(path) {
      calls.push(["write", path]);
      if (protectedPaths.has(path)) throw new Error("EROFS");
    },
    async rename(from, to) {
      calls.push(["rename", from, to]);
      if (protectedPaths.has(to)) throw new Error("EROFS");
    },
    async rm(path) {
      calls.push(["rm", path]);
    },
  });
  assert.equal(calls.filter(([operation]) => operation === "rename").length, 2);
});
