import { inspectFirstmateHome, inspectRegisteredProject } from "../adapters/firstmate-home.js";
import { currentCommit } from "../adapters/git.js";
import { inspectPublishedTask } from "../adapters/tasks-axi.js";
import {
  evaluateConditionEvidence,
  evaluateTaskEvidence,
  type EvidenceStatus,
} from "./evidence.js";
import { readYamlContract } from "./load.js";
import { loadPublicationInput } from "./plan.js";
import type { CompletionContract } from "../types.js";

export interface StatusOptions {
  root: string;
  home: string | null;
  tasksPath: string | null;
  timeoutMs: number;
}

type BacklogStatus = "queued" | "in_flight" | "done" | "unverified";

export interface StatusReport {
  schema_version: 1;
  ok: true;
  command: "status";
  root: string;
  backlog: {
    home: string | null;
    available: boolean;
    summary: Record<BacklogStatus, number>;
    all_tasks_done: boolean;
    tasks: Array<{
      task_id: string;
      published_id: string;
      state: string | null;
      status: BacklogStatus;
    }>;
  };
  task_evidence: {
    summary: Record<EvidenceStatus, number>;
    tasks: Awaited<ReturnType<typeof evaluateTaskEvidence>>[];
  };
  product: {
    status: "COMPLETE" | "NOT COMPLETE";
    release_candidate: string;
    completion_sha256: string;
    summary: Record<EvidenceStatus, number>;
    conditions: Awaited<ReturnType<typeof evaluateConditionEvidence>>[];
  };
}

export async function projectStatus(options: StatusOptions): Promise<StatusReport> {
  const input = await loadPublicationInput(options.root);
  const releaseCandidate = await currentCommit(options.root);
  const completion = (await readYamlContract(
    options.root,
    input.project.completion,
  )) as CompletionContract;
  const completionSha256 = input.snapshots[input.project.completion];
  if (completionSha256 === undefined) throw new Error("Validated completion digest is missing");

  const backlogTasks: StatusReport["backlog"]["tasks"] = [];
  let canonicalHome: string | null = null;
  if (options.home !== null) {
    if (options.tasksPath === null) throw new Error("tasks-axi path is required with --home");
    const home = await inspectFirstmateHome(options.home);
    await inspectRegisteredProject(home, options.root);
    canonicalHome = home.path;
    for (const item of input.tasks) {
      const observed = await inspectPublishedTask({
        tasksPath: options.tasksPath,
        home,
        id: item.published_id,
        timeoutMs: options.timeoutMs,
      });
      if (observed === null || observed === "duplicate") {
        backlogTasks.push({
          task_id: item.task.id,
          published_id: item.published_id,
          state: observed === "duplicate" ? "duplicate" : null,
          status: "unverified",
        });
      } else {
        backlogTasks.push({
          task_id: item.task.id,
          published_id: item.published_id,
          state: observed.state,
          status: backlogStatus(observed.state),
        });
      }
    }
  } else {
    for (const item of input.tasks) {
      backlogTasks.push({
        task_id: item.task.id,
        published_id: item.published_id,
        state: null,
        status: "unverified",
      });
    }
  }

  const taskEvidence = await Promise.all(
    input.tasks.map(async (item) => await evaluateTaskEvidence(input, item, releaseCandidate)),
  );
  const conditions = await Promise.all(
    completion.conditions.map(
      async (condition) =>
        await evaluateConditionEvidence({
          root: options.root,
          condition,
          completionPath: input.project.completion,
          completionSha256,
          releaseCandidate,
        }),
    ),
  );
  const backlogSummary = summarize(
    backlogTasks.map((task) => task.status),
    ["queued", "in_flight", "done", "unverified"],
  );
  const productSummary = summarize(
    conditions.map((condition) => condition.status),
    ["passed", "failed", "stale", "unverified"],
  );

  return {
    schema_version: 1,
    ok: true,
    command: "status",
    root: options.root,
    backlog: {
      home: canonicalHome,
      available: options.home !== null,
      summary: backlogSummary,
      all_tasks_done: backlogTasks.every((task) => task.status === "done"),
      tasks: backlogTasks,
    },
    task_evidence: {
      summary: summarize(
        taskEvidence.map((task) => task.status),
        ["passed", "failed", "stale", "unverified"],
      ),
      tasks: taskEvidence,
    },
    product: {
      status: conditions.every((condition) => condition.status === "passed")
        ? "COMPLETE"
        : "NOT COMPLETE",
      release_candidate: releaseCandidate,
      completion_sha256: completionSha256,
      summary: productSummary,
      conditions,
    },
  };
}

function backlogStatus(state: string): BacklogStatus {
  const normalized = state.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["done", "closed", "complete", "completed"].includes(normalized)) return "done";
  if (["in_progress", "active", "doing", "in_flight"].includes(normalized)) return "in_flight";
  if (["queued", "todo", "ready", "blocked", "open"].includes(normalized)) return "queued";
  return "unverified";
}

function summarize<T extends string>(values: T[], keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(
    keys.map((key) => [key, values.filter((value) => value === key).length]),
  ) as Record<T, number>;
}
