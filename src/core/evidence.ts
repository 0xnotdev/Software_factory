import { readFile } from "node:fs/promises";
import { Ajv, type ValidateFunction } from "ajv";
import { currentCommit } from "../adapters/git.js";
import { sha256File } from "../adapters/process.js";
import type { PublicationInput, PublicationTask } from "./plan.js";
import { loadPublicationInput } from "./plan.js";
import { ContractIssue, readTextFile, resolveInside } from "./load.js";
import type { CompletionCondition } from "../types.js";

export type EvidenceStatus = "passed" | "failed" | "stale" | "unverified";

export interface EvidenceIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ObservedCheck {
  id: string;
  status: "pass" | "fail";
  command_id: string;
  exit_code: number;
  artifact: string;
  artifact_sha256: string;
}

interface TaskReceipt {
  schema_version: 1;
  task_id: string;
  contract_sha256: string;
  commit: string;
  checks: ObservedCheck[];
  review?: { status: "pass" | "fail" | "pending"; artifact: string | null };
  recorded_at: string;
}

interface ExecutableResult {
  kind: "executable";
  status: "pass" | "fail";
  check_id: string;
  command_id: string;
  exit_code: number;
  artifact: string;
  artifact_sha256: string;
}

interface ObservationResult {
  kind: "observation";
  status: "pass" | "fail";
  reviewer: string;
  artifact: string;
  artifact_sha256: string;
}

interface CompletionReceipt {
  schema_version: 1;
  condition_id: string;
  completion_sha256: string;
  commit: string;
  result: ExecutableResult | ObservationResult;
  recorded_at: string;
}

export interface TaskEvidenceReport {
  schema_version: 1;
  ok: true;
  command: "evidence";
  task_id: string;
  receipt_path: string;
  status: EvidenceStatus;
  valid: boolean;
  contract_sha256: string;
  tested_commit: string | null;
  release_candidate: string;
  checks: ObservedCheck[];
  issues: EvidenceIssue[];
}

export interface ConditionEvidenceReport {
  id: string;
  outcome: string;
  method: CompletionCondition["method"];
  receipt_path: string;
  status: EvidenceStatus;
  tested_commit: string | null;
  issues: EvidenceIssue[];
}

type ReceiptRead =
  | { state: "missing" }
  | { state: "invalid"; issue: EvidenceIssue }
  | { state: "present"; value: unknown };

let evidenceValidatorPromise: Promise<ValidateFunction> | undefined;

export async function inspectTaskEvidence(
  root: string,
  taskId: string,
): Promise<TaskEvidenceReport> {
  const input = await loadPublicationInput(root);
  const item = input.tasks.find((candidate) => candidate.task.id === taskId);
  if (item === undefined)
    throw new EvidenceIssueError("TASK_NOT_FOUND", `Unknown task ID: ${taskId}`);
  return await evaluateTaskEvidence(input, item, await currentCommit(root));
}

