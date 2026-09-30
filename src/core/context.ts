import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { invokeCtxJson, type CtxJsonInvocation } from "../adapters/ctx.js";
import { runCommand } from "../adapters/process.js";
import type { ProjectContract, TaskContract } from "../types.js";
import { asDiagnostic, readTextFile, parseYamlContract, resolveInside } from "./load.js";
import { validateProject } from "./validate.js";

const SOURCE_READ_LIMIT = 1_000_000;
const TOKEN_BYTES = 3;
const DEFAULT_TOKEN_BUDGET = { bounded: 4_000, normal: 8_000, critical: 15_000 } as const;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ContextResult {
  schema_version: 1;
  ok: true;
  command: "context";
  task_id: string;
  pack_path: string;
  receipt_path: string;
  token_budget: number;
  estimated_tokens: number;
  byte_budget: number;
  bytes: number;
  previous_receipt_valid: boolean;
  receipt_invalid_reasons: string[];
  source_digests: Record<string, string>;
  ctx: {
    index_generation: number;
    retrieval_mode: string;
  };
}

export class ContextIssue extends Error {
  constructor(
    readonly code: "CONTEXT_BLOCKED",
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContextIssue";
  }
}

interface SourceFile {
  identity: string;
  aliases: string[];
  path: string;
  text: string;
  sha256: string;
}

