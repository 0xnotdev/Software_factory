import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { PublishedTask } from "../adapters/tasks-axi.js";
import { parseYamlContract, resolveInside, taskPaths } from "./load.js";
import { validateProject } from "./validate.js";
import type { ProjectContract, TaskContract } from "../types.js";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type PublicationAction = "create" | "unchanged" | "conflict" | "blocked";

export interface PublicationTask {
  task: TaskContract;
  contract_path: string;
  contract_sha256: string;
  published_id: string;
  dependency_ids: string[];
  body: string;
}

export interface PublicationInput {
  root: string;
  repo: string;
  project: ProjectContract;
  tasks: PublicationTask[];
  snapshots: Record<string, string>;
}

export interface PublicationRecord {
  task_id: string;
  published_id: string;
  action: PublicationAction;
  contract_sha256: string;
  depends_on: string[];
  reason?: string;
}

export interface PublicationPlan {
  records: PublicationRecord[];
  summary: Record<PublicationAction, number>;
}

export class PublicationIssue extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PublicationIssue";
  }
}

export async function loadPublicationInput(root: string): Promise<PublicationInput> {
  const captured = new Map<string, string>();
  const validation = await validateProject(root, captured);
  if (validation.diagnostics.length > 0) {
    throw new PublicationIssue(
      "VALIDATION_FAILED",
      "Project contracts are invalid",
      2,
      validation.diagnostics,
    );
  }
  const projectText = captured.get(".factory/project.yaml");
  if (projectText === undefined) {
    throw new PublicationIssue("VALIDATION_FAILED", "Project contract was not captured", 2);
  }
  const project = parseYamlContract(projectText, ".factory/project.yaml") as ProjectContract;
  const snapshots = Object.fromEntries(
    await Promise.all(
      [...captured].map(async ([path, text]) => {
        const bytes = await readFile(await resolveInside(root, path));
        if (decoder.decode(bytes) !== text) {
          throw new PublicationIssue(
            "CONTRACT_CHANGED",
            "A publication contract changed after validation",
            3,
            { path },
          );
        }
        return [path, sha256(bytes)] as const;
      }),
    ),
  );
  const paths = await taskPaths(root);
  const byId = new Map<string, { task: TaskContract; path: string }>();
  for (const path of paths) {
    const text = captured.get(path);
    if (text === undefined) {
      throw new PublicationIssue(
        "CONTRACT_CHANGED",
        "A task contract changed during validation",
        3,
        {
          path,
        },
      );
    }
    const task = parseYamlContract(text, path) as TaskContract;
    byId.set(task.id, { task, path });
  }

  const repo = basename(root);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) {
    throw new PublicationIssue(
      "PROJECT_IDENTITY_UNSUPPORTED",
      "The canonical repository directory name is not a supported Firstmate project name",
      3,
      { repo, root },
    );
  }
  const publishedIds = new Map<string, string>();
  const tasks = validation.task_order.map((id) => {
    const item = byId.get(id);
    if (item === undefined) {
      throw new PublicationIssue("CONTRACT_CHANGED", "Validated task disappeared", 3, { id });
    }
    const publishedId = encodePublicationId(project.id, item.task.id);
    const priorId = publishedIds.get(publishedId);
    if (priorId !== undefined) {
      throw new PublicationIssue(
        "DUPLICATE_PUBLICATION_ID",
        "Task IDs collide after tasks-axi publication encoding",
        2,
        { published_id: publishedId, task_ids: [priorId, item.task.id] },
      );
    }
    publishedIds.set(publishedId, item.task.id);
    const dependencyIds = item.task.depends_on.map((dependency) =>
      encodePublicationId(project.id, dependency),
    );
    const digest = snapshots[item.path];
    if (digest === undefined) {
      throw new PublicationIssue("CONTRACT_CHANGED", "Task digest snapshot is missing", 3, {
        path: item.path,
      });
    }
    return {
      task: item.task,
      contract_path: item.path,
      contract_sha256: digest,
      published_id: publishedId,
      dependency_ids: dependencyIds,
      body: renderTaskBody({
        project,
        repo,
        task: item.task,
        path: item.path,
        digest,
        dependencyIds,
      }),
    };
  });
  return {
    root,
    repo,
    project,
    tasks,
    snapshots,
  };
}

