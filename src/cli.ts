#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectFirstmateHome, FirstmateHomeError } from "./adapters/firstmate-home.js";
import { probeCtx, summarize, type CommandSummary } from "./adapters/ctx.js";
import { probeTasksAxi, TasksAxiError } from "./adapters/tasks-axi.js";
import { resolveExecutable, runCommand, type ExecutableResolution } from "./adapters/process.js";

const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 8_000;

interface CliOptions {
  command: string | null;
  json: boolean;
  home: string | null;
  root: string;
  timeoutMs: number;
  bins: Record<string, string | undefined>;
}

interface ToolProbe {
  ok: boolean;
  required: boolean;
  resolution: ExecutableResolution;
  version?: CommandSummary;
}

interface DoctorReport {
  schema_version: 1;
  ok: boolean;
  command: "doctor";
  checked_at: string;
  root: string;
  tools: Record<string, ToolProbe>;
  integrations: {
    firstmate_home: Awaited<ReturnType<typeof inspectFirstmateHome>>;
    ctx: Awaited<ReturnType<typeof probeCtx>>;
    tasks_axi: Awaited<ReturnType<typeof probeTasksAxi>>;
  };
}

interface JsonError {
  schema_version: 1;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, exitCode: number, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options = defaultOptions();
  try {
    options = parseArgs(argv);
    if (options.command !== "doctor") {
      throw new CliError("INVALID_COMMAND", "Expected command: doctor", 2, {
        command: options.command,
      });
    }
    const report = await runDoctor(options);
    writeOutput(options.json, report);
    return report.ok ? 0 : 3;
  } catch (error) {
    const normalized = normalizeError(error);
    const json = options.json || argv.includes("--json");
    writeError(json, normalized);
    return normalized.exitCode;
  }
}

async function runDoctor(options: CliOptions): Promise<DoctorReport> {
  if (options.home === null) {
    throw new CliError("VALIDATION_ERROR", "doctor requires --home <disposable-Firstmate-home>", 2);
  }

  const root = await canonicalRoot(options.root);
  const firstmateHome = await inspectFirstmateHome(options.home);

  const toolChecks: Record<string, ToolProbe> = {};
  toolChecks.node = await probeVersionTool("node", process.execPath, true, ["--version"], root, {
    source: "process",
  });
  toolChecks.git = await resolveAndProbe(
    "git",
    true,
    options.bins.git,
    ["--version"],
    root,
    options.timeoutMs,
  );
  toolChecks.ctx = await resolveAndProbe(
    "ctx",
    true,
    options.bins.ctx,
    ["--version"],
    root,
    options.timeoutMs,
  );
  toolChecks["tasks-axi"] = await resolveAndProbe(
    "tasks-axi",
    true,
    options.bins["tasks-axi"],
    ["--version"],
    firstmateHome.path,
    options.timeoutMs,
  );
  toolChecks.pi = await resolveAndProbe(
    "pi",
    false,
    options.bins.pi,
    ["--version"],
    root,
    options.timeoutMs,
  );
  toolChecks.herdr = await resolveAndProbe(
    "herdr",
    false,
    options.bins.herdr,
    ["--version"],
    root,
    options.timeoutMs,
  );
  toolChecks.treehouse = await resolveAndProbe(
    "treehouse",
    false,
    options.bins.treehouse,
    ["--version"],
    root,
    options.timeoutMs,
  );
  toolChecks["no-mistakes"] = await resolveAndProbe(
    "no-mistakes",
    false,
    options.bins["no-mistakes"],
    ["--version"],
    root,
    options.timeoutMs,
  );

  assertRequiredTool(toolChecks.ctx, "ctx");
  assertRequiredTool(toolChecks["tasks-axi"], "tasks-axi");
  assertRequiredTool(toolChecks.git, "git");

  const ctxPath = toolChecks.ctx.resolution.path;
  const tasksPath = toolChecks["tasks-axi"].resolution.path;
  if (ctxPath === null || tasksPath === null) {
    throw new CliError("TOOL_UNAVAILABLE", "Required tool resolution unexpectedly missing", 3);
  }

  const ctx = await probeCtx({ ctxPath, root, timeoutMs: options.timeoutMs });
  const tasksAxi = await probeTasksAxi({
    tasksPath,
    home: firstmateHome,
    timeoutMs: options.timeoutMs,
  });

  return {
    schema_version: SCHEMA_VERSION,
    ok: ctx.ok && tasksAxi.ok,
    command: "doctor",
    checked_at: new Date().toISOString(),
    root,
    tools: toolChecks,
    integrations: {
      firstmate_home: firstmateHome,
      ctx,
      tasks_axi: tasksAxi,
    },
  };
}

