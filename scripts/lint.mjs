#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const failures = [];

const ignoredPaths = [
  ".factory/state/context/TASK.md",
  ".ctx/index.sqlite",
  "docs/probes/tmp/pack.md",
  "docs/probes/evidence.transcript.1",
  "docs/probes/generated.pack.md",
  "models/model.gguf",
  "models/model.safetensors",
];

const trackedPaths = ["docs/probes/CP-00.md", ".env.example", "models/source-fixture.md"];

for (const path of ignoredPaths) {
  if (!(await isIgnored(path))) {
    failures.push(`expected Git to ignore protected path: ${path}`);
  }
}

for (const path of trackedPaths) {
  if (await isIgnored(path)) {
    failures.push(`expected Git to allow trackable path: ${path}`);
  }
}

for await (const path of glob("src/**/*.ts")) {
  const text = await readFile(path, "utf8");
  if (/shell\s*:\s*true/.test(text)) {
    failures.push(`${path} uses shell: true; CP-00 subprocesses must use argument arrays`);
  }
  if (/execSync|spawnSync|execFileSync/.test(text)) {
    failures.push(`${path} uses a synchronous subprocess API`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("lint ok");

async function isIgnored(path) {
  try {
    await execFileAsync("git", ["check-ignore", "--quiet", "--", path]);
    return true;
  } catch (error) {
    if (typeof error?.code === "number" && error.code === 1) return false;
    throw error;
  }
}
