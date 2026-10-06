import { isExpectedOriginalReference } from "./cp06-worker-audit.mjs";

export function auditWorkerOutcome(response, options) {
  const topLevelKeys = [
    "broad_scan",
    "corrected_constraints",
    "evidence_gaps",
    "missing_source",
    "reads",
    "status",
  ];
  const corrected = response?.corrected_constraints;
  if (
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    Object.keys(response).sort().join(",") !== topLevelKeys.join(",") ||
    response.status !== "MISSING_SOURCE" ||
    !isExpectedOriginalReference(response.missing_source, options) ||
    response.broad_scan !== false ||
    !Array.isArray(response.reads) ||
    response.reads.length !== 1 ||
    response.reads[0] !== options.expectedOriginalPath ||
    !Array.isArray(corrected) ||
    corrected.length !== 2 ||
    corrected[0] !== "ownership comes only from the authenticated principal" ||
    corrected[1] !== "request-supplied owner fields are ignored"
  ) {
    return { ok: false, reason: "response did not satisfy the targeted-read oracle" };
  }
  const gaps = response.evidence_gaps;
  const gap = Array.isArray(gaps) && gaps.length === 1 ? gaps[0] : undefined;
  const checks = gap?.missing_checks;
  if (
    gap === null ||
    typeof gap !== "object" ||
    Array.isArray(gap) ||
    Object.keys(gap).sort().join(",") !== "id,missing_checks,status" ||
    gap.id !== "creation-time-ownership" ||
    gap.status !== "unverified" ||
    !Array.isArray(checks) ||
    checks.length !== 2 ||
    !checks.includes("principal-derived-owner") ||
    !checks.includes("request-owner-ignored")
  ) {
    return {
      ok: false,
      reason: "creation-time ownership evidence must remain explicitly unverified",
    };
  }
  return { ok: true };
}