async function canonicalRoot(rootInput: string): Promise<string> {
  try {
    return await realpath(resolve(rootInput));
  } catch (error) {
    throw new CliError("VALIDATION_ERROR", "--root must point to an existing path", 2, {
      root: resolve(rootInput),
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveAndProbe(
  name: string,
  required: boolean,
  overridePath: string | undefined,
  versionArgs: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ToolProbe> {
  const resolution = await resolveExecutable(name, overridePath);
  if (!resolution.found || resolution.path === null) return { ok: false, required, resolution };
  return await probeVersionTool(
    name,
    resolution.path,
    required,
    versionArgs,
    cwd,
    resolution,
    timeoutMs,
  );
}

async function probeVersionTool(
  name: string,
  path: string,
  required: boolean,
  versionArgs: string[],
  cwd: string,
  resolution: Pick<ExecutableResolution, "source">,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolProbe> {
  const version = summarize(await runCommand(path, versionArgs, { cwd, timeoutMs }));
  return {
    ok: version.exit_code === 0,
    required,
    resolution: { name, path, found: true, source: resolution.source },
    version,
  };
}

function assertRequiredTool(tool: ToolProbe | undefined, name: string): void {
  if (tool?.ok && tool.resolution.path !== null) return;
  throw new CliError("TOOL_UNAVAILABLE", `Required tool is unavailable: ${name}`, 3, {
    tool: name,
    resolution: tool?.resolution,
    version: tool?.version,
  });
}

function defaultOptions(): CliOptions {
  return {
    command: null,
    json: false,
    home: null,
    root: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    bins: {},
  };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = defaultOptions();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("-") && options.command === null) {
      options.command = arg;
      continue;
    }
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--home":
        options.home = readValue(argv, ++index, arg);
        break;
      case "--root":
        options.root = readValue(argv, ++index, arg);
        break;
      case "--ctx-bin":
        options.bins.ctx = readValue(argv, ++index, arg);
        break;
      case "--tasks-bin":
        options.bins["tasks-axi"] = readValue(argv, ++index, arg);
        break;
      case "--git-bin":
        options.bins.git = readValue(argv, ++index, arg);
        break;
      case "--pi-bin":
        options.bins.pi = readValue(argv, ++index, arg);
        break;
      case "--herdr-bin":
        options.bins.herdr = readValue(argv, ++index, arg);
        break;
      case "--treehouse-bin":
        options.bins.treehouse = readValue(argv, ++index, arg);
        break;
      case "--no-mistakes-bin":
        options.bins["no-mistakes"] = readValue(argv, ++index, arg);
        break;
      case "--timeout-ms": {
        const value = Number.parseInt(readValue(argv, ++index, arg), 10);
        if (!Number.isFinite(value) || value <= 0) {
          throw new CliError("VALIDATION_ERROR", "--timeout-ms must be a positive integer", 2);
        }
        options.timeoutMs = value;
        break;
      }
      case "--help":
      case "-h":
        throw new CliError("HELP", helpText(), 0);
      default:
        throw new CliError("VALIDATION_ERROR", `Unknown argument: ${arg}`, 2);
    }
  }

  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new CliError("VALIDATION_ERROR", `${flag} requires a value`, 2);
  }
  return value;
}

function writeOutput(json: boolean, report: DoctorReport): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "Factory doctor",
      `root: ${report.root}`,
      `home: ${report.integrations.firstmate_home.path}`,
      `ctx: ${report.integrations.ctx.ok ? "ok" : "failed"}`,
      `tasks-axi: ${report.integrations.tasks_axi.ok ? "ok" : "failed"}`,
    ].join("\n") + "\n",
  );
}

function writeError(json: boolean, error: CliError): void {
  if (error.code === "HELP" && !json) {
    process.stdout.write(`${error.message}\n`);
    return;
  }
  const payload: JsonError = {
    schema_version: SCHEMA_VERSION,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stderr.write(`${payload.error.code}: ${payload.error.message}\n`);
}

function normalizeError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof FirstmateHomeError) {
    return new CliError(error.code, error.message, error.exitCode, error.details);
  }
  if (error instanceof TasksAxiError) {
    return new CliError(error.code, error.message, error.exitCode, error.details);
  }
  return new CliError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), 1);
}

function helpText(): string {
  return `usage: factory doctor --home <disposable-firstmate-home> [--json]\n\nRead-only CP-00 integration boundary probe.\n\nOptions:\n  --root <path>              Project root to inspect (default: cwd)\n  --home <path>              Disposable Firstmate home to inspect (required)\n  --ctx-bin <path>           Override ctx executable\n  --tasks-bin <path>         Override tasks-axi executable\n  --json                     Print one schema_version=1 JSON object`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