interface RetrievedRange {
  identity: string;
  aliases: string[];
  path: string;
  text: string;
  sha256: string;
  rangeSha256: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

interface Receipt {
  schema_version: 1;
  task_id: string;
  contract_sha256: string;
  project_contract_sha256: string;
  source_digests: Record<string, string>;
  pack_sha256: string;
  ctx: { index_generation: number; retrieval_mode: string };
  budgets: { token: number; estimated_tokens: number; bytes: number; byte_limit: number };
  generated_at: string;
}

export async function generateContextPack(options: {
  root: string;
  taskId: string;
  ctxPath: string;
  timeoutMs?: number;
  tokenBudget?: number;
  byteBudget?: number;
}): Promise<ContextResult> {
  const input = await loadInput(options.root, options.taskId);
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET[input.task.complexity];
  const byteBudget = options.byteBudget ?? tokenBudget * 4;
  const sourceDigests = Object.fromEntries(
    input.sources.flatMap((source) => source.aliases.map((path) => [path, source.sha256])),
  );
  const paths = contextPaths(options.taskId);

  const status = await ctxCall(options, ["status", "--root", options.root, "--json"]);
  const statusJson = requireSuccessfulJson(status, "CTX_STATUS_FAILED");
  const generation = integerField(statusJson, "index_generation", "CTX status");
  const statusMode = stringField(statusJson, "retrieval_mode", "CTX status");
  assertFreshStatus(statusJson);
  const prior = await inspectPriorReceipt(options.root, paths, {
    task: input.taskSha256,
    project: input.projectSha256,
    sources: sourceDigests,
    generation,
  });

  const doctor = await ctxCall(options, ["doctor", "--offline", "--root", options.root, "--json"]);
  const doctorJson = requireSuccessfulJson(doctor, "CTX_OFFLINE_UNAVAILABLE");
  if (doctorJson.offline_ready !== true || doctorJson.network_attempted !== false) {
    blocked("CTX offline diagnostics did not prove a network-free ready state", {
      reason: "CTX_OFFLINE_UNAVAILABLE",
      doctor: doctorJson,
    });
  }

  const mandatoryOnly = renderPack({
    taskId: options.taskId,
    taskPath: input.taskPath,
    taskText: input.taskText,
    taskSha256: input.taskSha256,
    projectPath: ".factory/project.yaml",
    projectSha256: input.projectSha256,
    constraints: input.project.constraints,
    sources: input.sources,
    ranges: [],
    generation,
    retrievalMode: statusMode,
    tokenBudget,
    byteBudget,
  });
  enforceBudget(mandatoryOnly, tokenBudget, byteBudget);
  const remaining = tokenBudget - estimateTokens(mandatoryOnly);
  if (remaining < 1) {
    blocked("Mandatory context leaves no token budget for CTX retrieval", {
      reason: "TOKEN_BUDGET_EXCEEDED",
      token_budget: tokenBudget,
      mandatory_tokens: estimateTokens(mandatoryOnly),
    });
  }

  const lexical = statusMode === "LEXICAL_ONLY";
  const retrievalDocuments =
    input.task.context.required.length > 0
      ? input.task.context.required
      : input.project.documents.required;
  const retrievalIdentities = selectedRetrievalIdentities(input.sources, retrievalDocuments);
  const packArgs = [
    "pack",
    contextQuery(input.task),
    "--root",
    options.root,
    "--token-budget",
    String(remaining),
    ...retrievalDocuments.flatMap((path) => ["--document", path]),
    ...(lexical ? ["--no-embeddings"] : []),
    "--json",
  ];
  const ctxPack = await ctxCall(options, packArgs);
  const packJson = requireSuccessfulJson(ctxPack, "CTX_PACK_FAILED");
  if (packJson.completeness_status !== "COMPLETE") {
    blocked("CTX retrieval was insufficient for this task", {
      reason: "RETRIEVAL_INSUFFICIENT",
      completeness_status: packJson.completeness_status,
    });
  }
  if (integerField(packJson, "index_generation", "CTX pack") !== generation) {
    blocked("CTX generation changed while building context", {
      reason: "INDEX_GENERATION_CHANGED",
      status_generation: generation,
      pack_generation: packJson.index_generation,
    });
  }
  const retrieval = objectField(packJson, "retrieval_metadata", "CTX pack");
  const retrievalMode = stringField(retrieval, "retrieval_mode", "CTX pack retrieval metadata");
  if (retrievalMode !== "LEXICAL_ONLY" && retrievalMode !== "HYBRID_SEMANTIC") {
    blocked("CTX did not explicitly report a supported retrieval mode", {
      reason: "RETRIEVAL_MODE_UNSUPPORTED",
      retrieval_mode: retrievalMode,
    });
  }
  if (retrievalMode === "LEXICAL_ONLY" && packJson.completeness_status !== "COMPLETE") {
    blocked("Lexical CTX fallback did not retrieve sufficient authority", {
      reason: "RETRIEVAL_INSUFFICIENT",
    });
  }

  const allSourceDigests = { ...sourceDigests };
  const ranges = await verifiedRanges(
    options.root,
    packJson,
    generation,
    input.sources,
    allSourceDigests,
    retrievalIdentities,
  );

  const markdown = renderPack({
    taskId: options.taskId,
    taskPath: input.taskPath,
    taskText: input.taskText,
    taskSha256: input.taskSha256,
    projectPath: ".factory/project.yaml",
    projectSha256: input.projectSha256,
    constraints: input.project.constraints,
    sources: input.sources,
    ranges,
    generation,
    retrievalMode,
    tokenBudget,
    byteBudget,
  });
  const metrics = enforceBudget(markdown, tokenBudget, byteBudget);
  const packSha256 = sha256(markdown);
  const receipt: Receipt = {
    schema_version: 1,
    task_id: options.taskId,
    contract_sha256: input.taskSha256,
    project_contract_sha256: input.projectSha256,
    source_digests: allSourceDigests,
    pack_sha256: packSha256,
    ctx: { index_generation: generation, retrieval_mode: retrievalMode },
    budgets: {
      token: tokenBudget,
      estimated_tokens: metrics.tokens,
      bytes: metrics.bytes,
      byte_limit: byteBudget,
    },
    generated_at: new Date().toISOString(),
  };
  await assertInputsStable(options.root, {
    taskPath: input.taskPath,
    taskSha256: input.taskSha256,
    projectSha256: input.projectSha256,
    sourceDigests: allSourceDigests,
  });
  await writeAtomically(options.root, paths, markdown, `${JSON.stringify(receipt, null, 2)}\n`);

  return {
    schema_version: 1,
    ok: true,
    command: "context",
    task_id: options.taskId,
    pack_path: paths.pack,
    receipt_path: paths.receipt,
    token_budget: tokenBudget,
    estimated_tokens: metrics.tokens,
    byte_budget: byteBudget,
    bytes: metrics.bytes,
    previous_receipt_valid: prior.valid,
    receipt_invalid_reasons: prior.reasons,
    source_digests: allSourceDigests,
    ctx: { index_generation: generation, retrieval_mode: retrievalMode },
  };
}

async function loadInput(
  root: string,
  taskId: string,
): Promise<{
  project: ProjectContract;
  projectText: string;
  projectSha256: string;
  task: TaskContract;
  taskPath: string;
  taskText: string;
  taskSha256: string;
  sources: SourceFile[];
}> {
  const captured = new Map<string, string>();
  const validation = await validateProject(root, captured);
  if (validation.diagnostics.length > 0) {
    blocked("Project contracts or mandatory sources are invalid", {
      reason: "VALIDATION_FAILED",
      diagnostics: validation.diagnostics,
    });
  }
  const projectText = captured.get(".factory/project.yaml")!;
  const project = parseYamlContract(projectText, ".factory/project.yaml") as ProjectContract;
  let taskPath: string | undefined;
  let task: TaskContract | undefined;
  let taskText = "";
  for (const [path, text] of captured) {
    if (!path.startsWith(".factory/tasks/")) continue;
    const candidate = parseYamlContract(text, path) as TaskContract;
    if (candidate.id === taskId) {
      taskPath = path;
      task = candidate;
      taskText = text;
      break;
    }
  }
  if (taskPath === undefined || task === undefined) {
    blocked(`Task contract not found: ${taskId}`, { reason: "TASK_NOT_FOUND", task_id: taskId });
  }
  const required = [...new Set([...project.documents.required, ...task.context.required])];
  const sources: SourceFile[] = [];
  for (const path of required) {
    try {
      const text = await readTextFile(root, path, SOURCE_READ_LIMIT);
      const identity = await resolveInside(root, path);
      const existing = sources.find((source) => source.identity === identity);
      if (existing) {
        assertSameSnapshot(path, existing.sha256, sha256(text));
        existing.aliases.push(path);
      } else sources.push({ path, identity, aliases: [path], text, sha256: sha256(text) });
    } catch (error) {
      blocked("A mandatory context source cannot be read exactly", {
        reason: "MANDATORY_SOURCE_INVALID",
        diagnostic: asDiagnostic(error),
      });
    }
  }
  return {
    project,
    projectText,
    projectSha256: sha256(projectText),
    task,
    taskPath,
    taskText,
    taskSha256: sha256(taskText),
    sources,
  };
}

async function ctxCall(
  options: { root: string; ctxPath: string; timeoutMs?: number },
  args: string[],
): Promise<CtxJsonInvocation> {
  return await invokeCtxJson({
    ctxPath: options.ctxPath,
    root: options.root,
    args,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

function requireSuccessfulJson(
  invocation: CtxJsonInvocation,
  reason: string,
): Record<string, unknown> {
  if (
    invocation.summary.exit_code !== 0 ||
    invocation.summary.timed_out ||
    invocation.summary.json_parse_error !== undefined ||
    invocation.json === null
  ) {
    blocked("CTX returned an unusable response", {
      reason,
      command: invocation.summary.command,
      args: invocation.summary.args,
      exit_code: invocation.summary.exit_code,
      timed_out: invocation.summary.timed_out,
      stderr: invocation.summary.stderr,
      stdout: invocation.summary.stdout,
      json_parse_error: invocation.summary.json_parse_error,
    });
  }
  return invocation.json;
}

function assertFreshStatus(status: Record<string, unknown>): void {
  const category = stringField(status, "category", "CTX status");
  const stale = stringArray(status.stale_documents);
  const missing = stringArray(status.missing_documents);
  if (category === "SOURCE_STALE" || stale.length > 0) {
    blocked("CTX index is stale; synchronize it before generating context", {
      reason: "SOURCE_STALE",
      category,
      stale_documents: stale,
    });
  }
  if (missing.length > 0) {
    blocked("CTX index is missing configured documents", {
      reason: "INDEX_DOCUMENT_MISSING",
      category,
      missing_documents: missing,
    });
  }
  if (category !== "CLEAN" && category !== "EMBEDDINGS_STALE") {
    blocked("CTX status is not usable for context generation", {
      reason: "CTX_STATUS_UNUSABLE",
      category,
    });
  }
  const mode = stringField(status, "retrieval_mode", "CTX status");
  const channels = stringArray(status.active_channels);
  if (mode !== "LEXICAL_ONLY" && mode !== "HYBRID_SEMANTIC") {
    blocked("CTX status did not explicitly report a supported retrieval mode", {
      reason: "RETRIEVAL_MODE_UNSUPPORTED",
      retrieval_mode: mode,
    });
  }
  if (mode === "LEXICAL_ONLY" && !channels.includes("lexical")) {
    blocked("CTX lexical fallback was not explicitly reported as active", {
      reason: "RETRIEVAL_MODE_UNSUPPORTED",
      retrieval_mode: mode,
      active_channels: channels,
    });
  }
}

function assertSameSnapshot(path: string, captured: string | undefined, actual: string): void {
  if (captured !== undefined && captured !== actual) {
    blocked("A source changed while context was being generated", {
      reason: "SOURCE_CHANGED_DURING_GENERATION",
      paths: [path],
    });
  }
}

function selectedRetrievalIdentities(sources: SourceFile[], selectedPaths: string[]): Set<string> {
  const identities = new Set<string>();
  const missing: string[] = [];
  for (const path of selectedPaths) {
    const source = sources.find((candidate) => candidate.aliases.includes(path));
    if (source === undefined) missing.push(path);
    else identities.add(source.identity);
  }
  if (missing.length > 0) {
    blocked("CTX retrieval scope did not match the validated mandatory sources", {
      reason: "RETRIEVAL_SCOPE_INVALID",
      selected_documents: selectedPaths,
      missing_documents: missing,
    });
  }
  return identities;
}

async function verifiedRanges(
  root: string,
  pack: Record<string, unknown>,
  generation: number,
  mandatory: SourceFile[],
  digests: Record<string, string>,
  allowedIdentities: Set<string>,
): Promise<RetrievedRange[]> {
  if (!Array.isArray(pack.items)) {
    blocked("CTX pack omitted its items array", { reason: "CTX_PACK_INVALID" });
  }
  const snapshots = new Map(mandatory.map((source) => [source.identity, source.sha256]));
  const mandatoryIdentities = new Set(snapshots.keys());
  const cache = new Map<string, SourceFile>();
  const ranges: RetrievedRange[] = [];
  for (const rawItem of pack.items) {
    const item = asObject(rawItem, "CTX pack item");
    const source = objectField(item, "source", "CTX pack item");
    const text = stringField(source, "text", "CTX pack source");
    const provenance = objectField(source, "provenance", "CTX pack source");
    const path = stringField(provenance, "document_path", "CTX provenance");
    const expectedDocumentHash = stringField(provenance, "document_sha256", "CTX provenance");
    const startOffset = integerField(provenance, "start_offset", "CTX provenance");
    const endOffset = integerField(provenance, "end_offset", "CTX provenance");
    const itemGeneration = integerField(provenance, "index_generation", "CTX provenance");
    if (itemGeneration !== generation) {
      blocked("CTX excerpt provenance used a different index generation", {
        reason: "INDEX_GENERATION_CHANGED",
        path,
        expected: generation,
        actual: itemGeneration,
      });
    }
    let document = cache.get(path);
    if (document === undefined) {
      try {
        const original = await readTextFile(root, path, SOURCE_READ_LIMIT);
        document = {
          path,
          identity: await resolveInside(root, path),
          aliases: [path],
          text: original,
          sha256: sha256(original),
        };
        cache.set(path, document);
      } catch (error) {
        blocked("CTX provenance did not resolve to an exact source inside the repository", {
          reason: "PROVENANCE_MISMATCH",
          path,
          diagnostic: asDiagnostic(error),
        });
      }
    }
    const claimedRangeHash = provenance.range_sha256;
    if (
      document.sha256 !== expectedDocumentHash ||
      startOffset < 0 ||
      endOffset < startOffset ||
      endOffset > codePointLength(document.text) ||
      codePointSlice(document.text, startOffset, endOffset) !== text ||
      (typeof claimedRangeHash === "string" && claimedRangeHash !== sha256(text))
    ) {
      blocked("CTX excerpt does not exactly match its claimed original source range", {
        reason: "PROVENANCE_MISMATCH",
        path,
        start_offset: startOffset,
        end_offset: endOffset,
      });
    }
    if (!allowedIdentities.has(document.identity)) {
      blocked("CTX excerpt provenance was outside the selected retrieval scope", {
        reason: "RETRIEVAL_SCOPE_WIDENED",
        path,
      });
    }
    assertSameSnapshot(path, snapshots.get(document.identity), document.sha256);
    assertSameSnapshot(path, digests[path], document.sha256);
    snapshots.set(document.identity, document.sha256);
    digests[path] ??= document.sha256;
    if (mandatoryIdentities.has(document.identity)) continue;
    ranges.push({
      identity: document.identity,
      aliases: [path],
      path,
      text,
      sha256: document.sha256,
      rangeSha256: sha256(text),
      startOffset,
      endOffset,
      startLine: lineAt(document.text, startOffset),
      endLine: lineAt(document.text, Math.max(startOffset, endOffset - 1)),
    });
  }
  return mergeRanges(ranges, cache);
}

function mergeRanges(ranges: RetrievedRange[], cache: Map<string, SourceFile>): RetrievedRange[] {
  const ordered = [...ranges].sort(
    (left, right) =>
      left.identity.localeCompare(right.identity) ||
      left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset,
  );
  const merged: RetrievedRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.identity === range.identity &&
      range.startOffset <= previous.endOffset
    ) {
      previous.aliases = [...new Set([...previous.aliases, ...range.aliases])];
      if (range.endOffset > previous.endOffset) {
        previous.endOffset = range.endOffset;
        previous.endLine = range.endLine;
        const source = cache.get(range.path);
        if (source === undefined)
          blocked("Verified CTX source cache was lost", { reason: "INTERNAL" });
        previous.text = codePointSlice(source.text, previous.startOffset, previous.endOffset);
        previous.rangeSha256 = sha256(previous.text);
      }
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function renderPack(input: {
  taskId: string;
  taskPath: string;
  taskText: string;
  taskSha256: string;
  projectPath: string;
  projectSha256: string;
  constraints: string[];
  sources: SourceFile[];
  ranges: RetrievedRange[];
  generation: number;
  retrievalMode: string;
  tokenBudget: number;
  byteBudget: number;
}): string {
  const parts = [
    `# Factory task context: ${input.taskId}`,
    "",
    `CTX generation: \`${input.generation}\`  `,
    `Retrieval mode: \`${input.retrievalMode}\`  `,
    `Token budget: \`${input.tokenBudget}\`  `,
    `Byte budget: \`${input.byteBudget}\``,
    "",
    "## Exact task contract",
    "",
    `Source: \`${input.taskPath}\`  `,
    `SHA-256: \`${input.taskSha256}\``,
    "",
    input.taskText,
    "",
    "## Global project constraints",
    "",
    `Source: \`${input.projectPath}\`  `,
    `SHA-256: \`${input.projectSha256}\``,
    "",
    ...input.constraints.map((constraint) => `- ${constraint}`),
  ];
  for (const source of input.sources) {
    parts.push(
      "",
      `## Required source: ${source.path}`,
      "",
      `Source: ${source.aliases.map((path) => `\`${path}\``).join(", ")}  `,
      `SHA-256: \`${source.sha256}\``,
      "",
      source.text,
    );
  }
  for (const range of input.ranges) {
    parts.push(
      "",
      `## Retrieved context: ${range.path}:${range.startLine}-${range.endLine}`,
      "",
      `Source: ${range.aliases.map((path) => `\`${path}\``).join(", ")}  `,
      `Document SHA-256: \`${range.sha256}\`  `,
      `Range SHA-256: \`${range.rangeSha256}\`  `,
      `Original offsets: \`${range.startOffset}-${range.endOffset}\`  `,
      `CTX generation: \`${input.generation}\``,
      "",
      range.text,
    );
  }
  return `${parts.join("\n")}\n`;
}

function enforceBudget(
  content: string,
  tokenBudget: number,
  byteBudget: number,
): { tokens: number; bytes: number } {
  const bytes = Buffer.byteLength(content, "utf8");
  const tokens = estimateTokens(content);
  if (tokens > tokenBudget) {
    blocked("Context pack exceeds its token budget; no authoritative source was truncated", {
      reason: "TOKEN_BUDGET_EXCEEDED",
      token_budget: tokenBudget,
      estimated_tokens: tokens,
    });
  }
  if (bytes > byteBudget) {
    blocked("Context pack exceeds its byte budget; no authoritative source was truncated", {
      reason: "BYTE_BUDGET_EXCEEDED",
      byte_budget: byteBudget,
      bytes,
    });
  }
  return { tokens, bytes };
}

function estimateTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, "utf8") / TOKEN_BYTES);
}

