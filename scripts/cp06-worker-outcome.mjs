import { isExpectedOriginalReference } from "./cp06-worker-audit.mjs";

export function auditWorkerOutcome(response, options) {
  const corrected = Array.isArray(response?.corrected_constraints)
    ? response.corrected_constraints.join(" ")
    : "";
  if (
    response?.status !== "MISSING_SOURCE" ||
    !isExpectedOriginalReference(response.missing_source, options) ||
    response.broad_scan !== false ||
    !/ownership comes only from the authenticated principal/i.test(corrected) ||
    !/request-supplied owner fields? (?:are )?ignored/i.test(corrected)
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
