import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function isExpectedOriginalReference(value, options) {
  return value === (options.expectedOriginalReference ?? "docs/AUTH.md");
}

export const AUDIT_REJECTION_REASONS = Object.freeze({
  unexpectedTools: "unexpected tool events",
  readCount: "expected exactly one read of the supplied original",
  missingCallId: "original read start omitted toolCallId",
  range: "original read used offset or limit",
  matchingCompletion: "expected one matching read completion",
  duplicateCompletion: "read event stream contains an unmatched or duplicate completion",
  completionOrder: "read completion did not occur after its matching start",
  completionFailed: "matching read completion was not explicitly successful",
  completionContent: "successful read completion omitted one authoritative text result",
  bytes: "read result bytes do not equal the supplied exact original",
  decisive: "the supplied original does not contain every declared decisive constraint",
  responseOrder: "final assistant response did not occur after the successful original read",
});
const ALLOWLISTED_REASONS = new Set(Object.values(AUDIT_REJECTION_REASONS));

export function sanitizedAuditReason(reason) {
  return ALLOWLISTED_REASONS.has(reason) ? reason : "SDK event audit rejected the event stream";
}

export function auditReadEvents(events, options) {
  const expectedPath = resolve(options.root, options.expectedOriginalPath);
  const expectedBytes = Buffer.isBuffer(options.expectedOriginal)
    ? options.expectedOriginal
    : Buffer.from(options.expectedOriginal, "utf8");
  const expectedText = expectedBytes.toString("utf8");
  const decisiveText = options.decisiveText ?? [];
  const starts = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === "tool_execution_start");
  const ends = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === "tool_execution_end");
  const readStarts = starts.filter(({ event }) => event.toolName === "read");
  const readEnds = ends.filter(({ event }) => event.toolName === "read");
  const otherToolCalls = starts.filter(({ event }) => event.toolName !== "read");
  const otherToolCompletions = ends.filter(({ event }) => event.toolName !== "read");
  const resolvedReads = readStarts.map(({ event, index }) => ({
    event,
    index,
    path: event.args?.path,
    resolvedPath:
      typeof event.args?.path === "string" ? resolve(options.root, event.args.path) : null,
  }));
  const originalReads = resolvedReads.filter((entry) => entry.resolvedPath === expectedPath);
  const rejectedReads = resolvedReads.filter((entry) => entry.resolvedPath !== expectedPath);
  const summary = {
    read_count: readStarts.length,
    project_read_count: originalReads.length,
    project_read_paths: originalReads.map((entry) => entry.resolvedPath),
    rejected_read_paths: rejectedReads.map((entry) => entry.path),
    other_tool_calls: otherToolCalls.map(({ event }) => event.toolName),
    other_tool_completions: otherToolCompletions.map(({ event }) => event.toolName),
    completed_successfully: false,
    exact_original: false,
    expected_sha256: sha256(expectedBytes),
    returned_sha256: null,
    returned_bytes: null,
    tool_call_id: null,
    start_event_index: null,
    end_event_index: null,
    response_event_index: null,
  };
  const reject = (reason) => ({ ok: false, reason, summary });

  if (otherToolCalls.length > 0 || otherToolCompletions.length > 0) {
    return reject(AUDIT_REJECTION_REASONS.unexpectedTools);
  }
  if (readStarts.length !== 1 || originalReads.length !== 1 || rejectedReads.length > 0) {
    return reject(AUDIT_REJECTION_REASONS.readCount);
  }

  const start = originalReads[0];
  const callId = start.event.toolCallId;
  summary.tool_call_id = typeof callId === "string" ? callId : null;
  summary.start_event_index = start.index;
  if (typeof callId !== "string" || callId.length === 0) {
    return reject(AUDIT_REJECTION_REASONS.missingCallId);
  }
  const args = start.event.args;
  if (
    args !== null &&
    typeof args === "object" &&
    (Object.hasOwn(args, "offset") || Object.hasOwn(args, "limit"))
  ) {
    return reject(AUDIT_REJECTION_REASONS.range);
  }

  const matchingEnds = readEnds.filter(({ event }) => event.toolCallId === callId);
  if (matchingEnds.length !== 1) {
    return reject(AUDIT_REJECTION_REASONS.matchingCompletion);
  }
  if (readEnds.length !== 1) {
    return reject(AUDIT_REJECTION_REASONS.duplicateCompletion);
  }
  const end = matchingEnds[0];
  summary.end_event_index = end.index;
  if (end.index <= start.index) {
    return reject(AUDIT_REJECTION_REASONS.completionOrder);
  }
  if (end.event.isError !== false) {
    return reject(AUDIT_REJECTION_REASONS.completionFailed);
  }
  const content = end.event.result?.content;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0]?.type !== "text" ||
    typeof content[0].text !== "string"
  ) {
    return reject(AUDIT_REJECTION_REASONS.completionContent);
  }
  const returnedBytes = Buffer.from(content[0].text, "utf8");
  summary.returned_sha256 = sha256(returnedBytes);
  summary.returned_bytes = returnedBytes.length;
  if (!returnedBytes.equals(expectedBytes)) {
    return reject(AUDIT_REJECTION_REASONS.bytes);
  }
  if (decisiveText.some((text) => !expectedText.includes(text))) {
    return reject(AUDIT_REJECTION_REASONS.decisive);
  }

  const finalResponse = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === "message_end" && event.message?.role === "assistant")
    .at(-1);
  summary.response_event_index = finalResponse?.index ?? null;
  if (finalResponse === undefined || finalResponse.index <= end.index) {
    return reject(AUDIT_REJECTION_REASONS.responseOrder);
  }

  summary.completed_successfully = true;
  summary.exact_original = true;
  return { ok: true, summary };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assistantResponseText(events) {
  const messages = events
    .filter((event) => event?.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message);
  const final = messages.at(-1);
  if (final === undefined) {
    return { ok: false, reason: "SDK event stream omitted the final assistant message" };
  }
  for (const message of messages.slice(0, -1)) {
    if (!isToolCallEnvelope(message)) {
      return { ok: false, reason: "an earlier assistant message carried unsupported content" };
    }
  }
  if (final.stopReason !== "stop") {
    return { ok: false, reason: "final assistant message did not stop normally" };
  }
  if (typeof final.content === "string") return { ok: true, text: final.content };
  if (
    !Array.isArray(final.content) ||
    !final.content.some((block) => block?.type === "text") ||
    !final.content.every(
      (block) =>
        (block?.type === "text" && typeof block.text === "string") || isThinkingBlock(block),
    )
  ) {
    return { ok: false, reason: "final assistant message carried an unsupported content channel" };
  }
  return {
    ok: true,
    text: final.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
  };
}

function isToolCallEnvelope(message) {
  return (
    message.stopReason === "toolUse" &&
    Array.isArray(message.content) &&
    message.content.some((block) => block?.type === "toolCall") &&
    message.content.every(
      (block) =>
        (block?.type === "toolCall" && typeof block.id === "string") ||
        isThinkingBlock(block) ||
        (block?.type === "text" && typeof block.text === "string" && block.text.trim() === ""),
    )
  );
}

function isThinkingBlock(block) {
  return block?.type === "thinking" && typeof block.thinking === "string";
}
