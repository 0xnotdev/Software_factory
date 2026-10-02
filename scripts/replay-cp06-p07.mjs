#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openAnchoredDirectory, openProbeOutput } from "./cp06-probe-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, process.env.CP06_OUTPUT ?? ".factory/state/cp06-correction");
const output = openProbeOutput({ root, outputRoot, create: true, runner: true });
const p07Root = openAnchoredDirectory(output.anchor, "p07", { reset: true });
const rawDirectory = openAnchoredDirectory(p07Root.anchor, "raw");
const rawRoot = rawDirectory.anchor;

const steps = [];
steps.push(run("build", "npm", ["run", "build"], 0));
steps.push(
  run(
    "fail-before",
    process.execPath,
    ["test/fixtures/workflow/history/malformed-json-probe.mjs"],
    1,
    ["SyntaxError", "not valid JSON"],
  ),
);
steps.push(
  run(
    "fix-after",
    process.execPath,
    [
      "--test",
      "--test-name-pattern=normal API fixture rejects malformed",
      "dist/test/workflow.test.js",
    ],
    0,
  ),
);
steps.push(
  run(
    "critical-auth-retest",
    process.execPath,
    ["--test", "--test-name-pattern=critical auth fixture", "dist/test/workflow.test.js"],
    0,
  ),
);

const findingPath = "test/fixtures/workflow/history/finding.json";
const finding = JSON.parse(await readFile(join(root, findingPath), "utf8"));
const testedSha = runText("git", ["rev-parse", "HEAD"]);
const manifest = {
  schema_version: 1,
  gate: "P-07",
  tested_sha: testedSha,
  recorded_at: new Date().toISOString(),
  reviewer: process.env.CP06_REVIEWER ?? "Pi CP-06 correction worker",
  finding: {
    path: findingPath,
    sha256: await fileHash(join(root, findingPath)),
    record: finding,
  },
  sequence: steps,
  result: "pass",
  limitations: [
    "Behavioral fixtures are in-memory and make no network or real-account access.",
    "The historical module is a minimal retained reproduction, not a raw worker transcript.",
  ],
};
const manifestPath = join(p07Root.anchor, "evidence.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify({
    ok: true,
    gate: "P-07",
    tested_sha: testedSha,
    manifest_path: relative(manifestPath),
    manifest_sha256: await fileHash(manifestPath),
    sequence: steps.map(({ id, command, exit_code, output_path, output_sha256 }) => ({
      id,
      command,
      exit_code,
      output_path,
      output_sha256,
    })),
  }),
);

function run(id, command, args, expectedExit, expectedOutputFragments = []) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: process.env });
  const exitCode = result.status;
  const output = `command: ${quote([command, ...args])}\nexit: ${exitCode}\n--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`;
  const outputPath = join(rawRoot, `${id}.txt`);
  writeFileSync(outputPath, output);
  const missingFragments = expectedOutputFragments.filter((fragment) => !output.includes(fragment));
  if (result.error !== undefined || exitCode !== expectedExit || missingFragments.length > 0) {
    process.stderr.write(output);
    const suffix =
      missingFragments.length > 0
        ? `; missing output fragments ${missingFragments.join(", ")}`
        : "";
    throw new Error(`${id} exited ${exitCode}; expected ${expectedExit}${suffix}`);
  }
  return {
    id,
    command: quote([command, ...args]),
    expected_exit_code: expectedExit,
    exit_code: exitCode,
    output_path: relative(outputPath),
    output_sha256: sha256(output),
    expected_output_fragments: expectedOutputFragments,
  };
}

function runText(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function quote(parts) {
  return parts.map((part) => (/[\s'"]/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

function relative(path) {
  let located = path;
  try {
    located = realpathSync(path);
  } catch {}
  return located.startsWith(`${root}/`) ? located.slice(root.length + 1) : located;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function fileHash(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
