import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const cliPath = join(repoRoot, "dist/src/cli.js");

interface Fixture {
  base: string;
  root: string;
  home: string;
  tasksBin: string;
  completionPath: string;
  dispose(): Promise<void>;
}

const project = `schema_version: 1
id: status-fixture
name: Status Fixture
intent: Keep product completion independent.
audience: Factory maintainers.
goals: [Report two independent axes.]
non_goals: [Change task state.]
constraints: [Closed tasks do not prove completion.]
documents:
  required: [PROJECT.md, ARCHITECTURE.md]
completion: .factory/completion.yaml
`;

const completion = `schema_version: 1
project: status-fixture
conditions:
  - id: C-PASS
    outcome: Passing behavior is observed.
    method: executable
    check_id: pass-check
    evidence: artifacts/pass.json
  - id: C-FAIL
    outcome: Failing behavior remains incomplete.
    method: executable
    check_id: fail-check
    evidence: artifacts/fail.json
  - id: C-STALE
    outcome: Old release evidence is stale.
    method: executable
    check_id: stale-check
    evidence: artifacts/stale.json
  - id: C-UNVERIFIED
    outcome: Missing evidence is unverified.
    method: executable
    check_id: unverified-check
    evidence: artifacts/unverified.json
`;

const taskContract = `schema_version: 1
id: TASK-001
title: Exercise product checks
outcome: Project conditions are independently reported.
depends_on: []
complexity: bounded
risk: bounded
acceptance:
  - id: A-001
    statement: Status has separate axes.
advances: [C-PASS, C-FAIL, C-STALE, C-UNVERIFIED]
context:
  topics: [status]
  required: [PROJECT.md, ARCHITECTURE.md]
evidence:
  required: [integration]
delivery: project-default
`;

