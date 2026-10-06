import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256File, runCommand, trimOutput } from "./process.js";
import { summarize, type CommandSummary } from "./ctx.js";
import type { FirstmateHomeCheck } from "./firstmate-home.js";
import type { PublicationTask } from "../core/plan.js";

export interface TasksAxiCheck {
  ok: boolean;
  path: string;
  cwd: string;
  backend: string;
  version: CommandSummary;
  help: CommandSummary;
  ready: CommandSummary;
  backlog_sha256_before: string;
  backlog_sha256_after: string;
  read_only: boolean;
}

export interface SyncTasksAxiCheck {
  path: string;
  version: string;
  backlog_sha256_before: string;
  backlog_sha256_after: string;
}

export interface PublishedTask {
  id: string;
  title: string;
  state: string;
  kind: string;
  repo: string;
  blocked_by: string[];
  held: boolean;
  body: string;
}

export class TasksAxiError extends Error {
  readonly exitCode: number;
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: string,
    message: string,
    details: Record<string, unknown>,
    exitCode = 3,
  ) {
    super(message);
    this.name = "TasksAxiError";
    this.details = details;
    this.exitCode = exitCode;
  }
}

export async function probeTasksAxi(options: {
  tasksPath: string;
  home: FirstmateHomeCheck;
  timeoutMs: number;
}): Promise<TasksAxiCheck> {
  const runOptions = { cwd: options.home.path, timeoutMs: options.timeoutMs };
  const before = options.home.markdown.backlog_sha256;
  const version = summarize(await runCommand(options.tasksPath, ["--version"], runOptions));
  const help = summarize(await runCommand(options.tasksPath, ["--help"], runOptions));
  const afterMetadataProbe = await sha256File(options.home.markdown.backlog_path);
  const ready = summarize(await runCommand(options.tasksPath, ["ready"], runOptions));
  const after = await sha256File(options.home.markdown.backlog_path);
  const readOnly = before === afterMetadataProbe && afterMetadataProbe === after;
  if (!readOnly) {
    throw new TasksAxiError(
      "READ_ONLY_VIOLATION",
      "Read-only tasks-axi probe changed the backlog file",
      {
        home: options.home.path,
        backlog_path: options.home.markdown.backlog_path,
        before,
        after_metadata_probe: afterMetadataProbe,
        after,
      },
    );
  }

  return {
    ok: version.exit_code === 0 && help.exit_code === 0 && ready.exit_code === 0 && readOnly,
    path: options.tasksPath,
    cwd: options.home.path,
    backend: options.home.backend,
    version,
    help,
    ready,
    backlog_sha256_before: before,
    backlog_sha256_after: after,
    read_only: readOnly,
  };
}

export async function probeTasksAxiForSync(options: {
  tasksPath: string;
  home: FirstmateHomeCheck;
  timeoutMs: number;
}): Promise<SyncTasksAxiCheck> {
  const runOptions = { cwd: options.home.path, timeoutMs: options.timeoutMs };
  const before = await sha256File(options.home.markdown.backlog_path);
  const versionResult = await runCommand(options.tasksPath, ["--version"], runOptions);
  const version = versionResult.stdout.trim();
  const probes = await Promise.all([
    runCommand(options.tasksPath, ["add", "--help"], runOptions),
    runCommand(options.tasksPath, ["show", "--help"], runOptions),
    runCommand(options.tasksPath, ["ready", "--help"], runOptions),
  ]);
  const after = await sha256File(options.home.markdown.backlog_path);
  if (before !== after) {
    throw new TasksAxiError("READ_ONLY_VIOLATION", "tasks-axi feature probes changed the backlog", {
      before,
      after,
      backlog_path: options.home.markdown.backlog_path,
    });
  }
  const compatible =
    versionResult.exit_code === 0 &&
    version === "0.2.5" &&
    probes.every((result) => result.exit_code === 0) &&
    probes[0]?.stdout.includes("--body-file") === true &&
    probes[0]?.stdout.includes("--blocked-by") === true &&
    probes[0]?.stdout.includes("--json") === true &&
    probes[1]?.stdout.includes("--full") === true &&
    probes[2]?.stdout.includes("--repo") === true;
  if (!compatible) {
    throw new TasksAxiError(
      "TASKS_AXI_INCOMPATIBLE",
      "Installed tasks-axi version or features are not supported for publication",
      {
        supported_version: "0.2.5",
        observed_version: version,
        version_exit_code: versionResult.exit_code,
        feature_probes: probes.map((result) => summarize(result)),
      },
    );
  }
  return {
    path: options.tasksPath,
    version,
    backlog_sha256_before: before,
    backlog_sha256_after: after,
  };
}

