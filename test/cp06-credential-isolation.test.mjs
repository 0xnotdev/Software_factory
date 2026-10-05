import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertDestructiveCredentialWritesDenied,
  mountLiveCredentialReadOnly,
} from "../scripts/cp06-credential-isolation.mjs";
import { withCompiledHelper } from "./fixtures/cp06-compiled-helper.mjs";

function runMountScenario(helperFd, scenario) {
  const result = spawnSync(
    "unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "--propagation",
      "private",
      "--",
      process.execPath,
      resolve("test/fixtures/cp06-credential-mount.mjs"),
      scenario,
    ],
    { encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe", helperFd] },
  );
  assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("descriptor-bound credential mount exposes one read-only inode at both paths", async () => {
  await withCompiledHelper("mount-control", async ({ helperFd }) => {
    assert.deepEqual(runMountScenario(helperFd, "control"), {
      scenario: "control",
      mounted: true,
      target_bytes: '{"fixture":"DUMMY","token":"DUMMY-NOT-REAL"}',
      target_write: "EROFS",
      parent_write: "EROFS",
      integrity: true,
      cleanup: "pass",
      target_after_cleanup: "",
      marker_unchanged: true,
      source_unchanged: true,
      remaining_mounts: 0,
    });
  });
});

test("leaf or parent substitution between preparation and mount is refused", async () => {
  await withCompiledHelper("mount-substitution", async ({ helperFd }) => {
    for (const [scenario, error] of [
      ["target-leaf-symlink", "CP-06 mount destination identity changed"],
      ["target-leaf-replaced", "CP-06 mount destination identity changed"],
      ["source-leaf-symlink", "CP-06 mount destination identity changed"],
      ["target-parent-replaced", "CP-06 mount destination path identity changed"],
      ["source-parent-replaced", "CP-06 mount destination path identity changed"],
    ]) {
      assert.deepEqual(runMountScenario(helperFd, scenario), {
        scenario,
        mounted: false,
        error: `read-only credential isolation unavailable: ${error}\n`,
        marker_unchanged: true,
        source_unchanged: true,
        remaining_mounts: 0,
      });
    }
  });
});

test("mount setup failure reports cleanup failure instead of discarding it", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-cp06-cleanup-test-"));
  const source = join(root, "auth-source.json");
  const target = join(root, "agent", "auth.json");
  await writeFile(source, "DUMMY");
  let mountCalls = 0;
  const spawnSyncImpl = (command) => {
    if (command === "/DUMMY-helper" && ++mountCalls === 2) {
      return { status: 65, stdout: "", stderr: "DUMMY bind failure" };
    }
    if (command === "umount") {
      return { status: 32, stdout: "", stderr: "DUMMY cleanup failure" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    await assert.rejects(
      mountLiveCredentialReadOnly({
        root,
        source,
        target,
        mountHelper: "/DUMMY-helper",
        spawnSyncImpl,
      }),
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
