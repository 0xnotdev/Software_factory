// Development-only DUMMY executable shims for CLI failure-composition proofs.
// Only the evaluated worker launch and the credential-target unmount are
// replaced; every other setpriv/umount invocation runs the real command.
import { accessSync, closeSync, constants, openSync, writeSync } from "node:fs";
import { delimiter, join } from "node:path";

const AUDIT = {
  stage: "audit",
  code: "CP06_CHILD_OUTPUT_INVALID",
  exit_code: 70,
  description: "isolated child output was invalid",
};
const CHILD_EXIT = {
  stage: "child-exit",
  code: "CP06_CHILD_EXIT_FAILED",
  exit_code: 1,
  description: "isolated child exited unsuccessfully",
};
const CLEANUP = {
  stage: "cleanup",
  code: "CP06_CREDENTIAL_CLEANUP_FAILED",
  exit_code: null,
  description: "credential mount cleanup failed",
};
const compound = (causes) => ({
  schema_version: 1,
  stage: "cleanup",
  code: "CP06_CLEANUP_FAILED",
  exit_code: 74,
  description: "credential namespace cleanup failed",
  causes,
});

/** Child behavior, injected cleanup failure and the expected supervisor record. */
export const DUMMY_CLI_SCENARIOS = {
  "malformed-output-and-cleanup": {
    child: "malformed",
    cleanupFails: true,
    record: compound([AUDIT, CLEANUP]),
  },
  "semantic-audit-and-cleanup": {
    child: "semantic",
    cleanupFails: true,
    record: compound([AUDIT, CLEANUP]),
  },
  "child-exit-and-cleanup": {
    child: "exit",
    cleanupFails: true,
    record: compound([CHILD_EXIT, CLEANUP]),
  },
  "audit-only": {
    child: "malformed",
    cleanupFails: false,
    record: { schema_version: 1, ...AUDIT, causes: [] },
  },
  "cleanup-only": { child: "valid", cleanupFails: true, record: compound([CLEANUP]) },
  success: { child: "valid", cleanupFails: false, record: null },
};

export const DUMMY_CLI_SECRET = "DUMMY-SECRET-CLI-MARKER";

const VALID_WORKER_CHILD = {
  schema_version: 1,
  result: "pass",
  pi_version: "0.85.1",
  pi_install: { fixture_origin: true },
  provider: "DUMMY",
  model: "DUMMY",
  credential_store: { fixture_origin: true },
  oauth_preflight: { refreshed: false },
  session: { in_memory: true, active_tools: ["read"] },
  event_stream: { read_audit: { exact_original: true, read_count: 1 } },
  response: { fixture_origin: true },
  response_sha256: "0".repeat(64),
  raw_transcript_retained: false,
};

/** Write scenario shims into `anchor`; returns a PATH that resolves them first. */
export function writeDummyCliShims({ anchor, path, scenario, inheritedPath = process.env.PATH }) {
  const selected = DUMMY_CLI_SCENARIOS[scenario];
  if (selected === undefined) throw new Error("unsupported DUMMY CLI scenario");
  const realSetpriv = locate("setpriv", inheritedPath);
  const realUmount = locate("umount", inheritedPath);
  const child = {
    malformed: `printf '%s' '${DUMMY_CLI_SECRET} malformed'; printf '%s' '${DUMMY_CLI_SECRET}' >&2; exit 0`,
    semantic: `printf '%s' '{"result":"fail","detail":"${DUMMY_CLI_SECRET}"}'; exit 0`,
    exit: `printf '%s' '${DUMMY_CLI_SECRET}' >&2; exit 1`,
    valid: `printf '%s' '${JSON.stringify(VALID_WORKER_CHILD)}'; exit 0`,
  }[selected.child];
  writeExecutable(
    anchor,
    "setpriv",
    `#!/bin/sh
for argument do
  case "$argument" in
    */scripts/cp06-sdk-worker.mjs) ${child} ;;
  esac
done
exec '${realSetpriv}' "$@"
`,
  );
  writeExecutable(
    anchor,
    "umount",
    `#!/bin/sh
for argument do last="$argument"; done
case "$last" in
  */auth.json) ${selected.cleanupFails ? `printf '%s' '${DUMMY_CLI_SECRET}' >&2; exit 32` : ":"} ;;
esac
exec '${realUmount}' "$@"
`,
  );
  return `${path}${delimiter}${inheritedPath}`;
}

function locate(command, searchPath = "") {
  for (const directory of searchPath.split(delimiter)) {
    if (!directory.startsWith("/")) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`DUMMY CLI shim cannot locate ${command}`);
}

function writeExecutable(anchor, name, text) {
  const fd = openSync(
    join(anchor, name),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_CLOEXEC,
    0o700,
  );
  try {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally {
    closeSync(fd);
  }
}