function contextQuery(task: TaskContract): string {
  return [
    task.title,
    task.outcome,
    ...task.acceptance.map((item) => `${item.id}: ${item.statement}`),
    ...task.context.topics,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReceipt(value: unknown): value is Receipt {
  if (!isRecord(value)) return false;
  const digest = (entry: unknown): boolean =>
    typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry);
  const integer = (entry: unknown): boolean =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
  return (
    value.schema_version === 1 &&
    typeof value.task_id === "string" &&
    value.task_id.length > 0 &&
    digest(value.contract_sha256) &&
    digest(value.project_contract_sha256) &&
    digest(value.pack_sha256) &&
    isRecord(value.source_digests) &&
    Object.values(value.source_digests).every(digest) &&
    isRecord(value.ctx) &&
    integer(value.ctx.index_generation) &&
    (value.ctx.retrieval_mode === "LEXICAL_ONLY" ||
      value.ctx.retrieval_mode === "HYBRID_SEMANTIC") &&
    isRecord(value.budgets) &&
    [
      value.budgets.token,
      value.budgets.estimated_tokens,
      value.budgets.bytes,
      value.budgets.byte_limit,
    ].every(integer) &&
    typeof value.generated_at === "string" &&
    Number.isFinite(Date.parse(value.generated_at))
  );
}

async function inspectPriorReceipt(
  root: string,
  paths: { pack: string; receipt: string },
  current: {
    task: string;
    project: string;
    sources: Record<string, string>;
    generation: number;
  },
): Promise<{ valid: boolean; reasons: string[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, paths.receipt), "utf8")) as unknown;
  } catch {
    return { valid: false, reasons: ["RECEIPT_MISSING"] };
  }
  if (!isReceipt(parsed)) return { valid: false, reasons: ["RECEIPT_INVALID"] };
  const receipt = parsed;
  const reasons = new Set<string>();
  if (receipt.contract_sha256 !== current.task) reasons.add("CONTRACT_CHANGED");
  if (receipt.project_contract_sha256 !== current.project) reasons.add("PROJECT_CONTRACT_CHANGED");
  if (receipt.ctx?.index_generation !== current.generation) reasons.add("CTX_GENERATION_CHANGED");
  for (const [path, digest] of Object.entries(current.sources)) {
    if (receipt.source_digests?.[path] !== digest) reasons.add(`SOURCE_CHANGED:${path}`);
  }
  for (const [path, digest] of Object.entries(receipt.source_digests ?? {})) {
    try {
      const currentText = await readTextFile(root, path, SOURCE_READ_LIMIT);
      if (sha256(currentText) !== digest) reasons.add(`SOURCE_CHANGED:${path}`);
    } catch {
      reasons.add(`SOURCE_CHANGED:${path}`);
    }
  }
  try {
    const actualPackHash = sha256(await readFile(join(root, paths.pack), "utf8"));
    if (actualPackHash !== receipt.pack_sha256) reasons.add("PACK_CHANGED");
  } catch {
    reasons.add("PACK_MISSING");
  }
  return { valid: reasons.size === 0, reasons: [...reasons] };
}