async function fixture(name: string): Promise<Fixture> {
  const temporaryRoot = resolve(repoRoot, "test/.tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const base = await mkdtemp(join(temporaryRoot, `${name}-`));
  const root = join(base, "project-repo");
  const home = join(base, "firstmate-home");
  await mkdir(join(root, ".factory/tasks"), { recursive: true });
  await mkdir(join(root, ".factory/state/completion"), { recursive: true });
  await mkdir(join(root, "artifacts"), { recursive: true });
  await mkdir(join(home, "data"), { recursive: true });
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(join(root, "PROJECT.md"), "# Project\n");
  await writeFile(join(root, "ARCHITECTURE.md"), "# Architecture\n");
  await writeFile(join(root, ".factory/project.yaml"), project);
  const completionPath = join(root, ".factory/completion.yaml");
  await writeFile(completionPath, completion);
  await writeFile(join(root, ".factory/tasks/TASK-001.yaml"), taskContract);
  for (const id of ["pass", "fail", "stale"]) {
    await writeFile(join(root, `artifacts/${id}.json`), `${JSON.stringify({ id })}\n`);
  }
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "factory@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Factory Test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });
  const oldCommit = await head(root);
  await writeFile(join(root, "release.txt"), "release candidate\n");
  await execFileAsync("git", ["add", "release.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "release candidate"], { cwd: root });
  const releaseCommit = await head(root);
  const completionDigest = await sha256(completionPath);
  await writeCompletionReceipt(
    root,
    "C-PASS",
    "pass-check",
    "artifacts/pass.json",
    0,
    releaseCommit,
    completionDigest,
  );
  await writeCompletionReceipt(
    root,
    "C-FAIL",
    "fail-check",
    "artifacts/fail.json",
    9,
    releaseCommit,
    completionDigest,
  );
  await writeCompletionReceipt(
    root,
    "C-STALE",
    "stale-check",
    "artifacts/stale.json",
    0,
    oldCommit,
    completionDigest,
  );

  await writeFile(
    join(home, ".tasks.toml"),
    'backend = "markdown"\n\n[markdown]\npath = "data/backlog.md"\narchive = "data/done-archive.md"\n',
  );
  await writeFile(
    join(home, "data/backlog.md"),
    "# Backlog\n\n## Done\n- [x] factory-status-fixture-task-001 - done\n",
  );
  await writeFile(join(home, "data/projects.md"), `- ${basename(root)} [no-mistakes] - fixture\n`);
  await writeFile(join(home, "config/backlog-backend"), "tasks-axi\n");
  const tasksBin = join(base, "tasks-axi-fixture");
  await writeFile(
    tasksBin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "show" && args[1] === "factory-status-fixture-task-001") {
  console.log('  id: factory-status-fixture-task-001');
  console.log('  title: Exercise product checks');
  console.log('  state: done');
  console.log('  kind: ship');
  console.log('  repo: project-repo');
  console.log('  blocked_by: none');
  console.log('  held: no');
  console.log('  body: "fixture"');
  process.exit(0);
}
console.error("NOT_FOUND"); process.exit(1);
`,
  );
  await chmod(tasksBin, 0o755);
  return {
    base,
    root,
    home,
    tasksBin,
    completionPath,
    async dispose() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function writeCompletionReceipt(
  root: string,
  conditionId: string,
  checkId: string,
  artifact: string,
  exitCode: number,
  commit: string,
  completionDigest: string,
): Promise<void> {
  const receipt = {
    schema_version: 1,
    condition_id: conditionId,
    completion_sha256: completionDigest,
    commit,
    result: {
      kind: "executable",
      status: exitCode === 0 ? "pass" : "fail",
      check_id: checkId,
      command_id: checkId,
      exit_code: exitCode,
      artifact,
      artifact_sha256: await sha256(join(root, artifact)),
    },
    recorded_at: "2026-09-28T00:00:00Z",
  };
  await writeFile(
    join(root, `.factory/state/completion/${conditionId}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function head(root: string): Promise<string> {
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

async function factory(item: Fixture) {
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
    (resolveResult) => {
      const child = spawn(
        process.execPath,
        [
          cliPath,
          "status",
          "--root",
          item.root,
          "--home",
          item.home,
          "--tasks-bin",
          item.tasksBin,
          "--json",
        ],
        { cwd: repoRoot, shell: false },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
    },
  );
}

test("status reports backlog progress separately from every product evidence condition", async () => {
  const item = await fixture("status-axes");
  try {
    const result = await factory(item);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "status");
    assert.deepEqual(report.backlog.summary, {
      queued: 0,
      in_flight: 0,
      done: 1,
      unverified: 0,
    });
    assert.equal(report.backlog.all_tasks_done, true);
    assert.deepEqual(report.product.summary, {
      passed: 1,
      failed: 1,
      stale: 1,
      unverified: 1,
    });
    assert.equal(report.product.status, "NOT COMPLETE");
    assert.equal(report.product.release_candidate, await head(item.root));
    assert.deepEqual(
      Object.fromEntries(
        report.product.conditions.map((condition: any) => [condition.id, condition.status]),
      ),
      { "C-PASS": "passed", "C-FAIL": "failed", "C-STALE": "stale", "C-UNVERIFIED": "unverified" },
    );
  } finally {
    await item.dispose();
  }
});

test("a failed project check keeps all-closed work NOT COMPLETE", async () => {
  const item = await fixture("status-independent");
  try {
    const result = await factory(item);
    const report = JSON.parse(result.stdout);
    assert.equal(report.backlog.all_tasks_done, true);
    assert.equal(
      report.product.conditions.find((condition: any) => condition.id === "C-FAIL").status,
      "failed",
    );
    assert.equal(report.product.status, "NOT COMPLETE");
  } finally {
    await item.dispose();
  }
});

test("dirty completion contract cannot pass at unchanged HEAD", async () => {
  const item = await fixture("status-dirty-completion");
  try {
    await writeFile(item.completionPath, `${completion}# dirty but uncommitted\n`);
    await writeCompletionReceipt(
      item.root,
      "C-PASS",
      "pass-check",
      "artifacts/pass.json",
      0,
      await head(item.root),
      await sha256(item.completionPath),
    );
    const result = await factory(item);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    const condition = report.product.conditions.find((candidate: any) => candidate.id === "C-PASS");
    assert.equal(condition.status, "stale");
    assert.ok(
      condition.issues.some(
        (issue: { code: string }) => issue.code === "COMPLETION_CONTRACT_NOT_IN_RELEASE",
      ),
    );
    assert.equal(report.product.status, "NOT COMPLETE");
  } finally {
    await item.dispose();
  }
});