export async function evaluateTaskEvidence(
  input: PublicationInput,
  item: PublicationTask,
  releaseCandidate: string,
): Promise<TaskEvidenceReport> {
  const receiptPath = `.factory/state/evidence/${item.task.id}.json`;
  const read = await readReceipt(input.root, receiptPath);
  if (read.state === "missing") {
    return taskReport(
      item,
      receiptPath,
      releaseCandidate,
      "unverified",
      null,
      [],
      [{ code: "RECEIPT_MISSING", message: "No task evidence receipt has been recorded" }],
    );
  }
  if (read.state === "invalid") {
    return taskReport(item, receiptPath, releaseCandidate, "failed", null, [], [read.issue]);
  }

  const validator = await evidenceValidator();
  if (!validator(read.value) || !isTaskReceipt(read.value)) {
    return taskReport(
      item,
      receiptPath,
      releaseCandidate,
      "failed",
      null,
      [],
      [
        {
          code: "RECEIPT_INVALID",
          message: schemaMessage(validator),
          path: receiptPath,
        },
      ],
    );
  }

  const receipt = read.value;
  const issues: EvidenceIssue[] = [];
  const stale: EvidenceIssue[] = [];
  if (receipt.task_id !== item.task.id) {
    issues.push({ code: "TASK_ID_MISMATCH", message: `Receipt names ${receipt.task_id}` });
  }
  if (receipt.contract_sha256 !== item.contract_sha256) {
    stale.push({
      code: "CONTRACT_CHANGED",
      message: "The task contract digest differs from the recorded digest",
      path: item.contract_path,
    });
  }
  if (receipt.commit !== releaseCandidate) {
    stale.push({
      code: "RELEASE_SHA_CHANGED",
      message: "The evidence was not executed at the current release-candidate SHA",
    });
  }

  const ids = new Set<string>();
  for (const check of receipt.checks) {
    if (ids.has(check.id)) {
      issues.push({ code: "DUPLICATE_CHECK", message: `Check ${check.id} appears more than once` });
    }
    ids.add(check.id);
    if (check.status !== "pass" || check.exit_code !== 0) {
      issues.push({
        code: "CHECK_FAILED",
        message: `Check ${check.id} reported ${check.status} with exit ${check.exit_code}`,
      });
    }
    issues.push(...(await verifyArtifact(input.root, check.artifact, check.artifact_sha256)));
  }
  for (const required of item.task.evidence.required) {
    if (!ids.has(required)) {
      issues.push({
        code: "REQUIRED_CHECK_MISSING",
        message: `Required evidence check ${required} is absent`,
      });
    }
  }
  if (receipt.review?.status === "fail") {
    issues.push({ code: "REVIEW_FAILED", message: "The recorded reviewer disposition is fail" });
  }

  const status: EvidenceStatus =
    stale.length > 0 ? "stale" : issues.length > 0 ? "failed" : "passed";
  return taskReport(item, receiptPath, releaseCandidate, status, receipt.commit, receipt.checks, [
    ...stale,
    ...issues,
  ]);
}

export async function evaluateConditionEvidence(input: {
  root: string;
  condition: CompletionCondition;
  completionSha256: string;
  releaseCandidate: string;
}): Promise<ConditionEvidenceReport> {
  const receiptPath = `.factory/state/completion/${input.condition.id}.json`;
  const read = await readReceipt(input.root, receiptPath);
  if (read.state === "missing") {
    return conditionReport(input.condition, receiptPath, "unverified", null, [
      { code: "RECEIPT_MISSING", message: "No project-condition receipt has been recorded" },
    ]);
  }
  if (read.state === "invalid") {
    return conditionReport(input.condition, receiptPath, "failed", null, [read.issue]);
  }

  const validator = await evidenceValidator();
  if (!validator(read.value) || !isCompletionReceipt(read.value)) {
    return conditionReport(input.condition, receiptPath, "failed", null, [
      { code: "RECEIPT_INVALID", message: schemaMessage(validator), path: receiptPath },
    ]);
  }

  const receipt = read.value;
  const stale: EvidenceIssue[] = [];
  const issues: EvidenceIssue[] = [];
  if (receipt.condition_id !== input.condition.id) {
    issues.push({
      code: "CONDITION_ID_MISMATCH",
      message: `Receipt names ${receipt.condition_id}`,
    });
  }
  if (receipt.completion_sha256 !== input.completionSha256) {
    stale.push({
      code: "COMPLETION_CONTRACT_CHANGED",
      message: "The completion contract digest differs from the recorded digest",
    });
  }
  if (receipt.commit !== input.releaseCandidate) {
    stale.push({
      code: "RELEASE_SHA_CHANGED",
      message: "The condition was not tested at the current release-candidate SHA",
    });
  }
  if (receipt.result.kind !== input.condition.method) {
    issues.push({
      code: "METHOD_MISMATCH",
      message: `Receipt method ${receipt.result.kind} differs from ${input.condition.method}`,
    });
  }
  if (receipt.result.artifact !== input.condition.evidence) {
    issues.push({
      code: "ARTIFACT_MISMATCH",
      message: "Receipt does not reference the condition's source-of-truth artifact",
      path: receipt.result.artifact,
    });
  }
  issues.push(
    ...(await verifyArtifact(input.root, receipt.result.artifact, receipt.result.artifact_sha256)),
  );
  if (receipt.result.status !== "pass") {
    issues.push({ code: "CONDITION_FAILED", message: "The project condition reported fail" });
  }
  if (receipt.result.kind === "executable") {
    if (receipt.result.check_id !== input.condition.check_id) {
      issues.push({
        code: "CHECK_ID_MISMATCH",
        message: `Receipt check ${receipt.result.check_id} differs from ${input.condition.check_id ?? "missing check"}`,
      });
    }
    if (receipt.result.exit_code !== 0) {
      issues.push({
        code: "CHECK_FAILED",
        message: `Project check exited ${receipt.result.exit_code}`,
      });
    }
  }

  const status: EvidenceStatus =
    stale.length > 0 ? "stale" : issues.length > 0 ? "failed" : "passed";
  return conditionReport(input.condition, receiptPath, status, receipt.commit, [
    ...stale,
    ...issues,
  ]);
}