export async function inspectPublishedTask(options: {
  tasksPath: string;
  home: FirstmateHomeCheck;
  id: string;
  timeoutMs: number;
}): Promise<PublishedTask | "duplicate" | null> {
  const backlog = await readFile(options.home.markdown.backlog_path, "utf8");
  const occurrences = taskIdOccurrences(backlog, options.id);
  if (occurrences > 1) return "duplicate";
  const result = await runCommand(options.tasksPath, ["show", options.id, "--full"], {
    cwd: options.home.path,
    timeoutMs: options.timeoutMs,
  });
  if (result.exit_code !== 0) {
    if (occurrences === 0 && `${result.stdout}\n${result.stderr}`.includes("NOT_FOUND"))
      return null;
    throw new TasksAxiError("TASKS_AXI_READ_FAILED", "tasks-axi could not inspect an existing ID", {
      id: options.id,
      exit_code: result.exit_code,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr),
    });
  }
  if (occurrences !== 1) {
    throw new TasksAxiError(
      "BACKLOG_RECONCILIATION_FAILED",
      "tasks-axi and backlog ID lookup disagree",
      {
        id: options.id,
        backlog_occurrences: occurrences,
      },
    );
  }
  return parseFullTask(result.stdout, options.id);
}

export async function createPublishedTask(options: {
  tasksPath: string;
  home: FirstmateHomeCheck;
  repo: string;
  item: PublicationTask;
  timeoutMs: number;
}): Promise<CommandSummary> {
  const temporary = await mkdtemp(join(tmpdir(), "factory-task-body-"));
  const bodyPath = join(temporary, "body.md");
  try {
    await writeFile(bodyPath, options.item.body, { encoding: "utf8", mode: 0o600 });
    const args = [
      "add",
      options.item.published_id,
      options.item.task.title,
      "--kind",
      options.item.task.kind ?? "ship",
      "--repo",
      options.repo,
      "--body-file",
      bodyPath,
    ];
    for (const dependency of options.item.dependency_ids) {
      args.push("--blocked-by", dependency);
    }
    args.push("--json");
    return summarize(
      await runCommand(options.tasksPath, args, {
        cwd: options.home.path,
        timeoutMs: options.timeoutMs,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function assertBacklogHash(home: FirstmateHomeCheck, expected: string): Promise<void> {
  const actual = await sha256File(home.markdown.backlog_path);
  if (actual !== expected) {
    throw new TasksAxiError(
      "BACKLOG_CHANGED",
      "Backlog changed after publication preflight; rerun sync",
      { backlog_path: home.markdown.backlog_path, expected, actual },
      4,
    );
  }
}

function parseFullTask(output: string, expectedId: string): PublishedTask {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^  ([a-z_]+):\s?(.*)$/.exec(line);
    if (match?.[1] !== undefined) fields.set(match[1], match[2] ?? "");
  }
  const id = requiredField(fields, "id", expectedId, output);
  const body = requiredField(fields, "body", expectedId, output);
  if (id !== expectedId) {
    throw new TasksAxiError("TASKS_AXI_OUTPUT_INVALID", "tasks-axi show returned the wrong task", {
      expected_id: expectedId,
      actual_id: id,
    });
  }
  const blocked = requiredField(fields, "blocked_by", expectedId, output);
  return {
    id,
    title: requiredField(fields, "title", expectedId, output),
    state: requiredField(fields, "state", expectedId, output),
    kind: requiredField(fields, "kind", expectedId, output),
    repo: requiredField(fields, "repo", expectedId, output),
    blocked_by: blocked === "none" ? [] : blocked.split(/,\s*/).filter(Boolean),
    held: requiredField(fields, "held", expectedId, output) === "yes",
    body,
  };
}

function requiredField(
  fields: Map<string, string>,
  field: string,
  id: string,
  output: string,
): string {
  const value = fields.get(field);
  if (value === undefined) {
    throw new TasksAxiError("TASKS_AXI_OUTPUT_INVALID", "tasks-axi show omitted a required field", {
      id,
      field,
    });
  }
  if (!value.startsWith('"')) return value;
  try {
    const decoded: unknown = JSON.parse(value);
    if (typeof decoded === "string") return decoded;
  } catch (error) {
    throw new TasksAxiError(
      "TASKS_AXI_OUTPUT_INVALID",
      "tasks-axi show returned an invalid field",
      {
        id,
        field,
        cause: error instanceof Error ? error.message : String(error),
        output: trimOutput(output),
      },
    );
  }
  throw new TasksAxiError(
    "TASKS_AXI_OUTPUT_INVALID",
    "tasks-axi show returned a non-string field",
    {
      id,
      field,
      output: trimOutput(output),
    },
  );
}

function taskIdOccurrences(backlog: string, id: string): number {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^- (?:\\[ \\] ${escaped}|\\[x\\] ${escaped}|\\*\\*${escaped}\\*\\*) - `,
    "gm",
  );
  return [...backlog.matchAll(pattern)].length;
}
