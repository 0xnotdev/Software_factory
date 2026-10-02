import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runDummySdkProof, runIsolationProbe } from "../scripts/cp06-auth-security.mjs";
import { openAnchoredDirectory, openProbeOutput } from "../scripts/cp06-probe-fixture.mjs";

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
        if (result.stderr === JSON.stringify(structured)) {
          assert.deepEqual(error.workerFailure, structured);
        } else if (result.error?.code === "ETIMEDOUT") {
          assert.equal(error.workerFailure.code, "CP06_CHILD_TIMEOUT");
          assert.equal(error.workerFailure.stage, "timeout");
        } else assert.equal(error.workerFailure, undefined);
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

test("DUMMY SDK proof consumer rejects incomplete and extra payloads", () => {
  const validBase = {
    schema_version: 1,
    result: "pass",
    auth_cases: [
      authCase("expired", "blocked", 0),
      authCase("near_expiry", "blocked", 0),
      authCase("unexpired", "resolved", 1),
    ],
    sdk_worker: {
      active_tools: ["read"],
      in_memory_session: true,
      event_count: 2,
      event_sha256: "0".repeat(64),
      read_audit: { exact_original: true, read_count: 1 },
      refresh_callbacks: 0,
      credential_store: credentialAudit(),
    },
    sdk_dependency: { version: "0.85.1", package_sha256: "1".repeat(64) },
    actual_sdk_outcomes: {
      fixture_origin: true,
      semantic_acceptance: false,
      cases: [
        outcome("valid", 0),
        outcome("fenced-valid", 0),
        outcome("extra-before-fence", 75),
        outcome("empty-gap", 75),
        outcome("missing-gap", 75),
        outcome("contradictory-gap", 75),
        outcome("extra-evidence", 75),
        outcome("constraint-pass", 75),
        outcome("missing-reads", 75),
        outcome("credential-read", 75),
        outcome("symlink-read", 75),
        outcome("expired", 75, { runtime_create: 0 }),
        outcome("near-expiry", 75, { runtime_create: 0 }),
        outcome("timeout", 70),
      ],
    },
    fixture_origin: true,
    semantic_acceptance: false,
    network_calls: 0,
  };
  for (const payload of [
    { ...validBase, auth_cases: [] },
    { ...validBase, auth_cases: [...validBase.auth_cases, authCase("expired", "blocked", 0)] },
    { ...validBase, extra: "DUMMY-SECRET" },
    { ...validBase, sdk_worker: { ...validBase.sdk_worker, active_tools: ["read", "write"] } },
  ]) {
    assert.throws(
      () =>
        runDummySdkProof({
          root: process.cwd(),
          helper: "/DUMMY-helper",
          piRoot: "/DUMMY-pi",
          spawnSyncImpl() {
            return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
          },
        }),
      (error) => !String(error.message).includes("DUMMY-SECRET"),
    );
  }
  const accepted = runDummySdkProof({
    root: process.cwd(),
    helper: "/DUMMY-helper",
    piRoot: "/DUMMY-pi",
    spawnSyncImpl() {
      return { status: 0, stdout: JSON.stringify(validBase), stderr: "" };
    },
  });
  assert.equal(accepted.result, "pass");
});

test("anchored runner child directories do not follow substituted paths", async () => {
  const root = process.cwd();
  const outputRoot = resolve(".factory/state/cp06-correction/DUMMY-child-anchor");
  const external = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-child-external-"));
  const output = openProbeOutput({ root, outputRoot, create: true, runner: true });
  const child = openAnchoredDirectory(output.anchor, "worker", { reset: true });
  try {
    await rename(join(outputRoot, "worker"), join(outputRoot, "worker-original"));
    await symlink(external, join(outputRoot, "worker"));
    await writeFile(join(child.anchor, "input.json"), "DUMMY anchored write");
    assert.deepEqual(await readdir(external), []);
    assert.equal(
      await readFile(join(outputRoot, "worker-original", "input.json"), "utf8"),
      "DUMMY anchored write",
    );
  } finally {
    child.close();
    output.close();
    await rm(outputRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

function authCase(scenario, result, toAuth) {
  return {
    scenario,
    result,
    refresh_callbacks: 0,
    to_auth_calls: toAuth,
    credential_store: credentialAudit(),
    persistence_operations: 0,
    source_unchanged: true,
  };
}

function credentialAudit() {
  return { reads: 1, lists: 0, modify_denials: 1, delete_denials: 1 };
}

function outcome(scenario, exitCode, extra = {}) {
  return {
    scenario,
    exit_code: exitCode,
    expected_exit_code: exitCode,
    default_storage: 0,
    network: 0,
    refresh: 0,
    source_unchanged: true,
    ...extra,
  };
}
