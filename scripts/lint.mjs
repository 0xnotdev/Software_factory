#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const failures = [];

const gitignore = await readFile(".gitignore", "utf8");
for (const required of [".factory/state/", ".ctx/", "docs/probes/*.transcript.*", ".env.*"]) {
  if (!gitignore.split(/\r?\n/).includes(required)) {
    failures.push(`.gitignore missing exact rule: ${required}`);
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
