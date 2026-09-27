import { sha256File, runCommand } from "./process.js";
import { summarize, type CommandSummary } from "./ctx.js";
import type { FirstmateHomeCheck } from "./firstmate-home.js";

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

export class TasksAxiError extends Error {
  readonly code = "READ_ONLY_VIOLATION";
  readonly exitCode = 3;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "TasksAxiError";
    this.details = details;
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
    throw new TasksAxiError("Read-only tasks-axi probe changed the backlog file", {
      home: options.home.path,
      backlog_path: options.home.markdown.backlog_path,
      before,
      after_metadata_probe: afterMetadataProbe,
      after,
    });
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
