#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const factoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const stateRoot = join(factoryRoot, ".factory", "state");
const cli = join(factoryRoot, "dist", "src", "cli.js");
const releaseShaPattern = /^[a-f0-9]{40}$/;

class ProofError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const allowed = new Set([
    "--subject",
    "--evidence-source",
    "--home",
    "--release",
    "--output",
    "--reviewer",
    "--tasks-bin",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || values.has(flag)) {
      throw new ProofError(
        "USAGE",
        "usage: cp08-status-proof --subject <registered-app> --evidence-source <worker-copy> --home <Firstmate-home> --release <sha> --output <new-.factory/state-path> --reviewer <name> [--tasks-bin <path>]",
      );
    }
    values.set(flag, value);
  }
  const required = [
    "--subject",
    "--evidence-source",
    "--home",
    "--release",
    "--output",
    "--reviewer",
  ];
  for (const flag of required) {
    if (!values.get(flag)) throw new ProofError("USAGE", `missing required argument: ${flag}`);
  }
  const release = values.get("--release");
  if (!releaseShaPattern.test(release)) {
    throw new ProofError("USAGE", "release must be a full lowercase Git SHA-1");
  }
  return {
    subject: values.get("--subject"),
    evidenceSource: values.get("--evidence-source"),
    home: values.get("--home"),
    release,
    output: values.get("--output"),
    reviewer: values.get("--reviewer"),
    tasksBin: values.get("--tasks-bin") ?? null,
  };
}

