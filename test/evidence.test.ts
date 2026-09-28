import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const cliPath = join(repoRoot, "dist/src/cli.js");

interface Fixture {
  root: string;
  taskPath: string;
  receiptPath: string;
  artifactPath: string;
  dispose(): Promise<void>;
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const project = `schema_version: 1
id: evidence-fixture
name: Evidence Fixture
intent: Verify task evidence.
audience: Factory maintainers.
goals: [Bind proof to source.]
non_goals: [Publish work.]
constraints: [Backlog closure is independent.]
documents:
  required: [PROJECT.md, ARCHITECTURE.md]
completion: .factory/completion.yaml
`;

const completion = `schema_version: 1
project: evidence-fixture
conditions:
  - id: C-001
    outcome: Evidence stays bound to source.
    method: executable
    check_id: project-check
    evidence: artifacts/project.json
`;

const taskContract = `schema_version: 1
id: TASK-001
title: Produce exact evidence
outcome: Evidence is machine-verifiable.
depends_on: []
complexity: bounded
risk: bounded
acceptance:
  - id: A-001
    statement: Evidence includes observed checks.
advances: [C-001]
context:
  topics: [evidence]
  required: [PROJECT.md, ARCHITECTURE.md]
evidence:
  required: [unit, integration]
delivery: project-default
`;

async function fixture(name: string): Promise<Fixture> {
  const temporaryRoot = resolve(repoRoot, "test/.tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, `${name}-`));
  await mkdir(join(root, ".factory/tasks"), { recursive: true });
  await mkdir(join(root, ".factory/state/evidence"), { recursive: true });
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(join(root, "PROJECT.md"), "# Project\n");
  await writeFile(join(root, "ARCHITECTURE.md"), "# Architecture\n");
  await writeFile(join(root, ".factory/project.yaml"), project);
  await writeFile(join(root, ".factory/completion.yaml"), completion);
  const taskPath = join(root, ".factory/tasks/TASK-001.yaml");
  await writeFile(taskPath, taskContract);
  const artifactPath = join(root, "artifacts/task.txt");
  await writeFile(artifactPath, "observed output\n");
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "factory@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Factory Test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return {
    root,
    taskPath,
    receiptPath: join(root, ".factory/state/evidence/TASK-001.json"),
    artifactPath,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function head(root: string): Promise<string> {
  return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

async function writePassingReceipt(item: Fixture): Promise<void> {
  const check = (id: string) => ({
    id,
    status: "pass",
    command_id: `test-${id}`,
    exit_code: 0,
    artifact: "artifacts/task.txt",
    artifact_sha256: "",
  });
  const receipt = {
    schema_version: 1,
    task_id: "TASK-001",
    contract_sha256: await sha256(item.taskPath),
    commit: await head(item.root),
    checks: [check("unit"), check("integration")],
    review: { status: "pending", artifact: null },
    recorded_at: "2026-09-28T00:00:00Z",
  };
  for (const evidence of receipt.checks) evidence.artifact_sha256 = await sha256(item.artifactPath);
  await writeFile(item.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function factory(root: string): Promise<CliResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(
      process.execPath,
      [cliPath, "evidence", "TASK-001", "--root", root, "--json"],
      {
        cwd: repoRoot,
        shell: false,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

test("valid task evidence is bound to its exact contract and Git SHA", async () => {
  const item = await fixture("evidence-valid");
  try {
    await writePassingReceipt(item);
    const result = await factory(item.root);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "evidence");
    assert.equal(report.status, "passed");
    assert.equal(report.valid, true);
    assert.equal(report.contract_sha256, await sha256(item.taskPath));
    assert.equal(report.tested_commit, await head(item.root));
  } finally {
    await item.dispose();
  }
});

for (const scenario of [
  "prose-only pass",
  "failed exit",
  "missing artifact",
  "changed contract",
  "changed release SHA",
] as const) {
  test(`${scenario} cannot produce valid passing task evidence`, async () => {
    const item = await fixture(`evidence-${scenario.replaceAll(" ", "-")}`);
    try {
      await writePassingReceipt(item);
      if (scenario === "prose-only pass") {
        await writeFile(item.receiptPath, JSON.stringify({ status: "pass", note: "tests passed" }));
      }
      if (scenario === "failed exit") {
        const receipt = JSON.parse(await readFile(item.receiptPath, "utf8"));
        receipt.checks[1].exit_code = 7;
        await writeFile(item.receiptPath, JSON.stringify(receipt));
      }
      if (scenario === "missing artifact") await rm(item.artifactPath);
      if (scenario === "changed contract")
        await writeFile(item.taskPath, `${taskContract}# changed\n`);
      if (scenario === "changed release SHA") {
        await writeFile(join(item.root, "release.txt"), "new release\n");
        await execFileAsync("git", ["add", "release.txt"], { cwd: item.root });
        await execFileAsync("git", ["commit", "-qm", "new release"], { cwd: item.root });
      }

      const result = await factory(item.root);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.valid, false);
      assert.notEqual(report.status, "passed");
      if (scenario.startsWith("changed")) assert.equal(report.status, "stale");
      else assert.equal(report.status, "failed");
    } finally {
      await item.dispose();
    }
  });
}
