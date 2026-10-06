import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workerEvidenceContext } from "./cp06-worker-evidence.mjs";
import { DUMMY_OUTCOME_ORIGINAL, DUMMY_PI_PROVENANCE } from "./cp06-dummy-originals.mjs";
import { resolvePinnedPiProvenance } from "./cp06-pi-install.mjs";

export function dummyWorkerContext(directory = "/DUMMY") {
  return {
    input: { provider: "openai-codex", model: "DUMMY-model", timeout_ms: 1_000 },
    paths: { root: directory, fixtureRoot: directory, originalPath: `${directory}/docs/AUTH.md` },
    original: Buffer.from(DUMMY_OUTCOME_ORIGINAL),
    provenance: DUMMY_PI_PROVENANCE,
  };
}

export function dummyWorkerEvidence({ input, paths, original } = dummyWorkerContext()) {
  const hash = createHash("sha256").update(original).digest("hex");
  return {
    schema_version: 1,
    result: "pass",
    pi_version: "0.85.1",
    pi_install: structuredClone(DUMMY_PI_PROVENANCE),
    provider: input.provider,
    model: input.model,
    oauth_preflight: {
      minimum_validity_ms: input.timeout_ms + 300_000,
      remaining_validity_ms: input.timeout_ms + 600_000,
      refreshed: false,
    },
    credential_store: { reads: 1, lists: 0, modify_denials: 0, delete_denials: 0 },
    session: { in_memory: true, active_tools: ["read"] },
    event_stream: {
      sha256: "0".repeat(64),
      event_count: 3,
      read_audit: {
        read_count: 1,
        project_read_count: 1,
        project_read_paths: [paths.originalPath],
        rejected_read_paths: [],
        other_tool_calls: [],
        other_tool_completions: [],
        completed_successfully: true,
        exact_original: true,
        expected_sha256: hash,
        returned_sha256: hash,
        returned_bytes: Buffer.byteLength(original),
        tool_call_id: "DUMMY-read",
        start_event_index: 0,
        end_event_index: 1,
        response_event_index: 2,
      },
    },
    response: {
      status: "MISSING_SOURCE",
      missing_source: "docs/AUTH.md",
      reads: [paths.originalPath],
      corrected_constraints: [
        "ownership comes only from the authenticated principal",
        "request-supplied owner fields are ignored",
      ],
      evidence_gaps: [
        {
          id: "creation-time-ownership",
          status: "unverified",
          missing_checks: ["principal-derived-owner", "request-owner-ignored"],
        },
      ],
      broad_scan: false,
    },
    response_sha256: "1".repeat(64),
    raw_transcript_retained: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const context = workerEvidenceContext(process.argv[2]);
    const evidence = dummyWorkerEvidence(context);
    if (process.argv[3] === "invalid") evidence.response = { status: "PASS", evidence_gaps: [] };
    if (process.argv[3] === "installed") {
      evidence.pi_install = resolvePinnedPiProvenance({
        projectRoot: process.env.CP06_PROJECT_ROOT,
        packageRoot: process.env.CP06_PI_PACKAGE_ROOT,
        executable: process.env.CP06_PI_BIN,
      });
    }
    if (process.argv[3] === "forged-provenance") {
      evidence.pi_install.package_artifact.tarball_integrity = "sha512-DUMMY-SECRET-CLI-MARKER";
    }
    console.log(JSON.stringify(evidence));
  } catch {
    process.stderr.write("CP06_DUMMY_EVIDENCE_FAILED\n");
    process.exitCode = 70;
  }
}
