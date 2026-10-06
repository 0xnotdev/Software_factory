import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  AUDIT_REJECTION_REASONS,
  assistantResponseText,
  auditReadEvents,
  isExpectedOriginalReference,
  sanitizedAuditReason,
} from "../scripts/cp06-worker-audit.mjs";

const root = process.cwd();
const originalPath = resolve(root, "test/fixtures/cp06-context/docs/AUTH.md");
const original = await readFile(originalPath);
const options = {
  root,
  expectedOriginalPath: originalPath,
  expectedOriginal: original,
  decisiveText: ["request-supplied owner fields are ignored"],
};
const start = {
  type: "tool_execution_start",
  toolName: "read",
  toolCallId: "read-auth",
  args: { path: originalPath },
};
const finalMessage = {
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "{}" }] },
};

function successfulEnd(overrides = {}) {
  return {
    type: "tool_execution_end",
    toolName: "read",
    toolCallId: "read-auth",
    isError: false,
    result: { content: [{ type: "text", text: original.toString("utf8") }] },
    ...overrides,
  };
}

for (const [name, events] of [
  ["omitted completion", [start, finalMessage]],
  [
    "stub failed read completion",
    [
      start,
      successfulEnd({ isError: true, result: { content: [{ type: "text", text: "ENOENT" }] } }),
      finalMessage,
    ],
  ],
  [
    "partial read",
    [
      { ...start, args: { path: originalPath, offset: 1, limit: 1 } },
      successfulEnd({
        result: { content: [{ type: "text", text: "# Authentication and tenancy" }] },
      }),
      finalMessage,
    ],
  ],
  [
    "explicit first-line offset with complete bytes",
    [{ ...start, args: { path: originalPath, offset: 1 } }, successfulEnd(), finalMessage],
  ],
  [
    "explicit limit with complete bytes",
    [
      { ...start, args: { path: originalPath, limit: Number.MAX_SAFE_INTEGER } },
      successfulEnd(),
      finalMessage,
    ],
  ],
  [
    "wrong starting range",
    [
      { ...start, args: { path: originalPath, offset: 2 } },
      successfulEnd({
        result: {
          content: [
            {
              type: "text",
              text: original.toString("utf8").split("\n").slice(1).join("\n"),
            },
          ],
        },
      }),
      finalMessage,
    ],
  ],
  [
    "mismatched completion id",
    [start, successfulEnd({ toolCallId: "different-call" }), finalMessage],
  ],
  ["completion before start", [successfulEnd(), start, finalMessage]],
  ["response before completion", [start, finalMessage, successfulEnd()]],
  [
    "orphan non-read completion",
    [
      start,
      successfulEnd(),
      {
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "orphan-bash",
        isError: false,
        result: { content: [{ type: "text", text: "unexpected" }] },
      },
      finalMessage,
    ],
  ],
]) {
  test(`worker read audit rejects ${name}`, () => {
    assert.equal(auditReadEvents(events, options).ok, false);
  });
}

test("worker read audit rejects another project read", () => {
  const events = [
    start,
    successfulEnd(),
    {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "read-extra",
      args: { path: resolve(root, "PROJECT.md") },
    },
    {
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "read-extra",
      isError: false,
      result: { content: [{ type: "text", text: "extra" }] },
    },
    finalMessage,
  ];
  assert.equal(auditReadEvents(events, options).ok, false);
});

test("worker missing-source identity accepts only the canonical original path", () => {
  const fixtureRoot = resolve(root, "test/fixtures/cp06-context");
  assert.equal(
    isExpectedOriginalReference("docs/AUTH.md", {
      root,
      referenceRoot: fixtureRoot,
      expectedOriginalPath: originalPath,
    }),
    true,
  );
  assert.equal(
    isExpectedOriginalReference("./docs/AUTH.md", {
      root,
      referenceRoot: fixtureRoot,
      expectedOriginalPath: originalPath,
    }),
    false,
  );
  assert.equal(
    isExpectedOriginalReference(originalPath, {
      root,
      referenceRoot: fixtureRoot,
      expectedOriginalPath: originalPath,
    }),
    false,
  );
  assert.equal(
    isExpectedOriginalReference("docs/OTHER.md", {
      root,
      referenceRoot: fixtureRoot,
      expectedOriginalPath: originalPath,
    }),
    false,
  );
  assert.equal(
    isExpectedOriginalReference("unrelated but nonempty", {
      root,
      referenceRoot: fixtureRoot,
      expectedOriginalPath: originalPath,
    }),
    false,
  );
});

