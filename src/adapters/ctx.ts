import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand, trimOutput, type CommandResult } from "./process.js";

export interface CtxCheck {
  ok: boolean;
  path: string;
  version: CommandSummary;
  help: CommandSummary;
  status: CommandSummary | SkippedCheck;
  doctor: CommandSummary | SkippedCheck;
}

export interface CommandSummary {
  command: string;
  args: string[];
  cwd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  json?: unknown;
}

export interface SkippedCheck {
  skipped: true;
  reason: string;
}

export async function probeCtx(options: {
  ctxPath: string;
  root: string;
  timeoutMs: number;
}): Promise<CtxCheck> {
  const runOptions = { cwd: options.root, timeoutMs: options.timeoutMs };
  const version = summarize(await runCommand(options.ctxPath, ["--version"], runOptions));
  const help = summarize(await runCommand(options.ctxPath, ["--help"], runOptions));

  let status: CommandSummary | SkippedCheck = {
    skipped: true,
    reason: "root has no .ctx directory; CP-00 doctor does not initialize CTX automatically",
  };
  let doctor: CommandSummary | SkippedCheck = {
    skipped: true,
    reason: "root has no .ctx directory; CP-00 doctor does not initialize CTX automatically",
  };

  if (await hasCtxDirectory(options.root)) {
    status = summarize(
      await runCommand(options.ctxPath, ["status", "--root", options.root, "--json"], runOptions),
      true,
    );
    doctor = summarize(
      await runCommand(
        options.ctxPath,
        ["doctor", "--offline", "--root", options.root, "--json"],
        runOptions,
      ),
      true,
    );
  }

  return {
    ok: version.exit_code === 0 && help.exit_code === 0,
    path: options.ctxPath,
    version,
    help,
    status,
    doctor,
  };
}

async function hasCtxDirectory(root: string): Promise<boolean> {
  try {
    const info = await stat(resolve(root, ".ctx"));
    return info.isDirectory();
  } catch {
    return false;
  }
}

export function summarize(result: CommandResult, parseJson = false): CommandSummary {
  const summary: CommandSummary = {
    command: result.command,
    args: result.args,
    cwd: result.cwd,
    exit_code: result.exit_code,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
    duration_ms: result.duration_ms,
    timed_out: result.timed_out,
  };
  if (parseJson && result.stdout.trim().length > 0) {
    try {
      summary.json = JSON.parse(result.stdout) as unknown;
    } catch {
      // Keep raw output only when JSON parsing fails.
    }
  }
  return summary;
}
