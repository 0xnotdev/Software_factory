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
  json_parse_error?: string;
}

export interface SkippedCheck {
  skipped: true;
  reason: string;
}

export interface CtxJsonInvocation {
  summary: CommandSummary;
  json: Record<string, unknown> | null;
}

export async function invokeCtxJson(options: {
  ctxPath: string;
  root: string;
  args: string[];
  timeoutMs: number;
}): Promise<CtxJsonInvocation> {
  const summary = summarize(
    await runCommand(options.ctxPath, options.args, {
      cwd: options.root,
      timeoutMs: options.timeoutMs,
    }),
    true,
  );
  const json = isObject(summary.json) ? summary.json : null;
  if (summary.json !== undefined && json === null && summary.json_parse_error === undefined) {
    summary.json_parse_error = "expected one JSON object on stdout";
  }
  return { summary, json };
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
    ok:
      version.exit_code === 0 &&
      help.exit_code === 0 &&
      skippedOrSuccessfulJson(status) &&
      skippedOrSuccessfulJson(doctor),
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
  if (parseJson) {
    if (result.stdout.trim().length === 0) {
      summary.json_parse_error = "expected JSON stdout";
    } else {
      try {
        summary.json = JSON.parse(result.stdout) as unknown;
      } catch (error) {
        summary.json_parse_error = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return summary;
}

function skippedOrSuccessfulJson(check: CommandSummary | SkippedCheck): boolean {
  if ("skipped" in check) return true;
  return check.exit_code === 0 && check.json_parse_error === undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
