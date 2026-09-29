import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { auditReadEvents, isExpectedOriginalReference } from "../scripts/cp06-worker-audit.mjs";

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

test("worker read audit accepts one completed exact-original read before the response", () => {
  const audit = auditReadEvents([start, successfulEnd(), finalMessage], options);
  assert.equal(audit.ok, true);
  assert.equal(audit.summary.completed_successfully, true);
  assert.equal(audit.summary.exact_original, true);
  assert.equal(audit.summary.expected_sha256, audit.summary.returned_sha256);
});