function run(file, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolveResult({
        exitCode: code ?? (signal ? 128 : 1),
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
}

async function checkedRun(file, args, options = {}) {
  const result = await run(file, args, options);
  if (result.exitCode !== 0) {
    throw new ProofError("COMMAND_FAILED", `${basename(file)} exited nonzero`, {
      operation: args[0],
      exit_code: result.exitCode,
      stderr: result.stderr.toString("utf8").slice(0, 2000),
    });
  }
  return result;
}

async function git(root, args, options = {}) {
  return await checkedRun("git", ["-C", root, ...args], options);
}

function stdout(result) {
  return result.stdout.toString("utf8").trim();
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function requireGitRoot(path, label) {
  const canonical = await realpath(path);
  const top = stdout(await git(canonical, ["rev-parse", "--show-toplevel"]));
  if ((await realpath(top)) !== canonical) {
    throw new ProofError("NOT_GIT_ROOT", `${label} must be a canonical Git repository root`);
  }
  return canonical;
}

async function requireAbsent(path) {
  try {
    await access(path);
    throw new ProofError("OUTPUT_EXISTS", "output must not already exist", { output: path });
  } catch (error) {
    if (error instanceof ProofError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeStatus(root, home, tasksBin, path) {
  const args = [cli, "status", "--root", root, "--home", home];
  if (tasksBin !== null) args.push("--tasks-bin", tasksBin);
  args.push("--json");
  const result = await checkedRun(process.execPath, args, { cwd: factoryRoot });
  await writeFile(path, result.stdout);
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new ProofError("STATUS_INVALID", "Factory status did not return JSON", { path });
  }
}

function assertSummary(report, expected, label) {
  const actual = {
    done: report.backlog?.summary?.done,
    all_tasks_done: report.backlog?.all_tasks_done,
    task: report.task_evidence?.summary,
    product: report.product?.summary,
    product_status: report.product?.status,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ProofError("STATUS_UNEXPECTED", `${label} status did not match the CP-08 oracle`, {
      expected,
      actual,
    });
  }
}

function condition(report, id) {
  const found = report.product?.conditions?.find((item) => item.id === id);
  if (!found) throw new ProofError("STATUS_UNEXPECTED", `status omitted condition ${id}`);
  return found;
}

function task(report, id) {
  const found = report.task_evidence?.tasks?.find((item) => item.task_id === id);
  if (!found) throw new ProofError("STATUS_UNEXPECTED", `status omitted task ${id}`);
  return found;
}

async function prepareClone(subject, evidenceSource, parent, release) {
  await mkdir(parent, { recursive: true });
  const root = join(parent, basename(subject));
  await checkedRun("git", ["clone", "--quiet", "--no-hardlinks", subject, root]);
  if (stdout(await git(root, ["rev-parse", "HEAD"])) !== release) {
    throw new ProofError("RELEASE_MISMATCH", "fixture clone did not select the declared release");
  }
  await mkdir(join(root, ".factory", "state"), { recursive: true });
  await mkdir(join(root, "evidence"), { recursive: true });
  await mkdir(join(root, ".data"), { recursive: true });
  await mkdir(join(root, "reviews"), { recursive: true });
  await cp(
    join(evidenceSource, ".factory", "state", "evidence"),
    join(root, ".factory", "state", "evidence"),
    {
      recursive: true,
    },
  );
  await cp(
    join(evidenceSource, ".factory", "state", "completion"),
    join(root, ".factory", "state", "completion"),
    { recursive: true },
  );
  await cp(join(evidenceSource, "evidence", "artifacts"), join(root, "evidence", "artifacts"), {
    recursive: true,
  });
  await cp(join(evidenceSource, ".data", "review"), join(root, ".data", "review"), {
    recursive: true,
  });
  await cp(
    join(evidenceSource, "reviews", "human-inspection.md"),
    join(root, "reviews", "human-inspection.md"),
  );
  if (stdout(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) !== "") {
    throw new ProofError("FIXTURE_DIRTY", "copied ignored evidence made the fixture tracked-dirty");
  }
  return root;
}

async function commitFixture(root, message) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "CP08 Fixture",
    GIT_AUTHOR_EMAIL: "cp08@example.invalid",
    GIT_COMMITTER_NAME: "CP08 Fixture",
    GIT_COMMITTER_EMAIL: "cp08@example.invalid",
  };
  await checkedRun("git", ["-C", root, "commit", "-qm", message], { env });
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const subject = await requireGitRoot(input.subject, "subject");
  const evidenceSource = await requireGitRoot(input.evidenceSource, "evidence source");
  const home = await realpath(input.home);
  const release = stdout(await git(subject, ["rev-parse", "HEAD"]));
  if (release !== input.release) {
    throw new ProofError(
      "RELEASE_MISMATCH",
      "registered subject HEAD is not the declared release",
      {
        expected: input.release,
        actual: release,
      },
    );
  }
  if (stdout(await git(subject, ["status", "--porcelain=v1", "--untracked-files=all"])) !== "") {
    throw new ProofError("SUBJECT_DIRTY", "registered subject must be clean");
  }
  if (stdout(await git(evidenceSource, ["rev-parse", "HEAD"])) !== input.release) {
    throw new ProofError(
      "EVIDENCE_RELEASE_MISMATCH",
      "evidence source is not at the declared release",
    );
  }

  const output = resolve(input.output);
  const canonicalState = await realpath(stateRoot);
  const canonicalParent = await realpath(dirname(output));
  if (
    canonicalParent !== canonicalState &&
    !canonicalParent.startsWith(`${canonicalState}${sep}`)
  ) {
    throw new ProofError("OUTPUT_OUTSIDE_STATE", "output must be a new path under .factory/state");
  }
  await requireAbsent(output);
  await mkdir(output);

  const backlog = join(home, "data", "backlog.md");
  const backlogBefore = await sha256(backlog);
  const failureRoot = await prepareClone(
    subject,
    evidenceSource,
    join(output, "failure"),
    input.release,
  );
  const contractRoot = await prepareClone(
    subject,
    evidenceSource,
    join(output, "contract"),
    input.release,
  );

  const baseline = await writeStatus(
    failureRoot,
    home,
    input.tasksBin,
    join(output, "baseline.json"),
  );
  const normal = {
    done: 2,
    all_tasks_done: true,
    task: { passed: 1, failed: 0, stale: 0, unverified: 1 },
    product: { passed: 6, failed: 0, stale: 0, unverified: 0 },
    product_status: "COMPLETE",
  };
  assertSummary(baseline, normal, "baseline");

  const isolationArtifact = join(failureRoot, "evidence", "artifacts", "account-isolation.json");
  await appendFile(isolationArtifact, "\nCORRUPTED FOR CP08 P04\n");
  const failed = await writeStatus(
    failureRoot,
    home,
    input.tasksBin,
    join(output, "failed-project-check.json"),
  );
  assertSummary(
    failed,
    {
      done: 2,
      all_tasks_done: true,
      task: { passed: 0, failed: 1, stale: 0, unverified: 1 },
      product: { passed: 5, failed: 1, stale: 0, unverified: 0 },
      product_status: "NOT COMPLETE",
    },
    "failed project check",
  );
  if (
    condition(failed, "RL-002").status !== "failed" ||
    !condition(failed, "RL-002").issues.some((issue) => issue.code === "ARTIFACT_CHANGED")
  ) {
    throw new ProofError("FAILURE_NOT_DETECTED", "RL-002 did not reject the changed artifact");
  }

  await cp(
    join(evidenceSource, "evidence", "artifacts", "account-isolation.json"),
    isolationArtifact,
  );
  const repaired = await writeStatus(
    failureRoot,
    home,
    input.tasksBin,
    join(output, "repaired-retest.json"),
  );
  assertSummary(repaired, normal, "repaired retest");

  await writeFile(join(failureRoot, "release-head-negative.txt"), "release-head-negative\n");
  await git(failureRoot, ["add", "release-head-negative.txt"]);
  await commitFixture(failureRoot, "Advance release fixture head");
  const staleRelease = await writeStatus(
    failureRoot,
    home,
    input.tasksBin,
    join(output, "stale-release-head.json"),
  );
  if (
    staleRelease.product?.summary?.stale !== 6 ||
    task(staleRelease, "SLICE-002").status !== "stale"
  ) {
    throw new ProofError(
      "STALE_RELEASE_ACCEPTED",
      "changed release head did not make evidence stale",
    );
  }

  const taskContract = join(contractRoot, ".factory", "tasks", "SLICE-002.yaml");
  await appendFile(taskContract, "\n# CP08 fixture mutation\n");
  await git(contractRoot, ["add", ".factory/tasks/SLICE-002.yaml"]);
  await commitFixture(contractRoot, "Mutate task contract fixture");
  const staleContract = await writeStatus(
    contractRoot,
    home,
    input.tasksBin,
    join(output, "stale-contract.json"),
  );
  const staleTask = task(staleContract, "SLICE-002");
  if (
    staleTask.status !== "stale" ||
    !staleTask.issues.some((issue) => issue.code === "CONTRACT_CHANGED")
  ) {
    throw new ProofError(
      "STALE_CONTRACT_ACCEPTED",
      "changed task contract did not make evidence stale",
    );
  }

  const backlogAfter = await sha256(backlog);
  if (backlogBefore !== backlogAfter) {
    throw new ProofError(
      "BACKLOG_CHANGED",
      "read-only CP-08 status proof changed the operating backlog",
      {
        before: backlogBefore,
        after: backlogAfter,
      },
    );
  }

  const artifactFiles = [
    "baseline.json",
    "failed-project-check.json",
    "repaired-retest.json",
    "stale-release-head.json",
    "stale-contract.json",
  ];
  const artifacts = Object.fromEntries(
    await Promise.all(artifactFiles.map(async (path) => [path, await sha256(join(output, path))])),
  );
  const report = {
    schema_version: 1,
    check_id: "cp08-independent-status-negatives",
    status: "pass",
    release_commit: input.release,
    reviewer: input.reviewer,
    recorded_at: new Date().toISOString(),
    operating_backlog_sha256_before: backlogBefore,
    operating_backlog_sha256_after: backlogAfter,
    assertions: [
      "both-actual-tasks-done",
      "failed-project-check-remains-not-complete",
      "repair-restores-five-executable-passes",
      "changed-release-head-is-stale",
      "changed-task-contract-is-stale",
      "actual-human-RL-006-remains-bound-to-release",
      "operating-backlog-byte-identical",
    ],
    artifacts,
  };
  await writeFile(join(output, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const failure =
    error instanceof ProofError
      ? error
      : new ProofError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: 1,
        status: "fail",
        error: { code: failure.code, message: failure.message, details: failure.details },
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = failure.code === "USAGE" ? 2 : 1;
}
