import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist/src/cli.js");

export async function smoke(packageRoot) {
  const sdk = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
  const version = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
  const scratch = await mkdtemp(join(tmpdir(), "factory CP07 DUMMY "));
  const agentDir = join(scratch, "agent");
  const project = join(scratch, "project");
  const cases = [];
  const children = async () =>
    process.platform === "linux"
      ? (await readFile(`/proc/self/task/${process.pid}/children`, "utf8")).trim()
      : null;
  const initialChildren = await children();
  let session;
  let agentStarts = 0;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("CP07 smoke prohibits network");
  };
  try {
    await mkdir(agentDir);
    await mkdir(join(project, ".factory/tasks"), { recursive: true });
    for (const [source, target] of [
      ["project.yaml", ".factory/project.yaml"],
      ["completion.yaml", ".factory/completion.yaml"],
      ["task.yaml", ".factory/tasks/CTX-001.yaml"],
      ["PROJECT.md", "PROJECT.md"],
      ["ARCHITECTURE.md", "ARCHITECTURE.md"],
    ]) {
      await cp(join(root, "test/fixtures/ctx", source), join(project, target));
    }
    await writeFile(join(project, ".gitignore"), ".factory/state/\n.ctx/\n");
    await exec("git", ["init", "--quiet", project]);
    await exec(process.execPath, [cli, "init", "--root", project, "--json"]);
    await exec("git", ["-C", project, "add", "."]);
    await exec("git", [
      "-C",
      project,
      "-c",
      "user.name=CP07 DUMMY",
      "-c",
      "user.email=cp07@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "DUMMY fixture",
    ]);
    const settingsManager = sdk.SettingsManager.inMemory({
      packages: [root],
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload({ resolveProjectTrust: async () => true });
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    assert.equal(
      loader.getSkills().skills.filter((s) => s.name === "factory" && s.filePath.startsWith(root))
        .length,
      1,
    );
    const runtime = await sdk.ModelRuntime.create({
      credentials: {
        get: async () => undefined,
        list: async () => [],
        modify: async () => {
          throw new Error("no credentials");
        },
        delete: async () => {
          throw new Error("no credentials");
        },
      },
      modelsPath: null,
      modelsStorePath: join(agentDir, "catalog.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    // No provider request occurs: every input is consumed by the registered command.
    ({ session } = await sdk.createAgentSession({
      cwd: project,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      modelRuntime: runtime,
      model: runtime.getModels()[0],
      noTools: true,
      sessionManager: sdk.SessionManager.inMemory(project),
    }));
    await session.bindExtensions({});
    session.subscribe((event) => {
      if (event.type === "agent_start") agentStarts++;
    });
    assert.equal(
      await children(),
      initialChildren,
      "package load must not create a background child",
    );
    const command = () =>
      session.extensionRunner.getRegisteredCommands().filter((c) => c.name === "factory");
    assert.equal(command().length, 1);
    const initialRegistration = command()[0];

    async function parity(text, argv, expectedCode) {
      let direct;
      try {
        const r = await exec(process.execPath, [cli, ...argv], {
          cwd: project,
          maxBuffer: 8_000_000,
        });
        direct = { stdout: r.stdout, stderr: r.stderr, exit_code: 0 };
      } catch (e) {
        direct = { stdout: e.stdout, stderr: e.stderr, exit_code: e.code };
      }
      assert.equal(direct.exit_code, expectedCode, direct.stdout + direct.stderr);
      await session.prompt(`/factory ${text}`);
      const result = session.messages.at(-1);
      assert.equal(result.customType, "factory-result");
      assert.deepEqual(
        {
          stdout: result.details.stdout,
          stderr: result.details.stderr,
          exit_code: result.details.exit_code,
        },
        direct,
      );
      assert.equal(result.details.killed, false);
      assert.equal(await children(), initialChildren, "CLI must be reaped before command returns");
      cases.push({ input: `/factory ${text}`, exit_code: expectedCode, exact_stdout_stderr: true });
    }

    for (const [text, argv] of [
      ["context", ["context"]],
      ["validate extra", ["validate", "extra"]],
      ["status extra", ["status", "extra"]],
      ["context X extra", ["context", "X", "extra"]],
      ["validate --root", ["validate", "--root"]],
      ["status --unsupported --json", ["status", "--unsupported", "--json"]],
      ["context X --token-budget 0 --json", ["context", "X", "--token-budget", "0", "--json"]],
    ])
      await parity(text, argv, 2);
    for (const text of ["", "run", "sync --apply", "validate --root 'unfinished"]) {
      await session.prompt(`/factory${text ? " " + text : ""}`);
      assert.equal(session.messages.at(-1).details.exit_code, 2);
      cases.push({ input: `/factory ${text}`, exit_code: 2, wrapper_rejection: true });
    }
    await parity("validate", ["validate"], 0);
    await parity(
      `validate --root "${project}" --json`,
      ["validate", "--root", project, "--json"],
      0,
    );
    await parity("status", ["status"], 0);
    await parity("status --json", ["status", "--json"], 0);
    await parity(
      `status --home "${join(scratch, "absent home")}" --json`,
      ["status", "--home", join(scratch, "absent home"), "--json"],
      3,
    );
    await parity(
      `context CTX-001 --ctx-bin "${join(scratch, "absent ctx")}" --json`,
      ["context", "CTX-001", "--ctx-bin", join(scratch, "absent ctx"), "--json"],
      3,
    );
    await writeFile(join(project, ".factory/tasks/BROKEN.yaml"), "schema_version: 999\n");
    await parity("validate --json", ["validate", "--json"], 2);
    await rm(join(project, ".factory/tasks/BROKEN.yaml"));
    if (process.env.CP07_REAL_CTX === "1") {
      const ctxEnv = { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
      for (const argv of [
        ["init", project, "--json"],
        [
          "add",
          "PROJECT.md",
          "--root",
          project,
          "--authority",
          "normative",
          "--priority",
          "100",
          "--json",
        ],
        [
          "add",
          "ARCHITECTURE.md",
          "--root",
          project,
          "--authority",
          "normative",
          "--priority",
          "100",
          "--json",
        ],
        ["index", "--root", project, "--json"],
      ]) {
        await exec("ctx", argv, {
          cwd: project,
          env: ctxEnv,
          timeout: 120_000,
          maxBuffer: 8_000_000,
        });
      }
      await parity("context CTX-001", ["context", "CTX-001"], 0);
      await parity("context CTX-001 --json", ["context", "CTX-001", "--json"], 0);
      await session.prompt("/factory context CTX-001 --json");
      const result = JSON.parse(session.messages.at(-1).details.stdout);
      assert.equal(session.messages.at(-1).details.exit_code, 0);
      assert.equal(result.ctx.retrieval_mode, "HYBRID_SEMANTIC");
      assert.ok(result.bytes <= result.byte_budget);
      assert.ok(result.estimated_tokens <= result.token_budget);
      assert.deepEqual(Object.keys(result.source_digests).sort(), [
        "ARCHITECTURE.md",
        "PROJECT.md",
      ]);
      cases.push({
        input: "/factory context CTX-001 --json",
        exit_code: 0,
        semantic: true,
        bounded: true,
        exact_source_scope: true,
      });
      await parity(
        "context CTX-001 --token-budget 1 --json",
        ["context", "CTX-001", "--token-budget", "1", "--json"],
        3,
      );
      await writeFile(join(project, "PROJECT.md"), "# Changed authoritative original\n");
      await parity("context CTX-001 --json", ["context", "CTX-001", "--json"], 3);
    }
    await session.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(command().length, 1);
    assert.notEqual(command()[0], initialRegistration, "reload must replace the command runtime");
    await parity("validate --json", ["validate", "--json"], 0);
    await parity("status", ["status"], 0);
    assert.equal(networkCalls, 0);
    assert.equal(agentStarts, 0);
    assert.equal(await children(), initialChildren, "reload must not create a background child");
    return {
      pi_version: version,
      package_root: packageRoot,
      discovery: "settings packages local path",
      reload: "await session.reload()",
      reload_replaced_runtime: true,
      model_requests: agentStarts,
      network_calls: networkCalls,
      background_children: initialChildren === null ? "unverified on this platform" : 0,
      real_ctx: process.env.CP07_REAL_CTX === "1",
      cases,
    };
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const packageRoot = resolve(
    process.env.CP07_PI_PACKAGE_ROOT ?? join(root, "node_modules/@earendil-works/pi-coding-agent"),
  );
  console.log(JSON.stringify(await smoke(packageRoot), null, 2));
}
