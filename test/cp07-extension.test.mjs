import assert from "node:assert/strict";
import test from "node:test";

// The shipped source entry is also what Pi loads (not an emitted dist extension).
const entry = new URL("../extensions/factory.ts", import.meta.url);

async function harness(
  result = {
    stdout: "DUMMY stdout\n",
    stderr: "DUMMY stderr\n",
    code: 3,
    killed: false,
  },
) {
  const { default: register } = await import(entry.href);
  const commands = new Map();
  const executions = [];
  const messages = [];
  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    async exec(command, args, options) {
      executions.push({ command, args, options });
      return result;
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  register(pi);
  assert.deepEqual([...commands.keys()], ["factory"]);
  assert.equal(executions.length, 0, "registration must not start a process");
  return {
    executions,
    messages,
    async invoke(args) {
      await commands.get("factory").handler(args, { cwd: "/DUMMY project with spaces" });
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
    const h = await harness();
    await h.invoke(args);
    assert.equal(h.executions.length, 0);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].message.details.exit_code, 2);
    assert.match(h.messages[0].message.details.stderr, /FACTORY_ARGUMENT_ERROR/);
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
    const h = await harness();
    await h.invoke(args);
    assert.equal(h.executions.length, 1);
    assert.equal(h.executions[0].args.slice(1).join(" "), args);
    assert.deepEqual(h.messages[0].message.details, {
      stdout: "DUMMY stdout\n",
      stderr: "DUMMY stderr\n",
      exit_code: 3,
      killed: false,
    });
    assert.equal(h.messages[0].options.triggerTurn, false);
  });
}

test("quoted/escaped spaces, empty values, Windows backslashes and shell metacharacters stay argv data", async () => {
  const h = await harness();
  await h.invoke(
    'context "TASK;touch DUMMY" --root "/DUMMY project/$(touch X)" --ctx-bin C:\\tools\\ctx.exe --byte-budget 16000',
  );
  assert.deepEqual(h.executions[0].args.slice(1), [
    "context",
    "TASK;touch DUMMY",
    "--root",
    "/DUMMY project/$(touch X)",
    "--ctx-bin",
    "C:\\tools\\ctx.exe",
    "--byte-budget",
    "16000",
  ]);
  assert.equal(h.executions[0].command, process.execPath);
  assert.equal(h.executions[0].options.cwd, "/DUMMY project with spaces");
  assert.ok(h.executions[0].args[0].endsWith("/dist/src/cli.js"));
  await h.invoke("validate --root /DUMMY\\ project --json");
  assert.deepEqual(h.executions[1].args.slice(1), [
    "validate",
    "--root",
    "/DUMMY project",
    "--json",
  ]);
  await h.invoke("validate --root ''");
  assert.deepEqual(h.executions[2].args.slice(1), ["validate", "--root", ""]);
});

test("sequential calls hold no task state and retain full output without truncation", async () => {
  const stdout = "DUMMY".repeat(50_000) + "\n";
  const stderr = "DUMMY diagnostic\n";
  const h = await harness({ stdout, stderr, code: 2, killed: false });
  await h.invoke("status --json");
  await h.invoke("validate");
  assert.equal(h.executions.length, 2);
  assert.equal(h.messages.length, 2);
  for (const { message } of h.messages) {
    assert.deepEqual(message.details, { stdout, stderr, exit_code: 2, killed: false });
    assert.equal(message.content, stdout + stderr + "exit: 2");
  }
});
