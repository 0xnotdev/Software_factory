import { strict as assert } from "node:assert";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  superviseCredentialChild,
  supervisorFailureRecord,
} from "../scripts/cp06-namespace-supervisor.mjs";
import { namespaceWorkerError } from "../scripts/cp06-auth-security.mjs";
import { Cp06CleanupError, withCleanup } from "../scripts/cp06-worker-lifecycle.mjs";
import { createWorkerBlockedStatus } from "../scripts/replay-cp06-worker.mjs";

for (const scenario of [
  "success",
  "expired",
  "near-expiry",
  "setup",
  "setup-and-cleanup",
  "missing-source",
  "missing-source-and-cleanup",
  "launch",
  "timeout",
  "audit",
  "cleanup",
  "primary-and-cleanup",
  "audit-and-cleanup",
]) {
  test(`supervisor awaits cleanup and preserves failures: ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-lifecycle-"));
    const source = join(directory, "DUMMY-source");
    const target = join(directory, "DUMMY-target");
    await writeFile(source, "DUMMY ONLY");
    let cleanups = 0;
    let launches = 0;
    const setupError = new Error("DUMMY setup failed before mount acquired");
    const missingSourceError = Object.assign(new Error("DUMMY source missing"), {
      code: "ENOENT",
    });
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
            if (scenario === "setup-and-cleanup") {
              throw new AggregateError([setupError, cleanupError], "DUMMY setup cleanup");
            }
            if (scenario === "missing-source") throw missingSourceError;
            if (scenario === "missing-source-and-cleanup") {
              throw new AggregateError(
                [missingSourceError, cleanupError],
                "DUMMY missing source cleanup",
              );
            }
            await writeFile(target, "DUMMY placeholder");
            return {
              sourceIdentity: dummyIdentity(),
              mountIds: { source: "1", target: "2" },
              parentMounts: [{ id: "3", target: directory }],
              async verifyIntegrity() {
                return true;
              },
              async cleanup() {
                await new Promise((done) => setTimeout(done, 5));
                cleanups++;
                await rm(target);
                if (["cleanup", "primary-and-cleanup", "audit-and-cleanup"].includes(scenario))
                  throw cleanupError;
              },
            };
          },
          inspectSource: dummyStat,
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
              stdout: ["audit", "audit-and-cleanup"].includes(scenario)
                ? "invalid JSON"
                : '{"result":"pass"}',
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
          if (scenario === "setup-and-cleanup") {
            assert(error instanceof AggregateError);
            assert.equal(error.code, "CP06_CLEANUP_FAILED");
            assert.deepEqual(
              supervisorFailureRecord(error).causes.map(({ stage, code }) => ({ stage, code })),
              [
                { stage: "setup", code: "CP06_ISOLATION_SETUP_FAILED" },
                { stage: "cleanup", code: "CP06_CREDENTIAL_CLEANUP_FAILED" },
              ],
            );
          }
          if (scenario === "missing-source") {
            assert.equal(error.code, "CP06_CREDENTIAL_SOURCE_MISSING");
            assert.equal(error.stage, "missing-source");
            assert.equal(error.exitCode, 70);
            const wrapped = namespaceWorkerError({
              status: 70,
              stderr: JSON.stringify(supervisorFailureRecord(error)),
            });
            const blocked = createWorkerBlockedStatus(wrapped, "isolated-sdk-worker");
            assert.equal(blocked.code, "CP06_CREDENTIAL_SOURCE_MISSING");
            assert.equal(blocked.failure_stage, "missing-source");
          }
          if (scenario === "missing-source-and-cleanup") {
            const record = supervisorFailureRecord(error);
            assert.equal(record.code, "CP06_CLEANUP_FAILED");
            assert.deepEqual(
              record.causes.map(({ stage, code }) => ({ stage, code })),
              [
                { stage: "missing-source", code: "CP06_CREDENTIAL_SOURCE_MISSING" },
                { stage: "cleanup", code: "CP06_CREDENTIAL_CLEANUP_FAILED" },
              ],
            );
          }
          if (["expired", "near-expiry"].includes(scenario)) {
            assert.equal(error.exitCode, 75);
            assert.equal(error.code, "CP06_AUTH_BLOCKED");
          }
          if (scenario === "timeout") assert.equal(error.cause.code, "ETIMEDOUT");
          if (["cleanup", "primary-and-cleanup", "audit-and-cleanup"].includes(scenario)) {
            assert(error instanceof Cp06CleanupError);
            assert.equal(error.exitCode, 74);
            assert.equal(error.errors.at(-1), cleanupError);
            assert.equal(error.errors.length, scenario === "cleanup" ? 1 : 2);
            if (scenario === "primary-and-cleanup") {
              assert.equal(error.errors[0].exitCode, 75);
              assert.equal(error.errors[0].code, "CP06_AUTH_BLOCKED");
              assert.equal(error.cause, error.errors[0]);
            }
            if (scenario === "audit-and-cleanup") {
              assert.equal(error.errors[0].exitCode, 70);
              assert.equal(error.errors[0].code, "CP06_CHILD_OUTPUT_INVALID");
              assert.equal(error.cause, error.errors[0]);
            }
          }
          return true;
        });
      }
      const failedBeforeLaunch = [
        "setup",
        "setup-and-cleanup",
        "missing-source",
        "missing-source-and-cleanup",
      ].includes(scenario);
      assert.equal(cleanups, failedBeforeLaunch ? 0 : 1);
      assert.equal(launches, failedBeforeLaunch ? 0 : 1);
      await assert.rejects(stat(target), { code: "ENOENT" });
      assert.equal(await readFile(source, "utf8"), "DUMMY ONLY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("worker source integrity uses metadata without reading credential bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-metadata-"));
  const source = join(directory, "DUMMY-unreadable-source");
  await mkdir(source);
  const stat = await lstat(source, { bigint: true });
  const sourceIdentity = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    nlink: String(stat.nlink),
    mode: String(stat.mode),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
  };
  try {
    const result = await superviseCredentialChild(
      {
        mode: "worker",
        source,
        target: join(directory, "DUMMY-target"),
        helper: "/DUMMY-helper",
        syscallProbe: "/DUMMY-probe",
      },
      {
        async mount() {
          return {
            sourceIdentity,
            mountIds: { source: "1", target: "2" },
            parentMounts: [{ id: "3", target: directory }],
            async verifyIntegrity() {
              const current = await lstat(source, { bigint: true });
              return String(current.ino) === sourceIdentity.ino;
            },
            cleanup() {},
          };
        },
        spawn() {
          return { status: 0, stdout: '{"result":"pass"}' };
        },
      },
    );
    assert.equal(result.source_unchanged, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audit and cleanup causes survive supervisor output and replay blocked recording", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-output-chain-"));
  const source = join(directory, "DUMMY-source");
  const cleanupError = new Error("DUMMY independent cleanup failure");
  await writeFile(source, "DUMMY ONLY");
  let cleanups = 0;
  let caught;
  try {
    await superviseCredentialChild(
      {
        mode: "worker",
        source,
        target: join(directory, "DUMMY-target"),
        helper: "/DUMMY-helper",
        syscallProbe: "/DUMMY-probe",
      },
      {
        async mount() {
          return {
            sourceIdentity: dummyIdentity(),
            mountIds: { source: "1", target: "2" },
            parentMounts: [{ id: "3", target: directory }],
            async verifyIntegrity() {
              return true;
            },
            async cleanup() {
              await new Promise((done) => setTimeout(done, 5));
              cleanups++;
              throw cleanupError;
            },
          };
        },
        inspectSource: dummyStat,
        spawn() {
          return {
            status: 0,
            stdout: "DUMMY malformed child output",
            stderr: "DUMMY-SECRET-MUST-NOT-SURVIVE",
          };
        },
      },
    );
  } catch (error) {
    caught = error;
  }
  try {
    assert(caught instanceof Cp06CleanupError);
    assert.equal(cleanups, 1);
    assert.equal(caught.errors.length, 2);
    assert.equal(caught.errors[0].exitCode, 70);
    assert.equal(caught.errors[1], cleanupError);

    const supervisorRecord = supervisorFailureRecord(caught);
    assert.equal(supervisorRecord.code, "CP06_CLEANUP_FAILED");
    assert.equal(supervisorRecord.exit_code, 74);
    assert.deepEqual(supervisorRecord.causes, [
      {
        stage: "audit",
        code: "CP06_CHILD_OUTPUT_INVALID",
        exit_code: 70,
        description: "isolated child output was invalid",
      },
      {
        stage: "cleanup",
        code: "CP06_CREDENTIAL_CLEANUP_FAILED",
        exit_code: null,
        description: "credential mount cleanup failed",
      },
    ]);
    assert.equal(JSON.stringify(supervisorRecord).includes("DUMMY-SECRET"), false);
    assert.equal(JSON.stringify(supervisorRecord).includes("independent cleanup"), false);

    const workerError = namespaceWorkerError({
      status: 74,
      stderr: JSON.stringify(supervisorRecord),
    });
    const blocked = createWorkerBlockedStatus(
      workerError,
      "isolated-sdk-worker",
      "2026-10-01T00:00:00.000Z",
    );
    assert.equal(blocked.cleanup_failed, true);
    assert.equal(blocked.code, "CP06_CLEANUP_FAILED");
    assert.deepEqual(blocked.worker_failure, supervisorRecord);
    assert.equal(blocked.failure_stage, "cleanup");
    assert.equal(JSON.stringify(blocked).includes("DUMMY-SECRET"), false);

    const forged = namespaceWorkerError({
      status: 70,
      stderr: JSON.stringify({ ...supervisorRecord, exit_code: 70, raw: "DUMMY-SECRET" }),
    });
    assert.equal(forged.workerFailure, undefined);
    assert.equal(
      JSON.stringify(createWorkerBlockedStatus(forged, "isolated-sdk-worker")).includes(
        "DUMMY-SECRET",
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function dummyStat() {
  return {
    dev: 1n,
    ino: 2n,
    size: 10n,
    nlink: 1n,
    mode: 0o100600n,
    mtimeNs: 3n,
    ctimeNs: 4n,
  };
}

function dummyIdentity() {
  const stat = dummyStat();
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    nlink: String(stat.nlink),
    mode: String(stat.mode),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
  };
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