async function assertInputsStable(
  root: string,
  expected: {
    taskPath: string;
    taskSha256: string;
    projectSha256: string;
    sourceDigests: Record<string, string>;
  },
): Promise<void> {
  const changed: string[] = [];
  const checks: Array<[string, string]> = [
    [expected.taskPath, expected.taskSha256],
    [".factory/project.yaml", expected.projectSha256],
    ...Object.entries(expected.sourceDigests),
  ];
  for (const [path, digest] of checks) {
    try {
      if (sha256(await readTextFile(root, path, SOURCE_READ_LIMIT)) !== digest) changed.push(path);
    } catch {
      changed.push(path);
    }
  }
  if (changed.length > 0) {
    blocked("A contract or source changed while context was being generated", {
      reason: "SOURCE_CHANGED_DURING_GENERATION",
      paths: [...new Set(changed)],
    });
  }
}

async function writeAtomically(
  root: string,
  paths: { directory: string; pack: string; receipt: string },
  pack: string,
  receipt: string,
): Promise<void> {
  for (const path of [paths.pack, paths.receipt]) {
    const ignored = await runCommand("git", ["check-ignore", "-q", "--", path], {
      cwd: root,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (ignored.exit_code !== 0 || ignored.timed_out) {
      blocked(
        "Context artifacts must be ignored by Git; run factory init and remove tracked state from the index",
        {
          reason: "STATE_NOT_IGNORED",
          path,
        },
      );
    }
  }
  const state = await resolveInside(root, ".factory/state");
  await mkdir(join(state, "context"), { recursive: true });
  const directory = await resolveInside(root, paths.directory);
  const suffix = `${process.pid}-${randomUUID()}`;
  const packTemp = join(directory, `.${paths.pack.split("/").at(-1)}.${suffix}.tmp`);
  const receiptTemp = join(directory, `.${paths.receipt.split("/").at(-1)}.${suffix}.tmp`);
  try {
    await writeFile(packTemp, pack, { encoding: "utf8", flag: "wx" });
    await writeFile(receiptTemp, receipt, { encoding: "utf8", flag: "wx" });
    await rename(packTemp, join(root, paths.pack));
    await rename(receiptTemp, join(root, paths.receipt));
  } finally {
    await rm(packTemp, { force: true });
    await rm(receiptTemp, { force: true });
  }
}

function contextPaths(taskId: string): { directory: string; pack: string; receipt: string } {
  return {
    directory: ".factory/state/context",
    pack: `.factory/state/context/${taskId}.md`,
    receipt: `.factory/state/context/${taskId}.json`,
  };
}

function lineAt(text: string, offset: number): number {
  return codePointSlice(text, 0, offset).split("\n").length;
}

function codePointSlice(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join("");
}

function codePointLength(text: string): number {
  return [...text].length;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function objectField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  return asObject(value[key], `${label}.${key}`);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    blocked(`${label} must be a JSON object`, { reason: "CTX_JSON_INVALID", field: label });
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    blocked(`${label}.${key} must be a non-empty string`, {
      reason: "CTX_JSON_INVALID",
      field: `${label}.${key}`,
    });
  }
  return field;
}

function integerField(value: Record<string, unknown>, key: string, label: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) {
    blocked(`${label}.${key} must be an integer`, {
      reason: "CTX_JSON_INVALID",
      field: `${label}.${key}`,
    });
  }
  return field;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function blocked(message: string, details: Record<string, unknown>): never {
  throw new ContextIssue("CONTEXT_BLOCKED", message, details);
}
