#!/usr/bin/env node
import { unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cp06IsolationUnsupportedError, runCp06SecurityPreflight } from "./cp06-auth-security.mjs";
import { openProbeOutput, writeAnchoredFile } from "./cp06-probe-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, process.env.CP06_OUTPUT ?? ".factory/state/cp06-correction");
try {
  const proof = await runCp06SecurityPreflight({
    root,
    outputRoot: resolve(outputRoot, "auth-security"),
    reviewer: process.env.CP06_REVIEWER,
  });
  const path = resolve(outputRoot, "auth-security", "evidence.json");
  const output = openProbeOutput({ root, outputRoot: resolve(outputRoot, "auth-security") });
  try {
    try {
      unlinkSync(resolve(output.anchor, "evidence.json"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    writeAnchoredFile(output.anchor, "evidence.json", `${JSON.stringify(proof, null, 2)}\n`);
  } finally {
    output.close();
  }
  console.log(
    JSON.stringify({
      ok: true,
      gate: "CP-06-read-only-auth-security",
      evidence_path: path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
      result: proof.result,
    }),
  );
} catch (error) {
  if (error instanceof Cp06IsolationUnsupportedError) {
    process.stderr.write(`CP06_ISOLATION_UNSUPPORTED: ${error.message}\n`);
    process.exit(73);
  }
  process.stderr.write(`CP06_SECURITY_PROOF_FAILED: ${error.message}\n`);
  process.exit(1);
}
