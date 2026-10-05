import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import {
  compileIsolationHelpers,
  runDummySdkProof,
  runIsolationProbe,
} from "../scripts/cp06-auth-security.mjs";
import {
  openAnchoredDirectory,
  openProbeOutput,
  removeAnchoredEntry,
  writeAnchoredFile,
} from "../scripts/cp06-probe-fixture.mjs";

const runners = [
  "scripts/replay-cp06-worker.mjs",
  "scripts/replay-cp06-ten-pack.mjs",
  "scripts/replay-cp06-p07.mjs",
  "scripts/prove-cp06-worker-cleanup.mjs",
];

test("all proof runners reject external and symlinked output before removing artifacts", async () => {
  const external = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-external-output-"));
  const base = resolve(".factory/state/cp06-correction");
  const alias = join(base, "DUMMY-output-alias");
  await mkdir(base, { recursive: true });
  for (const name of ["worker", "ten-pack", "p07", "worker-cleanup"]) {
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
        for (const name of ["worker", "ten-pack", "p07", "worker-cleanup"]) {
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
  const trustedDependency = sdkDependency();
  const validBase = {
    schema_version: 1,
    result: "pass",
    auth_cases: [
      authCase("expired", "blocked", 0, 1),
      authCase("near_expiry", "blocked", 0, 1),
      authCase("unexpired", "resolved", 1, 0),
    ],
    sdk_worker: {
      active_tools: ["read"],
      in_memory_session: true,
      event_count: 2,
      event_sha256: "0".repeat(64),
      read_audit: readAudit("DUMMY-read", "@ROOT@/DUMMY-worker/DUMMY-original.md"),
      refresh_callbacks: 0,
      credential_store: { reads: 203, lists: 1, modify_denials: 0, delete_denials: 0 },
    },
    sdk_dependency: trustedDependency,
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
        outcome("earlier-assistant-claim", 75),
        outcome("final-extra-channel", 75, { to_auth: 4 }),
        outcome("unexpected-tool-secret", 75),
        outcome("expired", 75),
        outcome("near-expiry", 75),
        outcome("timeout", 70, { to_auth: 2 }),
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
    { ...validBase, sdk_dependency: { ...validBase.sdk_dependency, version: "0.99.2" } },
    {
      ...validBase,
      sdk_dependency: {
        ...validBase.sdk_dependency,
        root: resolve(".factory/state/cp06-sdk/node_modules/@earendil-works/pi-ai-forged"),
      },
    },
    {
      ...validBase,
      sdk_dependency: {
        ...validBase.sdk_dependency,
        entry: resolve(".factory/state/cp06-sdk/node_modules/@earendil-works/pi-ai/dist/forged.js"),
      },
    },
    {
      ...validBase,
      sdk_dependency: { ...validBase.sdk_dependency, manifest_sha256: "4".repeat(64) },
    },
    {
      ...validBase,
      actual_sdk_outcomes: {
        ...validBase.actual_sdk_outcomes,
        cases: [{ ...validBase.actual_sdk_outcomes.cases[0], forged: "DUMMY-SECRET" }],
      },
    },
    { ...validBase, sdk_worker: { ...validBase.sdk_worker, active_tools: ["read", "write"] } },
    {
      ...validBase,
      sdk_worker: {
        ...validBase.sdk_worker,
        read_audit: { ...validBase.sdk_worker.read_audit, extra: "DUMMY-SECRET" },
      },
    },
    {
      ...validBase,
      sdk_worker: { ...validBase.sdk_worker, read_audit: { exact_original: true, read_count: 1 } },
    },
    {
      ...validBase,
      sdk_worker: {
        ...validBase.sdk_worker,
        read_audit: readAudit("DUMMY-read", "/etc/DUMMY-worker/DUMMY-original.md"),
      },
    },
    {
      ...validBase,
      sdk_worker: {
        ...validBase.sdk_worker,
        read_audit: { ...validBase.sdk_worker.read_audit, other_tool_calls: ["DUMMY-SECRET"] },
      },
    },
    {
      ...validBase,
      sdk_worker: {
        ...validBase.sdk_worker,
        credential_store: { ...validBase.sdk_worker.credential_store, modify_denials: 7 },
      },
    },
    {
      ...validBase,
      auth_cases: [
        authCase("expired", "blocked", 0, 0),
        validBase.auth_cases[1],
        validBase.auth_cases[2],
      ],
    },
    {
      ...validBase,
      auth_cases: [
        validBase.auth_cases[0],
        authCase("near_expiry", "blocked", 0, 9),
        validBase.auth_cases[2],
      ],
    },
    ...[
      ["valid", { to_auth: 0 }],
      ["missing-reads", { runtime_create: 0, to_auth: 0 }],
      ["credential-read", { to_auth: 17 }],
      ["expired", { runtime_create: 1 }],
      [
        "valid",
        {
          read_audit: {
            ...readAudit("DUMMY-actual-worker-read", "@ROOT@/DUMMY-outcome/docs/AUTH.md"),
            extra: "DUMMY-SECRET",
          },
        },
      ],
      [
        "valid",
        {
          read_audit: readAudit(
            "DUMMY-actual-worker-read",
            "/home/DUMMY/.pi/agent/DUMMY-outcome/docs/AUTH.md",
          ),
        },
      ],
      [
        "fenced-valid",
        {
          read_audit: {
            ...readAudit("DUMMY-actual-worker-read", "@ROOT@/DUMMY-outcome/docs/AUTH.md"),
            returned_sha256: "9".repeat(64),
          },
        },
      ],
    ].map(([scenario, changes]) => ({
      ...validBase,
      actual_sdk_outcomes: {
        ...validBase.actual_sdk_outcomes,
        cases: validBase.actual_sdk_outcomes.cases.map((entry) =>
          entry.scenario === scenario ? { ...entry, ...changes } : entry,
        ),
      },
    })),
  ]) {
    assert.throws(
      () =>
        runDummySdkProof({
          root: process.cwd(),
          helper: "/DUMMY-helper",
          piRoot: "/DUMMY-pi",
          spawnSyncImpl: stubbedSdkProof(payload),
          expectedSdkDependency: trustedDependency,
        }),
      (error) => !String(error.message).includes("DUMMY-SECRET"),
    );
  }
  const accepted = runDummySdkProof({
    root: process.cwd(),
    helper: "/DUMMY-helper",
    piRoot: "/DUMMY-pi",
    spawnSyncImpl: stubbedSdkProof(validBase),
    expectedSdkDependency: trustedDependency,
  });
  assert.equal(accepted.result, "pass");
});

test("helper compilation rejects replaced artifact leaves", async () => {
  const root = process.cwd();
  const outputRoot = resolve(".factory/state/auth-security/DUMMY-compile");
  const external = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-compile-external-"));
  const sentinel = join(external, "DUMMY-sentinel");
  const output = openProbeOutput({ root, outputRoot, create: true });
  await writeFile(sentinel, "DUMMY sentinel unchanged");
  let replaced = false;
  try {
    assert.throws(() =>
      compileIsolationHelpers({
        root,
        outputRoot,
        anchoredOutputRoot: output.anchor,
        spawnSyncImpl(_command, _args, options) {
          const outputPath = `/proc/${process.pid}/fd/${options.stdio[3]}`;
          writeFileSync(outputPath, "DUMMY compiled helper");
          if (!replaced) {
            replaced = true;
            const leaf = readlinkSync(outputPath);
            rmSync(leaf, { force: true });
            symlinkSync(sentinel, leaf);
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    );
    assert.equal(await readFile(sentinel, "utf8"), "DUMMY sentinel unchanged");
  } finally {
    output.close();
    await rm(outputRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
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

function stubbedSdkProof(payload) {
  return (_command, args) => ({
    status: 0,
    stdout: JSON.stringify(payload).replaceAll("@ROOT@", args.at(-1)),
    stderr: "",
  });
}

function authCase(scenario, result, toAuth, modifyDenials) {
  return {
    scenario,
    result,
    refresh_callbacks: 0,
    to_auth_calls: toAuth,
    credential_store: { reads: 1, lists: 0, modify_denials: modifyDenials, delete_denials: 0 },
    persistence_operations: 0,
    source_unchanged: true,
  };
}

function readAudit(toolCallId, originalPath) {
  return {
    read_count: 1,
    project_read_count: 1,
    project_read_paths: [originalPath],
    rejected_read_paths: [],
    other_tool_calls: [],
    other_tool_completions: [],
    completed_successfully: true,
    exact_original: true,
    expected_sha256: "5".repeat(64),
    returned_sha256: "5".repeat(64),
    returned_bytes: 117,
    tool_call_id: toolCallId,
    start_event_index: 12,
    end_event_index: 13,
    response_event_index: 46,
  };
}

function sdkDependency() {
  const root = resolve(".factory/state/cp06-sdk/node_modules/@earendil-works/pi-ai");
  return {
    entry: join(root, "dist/index.js"),
    entry_sha256: "2".repeat(64),
    manifest_sha256: "3".repeat(64),
    name: "@earendil-works/pi-ai",
    package_sha256: "1".repeat(64),
    resolution: "esm-import-condition",
    root,
    tarball_integrity: "sha512-DUMMY",
    version: "0.85.1",
  };
}

function outcome(scenario, exitCode, extra = {}) {
  const result = {
    scenario,
    exit_code: exitCode,
    expected_exit_code: exitCode,
    exit: exitCode,
    fixture_origin: true,
    sdk_dependency: sdkDependency(),
    default_storage: 0,
    network: 0,
    refresh: 0,
    to_auth: ["expired", "near-expiry"].includes(scenario) ? 0 : 3,
    runtime_create: ["expired", "near-expiry"].includes(scenario) ? 0 : 1,
    source_unchanged: true,
    ...extra,
  };
  if (["valid", "fenced-valid"].includes(scenario)) {
    result.read_audit = readAudit("DUMMY-actual-worker-read", "@ROOT@/DUMMY-outcome/docs/AUTH.md");
  }
  return result;
}

test("anchored artifact writes refuse substituted leaves before external mutation", async () => {
  const root = process.cwd();
  const outputRoot = resolve(".factory/state/cp06-correction/DUMMY-artifact-leaf");
  const external = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-leaf-external-"));
  const sentinel = join(external, "DUMMY-sentinel");
  await writeFile(sentinel, "DUMMY-SENTINEL-UNCHANGED");
  const output = openProbeOutput({ root, outputRoot, create: true, runner: true });
  const child = openAnchoredDirectory(output.anchor, "worker", { reset: true });
  try {
    for (const name of ["input.json", "evidence.json", "blocked.json"]) {
      await symlink(sentinel, join(outputRoot, "worker", name));
      assert.throws(() => writeAnchoredFile(child.anchor, name, "DUMMY redirected write"), {
        code: "EEXIST",
      });
    }
    assert.equal(await readFile(sentinel, "utf8"), "DUMMY-SENTINEL-UNCHANGED");
    const digest = writeAnchoredFile(child.anchor, "worker-control.json", "DUMMY control");
    assert.equal(
      await readFile(join(outputRoot, "worker", "worker-control.json"), "utf8"),
      "DUMMY control",
    );
    assert.match(digest, /^[0-9a-f]{64}$/u);
    for (const name of ["../escape.json", "nested/blocked.json", ""]) {
      assert.throws(() => writeAnchoredFile(child.anchor, name, "DUMMY"));
    }
  } finally {
    child.close();
    output.close();
    await rm(outputRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("anchored removal never descends into a directory swapped for a symlink", async () => {
  const root = process.cwd();
  const outputRoot = resolve(".factory/state/cp06-correction/DUMMY-anchored-removal");
  const external = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-removal-external-"));
  const sentinel = join(external, "DUMMY-sentinel");
  await writeFile(sentinel, "DUMMY-SENTINEL-UNCHANGED");
  const output = openProbeOutput({ root, outputRoot, create: true, runner: true });
  try {
    await mkdir(join(outputRoot, "DUMMY-tree", "home", "credential"), { recursive: true });
    await writeFile(join(outputRoot, "DUMMY-tree", "home", "credential", "DUMMY-auth.json"), "x");
    await symlink(external, join(outputRoot, "DUMMY-tree", "home", "DUMMY-link"));
    assert.throws(() =>
      removeAnchoredEntry(output.anchor, "DUMMY-tree", {
        beforeDescend(path) {
          if (!path.endsWith("/credential")) return;
          renameSync(path, `${path}-moved`);
          symlinkSync(external, path);
        },
      }),
    );
    assert.deepEqual(await readdir(external), ["DUMMY-sentinel"]);
    assert.equal(await readFile(sentinel, "utf8"), "DUMMY-SENTINEL-UNCHANGED");

    removeAnchoredEntry(output.anchor, "DUMMY-tree");
    await assert.rejects(readdir(join(outputRoot, "DUMMY-tree")), { code: "ENOENT" });
    assert.deepEqual(await readdir(external), ["DUMMY-sentinel"]);
    assert.equal(await readFile(sentinel, "utf8"), "DUMMY-SENTINEL-UNCHANGED");
    removeAnchoredEntry(output.anchor, "DUMMY-absent");
  } finally {
    output.close();
    await rm(outputRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
