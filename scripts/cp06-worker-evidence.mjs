import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { auditWorkerOutcome } from "./cp06-worker-outcome.mjs";
import { validateReadAudit } from "./cp06-auth-security.mjs";
import { canonicalWorkerPaths, readPinnedRegularFile } from "./cp06-guarded-read.mjs";
import { DUMMY_PI_PROVENANCE } from "./cp06-dummy-originals.mjs";
import { resolvePinnedPiProvenance } from "./cp06-pi-install.mjs";

export function workerEvidenceContext(inputPath, target, source, { provenance } = {}) {
  const input = readWorkerInput(inputPath);
  const paths = canonicalWorkerPaths(input, target, source);
  const snapshot = readPinnedRegularFile(paths.originalPath);
  return { input, paths, original: snapshot.bytes, originalIdentity: snapshot.identity, provenance };
}

// The supervisor resolves the selected installation itself without executing
// Pi; the DUMMY expectation is a fixed literal no genuine installation reports.
export function trustedWorkerProvenance({ root, environment, dummy = false }) {
  if (dummy) return DUMMY_PI_PROVENANCE;
  return resolvePinnedPiProvenance({
    projectRoot: root,
    packageRoot: environment.CP06_PI_PACKAGE_ROOT,
    executable: environment.CP06_PI_BIN,
  });
}

export function readWorkerInput(path) {
  if (path === `/proc/${process.pid}/fd/5` || path === "/proc/self/fd/4") {
    const fd = openSync(path, constants.O_RDONLY | constants.O_CLOEXEC);
    try {
      const identity = fstatSync(fd);
      if (!identity.isFile() || identity.nlink !== 1 || identity.size < 1 || identity.size > 50 * 1024) throw new Error("CP06_CHILD_OUTPUT_INVALID");
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
  }
  return JSON.parse(readPinnedRegularFile(path).bytes.toString("utf8"));
}

export function validateWorkerEvidence(child, { input, paths, original, originalIdentity, provenance }) {
  if (originalIdentity) {
    const current = readPinnedRegularFile(paths.originalPath);
    for (const key of ["dev", "ino", "size", "nlink", "mode", "mtimeNs", "ctimeNs"]) requireValue(current.identity[key] === originalIdentity[key]);
    requireValue(current.bytes.equals(original));
  }
  exact(child, ["credential_store", "event_stream", "model", "oauth_preflight", "pi_install", "pi_version", "provider", "raw_transcript_retained", "response", "response_sha256", "result", "schema_version", "session"]);
  requireValue(child.schema_version === 1 && child.result === "pass" && child.pi_version === "0.85.1" && child.raw_transcript_retained === false);
  requireValue(child.provider === input.provider && child.model === input.model);
  exact(child.pi_install, ["install_root", "package_root", "package_artifact", "dependency", "executable", "executable_entry", "sdk_entry", "package_sha256", "executable_sha256", "sdk_entry_sha256"]);
  for (const key of ["install_root", "package_root", "executable", "executable_entry", "sdk_entry"]) requireValue(typeof child.pi_install[key] === "string" && child.pi_install[key].startsWith("/"));
  for (const key of ["package_sha256", "executable_sha256", "sdk_entry_sha256"]) requireValue(digest(child.pi_install[key]));
  exact(child.pi_install.package_artifact, ["manifest_sha256", "tarball_integrity"]);
  requireValue(digest(child.pi_install.package_artifact.manifest_sha256) && typeof child.pi_install.package_artifact.tarball_integrity === "string" && child.pi_install.package_artifact.tarball_integrity.startsWith("sha512-"));
  exact(child.pi_install.dependency, ["entry", "entry_sha256", "manifest_sha256", "name", "package_sha256", "resolution", "root", "tarball_integrity", "version"]);
  const dependency = child.pi_install.dependency;
  requireValue(dependency.version === "0.85.1" && dependency.name === "@earendil-works/pi-ai" && dependency.resolution === "esm-import-condition");
  for (const key of ["entry_sha256", "manifest_sha256", "package_sha256"]) requireValue(digest(dependency[key]));
  for (const key of ["root", "entry"]) requireValue(typeof dependency[key] === "string" && dependency[key].startsWith("/"));
  requireValue(typeof dependency.tarball_integrity === "string" && dependency.tarball_integrity.startsWith("sha512-"));
  requireValue(provenance !== undefined && sameJson(child.pi_install, provenance));
  exact(child.oauth_preflight, ["minimum_validity_ms", "remaining_validity_ms", "refreshed"]);
  requireValue(child.oauth_preflight.refreshed === false && child.oauth_preflight.minimum_validity_ms === input.timeout_ms + 300_000 && Number.isSafeInteger(child.oauth_preflight.remaining_validity_ms) && child.oauth_preflight.remaining_validity_ms >= child.oauth_preflight.minimum_validity_ms);
  exact(child.credential_store, ["reads", "lists", "modify_denials", "delete_denials"]);
  requireValue(Number.isSafeInteger(child.credential_store.reads) && child.credential_store.reads >= 1 && Number.isSafeInteger(child.credential_store.lists) && child.credential_store.lists >= 0 && child.credential_store.modify_denials === 0 && child.credential_store.delete_denials === 0);
  exact(child.session, ["in_memory", "active_tools"]);
  requireValue(child.session.in_memory === true && JSON.stringify(child.session.active_tools) === '["read"]');
  exact(child.event_stream, ["sha256", "event_count", "read_audit"]);
  requireValue(digest(child.event_stream.sha256) && digest(child.response_sha256));
  validateReadAudit(child.event_stream.read_audit, {
    toolCallId: child.event_stream.read_audit?.tool_call_id,
    originalPath: paths.originalPath,
    original,
    eventCount: child.event_stream.event_count,
  });
  requireValue(typeof child.event_stream.read_audit.tool_call_id === "string" && child.event_stream.read_audit.tool_call_id.length > 0);
  requireValue(auditWorkerOutcome(child.response, {
    root: paths.root,
    referenceRoot: paths.fixtureRoot,
    expectedOriginalPath: paths.originalPath,
  }).ok);
  return child;
}

function sameJson(actual, expected) {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (actual === null || typeof actual !== "object" || Array.isArray(actual) !== Array.isArray(expected)) return false;
  const keys = Object.keys(expected).sort();
  return Object.keys(actual).sort().join(",") === keys.join(",") && keys.every((key) => sameJson(actual[key], expected[key]));
}
function exact(value, keys) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys.sort().join(","));
}
function requireValue(value) {
  if (!value) throw new Error("CP06_CHILD_OUTPUT_INVALID");
}
function digest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
