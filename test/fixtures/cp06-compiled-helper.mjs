import { closeSync, constants, openSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { compileIsolationHelpers } from "../../scripts/cp06-auth-security.mjs";
import { openProbeOutput } from "../../scripts/cp06-probe-fixture.mjs";

/** Compile the real CP-06 helpers into ignored state and expose an inheritable helper fd. */
export async function withCompiledHelper(name, action) {
  const root = process.cwd();
  const outputRoot = resolve(`.factory/state/auth-security/DUMMY-${name}-${process.pid}`);
  const output = openProbeOutput({ root, outputRoot, create: true });
  let binaries;
  let helperFd;
  try {
    binaries = compileIsolationHelpers({ root, outputRoot, anchoredOutputRoot: output.anchor });
    helperFd = openSync(binaries.helper, constants.O_RDONLY | constants.O_CLOEXEC);
    return await action({ helperFd, binaries });
  } finally {
    if (helperFd !== undefined) closeSync(helperFd);
    binaries?.close();
    output.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
}
