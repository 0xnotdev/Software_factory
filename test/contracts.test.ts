import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const cliPath = resolve(here, "../src/cli.js");

const project = `schema_version: 1
id: read-later
name: Read Later
intent: Save articles for later.
audience: Individual readers.
goals: [Save a URL]
non_goals: [Sharing]
constraints: [Keep credentials out of context]
documents:
  required: [PROJECT.md, ARCHITECTURE.md]
completion: .factory/completion.yaml
`;
const completion = `schema_version: 1
project: read-later
conditions:
  - id: C-001
    outcome: A saved URL persists after restart.
    method: executable
    check_id: e2e-save
    evidence: e2e/save.json
`;
const task = `schema_version: 1
id: SAVE-001
title: Save a URL
outcome: A reader can reopen a saved URL.
depends_on: []
complexity: bounded
risk: normal
acceptance:
  - id: A-001
    statement: A saved URL is visible after restart.
advances: [C-001]
context:
  topics: [saved items]
  required: [PROJECT.md, ARCHITECTURE.md]
evidence:
  required: [integration]
delivery: project-default
`;

test("init is idempotent and preserves existing project content", async () => {
  const root = await fixture("init path with spaces");
  try {
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    await mkdir(join(root, ".factory"));
    await writeFile(join(root, ".factory/project.yaml"), "human authored\n");
    const first = await factory(root, "init");
    const second = await factory(root, "init");
    assert.equal(first.exit, 0, first.stderr);
    assert.equal(second.exit, 0, second.stderr);
    assert.equal(JSON.parse(first.stdout).command, "init");
    assert.equal(await readFile(join(root, ".factory/project.yaml"), "utf8"), "human authored\n");
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    assert.equal(ignore, "node_modules/\n/.factory/state/\n");
    assert.deepEqual(await readdir(join(root, ".factory/tasks")), []);
    assert.deepEqual(await readdir(join(root, ".factory/state")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid contracts validate and return dependency order", async () => {
  const root = await seeded("valid path with spaces");
  try {
    const result = await factory(root, "validate");
    assert.equal(result.exit, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.project_id, "read-later");
    assert.deepEqual(payload.task_order, ["SAVE-001"]);
    assert.equal(payload.condition_count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate orders dependencies before their consumers", async () => {
  const root = await seeded("dependency-order");
  try {
    await writeFile(
      join(root, ".factory/tasks/SAVE-001.yaml"),
      task.replace("depends_on: []", "depends_on: [DATA-001]"),
    );
    await writeFile(
      join(root, ".factory/tasks/DATA-001.yaml"),
      task.replace("id: SAVE-001", "id: DATA-001").replace("id: A-001", "id: A-002"),
    );
    const result = await factory(root, "validate");
    assert.equal(result.exit, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).task_order, ["DATA-001", "SAVE-001"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const invalidCases: Array<{
  name: string;
  code: string;
  mutate: (root: string) => Promise<void>;
}> = [
  {
    name: "malformed YAML",
    code: "YAML_INVALID",
    mutate: async (root) => writeFile(join(root, ".factory/project.yaml"), "foo: [\n"),
  },
  {
    name: "unknown key",
    code: "SCHEMA_INVALID",
    mutate: async (root) =>
      writeFile(join(root, ".factory/tasks/SAVE-001.yaml"), `${task}unexpected: true\n`),
  },
  {
    name: "unknown schema version",
    code: "SCHEMA_INVALID",
    mutate: async (root) =>
      writeFile(
        join(root, ".factory/project.yaml"),
        project.replace("schema_version: 1", "schema_version: 2"),
      ),
  },
  {
    name: "duplicate task IDs",
    code: "DUPLICATE_ID",
    mutate: async (root) => writeFile(join(root, ".factory/tasks/DUPLICATE.yaml"), task),
  },
  {
    name: "duplicate completion IDs",
    code: "DUPLICATE_ID",
    mutate: async (root) =>
      writeFile(
        join(root, ".factory/completion.yaml"),
        `${completion}  - id: C-001\n    outcome: Another duplicate outcome.\n    method: executable\n    check_id: e2e-other\n    evidence: e2e/other.json\n`,
      ),
  },
  {
    name: "task and completion ID collision",
    code: "DUPLICATE_ID",
    mutate: async (root) =>
      writeFile(
        join(root, ".factory/tasks/SAVE-001.yaml"),
        task.replace("id: SAVE-001", "id: C-001"),
      ),
  },
  {
    name: "missing completion ID",
    code: "COMPLETION_NOT_FOUND",
    mutate: async (root) =>
      writeFile(
        join(root, ".factory/tasks/SAVE-001.yaml"),
        task.replace("advances: [C-001]", "advances: [C-999]"),
      ),
  },
  {
    name: "dependency cycle",
    code: "DEPENDENCY_CYCLE",
    mutate: async (root) => {
      await writeFile(
        join(root, ".factory/tasks/SAVE-001.yaml"),
        task.replace("depends_on: []", "depends_on: [DATA-001]"),
      );
      await writeFile(
        join(root, ".factory/tasks/DATA-001.yaml"),
        task
          .replace("id: SAVE-001", "id: DATA-001")
          .replace("depends_on: []", "depends_on: [SAVE-001]"),
      );
    },
  },
  {
    name: "missing dependency",
    code: "DEPENDENCY_NOT_FOUND",
    mutate: async (root) =>
      writeFile(
        join(root, ".factory/tasks/SAVE-001.yaml"),
        task.replace("depends_on: []", "depends_on: [MISSING-001]"),
      ),
  },
  {
    name: "self dependency",
    code: "SELF_DEPENDENCY",
    mutate: async (root) =>
      writeFile(
        join(root, ".factory/tasks/SAVE-001.yaml"),
        task.replace("depends_on: []", "depends_on: [SAVE-001]"),
      ),
  },
  {
    name: "required source path escape",
    code: "PATH_ESCAPE",
    mutate: async (root) =>
      writeFile(
        join(root, ".factory/project.yaml"),
        project.replace("PROJECT.md, ARCHITECTURE.md", "../outside.md, ARCHITECTURE.md"),
      ),
  },
  {
    name: "oversized required source",
    code: "SOURCE_TOO_LARGE",
    mutate: async (root) =>
      writeFile(join(root, "PROJECT.md"), `# Oversized\n${"x".repeat(80_000)}\n`),
  },
];

for (const scenario of invalidCases) {
  test(`validate rejects ${scenario.name} with an actionable diagnostic`, async () => {
    const root = await seeded(scenario.name.replaceAll(" ", "-"));
    try {
      await scenario.mutate(root);
      const result = await factory(root, "validate");
      assert.equal(result.exit, 2, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, "VALIDATION_FAILED");
      assert.ok(
        payload.error.details.some(
          (item: { code: string; path: string; message: string }) =>
            item.code === scenario.code && item.path.length > 0 && item.message.length > 0,
        ),
        result.stdout,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("validate rejects a required-source symlink outside the Git root", async () => {
  const root = await seeded("source-symlink-escape");
  const outside = join(dirname(root), `${basename(root)}-external.md`);
  try {
    await writeFile(outside, "# External\n");
    await rm(join(root, "PROJECT.md"));
    await symlink(outside, join(root, "PROJECT.md"));
    const result = await factory(root, "validate");
    assert.equal(result.exit, 2, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.error.details.some((item: { code: string }) => item.code === "PATH_ESCAPE"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

async function fixture(name: string): Promise<string> {
  const base = join(repoRoot, "test/.tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `${name}-`));
  await execFileAsync("git", ["init", "-q", root]);
  return root;
}

async function seeded(name: string): Promise<string> {
  const root = await fixture(name);
  await mkdir(join(root, ".factory/tasks"), { recursive: true });
  await writeFile(join(root, "PROJECT.md"), "# Product\nSave articles.\n");
  await writeFile(join(root, "ARCHITECTURE.md"), "# Architecture\nLocal storage.\n");
  await writeFile(join(root, ".factory/project.yaml"), project);
  await writeFile(join(root, ".factory/completion.yaml"), completion);
  await writeFile(join(root, ".factory/tasks/SAVE-001.yaml"), task);
  return root;
}

async function factory(
  root: string,
  command: string,
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return await new Promise((done) => {
    const child = spawn(process.execPath, [cliPath, command, "--root", root, "--json"], {
      cwd: repoRoot,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (exit) => done({ exit, stdout, stderr }));
  });
}