export function makePublicationPlan(
  input: PublicationInput,
  existing: Map<string, PublishedTask | "duplicate" | null>,
): PublicationPlan {
  const records: PublicationRecord[] = input.tasks.map((item) => {
    const found = existing.get(item.published_id) ?? null;
    const base = {
      task_id: item.task.id,
      published_id: item.published_id,
      contract_sha256: item.contract_sha256,
      depends_on: item.dependency_ids,
    };
    if (found === null) return { ...base, action: "create" };
    if (found === "duplicate") {
      return { ...base, action: "conflict", reason: "DUPLICATE_PUBLISHED_ID" };
    }
    const expectedKind = item.task.kind ?? "ship";
    if (
      found.title !== item.task.title ||
      found.repo !== input.repo ||
      found.kind !== expectedKind ||
      found.body !== item.body ||
      !sameStrings(found.blocked_by, item.dependency_ids)
    ) {
      return { ...base, action: "conflict", reason: "EXISTING_TASK_DIFFERS" };
    }
    return { ...base, action: "unchanged" };
  });

  const byTask = new Map(records.map((record) => [record.task_id, record]));
  for (const record of records) {
    if (record.action !== "create") continue;
    const task = input.tasks.find((item) => item.task.id === record.task_id);
    const blockedBy = task?.task.depends_on.find((id) => {
      const dependency = byTask.get(id);
      return dependency?.action === "conflict" || dependency?.action === "blocked";
    });
    if (blockedBy !== undefined) {
      record.action = "blocked";
      record.reason = `DEPENDENCY_CONFLICT:${blockedBy}`;
    }
  }

  return {
    records,
    summary: {
      create: records.filter((record) => record.action === "create").length,
      unchanged: records.filter((record) => record.action === "unchanged").length,
      conflict: records.filter((record) => record.action === "conflict").length,
      blocked: records.filter((record) => record.action === "blocked").length,
    },
  };
}

export async function assertPublicationInputsStable(input: PublicationInput): Promise<void> {
  const changed: string[] = [];
  for (const [path, expected] of Object.entries(input.snapshots)) {
    let actual: string;
    try {
      actual = sha256(await readFile(await resolveInside(input.root, path)));
    } catch {
      changed.push(path);
      continue;
    }
    if (actual !== expected) changed.push(path);
  }
  if (changed.length > 0) {
    throw new PublicationIssue(
      "CONTRACT_CHANGED",
      "Publication contracts changed after validation; rerun sync",
      3,
      { paths: changed },
    );
  }
}

export function encodePublicationId(projectId: string, taskId: string): string {
  return `factory-${projectId}-${taskId}`.toLowerCase();
}

function renderTaskBody(input: {
  project: ProjectContract;
  repo: string;
  task: TaskContract;
  path: string;
  digest: string;
  dependencyIds: string[];
}): string {
  const acceptance = input.task.acceptance
    .map((item) => `- ${item.id}: ${item.statement}`)
    .join("\n");
  const dependencies =
    input.dependencyIds.length === 0
      ? "- none"
      : input.task.depends_on
          .map((id, index) => `- ${input.dependencyIds[index]} (Factory task ${id})`)
          .join("\n");
  return [
    "<!-- Factory publication v1 -->",
    `Factory source: factory:${input.project.id}:${input.task.id}`,
    `Project: ${input.project.id}`,
    `Repository: ${input.repo}`,
    `Contract SHA-256: ${input.digest}`,
    `Contract: ${input.path}`,
    `Complexity: ${input.task.complexity}`,
    `Risk: ${input.task.risk}`,
    `Delivery request: ${input.task.delivery ?? "project-default"}`,
    "",
    "## Project intent",
    input.project.intent,
    `Audience: ${input.project.audience}`,
    "",
    "## Project constraints",
    input.project.constraints.map((constraint) => `- ${constraint}`).join("\n") || "- none",
    "",
    "## Outcome",
    input.task.outcome,
    "",
    "## Acceptance",
    acceptance,
    "",
    "## Dependencies",
    dependencies,
    "",
    "## Product completion advanced",
    input.task.advances.length === 0
      ? "- none (enabling task)"
      : input.task.advances.map((id) => `- ${id}`).join("\n"),
    "",
    "## Evidence expected",
    input.task.evidence.required.map((kind) => `- ${kind}`).join("\n"),
    "",
    "## Authoritative context to read",
    input.task.context.required.map((path) => `- ${path}`).join("\n") || "- none",
    "",
    "## Worker brief",
    `Implement only ${input.task.id}: ${input.task.title}.`,
    `Deliver the outcome and every acceptance item above in repository ${input.repo}.`,
    `Read the tracked contract at ${input.path} and verify its SHA-256 before work.`,
    "Do not treat backlog closure as product completion; return exact command, exit code, artifact, and tested Git SHA evidence.",
  ].join("\n");
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
