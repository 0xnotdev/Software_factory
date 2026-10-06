import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// Pi loads this source entry from the package manifest, not dist/extensions/.
const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const usage = "usage: /factory status | validate | context <ID> [Factory CLI options]";

// Quoting is only argv framing. No expansion, interpolation, or shell evaluation.
function argumentsFor(input: string): string[] {
  if (input.includes("\0")) throw new Error("NUL is not an argument");
  const args: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];
    if (
      char === "\\" &&
      quote !== "'" &&
      next !== undefined &&
      (next === "\\" || next === '"' || next === "'" || /\s/.test(next))
    ) {
      word += next;
      started = true;
      i++;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unterminated quote");
  if (started) args.push(word);
  if (!["status", "validate", "context"].includes(args[0] ?? "")) throw new Error(usage);
  return args;
}

export interface FactoryHost {
  cli: string;
  execPath: string;
  bun: string | undefined;
  sea: boolean;
}

export interface FactoryResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  signal: string | null;
  killed: boolean;
}

function singleExecutable(): boolean {
  try {
    const sea = process.getBuiltinModule("node:sea") as { isSea(): boolean } | undefined;
    return sea?.isSea() ?? false;
  } catch {
    return true;
  }
}

// A Bun-compiled or bundled Pi binary is not a Node interpreter: running it with
// the CLI path would start a nested Pi prompt, so fail closed instead.
function isNodeInterpreter(host: FactoryHost): boolean {
  return (
    host.bun === undefined &&
    !host.sea &&
    /^node(js)?(-?\d+(\.\d+)*)?(\.exe)?$/i.test(basename(host.execPath))
  );
}

function failure(code: string, message: string, exitCode: number): FactoryResult {
  return {
    stdout: "",
    stderr: `${code}: ${message}\n`,
    exit_code: exitCode,
    signal: null,
    killed: false,
  };
}

// Streams are decoded once after close so multi-byte characters split across
// pipe chunks stay intact; a signal is reported as such, never as success.
function runCli(command: string, args: string[], cwd: string): Promise<FactoryResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) =>
      resolve(failure("FACTORY_RUNTIME_UNAVAILABLE", error.message, 3)),
    );
    child.once("close", (code, signal) =>
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exit_code: code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0),
        signal,
        killed: signal !== null,
      }),
    );
  });
}

async function invoke(host: FactoryHost, input: string, cwd: string): Promise<FactoryResult> {
  let args: string[];
  try {
    args = argumentsFor(input);
  } catch (error) {
    return failure("FACTORY_ARGUMENT_ERROR", (error as Error).message, 2);
  }
  if (!isNodeInterpreter(host)) {
    return failure(
      "FACTORY_RUNTIME_UNAVAILABLE",
      `Pi host ${host.execPath} is not a Node.js interpreter; run the Factory CLI directly with Node`,
      3,
    );
  }
  // One awaited foreground CLI. It owns validation, canonical roots, budgets,
  // integration timeouts and errors. Registration/reload starts nothing.
  return runCli(host.execPath, [host.cli, ...args], cwd);
}

export function registerFactory(pi: ExtensionAPI, host: FactoryHost): void {
  pi.registerCommand("factory", {
    description: "Factory CLI: status, validate, context <ID> (no dispatch)",
    handler: async (input, ctx) => {
      const result = await invoke(host, input, ctx.cwd);
      const status = `exit: ${result.exit_code}${result.signal ? ` (signal ${result.signal})` : ""}`;
      pi.sendMessage(
        {
          customType: "factory-result",
          display: true,
          content: `${result.stdout}${result.stderr}${status}`,
          details: result,
        },
        { triggerTurn: false },
      );
    },
  });
}

export default function factory(pi: ExtensionAPI): void {
  registerFactory(pi, {
    cli,
    execPath: process.execPath,
    bun: process.versions.bun,
    sea: singleExecutable(),
  });
}