test("worker read audit accepts one completed exact-original read without offset or limit", () => {
  const audit = auditReadEvents([start, successfulEnd(), finalMessage], options);
  assert.equal(audit.ok, true);
  assert.equal(audit.summary.completed_successfully, true);
  assert.equal(audit.summary.exact_original, true);
  assert.equal(audit.summary.expected_sha256, audit.summary.returned_sha256);
});

for (const [name, args] of [
  ["the SDK first-line range", { offset: 1, limit: 2_000 }],
  ["an explicit offset", { offset: 1 }],
  ["an explicit limit", { limit: Number.MAX_SAFE_INTEGER }],
]) {
  test(`worker read audit rejects ${name} even when it returns the complete original`, () => {
    const audit = auditReadEvents(
      [{ ...start, args: { path: originalPath, ...args } }, successfulEnd(), finalMessage],
      options,
    );
    assert.equal(audit.ok, false);
    assert.equal(audit.reason, AUDIT_REJECTION_REASONS.range);
  });
}

test("worker read audit reasons never carry event-controlled names or IDs", () => {
  const secretTool = {
    type: "tool_execution_start",
    toolName: "DUMMY-SECRET-TOOL",
    toolCallId: "DUMMY-SECRET-ID",
    args: {},
  };
  const unmatched = successfulEnd({ toolCallId: "DUMMY-SECRET-ID" });
  for (const events of [
    [start, successfulEnd(), secretTool, finalMessage],
    [{ ...start, toolCallId: "DUMMY-SECRET-ID" }, successfulEnd(), finalMessage],
    [start, unmatched, finalMessage],
  ]) {
    const audit = auditReadEvents(events, options);
    assert.equal(audit.ok, false);
    assert.equal(audit.reason.includes("DUMMY-SECRET"), false);
    assert.equal(sanitizedAuditReason(audit.reason), audit.reason);
  }
  assert.equal(
    sanitizedAuditReason("unexpected tool DUMMY-SECRET-TOOL"),
    "SDK event audit rejected the event stream",
  );
});

test("assistant envelope rejects competing evidence and unsupported final channels", () => {
  const toolCall = { type: "toolCall", id: "read-auth", name: "read", arguments: {} };
  const toolUse = (content) => ({
    type: "message_end",
    message: { role: "assistant", stopReason: "toolUse", content },
  });
  const final = (content) => ({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content },
  });
  const accepted = assistantResponseText([
    toolUse([{ type: "thinking", thinking: "DUMMY plan" }, toolCall]),
    final([{ type: "text", text: '{"status":"MISSING_SOURCE"}' }]),
  ]);
  assert.deepEqual(accepted, { ok: true, text: '{"status":"MISSING_SOURCE"}' });
  for (const events of [
    [],
    [toolUse([{ type: "text", text: "Creation verified and passed" }, toolCall]), final("{}")],
    [final([{ type: "text", text: "Creation passed" }]), final([{ type: "text", text: "{}" }])],
    [toolUse([toolCall]), final([{ type: "text", text: "{}" }, toolCall])],
    [toolUse([toolCall]), final([{ type: "image", data: "DUMMY", mimeType: "image/png" }])],
    [
      toolUse([toolCall]),
      { ...final("{}"), message: { ...final("{}").message, stopReason: "length" } },
    ],
  ]) {
    assert.equal(assistantResponseText(events).ok, false);
  }
});
