import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "src", "cli.js");
const repoRoot = resolve(__dirname, "..", "..");

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

test("doctor succeeds against a disposable markdown Firstmate home", async () => {
  const fixture = await createFixture("success");
  try {
    const home = await createHome(fixture.root, "firstmate home with spaces");
    const bins = await createFakeBins(fixture.root);
    const before = await readFile(join(home, "data/backlog.md"), "utf8");

    const result = await runFactory([
      "doctor",
      "--home",
      home,
      "--json",
      "--ctx-bin",
      bins.ctx,
      "--tasks-bin",
      bins.tasks,
      "--git-bin",
      bins.git,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(report.schema_version, 1);
    assert.equal(report.ok, true);
    assert.equal(report.integrations.firstmate_home.path, home);
    assert.equal(report.integrations.firstmate_home.backend, "markdown");
    assert.equal(report.integrations.ctx.version.stdout.trim(), "ctx 9.9.9");
    assert.equal(
      report.integrations.tasks_axi.ready.stdout.trim(),
      "count: 1\nready[1]: fixture-alpha",
    );
    assert.equal(report.integrations.tasks_axi.read_only, true);
    assert.equal(await readFile(join(home, "data/backlog.md"), "utf8"), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("doctor exits nonzero for a wrong home", async () => {
  const fixture = await createFixture("wrong-home");
  try {
    const wrongHome = join(fixture.root, "not-a-firstmate-home");
    await mkdir(wrongHome, { recursive: true });
    const bins = await createFakeBins(fixture.root);

    const result = await runFactory([
      "doctor",
      "--home",
      wrongHome,
      "--json",
      "--ctx-bin",
      bins.ctx,
      "--tasks-bin",
      bins.tasks,
      "--git-bin",
      bins.git,
    ]);

    assert.equal(result.exitCode, 3);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "FIRSTMATE_HOME_INVALID");
    assert.match(payload.error.message, /\.tasks\.toml/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("doctor exits nonzero for a missing required tool", async () => {
  const fixture = await createFixture("missing-tool");
  try {
    const home = await createHome(fixture.root, "home");
    const bins = await createFakeBins(fixture.root);
    const missingCtx = join(fixture.root, "bin", "missing-ctx");

    const result = await runFactory([
      "doctor",
      "--home",
      home,
      "--json",
      "--ctx-bin",
      missingCtx,
      "--tasks-bin",
      bins.tasks,
      "--git-bin",
      bins.git,
    ]);

    assert.equal(result.exitCode, 3);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "TOOL_UNAVAILABLE");
    assert.equal(payload.error.details.tool, "ctx");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("doctor detects a tasks-axi read-only violation", async () => {
  const fixture = await createFixture("mutating-tasks");
  try {
    const home = await createHome(fixture.root, "home");
    const bins = await createFakeBins(fixture.root, { mutateTasksReady: true });

    const result = await runFactory([
      "doctor",
      "--home",
      home,
      "--json",
      "--ctx-bin",
      bins.ctx,
      "--tasks-bin",
      bins.tasks,
      "--git-bin",
      bins.git,
    ]);

    assert.equal(result.exitCode, 3);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "READ_ONLY_VIOLATION");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(name: string): Promise<{ root: string }> {
  const base = resolve(repoRoot, "test/.tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `${name}-`));
  return { root };
}

async function createHome(root: string, name: string): Promise<string> {
  const home = join(root, name);
  await mkdir(join(home, "data"), { recursive: true });
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(
    join(home, ".tasks.toml"),
    'backend = "markdown"\n\n[markdown]\npath = "data/backlog.md"\narchive = "data/done-archive.md"\ndone_keep = 10\n',
  );
  await writeFile(join(home, "data/backlog.md"), "# Backlog\n\n");
  await writeFile(join(home, "config/backlog-backend"), "markdown\n");
  return home;
}

async function createFakeBins(
  root: string,
  options: { mutateTasksReady?: boolean } = {},
): Promise<{ ctx: string; tasks: string; git: string }> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const ctx = await writeExecutable(
    join(bin, "ctx"),
    `if (process.argv[2] === "--version") { console.log("ctx 9.9.9"); process.exit(0); }\nif (process.argv[2] === "--help") { console.log("Usage: ctx [OPTIONS] COMMAND"); process.exit(0); }\nconsole.error("unexpected ctx args", process.argv.slice(2).join(" ")); process.exit(2);\n`,
  );
  const git = await writeExecutable(
    join(bin, "git"),
    `if (process.argv[2] === "--version") { console.log("git version 9.9.9"); process.exit(0); }\nprocess.exit(2);\n`,
  );
  const mutation = options.mutateTasksReady
    ? `const fs = await import("node:fs"); const path = await import("node:path"); fs.appendFileSync(path.join(process.cwd(), "data/backlog.md"), "mutated\\n");`
    : "";
  const tasks = await writeExecutable(
    join(bin, "tasks-axi"),
    `if (process.argv[2] === "--version") { console.log("0.0.0-test"); process.exit(0); }\nif (process.argv[2] === "--help") { console.log("usage: tasks-axi [command] [args]"); process.exit(0); }\nif (process.argv[2] === "ready") { ${mutation} console.log("count: 1\\nready[1]: fixture-alpha"); process.exit(0); }\nconsole.error("unexpected tasks args", process.argv.slice(2).join(" ")); process.exit(2);\n`,
  );
  return { ctx, tasks, git };
}

async function writeExecutable(path: string, body: string): Promise<string> {
  await writeFile(path, `#!/usr/bin/env node\n${body}`);
  await chmod(path, 0o755);
  return path;
}

async function runFactory(args: string[]): Promise<SpawnResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      },
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
    child.on("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}