export class EvidenceIssueError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "EvidenceIssueError";
  }
}

function taskReport(
  item: PublicationTask,
  receiptPath: string,
  releaseCandidate: string,
  status: EvidenceStatus,
  testedCommit: string | null,
  checks: ObservedCheck[],
  issues: EvidenceIssue[],
): TaskEvidenceReport {
  return {
    schema_version: 1,
    ok: true,
    command: "evidence",
    task_id: item.task.id,
    receipt_path: receiptPath,
    status,
    valid: status === "passed",
    contract_sha256: item.contract_sha256,
    tested_commit: testedCommit,
    release_candidate: releaseCandidate,
    checks,
    issues,
  };
}

function conditionReport(
  condition: CompletionCondition,
  receiptPath: string,
  status: EvidenceStatus,
  testedCommit: string | null,
  issues: EvidenceIssue[],
): ConditionEvidenceReport {
  return {
    id: condition.id,
    outcome: condition.outcome,
    method: condition.method,
    receipt_path: receiptPath,
    status,
    tested_commit: testedCommit,
    issues,
  };
}

async function verifyArtifact(
  root: string,
  artifact: string,
  expectedSha256: string,
): Promise<EvidenceIssue[]> {
  try {
    const absolute = await resolveInside(root, artifact);
    const actual = await sha256File(absolute);
    if (actual !== expectedSha256) {
      return [
        {
          code: "ARTIFACT_CHANGED",
          message: "Artifact digest differs from the receipt",
          path: artifact,
        },
      ];
    }
    return [];
  } catch (error) {
    return [
      {
        code: "ARTIFACT_MISSING",
        message: error instanceof Error ? error.message : String(error),
        path: artifact,
      },
    ];
  }
}

async function readReceipt(root: string, path: string): Promise<ReceiptRead> {
  let text: string;
  try {
    text = await readTextFile(root, path, 1_000_000);
  } catch (error) {
    if (error instanceof ContractIssue && error.code === "FILE_MISSING")
      return { state: "missing" };
    return {
      state: "invalid",
      issue: {
        code: "RECEIPT_UNREADABLE",
        message: error instanceof Error ? error.message : String(error),
        path,
      },
    };
  }
  try {
    return { state: "present", value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      state: "invalid",
      issue: {
        code: "RECEIPT_INVALID",
        message: error instanceof Error ? error.message : String(error),
        path,
      },
    };
  }
}

async function evidenceValidator(): Promise<ValidateFunction> {
  evidenceValidatorPromise ??= (async () => {
    const url = new URL("../../../schemas/evidence.schema.json", import.meta.url);
    const schema = JSON.parse(await readFile(url, "utf8")) as object;
    return new Ajv({ allErrors: true, strict: false }).compile(schema);
  })();
  return await evidenceValidatorPromise;
}

function schemaMessage(validator: ValidateFunction): string {
  return (validator.errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function isTaskReceipt(value: unknown): value is TaskReceipt {
  return typeof value === "object" && value !== null && "task_id" in value && "checks" in value;
}

function isCompletionReceipt(value: unknown): value is CompletionReceipt {
  return (
    typeof value === "object" && value !== null && "condition_id" in value && "result" in value
  );
}
