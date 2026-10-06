import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// The shipped source entry is also what Pi loads (not an emitted dist extension).
const entry = new URL("../extensions/factory.ts", import.meta.url);
const extension = await import(entry.href);
const scratch = await mkdtemp(join(tmpdir(), "factory CP07 extension DUMMY "));
test.after(() => rm(scratch, { recursive: true, force: true }));

async function dummyCli(name, source) {
  const path = join(scratch, `${name}.mjs`);
  await writeFile(path, source);
  return path;
}

const echoCli = await dummyCli(
  "echo cli",
  `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.stderr.write("DUMMY stderr\\n");
process.exitCode = 3;
`,
);

function harness(host = {}) {
  const commands = new Map();
  const messages = [];
  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  extension.registerFactory(pi, {
    cli: echoCli,
    execPath: process.execPath,
    bun: undefined,
    sea: false,
    ...host,
  });
  assert.deepEqual([...commands.keys()], ["factory"]);
  return {
    messages,
    async invoke(args, cwd = scratch) {
      await commands.get("factory").handler(args, { cwd });
      return messages.at(-1).message;
    },
  };
}

for (const args of [
  "",
  "run",
  "sync --apply",
  "doctor",
  "inspect X",
  "validate --root 'unterminated",
  'validate --root "unterminated',
  "validate\0",
]) {
  test(`reject wrapper syntax/unsupported command: ${JSON.stringify(args)}`, async () => {
    const h = harness();
    const message = await h.invoke(args);
    assert.equal(h.messages.length, 1);
    assert.equal(message.details.exit_code, 2);
    assert.equal(message.details.stdout, "");
    assert.match(message.details.stderr, /^FACTORY_ARGUMENT_ERROR: /);
    assert.equal(message.content, message.details.stderr + "exit: 2");
  });
}

for (const args of [
  "context",
  "context X extra",
  "validate extra",
  "status extra",
  "validate --root",
  "context X --token-budget 0",
  "status --unsupported",
]) {
  test(`delegate CLI argument diagnostic unchanged: ${args}`, async () => {
    const h = harness();
    const message = await h.invoke(args);
    assert.deepEqual(message.details, {
      stdout: JSON.stringify({ argv: args.split(" "), cwd: scratch }) + "\n",
      stderr: "DUMMY stderr\n",
      exit_code: 3,
      signal: null,
      killed: false,
    });
    assert.equal(message.content, message.details.stdout + "DUMMY stderr\nexit: 3");
    assert.equal(h.messages[0].options.triggerTurn, false);
  });
}

test("quoted/escaped spaces, empty values, Windows backslashes and shell metacharacters stay argv data", async () => {
  const h = harness();
  const argv = async (input) => JSON.parse((await h.invoke(input)).details.stdout).argv;
  assert.deepEqual(
    await argv(
      'context "TASK;touch DUMMY" --root "/DUMMY project/$(touch X)" --ctx-bin C:\\tools\\ctx.exe --byte-budget 16000',
    ),
    [
      "context",
      "TASK;touch DUMMY",
      "--root",
      "/DUMMY project/$(touch X)",
      "--ctx-bin",
      "C:\\tools\\ctx.exe",
      "--byte-budget",
      "16000",
    ],
  );
  await assert.rejects(stat(join(scratch, "X")));
  assert.deepEqual(await argv("validate --root /DUMMY\\ project --json"), [
    "validate",
    "--root",
    "/DUMMY project",
    "--json",
  ]);
  assert.deepEqual(await argv("validate --root ''"), ["validate", "--root", ""]);
});

