import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const script = join(repoRoot, "scripts/cp08-oracle-proof.mjs");
const originalBrief =
  "Build a local read-later web app where separate accounts can save article links with title/notes, list and search their saved items, and edit/delete only their own items. Data survives restart. Provide a usable browser UI and reproducible local setup. Deliver at least two usable end-to-end slices; no public deployment, payment, email service, imported private data or real credentials.\n";

const project = `schema_version: 1
id: factory-read-later-acceptance
name: Read Later
intent: Test the frozen oracle.
audience: DUMMY local users.
goals: [Exercise two slices.]
non_goals: [Deploy publicly.]
constraints: [Derive ownership from the principal.]
documents:
  required: [ORIGINAL_BRIEF.md, PROJECT.md, ARCHITECTURE.md, COMPLETION.md, docs/DECISIONS.md, docs/VERIFICATION.md]
completion: .factory/completion.yaml
`;
const completion = `schema_version: 1
project: factory-read-later-acceptance
conditions:
${Array.from(
  { length: 6 },
  (_, index) => `  - id: RL-00${index + 1}
    outcome: Observable condition ${index + 1} passes.
    method: executable
    check_id: check-${index + 1}
    evidence: evidence/artifacts/check-${index + 1}.json`,
).join("\n")}
`;
const task = (id, dependency, advances) => `schema_version: 1
id: ${id}
title: ${id} vertical slice
outcome: ${id} delivers an observable browser journey.
depends_on: [${dependency}]
complexity: normal
risk: critical
acceptance:
  - id: A-${id}
    statement: ${id} has executable end-to-end evidence.
advances: [${advances.join(", ")}]
context:
  topics: [vertical slice]
  required: [ORIGINAL_BRIEF.md, PROJECT.md, ARCHITECTURE.md, COMPLETION.md, docs/DECISIONS.md, docs/VERIFICATION.md]
evidence:
  required: [e2e]
delivery: project-default
`;

async function git(root, args) {
  return await execFileAsync("git", ["-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CP08 Test",
      GIT_AUTHOR_EMAIL: "cp08@example.invalid",
      GIT_COMMITTER_NAME: "CP08 Test",
      GIT_COMMITTER_EMAIL: "cp08@example.invalid",
    },
  });
}

async function createSubject() {
  const parent = resolve(repoRoot, "test/.tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "cp08-oracle-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await mkdir(join(root, ".factory/tasks"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "ORIGINAL_BRIEF.md"), originalBrief);
  await writeFile(join(root, "PROJECT.md"), "# Project\n\nFrozen product truth.\n");
  await writeFile(join(root, "ARCHITECTURE.md"), "# Architecture\n\nMinimal local boundary.\n");
  await writeFile(join(root, "COMPLETION.md"), "# Completion\n\nIndependent oracle.\n");
  await writeFile(join(root, "README.md"), "# Read Later\n");
  await writeFile(join(root, "docs/DECISIONS.md"), "# Decisions\n\nNo unresolved choices.\n");
  await writeFile(join(root, "docs/VERIFICATION.md"), "# Verification\n\nRun observed checks.\n");
  await writeFile(join(root, ".gitignore"), ".factory/state/\n.ctx/\n.data/\n");
  await writeFile(join(root, ".factory/project.yaml"), project);
  await writeFile(join(root, ".factory/completion.yaml"), completion);
  await writeFile(
    join(root, ".factory/tasks/SLICE-001.yaml"),
    task("SLICE-001", "", ["RL-001", "RL-002", "RL-005"]),
  );
  await writeFile(
    join(root, ".factory/tasks/SLICE-002.yaml"),
    task("SLICE-002", "SLICE-001", ["RL-003", "RL-004", "RL-006"]),
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "Freeze oracle"]);
  const oracle = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/app.mjs"), "export const ready = true;\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "Implement slices"]);
  const release = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, oracle, release };
}

async function prove(subject) {
  try {
    const result = await execFileAsync(process.execPath, [
      script,
      "--subject",
      subject.root,
      "--oracle",
      subject.oracle,
      "--release",
      subject.release,
      "--reviewer",
      "CP08 executable test",
    ]);
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

test("CP08 oracle proof binds a separate release to its unchanged first-commit truth", async () => {
  const subject = await createSubject();
  try {
    const result = await prove(subject);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.status, "pass");
    assert.equal(evidence.oracle_commit, subject.oracle);
    assert.equal(evidence.release_commit, subject.release);
    assert.deepEqual(evidence.factory_validation.task_order, ["SLICE-001", "SLICE-002"]);
    assert.equal(evidence.oracle_application_files, 0);
  } finally {
    await rm(subject.root, { recursive: true, force: true });
  }
});

for (const mutation of [
  {
    path: ".factory/completion.yaml",
    content: completion.replace("Observable condition 1 passes.", "A weakened replacement passes."),
  },
  { path: "PROJECT.md", content: "# Project\n\nChanged product truth.\n" },
]) {
  test(`CP08 oracle proof rejects a later change to ${mutation.path}`, async () => {
    const subject = await createSubject();
    try {
      await writeFile(join(subject.root, mutation.path), mutation.content);
      await git(subject.root, ["add", mutation.path]);
      await git(subject.root, ["commit", "-q", "-m", "Mutate frozen oracle source"]);
      subject.release = (await git(subject.root, ["rev-parse", "HEAD"])).stdout.trim();

      const stale = await prove(subject);
      assert.equal(stale.exitCode, 1);
      const failure = JSON.parse(stale.stdout);
      assert.equal(failure.status, "fail");
      assert.equal(failure.error.code, "FROZEN_SOURCE_CHANGED");
      assert.equal(failure.error.details.path, mutation.path);
    } finally {
      await rm(subject.root, { recursive: true, force: true });
    }
  });
}
