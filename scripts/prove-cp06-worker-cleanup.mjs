#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openAnchoredDirectory,
  openProbeOutput,
  writeAnchoredFile,
} from "./cp06-probe-fixture.mjs";
import { withCleanup } from "./cp06-worker-lifecycle.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = resolve(root, process.env.CP06_OUTPUT ?? ".factory/state/cp06-correction");
const output = openProbeOutput({ root, outputRoot, create: true, runner: true });
const proofDirectory = openAnchoredDirectory(output.anchor, "worker-cleanup", { reset: true });
const proofRoot = proofDirectory.anchor;
const proofRootPath = join(outputRoot, "worker-cleanup");
const scratch = await mkdtemp(join(proofRoot, "DUMMY-cleanup-"));
const cases = await withCleanup(
  async () => {
    const cases = [];
    for (const [scenario, expectedExit] of [
      ["expired", 75],
      ["near-expiry", 75],
      ["missing-source-setup", 70],
    ]) {
      const home = join(scratch, scenario);
      const temporary = join(home, "tmp");
      const proofOutputPath = join(proofRootPath, "proofs", scenario);
      const proofOutputDirectory = openAnchoredDirectory(
        proofDirectory.anchor,
        `proofs/${scenario}`,
        { reset: true },
      );
      const proofOutput = proofOutputDirectory.anchor;
      const source = join(home, "credential", "DUMMY-auth.json");
      await mkdir(temporary, { recursive: true });
      await mkdir(join(home, "credential"), { recursive: true });
      const sourceBytes = JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "DUMMY-ACCESS",
          refresh: "DUMMY-REFRESH",
          expires: scenario === "expired" ? 0 : Date.now() + 60_000,
        },
      });
      if (scenario !== "missing-source-setup") await writeFile(source, sourceBytes);
      const rawDirectory = openAnchoredDirectory(proofOutput, "ten-pack/raw");
      const docsDirectory = openAnchoredDirectory(proofOutput, "ten-pack/repo/docs");
      try {
        writeAnchoredFile(
          rawDirectory.anchor,
          "auth-worker-missing.pack.md",
          "DUMMY cleanup-only handoff; no semantic acceptance claimed.\n",
        );
        writeAnchoredFile(
          docsDirectory.anchor,
          "AUTH.md",
          await readFile(join(root, "test/fixtures/cp06-context/docs/AUTH.md")),
        );
      } finally {
        rawDirectory.close();
        docsDirectory.close();
      }
      const args = [
        "--experimental-import-meta-resolve",
        join(root, "scripts/replay-cp06-worker.mjs"),
      ];
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: temporary,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          CP06_PI_AUTH_FILE: source,
          CP06_PI_PACKAGE_ROOT: process.env.CP06_PI_PACKAGE_ROOT,
          CP06_PI_BIN: process.env.CP06_PI_BIN,
          CP06_OUTPUT: proofOutputPath,
          CP06_REVIEWER: "DUMMY cleanup regression",
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedExit, result.stderr);
      const blocked = JSON.parse(
        await readFile(join(proofOutputPath, "worker/blocked.json"), "utf8"),
      );
      assert.equal(blocked.result, "blocked");
      assert.equal(blocked.stage, "isolated-sdk-worker");
      assert.deepEqual(await readdir(temporary), [], `${scenario}: evaluation home leaked`);
      if (scenario !== "missing-source-setup")
        assert.equal(await readFile(source, "utf8"), sourceBytes);
      await assert.rejects(readFile(join(proofOutputPath, "worker/evidence.json")), {
        code: "ENOENT",
      });
      proofOutputDirectory.close();
      cases.push({
        scenario,
        command: [process.execPath, ...args],
        exit_code: result.status,
        expected_exit_code: expectedExit,
        stage: blocked.stage,
        worker_failure: blocked.worker_failure,
        evaluation_home_removed: true,
        source_unchanged: scenario === "missing-source-setup" ? null : true,
        fixture_origin: true,
        semantic_acceptance: false,
      });
    }
    return cases;
  },
  () => rm(scratch, { recursive: true, force: true }),
);
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
assert.equal(git.status, 0);
const sources = [
  "scripts/replay-cp06-worker.mjs",
  "scripts/cp06-namespace-supervisor.mjs",
  "scripts/cp06-worker-lifecycle.mjs",
  "scripts/prove-cp06-worker-cleanup.mjs",
];
const manifest = {
  schema_version: 1,
  gate: "CP06-DUMMY-worker-cleanup",
  result: "pass",
  tested_sha: git.stdout.trim(),
  recorded_at: new Date().toISOString(),
  reviewer: process.env.CP06_REVIEWER ?? "CP06 correction worker",
  command: "npm run proof:cp06:worker-cleanup",
  exit_code: 0,
  fixture_origin: true,
  semantic_acceptance: false,
  cases,
  source_sha256: Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex"),
      ]),
    ),
  ),
  limitations: [
    "Actual full-runner expired/near-expiry and missing-source setup cases use DUMMY auth only. Launch, timeout, audit and compound cleanup failures are additionally injected at the executable supervisor interface in the unit suite; SDK timeout is exercised by the DUMMY auth-security proof.",
  ],
};
writeAnchoredFile(proofRoot, "evidence.json", `${JSON.stringify(manifest, null, 2)}\n`);
proofDirectory.close();
output.close();
console.log(
  JSON.stringify({
    result: "pass",
    gate: manifest.gate,
    tested_sha: manifest.tested_sha,
    cases: cases.map(({ scenario, exit_code, evaluation_home_removed }) => ({
      scenario,
      exit_code,
      evaluation_home_removed,
    })),
  }),
);