test("sequential calls hold no task state and retain full output without truncation", async () => {
  const stdout = "DUMMY".repeat(50_000) + "\n";
  const cli = await dummyCli(
    "large",
    `process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write("DUMMY diagnostic\\n");
process.exitCode = 2;
`,
  );
  const h = harness({ cli });
  await h.invoke("status --json");
  await h.invoke("validate");
  assert.equal(h.messages.length, 2);
  for (const { message } of h.messages) {
    assert.deepEqual(message.details, {
      stdout,
      stderr: "DUMMY diagnostic\n",
      exit_code: 2,
      signal: null,
      killed: false,
    });
    assert.equal(message.content, stdout + "DUMMY diagnostic\nexit: 2");
  }
});

test("multi-byte UTF-8 split across pipe chunks is decoded exactly once", async () => {
  const text = "DUMMY — ✓ 🏭 ".repeat(30_000);
  const cli = await dummyCli(
    "utf8",
    `const bytes = Buffer.from(${JSON.stringify(text)});
const split = bytes.indexOf(Buffer.from("—")) + 1;
const write = (stream, chunk) => new Promise((done) => stream.write(chunk, done));
const pause = () => new Promise((done) => setTimeout(done, 50));
for (const stream of [process.stdout, process.stderr]) {
  await write(stream, bytes.subarray(0, split));
  await pause();
  await write(stream, bytes.subarray(split, 65_537));
  await pause();
  await write(stream, bytes.subarray(65_537));
}
`,
  );
  const message = await harness({ cli }).invoke("context X");
  assert.equal(message.details.exit_code, 0);
  assert.ok(!message.details.stdout.includes("\uFFFD"));
  assert.equal(message.details.stdout, text);
  assert.equal(message.details.stderr, text);
});

test("a signal-terminated CLI is reported as a signal failure, not exit 0", async () => {
  const cli = await dummyCli(
    "signal",
    `process.stdout.write("DUMMY partial\\n", () => process.kill(process.pid, "SIGKILL"));`,
  );
  const message = await harness({ cli }).invoke("status");
  assert.deepEqual(message.details, {
    stdout: "DUMMY partial\n",
    stderr: "",
    exit_code: 137,
    signal: "SIGKILL",
    killed: true,
  });
  assert.equal(message.content, "DUMMY partial\nexit: 137 (signal SIGKILL)");
});

test("a non-Node Pi host executable is never invoked as the Factory interpreter", async () => {
  const marker = join(scratch, "nested pi ran");
  const fakePi = join(scratch, "pi");
  await writeFile(fakePi, `#!/bin/sh\ntouch "${marker}"\n`);
  await chmod(fakePi, 0o755);
  for (const host of [
    { execPath: fakePi },
    { execPath: fakePi, bun: "1.3.0" },
    { bun: "1.3.0" },
    { sea: true },
  ]) {
    const message = await harness(host).invoke("status");
    assert.equal(message.details.exit_code, 3);
    assert.equal(message.details.stdout, "");
    assert.match(
      message.details.stderr,
      /^FACTORY_RUNTIME_UNAVAILABLE: .*not a Node\.js interpreter/,
    );
  }
  await assert.rejects(stat(marker));
});

test("an unavailable working directory is a runtime failure, not success", async () => {
  const { details } = await harness().invoke("status", join(scratch, "absent DUMMY"));
  assert.equal(details.exit_code, 3);
  assert.match(details.stderr, /^FACTORY_RUNTIME_UNAVAILABLE: /);
});

test("default registration runs the built CLI with the current Node and matches it exactly", async () => {
  const messages = [];
  let handler;
  extension.default({
    registerCommand: (_name, command) => (handler = command.handler),
    sendMessage: (message) => messages.push(message),
  });
  assert.equal(messages.length, 0, "registration must not start a process");
  await handler("status DUMMY-EXTRA", { cwd: scratch });
  const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
  const direct = await promisify(execFile)(process.execPath, [cli, "status", "DUMMY-EXTRA"], {
    cwd: scratch,
  }).catch((error) => error);
  assert.deepEqual(messages[0].details, {
    stdout: direct.stdout,
    stderr: direct.stderr,
    exit_code: direct.code,
    signal: null,
    killed: false,
  });
  assert.equal(direct.code, 2);
});
