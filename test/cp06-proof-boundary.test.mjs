import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runDummySdkProof, runIsolationProbe } from "../scripts/cp06-auth-security.mjs";

const runners = [
  "scripts/replay-cp06-worker.mjs",
  "scripts/replay-cp06-ten-pack.mjs",
  "scripts/replay-cp06-p07.mjs",
];

test("all proof runners reject external and symlinked output before removing artifacts", async () => {
  const external = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-external-output-"));
  const base = resolve(".factory/state/cp06-correction");
  const alias = join(base, "DUMMY-output-alias");
  await mkdir(base, { recursive: true });
  for (const name of ["worker", "ten-pack", "p07"]) {
    await mkdir(join(external, name));
    await writeFile(join(external, name, "DUMMY-sentinel"), "DUMMY-SECRET-UNCHANGED");
  }
  await symlink(external, alias);
  try {
    for (const runner of runners) {
      for (const output of [external, alias]) {
        const result = spawnSync(process.execPath, [resolve(runner)], {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, CP06_OUTPUT: output },
        });
        assert.notEqual(result.status, 0, `${runner} accepted ${output}`);
        assert.equal(result.stdout.includes("DUMMY-SECRET-UNCHANGED"), false);
        assert.equal(result.stderr.includes("DUMMY-SECRET-UNCHANGED"), false);
        for (const name of ["worker", "ten-pack", "p07"]) {
          assert.deepEqual(await readdir(join(external, name)), ["DUMMY-sentinel"]);
          assert.equal(
            await readFile(join(external, name, "DUMMY-sentinel"), "utf8"),
            "DUMMY-SECRET-UNCHANGED",
          );
        }
      }
    }
  } finally {
    await rm(alias);
    await rm(external, { recursive: true, force: true });
  }
});

test("failed DUMMY probes never forward child output or spawn exceptions", async () => {
  const secret = "DUMMY-SECRET-STDOUT-STDERR";
  const structured = {
    schema_version: 1,
    stage: "audit",
    code: "CP06_CHILD_OUTPUT_INVALID",
    exit_code: 70,
    description: "isolated child output was invalid",
    causes: [],
  };
  for (const result of [
    { status: 70, stderr: `${JSON.stringify(structured)}\n${secret}`, stdout: secret },
    { status: 70, stderr: JSON.stringify(structured), stdout: secret },
    {
      status: null,
      error: Object.assign(new Error(secret), { code: "ETIMEDOUT" }),
      stderr: secret,
    },
  ]) {
    await assert.rejects(
      runIsolationProbe({
        root: process.cwd(),
        outputRoot: resolve(".factory/state/cp06-correction/auth-security"),
        mode: "unsafe-probe",
        binaries: { helper: "/DUMMY-helper", syscallProbe: "/DUMMY-probe" },
        runNamespaceImpl() {
          return result;
        },
      }),
      (error) => {
        assert.equal(error.code, "CP06_ISOLATION_UNSUPPORTED");
        assert.equal(
          JSON.stringify({ message: error.message, workerFailure: error.workerFailure }).includes(
            secret,
          ),
          false,
        );
        if (result.stderr === JSON.stringify(structured))
          assert.deepEqual(error.workerFailure, structured);
        else assert.equal(error.workerFailure, undefined);
        return true;
      },
    );
  }
  for (const result of [
    { status: 1, stdout: secret, stderr: secret },
    {
      status: null,
      error: Object.assign(new Error(secret), { code: "ETIMEDOUT" }),
      stderr: secret,
    },
  ]) {
    assert.throws(
      () =>
        runDummySdkProof({
          root: process.cwd(),
          helper: "/DUMMY-helper",
          piRoot: "/DUMMY-pi",
          spawnSyncImpl() {
            return result;
          },
        }),
      (error) => error.code === "CP06_ISOLATION_UNSUPPORTED" && !error.message.includes(secret),
    );
  }
});
