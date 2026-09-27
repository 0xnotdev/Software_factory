import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const cliPath = join(repoRoot, "dist/src/cli.js");
const installedTasksAxi =
  process.env.TASKS_AXI_BIN ?? (await execFileAsync("which", ["tasks-axi"])).stdout.trim();

interface Fixture {
  base: string;
  root: string;
  home: string;
  repo: string;
  tasks: string;
  dispose(): Promise<void>;
}

interface Result {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const task = (id: string, dependsOn: string[] = []): string => `schema_version: 1
id: ${id}
title: ${id} title
outcome: ${id} has an observable result.
depends_on: [${dependsOn.join(", ")}]
complexity: bounded
risk: bounded
acceptance:
  - id: A-${id}
    statement: ${id} acceptance is observable.
advances: [C-001]
context:
  topics: [publication]
  required: [PROJECT.md, ARCHITECTURE.md]
evidence:
  required: [integration]
delivery: project-default
`;

const project = `schema_version: 1
id: sync-fixture
name: Sync Fixture
intent: Verify safe publication.
audience: Factory maintainers.
goals: [Publish deterministic tasks.]
non_goals: [Dispatch workers.]
constraints: [Never edit the backlog directly.]
documents:
  required: [PROJECT.md, ARCHITECTURE.md]
completion: .factory/completion.yaml
`;

const completion = `schema_version: 1
project: sync-fixture
conditions:
  - id: C-001
    outcome: Publication is deterministic.
    method: executable
    check_id: sync-test
    evidence: evidence/sync.json
`;

const publishedId = (id: string): string => `factory-sync-fixture-${id.toLowerCase()}`;

async function createFixture(name: string, taskSpecs: Array<[string, string[]]>): Promise<Fixture> {
  const baseDir = resolve(repoRoot, "test/.tmp");
  await mkdir(baseDir, { recursive: true });
  const base = await mkdtemp(join(baseDir, `${name}-`));
  const root = join(base, "project-repo");
  const home = join(base, "named-firstmate-home");
  const repo = basename(root);
  await mkdir(join(root, ".factory/tasks"), { recursive: true });
  await mkdir(join(home, "data"), { recursive: true });
  await mkdir(join(home, "config"), { recursive: true });
  await execFileAsync("git", ["init", "-q", root]);
  await writeFile(join(root, "PROJECT.md"), "# Fixture project\n\nPublication requirements.\n");
  await writeFile(join(root, "ARCHITECTURE.md"), "# Fixture architecture\n\nSafe sync boundary.\n");
  await writeFile(join(root, ".factory/project.yaml"), project);
  await writeFile(join(root, ".factory/completion.yaml"), completion);
  for (const [id, dependencies] of taskSpecs) {
    await writeFile(join(root, `.factory/tasks/${id}.yaml`), task(id, dependencies));
  }
  await writeFile(
    join(home, ".tasks.toml"),
    'backend = "markdown"\n\n[markdown]\npath = "data/backlog.md"\narchive = "data/done-archive.md"\ndone_keep = 10\n',
  );
  await writeFile(
    join(home, "data/backlog.md"),
    "# Firstmate backlog\n\n## In flight\n\n## Queued\n\n## Done\n",
  );
  await writeFile(
    join(home, "data/projects.md"),
    `- ${repo} [no-mistakes] - disposable sync fixture (added 2026-09-27)\n`,
  );
  await writeFile(join(home, "config/backlog-backend"), "tasks-axi\n");
  return {
    base,
    root,
    home,
    repo,
    tasks: installedTasksAxi,
    async dispose() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function factory(fixture: Fixture, mode: "--dry-run" | "--apply", tasks = fixture.tasks) {
  return await runFactory([
    "sync",
    mode,
    "--root",
    fixture.root,
    "--home",
    fixture.home,
    "--tasks-bin",
    tasks,
    "--json",
  ]);
}

async function runFactory(args: string[]): Promise<Result> {
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

async function backlogHash(home: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(join(home, "data/backlog.md")))
    .digest("hex");
}

async function axi(fixture: Fixture, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(installedTasksAxi, args, { cwd: fixture.home });
}

async function writeWrapper(fixture: Fixture, name: string, body: string): Promise<string> {
  const path = join(fixture.base, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}`);
  await chmod(path, 0o755);
  return path;
}

test("dry-run previews create/unchanged/conflict without changing one backlog byte", async () => {
  const fixture = await createFixture("sync-preview", [["TASK-A", []]]);
  try {
    assert.equal((await factory(fixture, "--apply")).exitCode, 0);
    await writeFile(join(fixture.root, ".factory/tasks/TASK-B.yaml"), task("TASK-B"));
    await writeFile(join(fixture.root, ".factory/tasks/TASK-C.yaml"), task("TASK-C"));
    await axi(fixture, [
      "add",
      publishedId("TASK-C"),
      "TASK-C title",
      "--kind",
      "ship",
      "--repo",
      fixture.repo,
      "--body",
      "human-authored conflicting body",
      "--json",
    ]);

    const before = await backlogHash(fixture.home);
    const result = await factory(fixture, "--dry-run");
    const after = await backlogHash(fixture.home);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as any;
    assert.deepEqual(
      Object.fromEntries(report.records.map((record: any) => [record.task_id, record.action])),
      { "TASK-A": "unchanged", "TASK-B": "create", "TASK-C": "conflict" },
    );
    assert.equal(report.backlog.sha256_before, before);
    assert.equal(report.backlog.sha256_after, after);
    assert.equal(report.backlog.unchanged, true);
    assert.equal(after, before);

    const refused = await factory(fixture, "--apply");
    assert.equal(refused.exitCode, 4);
    assert.equal(JSON.parse(refused.stdout).error.code, "PUBLICATION_CONFLICT");
    assert.equal(await backlogHash(fixture.home), before);
    await assert.rejects(axi(fixture, ["show", publishedId("TASK-B"), "--full"]));
  } finally {
    await fixture.dispose();
  }
});

test("a dependency conflict deterministically blocks an unpublished dependent", async () => {
  const fixture = await createFixture("sync-blocked-plan", [
    ["TASK-A", []],
    ["TASK-B", ["TASK-A"]],
  ]);
  try {
    await axi(fixture, [
      "add",
      publishedId("TASK-A"),
      "TASK-A title",
      "--kind",
      "ship",
      "--repo",
      fixture.repo,
      "--body",
      "conflicting body",
      "--json",
    ]);
    const before = await backlogHash(fixture.home);
    const result = await factory(fixture, "--dry-run");
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as any;
    assert.deepEqual(
      Object.fromEntries(report.records.map((record: any) => [record.task_id, record.action])),
      { "TASK-A": "conflict", "TASK-B": "blocked" },
    );
    assert.equal(await backlogHash(fixture.home), before);
  } finally {
    await fixture.dispose();
  }
});

test("apply uses installed tasks-axi in dependency order and a second apply is idempotent", async () => {
  const fixture = await createFixture("sync-apply", [
    ["TASK-A", []],
    ["TASK-B", ["TASK-A"]],
  ]);
  try {
    const first = await factory(fixture, "--apply");
    assert.equal(first.exitCode, 0, first.stderr || first.stdout);
    const firstReport = JSON.parse(first.stdout) as any;
    assert.deepEqual(firstReport.created_ids, [publishedId("TASK-A"), publishedId("TASK-B")]);
    assert.deepEqual(
      firstReport.records.map((record: any) => record.task_id),
      ["TASK-A", "TASK-B"],
    );

    const showA = await axi(fixture, ["show", publishedId("TASK-A"), "--full"]);
    const showB = await axi(fixture, ["show", publishedId("TASK-B"), "--full"]);
    const ready = await axi(fixture, ["ready", "--repo", fixture.repo]);
    assert.match(showA.stdout, /Factory publication v1/);
    assert.match(showA.stdout, /Contract SHA-256: [a-f0-9]{64}/);
    assert.match(showB.stdout, new RegExp(`blocked_by: ${publishedId("TASK-A")}`));
    assert.match(ready.stdout, new RegExp(publishedId("TASK-A")));
    assert.doesNotMatch(ready.stdout, new RegExp(publishedId("TASK-B")));

    const beforeSecond = await backlogHash(fixture.home);
    const second = await factory(fixture, "--apply");
    assert.equal(second.exitCode, 0, second.stderr || second.stdout);
    const secondReport = JSON.parse(second.stdout) as any;
    assert.equal(secondReport.summary.unchanged, 2);
    assert.deepEqual(secondReport.created_ids, []);
    assert.equal(await backlogHash(fixture.home), beforeSecond);
    const backlog = await readFile(join(fixture.home, "data/backlog.md"), "utf8");
    assert.equal(backlog.split(`- [ ] ${publishedId("TASK-A")} -`).length - 1, 1);
    assert.equal(backlog.split(`- [ ] ${publishedId("TASK-B")} -`).length - 1, 1);
  } finally {
    await fixture.dispose();
  }
});

test("an existing held dependency stays held and keeps its dependent non-ready", async () => {
  const fixture = await createFixture("sync-held", [
    ["TASK-A", []],
    ["TASK-B", ["TASK-A"]],
  ]);
  try {
    assert.equal((await factory(fixture, "--apply")).exitCode, 0);
    await axi(fixture, ["hold", publishedId("TASK-A"), "--reason", "captain hold"]);
    const before = await backlogHash(fixture.home);
    const retry = await factory(fixture, "--apply");
    assert.equal(retry.exitCode, 0, retry.stderr || retry.stdout);
    assert.equal(await backlogHash(fixture.home), before);
    const show = await axi(fixture, ["show", publishedId("TASK-A"), "--full"]);
    const ready = await axi(fixture, ["ready", "--repo", fixture.repo]);
    assert.match(show.stdout, /held: yes/);
    assert.doesNotMatch(ready.stdout, new RegExp(publishedId("TASK-A")));
    assert.doesNotMatch(ready.stdout, new RegExp(publishedId("TASK-B")));
  } finally {
    await fixture.dispose();
  }
});

test("partial apply reports durable IDs and retry converges without duplicates", async () => {
  const fixture = await createFixture("sync-partial", [
    ["TASK-A", []],
    ["TASK-B", ["TASK-A"]],
  ]);
  try {
    const marker = join(fixture.base, "failed-once");
    const wrapper = await writeWrapper(
      fixture,
      "partial-tasks-axi",
      `import { existsSync, writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nif (args[0] === "add" && args[1] === ${JSON.stringify(publishedId("TASK-B"))} && !existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, "failed"); console.error("injected second create failure"); process.exit(9); }\nconst child = spawnSync(${JSON.stringify(installedTasksAxi)}, args, { cwd: process.cwd(), encoding: "utf8" });\nprocess.stdout.write(child.stdout ?? ""); process.stderr.write(child.stderr ?? ""); process.exit(child.status ?? 1);\n`,
    );
    const partial = await factory(fixture, "--apply", wrapper);
    assert.notEqual(partial.exitCode, 0);
    const failure = JSON.parse(partial.stdout) as any;
    assert.equal(failure.error.code, "PARTIAL_SYNC");
    assert.deepEqual(failure.error.details.created_ids, [publishedId("TASK-A")]);
    assert.deepEqual(failure.error.details.remaining_ids, [publishedId("TASK-B")]);
    assert.match(
      (await axi(fixture, ["show", publishedId("TASK-A"), "--full"])).stdout,
      /Factory publication v1/,
    );

    const retry = await factory(fixture, "--apply", wrapper);
    assert.equal(retry.exitCode, 0, retry.stderr || retry.stdout);
    const report = JSON.parse(retry.stdout) as any;
    assert.deepEqual(report.created_ids, [publishedId("TASK-B")]);
    assert.equal(report.summary.unchanged, 1);
    const backlog = await readFile(join(fixture.home, "data/backlog.md"), "utf8");
    assert.equal(backlog.split(`- [ ] ${publishedId("TASK-A")} -`).length - 1, 1);
    assert.equal(backlog.split(`- [ ] ${publishedId("TASK-B")} -`).length - 1, 1);
  } finally {
    await fixture.dispose();
  }
});

for (const scenario of [
  "wrong home",
  "unregistered project",
  "manual backend",
  "unsupported storage backend",
  "incompatible tasks-axi",
  "edited existing body",
  "symlink home",
  "stale contract",
] as const) {
  test(`${scenario} fails without changing backlog bytes`, async (context) => {
    const fixture = await createFixture(`sync-negative-${scenario.replaceAll(" ", "-")}`, [
      ["TASK-A", []],
    ]);
    try {
      let home = fixture.home;
      let tasks = fixture.tasks;
      if (scenario === "wrong home") home = join(fixture.base, "not-a-home");
      if (scenario === "unregistered project") {
        await writeFile(
          join(fixture.home, "data/projects.md"),
          "- another-repo [no-mistakes] - other\n",
        );
      }
      if (scenario === "manual backend") {
        await writeFile(join(fixture.home, "config/backlog-backend"), "manual\n");
      }
      if (scenario === "unsupported storage backend") {
        await writeFile(join(fixture.home, ".tasks.toml"), 'backend = "sqlite"\n');
      }
      if (scenario === "incompatible tasks-axi") {
        tasks = await writeWrapper(
          fixture,
          "old-tasks-axi",
          `import { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nif (args[0] === "--version") { console.log("0.2.4"); process.exit(0); }\nconst child = spawnSync(${JSON.stringify(installedTasksAxi)}, args, { cwd: process.cwd(), encoding: "utf8" }); process.stdout.write(child.stdout ?? ""); process.stderr.write(child.stderr ?? ""); process.exit(child.status ?? 1);\n`,
        );
      }
      if (scenario === "edited existing body") {
        assert.equal((await factory(fixture, "--apply")).exitCode, 0);
        await axi(fixture, ["update", publishedId("TASK-A"), "--body", "human edit"]);
      }
      if (scenario === "symlink home") {
        const link = join(fixture.base, "home-link");
        try {
          await symlink(fixture.home, link, "dir");
        } catch (error: any) {
          if (error?.code === "EPERM") {
            context.skip("host does not permit directory symlinks");
            return;
          }
          throw error;
        }
        home = link;
      }
      if (scenario === "stale contract") {
        const contractPath = join(fixture.root, ".factory/tasks/TASK-A.yaml");
        tasks = await writeWrapper(
          fixture,
          "mutating-tasks-axi",
          `import { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst mark = ${JSON.stringify(join(fixture.base, "mutated"))}; const args = process.argv.slice(2);\nif (args[0] === "show" && !existsSync(mark)) { appendFileSync(${JSON.stringify(contractPath)}, "\\n# changed during preflight\\n"); writeFileSync(mark, "yes"); }\nconst child = spawnSync(${JSON.stringify(installedTasksAxi)}, args, { cwd: process.cwd(), encoding: "utf8" }); process.stdout.write(child.stdout ?? ""); process.stderr.write(child.stderr ?? ""); process.exit(child.status ?? 1);\n`,
        );
      }

      const backlogPath = join(fixture.home, "data/backlog.md");
      const before = await readFile(backlogPath);
      const result = await runFactory([
        "sync",
        "--apply",
        "--root",
        fixture.root,
        "--home",
        home,
        "--tasks-bin",
        tasks,
        "--json",
      ]);
      assert.notEqual(result.exitCode, 0, result.stdout);
      const error = JSON.parse(result.stdout) as any;
      assert.equal(error.schema_version, 1);
      assert.equal(error.ok, false);
      assert.equal((result.stdout.match(/"schema_version"/g) ?? []).length, 1);
      assert.deepEqual(await readFile(backlogPath), before);
      if (scenario === "edited existing body")
        assert.equal(error.error.code, "PUBLICATION_CONFLICT");
      if (scenario === "stale contract") assert.equal(error.error.code, "CONTRACT_CHANGED");
    } finally {
      await fixture.dispose();
    }
  });
}

test("publication ID collision after tasks-axi encoding is rejected", async () => {
  const fixture = await createFixture("sync-encoded-duplicate", [
    ["TASK-A", []],
    ["task-a", []],
  ]);
  try {
    const before = await backlogHash(fixture.home);
    const result = await factory(fixture, "--apply");
    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.stdout).error.code, "DUPLICATE_PUBLICATION_ID");
    assert.equal(await backlogHash(fixture.home), before);
  } finally {
    await fixture.dispose();
  }
});

test("duplicate local task ID is rejected before publication", async () => {
  const fixture = await createFixture("sync-duplicate", [["TASK-A", []]]);
  try {
    await writeFile(join(fixture.root, ".factory/tasks/DUPLICATE.yaml"), task("TASK-A"));
    const before = await backlogHash(fixture.home);
    const result = await factory(fixture, "--apply");
    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.stdout).error.code, "VALIDATION_FAILED");
    assert.equal(await backlogHash(fixture.home), before);
  } finally {
    await fixture.dispose();
  }
});
