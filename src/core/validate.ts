import { readFile } from "node:fs/promises";
import { Ajv, type ValidateFunction } from "ajv";
import { analyzeGraph } from "./graph.js";
import {
  asDiagnostic,
  assertRelativePath,
  readTextFile,
  readYamlContract,
  taskPaths,
} from "./load.js";
import type { CompletionContract, Diagnostic, ProjectContract, TaskContract } from "../types.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const SOURCE_LIMIT = { bounded: 16_000, normal: 32_000, critical: 60_000 } as const;
let validatorsPromise:
  | Promise<{
      project: ValidateFunction;
      task: ValidateFunction;
      completion: ValidateFunction;
    }>
  | undefined;

export interface ValidationResult {
  root: string;
  project_id: string | null;
  task_count: number;
  condition_count: number;
  task_order: string[];
  diagnostics: Diagnostic[];
}

export async function validateProject(root: string): Promise<ValidationResult> {
  const validators = await getValidators();
  const diagnostics: Diagnostic[] = [];
  const projectPath = ".factory/project.yaml";
  const project = await load<ProjectContract>(root, projectPath, validators.project, diagnostics);
  if (project === undefined) return result(root, null, [], [], diagnostics);

  const completion = await load<CompletionContract>(
    root,
    project.completion,
    validators.completion,
    diagnostics,
  );
  const paths = await collectTaskPaths(root, diagnostics);
  const tasks: TaskContract[] = [];
  const taskFiles = new Map<string, string>();
  for (const path of paths) {
    const task = await load<TaskContract>(root, path, validators.task, diagnostics);
    if (task === undefined) continue;
    if (taskFiles.has(task.id)) {
      diagnostics.push({
        code: "DUPLICATE_ID",
        path,
        message: `Task ID ${task.id} also appears in ${taskFiles.get(task.id)}`,
      });
    } else {
      taskFiles.set(task.id, path);
      tasks.push(task);
    }
  }

  if (completion !== undefined) {
    if (completion.project !== project.id) {
      diagnostics.push({
        code: "PROJECT_MISMATCH",
        path: project.completion,
        message: `Completion project ${completion.project} differs from ${project.id}`,
      });
    }
    const conditionIds = new Set<string>();
    for (const condition of completion.conditions) {
      if (conditionIds.has(condition.id)) {
        diagnostics.push({
          code: "DUPLICATE_ID",
          path: project.completion,
          message: `Duplicate completion ID: ${condition.id}`,
        });
      }
      conditionIds.add(condition.id);
      checkOutputPath(condition.evidence, project.completion, diagnostics);
    }
    const acceptanceIds = new Set<string>();
    const covered = new Set<string>();
    for (const task of tasks) {
      const path = taskFiles.get(task.id) ?? `.factory/tasks/${task.id}.yaml`;
      if (conditionIds.has(task.id)) {
        diagnostics.push({
          code: "DUPLICATE_ID",
          path,
          message: `Task ID ${task.id} collides with a completion ID`,
        });
      }
      if (task.kind !== "enabling" && task.advances.length === 0) {
        diagnostics.push({
          code: "COMPLETION_REQUIRED",
          path,
          message: `${task.id} must advance a completion condition or declare kind: enabling`,
        });
      }
      for (const id of task.advances) {
        if (!conditionIds.has(id)) {
          diagnostics.push({
            code: "COMPLETION_NOT_FOUND",
            path,
            message: `${task.id} advances unknown completion ID ${id}`,
          });
        } else {
          covered.add(id);
        }
      }
      for (const item of task.acceptance) {
        if (acceptanceIds.has(item.id)) {
          diagnostics.push({
            code: "DUPLICATE_ID",
            path,
            message: `Duplicate acceptance ID: ${item.id}`,
          });
        }
        acceptanceIds.add(item.id);
      }
    }
    for (const id of conditionIds) {
      if (!covered.has(id)) {
        diagnostics.push({
          code: "UNCOVERED_CONDITION",
          path: project.completion,
          message: `No task advances ${id}`,
        });
      }
    }
  }

  for (const path of project.documents.required) {
    await checkSource(root, path, 60_000, projectPath, diagnostics);
  }
  for (const task of tasks) {
    const contractPath = taskFiles.get(task.id) ?? `.factory/tasks/${task.id}.yaml`;
    for (const path of task.context.required) {
      await checkSource(root, path, SOURCE_LIMIT[task.complexity], contractPath, diagnostics);
    }
  }

  const graph = analyzeGraph(tasks);
  diagnostics.push(...graph.diagnostics);
  return result(root, project.id, tasks, completion?.conditions ?? [], diagnostics, graph.order);
}

function result(
  root: string,
  projectId: string | null,
  tasks: TaskContract[],
  conditions: CompletionContract["conditions"],
  diagnostics: Diagnostic[],
  order: string[] = [],
): ValidationResult {
  return {
    root,
    project_id: projectId,
    task_count: tasks.length,
    condition_count: conditions.length,
    task_order: order,
    diagnostics,
  };
}

async function load<T>(
  root: string,
  path: string,
  validator: ValidateFunction,
  diagnostics: Diagnostic[],
): Promise<T | undefined> {
  try {
    const value = await readYamlContract(root, path);
    if (!validator(value)) {
      for (const issue of validator.errors ?? []) {
        const at = issue.instancePath || "/";
        diagnostics.push({
          code: "SCHEMA_INVALID",
          path: `${path}${at}`,
          message: `${issue.message ?? "Schema mismatch"}${issue.params && "additionalProperty" in issue.params ? `: ${String(issue.params.additionalProperty)}` : ""}`,
        });
      }
      return undefined;
    }
    return value as T;
  } catch (error) {
    diagnostics.push(asDiagnostic(error));
    return undefined;
  }
}

async function collectTaskPaths(root: string, diagnostics: Diagnostic[]): Promise<string[]> {
  try {
    return await taskPaths(root);
  } catch (error) {
    diagnostics.push(asDiagnostic(error));
    return [];
  }
}

async function checkSource(
  root: string,
  path: string,
  limit: number,
  contractPath: string,
  diagnostics: Diagnostic[],
): Promise<void> {
  try {
    if (!path.endsWith(".md")) {
      diagnostics.push({
        code: "SOURCE_NOT_MARKDOWN",
        path: contractPath,
        message: `Required source must be Markdown: ${path}`,
      });
      return;
    }
    await readTextFile(root, path, limit);
  } catch (error) {
    diagnostics.push(asDiagnostic(error));
  }
}

function checkOutputPath(path: string, contractPath: string, diagnostics: Diagnostic[]): void {
  try {
    assertRelativePath(path);
  } catch (error) {
    const issue = asDiagnostic(error);
    diagnostics.push({
      ...issue,
      path: contractPath,
      message: `Invalid evidence path ${path}: ${issue.message}`,
    });
  }
}

async function getValidators(): Promise<{
  project: ValidateFunction;
  task: ValidateFunction;
  completion: ValidateFunction;
}> {
  validatorsPromise ??= (async () => ({
    project: await compileSchema("project"),
    task: await compileSchema("task"),
    completion: await compileSchema("completion"),
  }))();
  return await validatorsPromise;
}

async function compileSchema(name: string): Promise<ValidateFunction> {
  const url = new URL(`../../../schemas/${name}.schema.json`, import.meta.url);
  return ajv.compile(JSON.parse(await readFile(url, "utf8")) as object);
}
