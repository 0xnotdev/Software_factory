import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const script = join(repoRoot, "scripts/cp08-status-proof.mjs");

async function invoke(args) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], { cwd: repoRoot });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

test("CP08 status proof reports structured usage errors", async () => {
  const result = await invoke([]);
  assert.equal(result.exitCode, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "fail");
  assert.equal(report.error.code, "USAGE");
});

test("CP08 status proof refuses output outside ignored Factory state", async () => {
  await mkdir(join(repoRoot, "test/.tmp"), { recursive: true });
  const base = await mkdtemp(join(repoRoot, "test/.tmp/cp08-status-guard-"));
  const subject = join(base, "FactoryReadLaterAcceptance");
  const evidence = join(base, "evidence-source");
  const home = join(base, "home");
  try {
    await mkdir(subject);
    await mkdir(home);
    await writeFile(join(subject, "README.md"), "fixture\n");
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: subject });
    await execFileAsync("git", ["add", "README.md"], { cwd: subject });
    await execFileAsync("git", ["commit", "-qm", "fixture"], {
      cwd: subject,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "CP08 Test",
        GIT_AUTHOR_EMAIL: "cp08@example.invalid",
        GIT_COMMITTER_NAME: "CP08 Test",
        GIT_COMMITTER_EMAIL: "cp08@example.invalid",
      },
    });
    await execFileAsync("git", ["clone", "-q", "--no-hardlinks", subject, evidence]);
    const release = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: subject })
    ).stdout.trim();

    const result = await invoke([
      "--subject",
      subject,
      "--evidence-source",
      evidence,
      "--home",
      home,
      "--release",
      release,
      "--output",
      join(base, "outside-state"),
      "--reviewer",
      "CP08 test",
    ]);
    assert.equal(result.exitCode, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "fail");
    assert.equal(report.error.code, "OUTPUT_OUTSIDE_STATE");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
