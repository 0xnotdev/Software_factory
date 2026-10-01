import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { superviseCredentialChild } from "../scripts/cp06-namespace-supervisor.mjs";
import { Cp06CleanupError, withCleanup } from "../scripts/cp06-worker-lifecycle.mjs";

for (const scenario of [
  "success",
  "expired",
  "near-expiry",
  "setup",
  "launch",
  "timeout",
  "audit",
  "cleanup",
  "primary-and-cleanup",
]) {
  test(`supervisor awaits cleanup and preserves failures: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-lifecycle-"));
    const source = join(directory, "DUMMY-source");
    const target = join(directory, "DUMMY-target");
    await writeFile(source, "DUMMY ONLY");
    let cleanups = 0;
    let launches = 0;
    const setupError = new Error("DUMMY setup failed before mount acquired");
    const cleanupError = new Error("DUMMY cleanup failed");
    const run = () =>
      superviseCredentialChild(
        {
          mode: "worker",
          source,
          target,
          helper: "/DUMMY-helper",
          syscallProbe: "/DUMMY-probe",
          childArgs: ["/DUMMY-input"],
        },
        {
          async mount() {
            if (scenario === "setup") throw setupError;
            await writeFile(target, "DUMMY placeholder");
            return {
              mountIds: { source: "1", target: "2" },
              async cleanup() {
                await new Promise((done) => setTimeout(done, 5));
                cleanups++;
                await rm(target);
                if (["cleanup", "primary-and-cleanup"].includes(scenario)) throw cleanupError;
              },
            };
          },
          spawn() {
            launches++;
            if (scenario === "launch") throw new Error("DUMMY spawn threw");
            if (scenario === "timeout")
              return {
                status: null,
                error: Object.assign(new Error("DUMMY timeout"), { code: "ETIMEDOUT" }),
              };
            if (["expired", "near-expiry", "primary-and-cleanup"].includes(scenario))
              return { status: 75, stderr: "DUMMY auth blocked" };
            return {
              status: 0,
              stdout: scenario === "audit" ? "invalid JSON" : '{"result":"pass"}',
            };
          },
        },
      );
    try {
      if (scenario === "success") {
        const result = await run();
        assert.equal(result.cleanup, "pass");
        assert.equal(result.source_unchanged, true);
      } else {
        await assert.rejects(run, (error) => {
          if (scenario === "setup") assert.equal(error.cause, setupError);
          if (["expired", "near-expiry"].includes(scenario)) assert.equal(error.exitCode, 75);
          if (scenario === "timeout") assert.equal(error.cause.code, "ETIMEDOUT");
          if (["cleanup", "primary-and-cleanup"].includes(scenario)) {
            assert(error instanceof Cp06CleanupError);
            assert.equal(error.exitCode, 74);
            assert.equal(error.errors.at(-1), cleanupError);
            if (scenario === "primary-and-cleanup") {
              assert.equal(error.errors[0].exitCode, 75);
              assert.match(error.errors[0].message, /DUMMY auth blocked/);
              assert.equal(error.cause, error.errors[0]);
            }
          }
          return true;
        });
      }
      assert.equal(cleanups, scenario === "setup" ? 0 : 1);
      assert.equal(launches, scenario === "setup" ? 0 : 1);
      await assert.rejects(stat(target), { code: "ENOENT" });
      assert.equal(await readFile(source, "utf8"), "DUMMY ONLY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("evaluation-home cleanup finishes before the blocked result is returned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-home-"));
  const primary = Object.assign(new Error("DUMMY blocked"), { exitCode: 75 });
  await assert.rejects(
    withCleanup(
      async () => {
        throw primary;
      },
      () => rm(directory, { recursive: true }),
    ),
    (error) => error === primary,
  );
  await assert.rejects(stat(directory), { code: "ENOENT" });
});
