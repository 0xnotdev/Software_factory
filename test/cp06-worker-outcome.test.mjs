import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import test from "node:test";
import { auditWorkerOutcome } from "../scripts/cp06-worker-outcome.mjs";

const root = process.cwd();
const options = {
  root,
  referenceRoot: resolve(root, "test/fixtures/cp06-context"),
  expectedOriginalPath: resolve(root, "test/fixtures/cp06-context/docs/AUTH.md"),
};
const gap = {
  id: "creation-time-ownership",
  status: "unverified",
  missing_checks: ["principal-derived-owner", "request-owner-ignored"],
};
const response = {
  status: "MISSING_SOURCE",
  missing_source: "docs/AUTH.md",
  reads: [options.expectedOriginalPath],
  broad_scan: false,
  corrected_constraints: [
    "Ownership comes only from the authenticated principal; request-supplied owner fields are ignored.",
  ],
  evidence_gaps: [gap],
};

test("worker outcome accepts the required structured unverified creation checks", () => {
  assert.equal(auditWorkerOutcome(response, options).ok, true);
  assert.equal(
    auditWorkerOutcome(
      {
        ...response,
        evidence_gaps: [{ ...gap, missing_checks: [...gap.missing_checks].reverse() }],
      },
      options,
    ).ok,
    true,
  );
});

for (const [name, evidence_gaps] of [
  ["missing", undefined],
  ["empty", []],
  ["legacy prose without a check disposition", ["creation evidence missing"]],
  ["contradictory passed disposition", [{ ...gap, status: "pass" }]],
  ["contradictory verified flag", [{ ...gap, verified: true }]],
  ["wrong gap", [{ ...gap, id: "read-time-ownership" }]],
  ["omitted ignored-owner check", [{ ...gap, missing_checks: ["principal-derived-owner"] }]],
  [
    "duplicate checks",
    [{ ...gap, missing_checks: ["principal-derived-owner", "principal-derived-owner"] }],
  ],
  ["mixed unverified and passed", [gap, { ...gap, status: "pass" }]],
]) {
  test(`worker outcome rejects ${name} creation evidence`, () => {
    assert.equal(auditWorkerOutcome({ ...response, evidence_gaps }, options).ok, false);
  });
}

test("creation evidence cannot replace source recovery or relax the read outcome", () => {
  for (const change of [
    { status: "PASS" },
    { missing_source: "docs/OTHER.md" },
    { missing_source: "./docs/AUTH.md" },
    { missing_source: resolve(root, "test/fixtures/cp06-context/docs/AUTH.md") },
    { broad_scan: true },
    { reads: [] },
    { reads: [resolve(root, "PROJECT.md")] },
    { corrected_constraints: [] },
    {
      corrected_constraints: [
        ...response.corrected_constraints,
        "creation behavior was independently verified",
      ],
    },
    {
      corrected_constraints: [
        `${response.corrected_constraints[0]} These creation checks passed.`,
      ],
    },
    { creation_evidence: { status: "passed" } },
    { verified: true },
  ])
    assert.equal(auditWorkerOutcome({ ...response, ...change }, options).ok, false);
  assert.equal(auditWorkerOutcome(null, options).ok, false);
});
