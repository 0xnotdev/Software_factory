import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function isExpectedOriginalReference(value, options) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const reference = value.trim();
  const expectedPath = resolve(options.root, options.expectedOriginalPath);
  const referenceRoot = options.referenceRoot ?? options.root;
  return resolve(referenceRoot, reference) === expectedPath;
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
    return reject(
      `unexpected tool events ${[
        ...summary.other_tool_calls,
        ...summary.other_tool_completions,
      ].join(", ")}`,
    );
  }
  if (readStarts.length !== 1 || originalReads.length !== 1 || rejectedReads.length > 0) {
    return reject(
      `expected exactly one read of the supplied original, saw ${originalReads.length} original and ${rejectedReads.length} other reads`,
    );
  }

  const start = originalReads[0];
  const callId = start.event.toolCallId;
  summary.tool_call_id = typeof callId === "string" ? callId : null;
  summary.start_event_index = start.index;
  if (typeof callId !== "string" || callId.length === 0) {
    return reject("original read start omitted toolCallId");
  }
  if (start.event.args?.offset !== undefined) {
    return reject("original read used an explicit offset");
  }
  if (start.event.args?.limit !== undefined) {
    return reject("original read used an explicit limit");
  }

  const matchingEnds = readEnds.filter(({ event }) => event.toolCallId === callId);
  if (matchingEnds.length !== 1) {
    return reject(
      `expected one matching read completion for ${callId}, saw ${matchingEnds.length}`,
    );
  }
  if (readEnds.length !== 1) {
    return reject("read event stream contains an unmatched or duplicate completion");
  }
  const end = matchingEnds[0];
  summary.end_event_index = end.index;
  if (end.index <= start.index) {
    return reject("read completion did not occur after its matching start");
  }
  if (end.event.isError !== false) {
    return reject("matching read completion was not explicitly successful");
  }
  const content = end.event.result?.content;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0]?.type !== "text" ||
    typeof content[0].text !== "string"
  ) {
    return reject("successful read completion omitted one authoritative text result");
  }
  const returnedBytes = Buffer.from(content[0].text, "utf8");
  summary.returned_sha256 = sha256(returnedBytes);
  summary.returned_bytes = returnedBytes.length;
  if (!returnedBytes.equals(expectedBytes)) {
    return reject("read result bytes do not equal the supplied exact original");
  }
  if (decisiveText.some((text) => !expectedText.includes(text))) {
    return reject("the supplied original does not contain every declared decisive constraint");
  }

  const finalResponse = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === "message_end" && event.message?.role === "assistant")
    .at(-1);
  summary.response_event_index = finalResponse?.index ?? null;
  if (finalResponse === undefined || finalResponse.index <= end.index) {
    return reject("final assistant response did not occur after the successful original read");
  }

  summary.completed_successfully = true;
  summary.exact_original = true;
  return { ok: true, summary };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
