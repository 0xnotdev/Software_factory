#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectFirstmateHome,
  inspectRegisteredProject,
  FirstmateHomeError,
} from "./adapters/firstmate-home.js";
import { probeCtx, summarize, type CommandSummary } from "./adapters/ctx.js";
import {
  assertBacklogHash,
  createPublishedTask,
  inspectPublishedTask,
  probeTasksAxi,
  probeTasksAxiForSync,
  TasksAxiError,
  type PublishedTask,
} from "./adapters/tasks-axi.js";
import {
  resolveExecutable,
  runCommand,
  sha256File,
  type ExecutableResolution,
} from "./adapters/process.js";
import { ContextIssue, generateContextPack, type ContextResult } from "./core/context.js";
import { initProject, type InitResult } from "./core/init.js";
import { ContractIssue } from "./core/load.js";
import {
  assertPublicationInputsStable,
  loadPublicationInput,
  makePublicationPlan,
  PublicationIssue,
  type PublicationInput,
  type PublicationPlan,
} from "./core/plan.js";
import { validateProject, type ValidationResult } from "./core/validate.js";

const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 8_000;

interface CliOptions {
  command: string | null;
  json: boolean;
  home: string | null;
  root: string;
  timeoutMs: number;
  taskId: string | null;
  tokenBudget: number | null;
  byteBudget: number | null;
  syncMode: "dry-run" | "apply" | null;
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

interface SyncReport {
  schema_version: 1;
  ok: true;
  command: "sync";
  mode: "dry-run" | "apply";
  root: string;
  home: string;
  project: { id: string; repo: string; delivery_mode: string; yolo: boolean };
  backend: { tasks_axi: string; storage: "markdown" };
  backlog: {
    path: string;
    sha256_before: string;
    sha256_after: string;
    unchanged: boolean;
  };
  summary: PublicationPlan["summary"];
  records: PublicationPlan["records"];
  created_ids: string[];
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

interface ValidateReport extends Omit<ValidationResult, "diagnostics"> {
  schema_version: 1;
  ok: true;
  command: "validate";
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
    if (options.command === "doctor") {
      const report = await runDoctor(options);
      writeOutput(options.json, report);
      return report.ok ? 0 : 3;
    }
    if (options.command === "init") {
      const root = await canonicalProjectRoot(options.root);
      writeOutput(options.json, await initProject(root));
      return 0;
    }
    if (options.command === "validate") {
      const root = await canonicalProjectRoot(options.root);
      const validation = await validateProject(root);
      if (validation.diagnostics.length > 0) {
        throw new CliError(
          "VALIDATION_FAILED",
          "Project contracts are invalid",
          2,
          validation.diagnostics,
        );
      }
      const { diagnostics: _diagnostics, ...fields } = validation;
      const report: ValidateReport = {
        schema_version: 1,
        ok: true,
        command: "validate",
        ...fields,
      };
      writeOutput(options.json, report);
      return 0;
    }
    if (options.command === "context") {
      if (options.taskId === null) {
        throw new CliError("VALIDATION_ERROR", "context requires TASK-ID", 2);
      }
      const root = await canonicalProjectRoot(options.root);
      const resolution = await resolveExecutable("ctx", options.bins.ctx);
      if (!resolution.found || resolution.path === null) {
        throw new CliError("TOOL_UNAVAILABLE", "Required tool is unavailable: ctx", 3, {
          tool: "ctx",
          resolution,
        });
      }
      const contextOptions: Parameters<typeof generateContextPack>[0] = {
        root,
        taskId: options.taskId,
        ctxPath: resolution.path,
        timeoutMs: options.timeoutMs,
        ...(options.tokenBudget === null ? {} : { tokenBudget: options.tokenBudget }),
        ...(options.byteBudget === null ? {} : { byteBudget: options.byteBudget }),
      };
      writeOutput(options.json, await generateContextPack(contextOptions));
      return 0;
    }
    if (options.command === "sync") {
      writeOutput(options.json, await runSync(options));
      return 0;
    }
    throw new CliError(
      "INVALID_COMMAND",
      "Expected command: doctor, init, validate, context, or sync",
      2,
      {
        command: options.command,
      },
    );
  } catch (error) {
    const normalized = normalizeError(error);
    const json = options.json || argv.includes("--json");
    writeError(json, normalized);
    return normalized.exitCode;
  }
}

async function runSync(options: CliOptions): Promise<SyncReport> {
  if (options.syncMode === null) {
    throw new CliError("VALIDATION_ERROR", "sync requires exactly one of --dry-run or --apply", 2);
  }
  if (options.home === null) {
    throw new CliError("VALIDATION_ERROR", "sync requires --home <canonical-Firstmate-home>", 2);
  }
  const root = await canonicalProjectRoot(options.root);
  const input = await loadPublicationInput(root);
  const home = await inspectFirstmateHome(options.home);
  const registered = await inspectRegisteredProject(home, root);
  assertDeliveryMatches(input, registered.mode);

  const resolution = await resolveExecutable("tasks-axi", options.bins["tasks-axi"]);
  if (!resolution.found || resolution.path === null) {
    throw new CliError("TOOL_UNAVAILABLE", "Required tool is unavailable: tasks-axi", 3, {
      tool: "tasks-axi",
      resolution,
    });
  }
  const probe = await probeTasksAxiForSync({
    tasksPath: resolution.path,
    home,
    timeoutMs: options.timeoutMs,
  });
  const existing = await inspectAllPublished(input, resolution.path, home, options.timeoutMs);
  await assertBacklogHash(home, probe.backlog_sha256_before);
  await assertPublicationInputsStable(input);
  const plan = makePublicationPlan(input, existing);

  if (options.syncMode === "dry-run") {
    const after = await sha256File(home.markdown.backlog_path);
    return syncReport({
      mode: options.syncMode,
      input,
      home,
      registered,
      tasksVersion: probe.version,
      before: probe.backlog_sha256_before,
      after,
      plan,
      createdIds: [],
    });
  }

  if (plan.summary.conflict > 0 || plan.summary.blocked > 0) {
    throw new PublicationIssue(
      "PUBLICATION_CONFLICT",
      "Publication preflight found conflicts; no tasks were created",
      4,
      { records: plan.records, summary: plan.summary, backlog_sha256: probe.backlog_sha256_before },
    );
  }

  const createdIds: string[] = [];
  let expectedBacklogHash = probe.backlog_sha256_before;
  const creates = input.tasks.filter(
    (item) => plan.records.find((record) => record.task_id === item.task.id)?.action === "create",
  );
  for (const item of creates) {
    try {
      await assertPublicationInputsStable(input);
      await assertBacklogHash(home, expectedBacklogHash);
      const result = await createPublishedTask({
        tasksPath: resolution.path,
        home,
        repo: input.repo,
        item,
        timeoutMs: options.timeoutMs,
      });
      const observed = await inspectPublishedTask({
        tasksPath: resolution.path,
        home,
        id: item.published_id,
        timeoutMs: options.timeoutMs,
      });
      const durable = publishedTaskMatches(input, item.task.id, observed);
      if (durable && !createdIds.includes(item.published_id)) createdIds.push(item.published_id);
      const observedBacklogHash = await sha256File(home.markdown.backlog_path);
      if (result.exit_code !== 0 || !durable) {
        throw new TasksAxiError("TASKS_AXI_WRITE_FAILED", "tasks-axi create did not reconcile", {
          id: item.published_id,
          command: result,
          durable,
        });
      }
      expectedBacklogHash = observedBacklogHash;
    } catch (error) {
      const finalHash = await sha256File(home.markdown.backlog_path);
      if (createdIds.length === 0 && finalHash === expectedBacklogHash) throw error;
      const remainingIds = creates
        .map((candidate) => candidate.published_id)
        .filter((id) => !createdIds.includes(id));
      throw new PublicationIssue(
        "PARTIAL_SYNC",
        "Publication stopped after one or more creates; rerun the same sync to converge",
        3,
        {
          created_ids: createdIds,
          durable_ids: createdIds,
          remaining_ids: remainingIds,
          backlog_sha256: finalHash,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  await assertPublicationInputsStable(input);
  const reconciled = await inspectAllPublished(input, resolution.path, home, options.timeoutMs);
  const finalPlan = makePublicationPlan(input, reconciled);
  if (finalPlan.summary.unchanged !== input.tasks.length) {
    const finalHash = await sha256File(home.markdown.backlog_path);
    throw new PublicationIssue(
      "PARTIAL_SYNC",
      "Post-write reconciliation did not find every publication unchanged",
      3,
      {
        created_ids: createdIds,
        durable_ids: createdIds,
        remaining_ids: finalPlan.records
          .filter((record) => record.action !== "unchanged")
          .map((record) => record.published_id),
        backlog_sha256: finalHash,
        records: finalPlan.records,
      },
    );
  }
  const after = await sha256File(home.markdown.backlog_path);
  return syncReport({
    mode: options.syncMode,
    input,
    home,
    registered,
    tasksVersion: probe.version,
    before: probe.backlog_sha256_before,
    after,
    plan,
    createdIds,
  });
}

async function inspectAllPublished(
  input: PublicationInput,
  tasksPath: string,
  home: Awaited<ReturnType<typeof inspectFirstmateHome>>,
  timeoutMs: number,
): Promise<Map<string, PublishedTask | "duplicate" | null>> {
  const existing = new Map<string, PublishedTask | "duplicate" | null>();
  for (const item of input.tasks) {
    existing.set(
      item.published_id,
      await inspectPublishedTask({ tasksPath, home, id: item.published_id, timeoutMs }),
    );
  }
  return existing;
}

function publishedTaskMatches(
  input: PublicationInput,
  taskId: string,
  observed: PublishedTask | "duplicate" | null,
): boolean {
  const item = input.tasks.find((candidate) => candidate.task.id === taskId);
  if (item === undefined) return false;
  const plan = makePublicationPlan(input, new Map([[item.published_id, observed]]));
  return plan.records.find((record) => record.task_id === taskId)?.action === "unchanged";
}

function assertDeliveryMatches(input: PublicationInput, registeredMode: string): void {
  const conflicts = input.tasks
    .filter(
      (item) =>
        item.task.delivery !== undefined &&
        item.task.delivery !== "project-default" &&
        item.task.delivery !== registeredMode,
    )
    .map((item) => ({ task_id: item.task.id, delivery: item.task.delivery }));
  if (conflicts.length > 0) {
    throw new PublicationIssue(
      "DELIVERY_MODE_CONFLICT",
      "A task delivery request conflicts with the registered Firstmate project mode",
      4,
      { registered_mode: registeredMode, tasks: conflicts },
    );
  }
}

function syncReport(input: {
  mode: "dry-run" | "apply";
  input: PublicationInput;
  home: Awaited<ReturnType<typeof inspectFirstmateHome>>;
  registered: Awaited<ReturnType<typeof inspectRegisteredProject>>;
  tasksVersion: string;
  before: string;
  after: string;
  plan: PublicationPlan;
  createdIds: string[];
}): SyncReport {
  return {
    schema_version: 1,
    ok: true,
    command: "sync",
    mode: input.mode,
    root: input.input.root,
    home: input.home.path,
    project: {
      id: input.input.project.id,
      repo: input.registered.name,
      delivery_mode: input.registered.mode,
      yolo: input.registered.yolo,
    },
    backend: { tasks_axi: input.tasksVersion, storage: "markdown" },
    backlog: {
      path: input.home.markdown.backlog_path,
      sha256_before: input.before,
      sha256_after: input.after,
      unchanged: input.before === input.after,
    },
    summary: input.plan.summary,
    records: input.plan.records,
    created_ids: input.createdIds,
  };
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

async function canonicalProjectRoot(rootInput: string): Promise<string> {
  const requested = await canonicalRoot(rootInput);
  const command = await runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: requested,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (command.exit_code !== 0) {
    throw new CliError("VALIDATION_ERROR", "--root must be inside a Git repository", 2, {
      root: requested,
      stderr: command.stderr.trim(),
    });
  }
  return await canonicalRoot(command.stdout.trim());
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
    taskId: null,
    tokenBudget: null,
    byteBudget: null,
    syncMode: null,
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
    if (!arg.startsWith("-") && options.command === "context" && options.taskId === null) {
      options.taskId = arg;
      continue;
    }
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--dry-run":
        if (options.syncMode !== null) {
          throw new CliError("VALIDATION_ERROR", "Choose exactly one of --dry-run or --apply", 2);
        }
        options.syncMode = "dry-run";
        break;
      case "--apply":
        if (options.syncMode !== null) {
          throw new CliError("VALIDATION_ERROR", "Choose exactly one of --dry-run or --apply", 2);
        }
        options.syncMode = "apply";
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
        options.timeoutMs = positiveInteger(readValue(argv, ++index, arg), arg);
        break;
      }
      case "--token-budget": {
        options.tokenBudget = positiveInteger(readValue(argv, ++index, arg), arg);
        break;
      }
      case "--byte-budget": {
        options.byteBudget = positiveInteger(readValue(argv, ++index, arg), arg);
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

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError("VALIDATION_ERROR", `${flag} must be a positive integer`, 2);
  }
  return parsed;
}

function writeOutput(
  json: boolean,
  report: DoctorReport | InitResult | ValidateReport | ContextResult | SyncReport,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (report.command === "init") {
    process.stdout.write(
      `Factory init: ${report.root}\ncreated: ${report.created.join(", ") || "nothing"}\n`,
    );
    return;
  }
  if (report.command === "validate") {
    process.stdout.write(
      `Factory validate: ${report.project_id}\ntasks: ${report.task_count}; conditions: ${report.condition_count}\n`,
    );
    return;
  }
  if (report.command === "context") {
    process.stdout.write(
      `Factory context: ${report.task_id}\npack: ${report.pack_path}\nreceipt: ${report.receipt_path}\n`,
    );
    return;
  }
  if (report.command === "sync") {
    process.stdout.write(
      `Factory sync (${report.mode}): ${report.project.id}\ncreate: ${report.summary.create}; unchanged: ${report.summary.unchanged}; conflict: ${report.summary.conflict}; blocked: ${report.summary.blocked}\n`,
    );
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
  if (error instanceof ContractIssue) {
    return new CliError("VALIDATION_FAILED", error.message, 2, [error.diagnostic()]);
  }
  if (error instanceof ContextIssue) {
    return new CliError(error.code, error.message, 3, error.details);
  }
  if (error instanceof PublicationIssue) {
    return new CliError(error.code, error.message, error.exitCode, error.details);
  }
  return new CliError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), 1);
}

function helpText(): string {
  return `usage: factory <doctor|init|validate|context TASK-ID|sync --dry-run|--apply> [--root <project>] [--json]\n\nCommands:\n  doctor --home <home>       Read-only integration boundary probe\n  init                       Create .factory directories and ignore runtime state\n  validate                   Check versioned contracts and dependency graph\n  context TASK-ID            Write a bounded attributed context pack and receipt\n  sync --dry-run --home HOME Preview create-only backlog reconciliation\n  sync --apply --home HOME   Publish after a fresh conflict-free preflight\n\nOptions:\n  --root <path>              Project root (default: cwd)\n  --home <path>              Explicit canonical Firstmate home\n  --ctx-bin <path>           Override ctx executable\n  --tasks-bin <path>         Override tasks-axi executable\n  --token-budget <count>     Override the task token budget\n  --byte-budget <count>      Override the task byte ceiling\n  --json                     Print one schema_version=1 JSON object`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
