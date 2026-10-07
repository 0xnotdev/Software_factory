#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ORIGINAL_BRIEF =
  "Build a local read-later web app where separate accounts can save article links with title/notes, list and search their saved items, and edit/delete only their own items. Data survives restart. Provide a usable browser UI and reproducible local setup. Deliver at least two usable end-to-end slices; no public deployment, payment, email service, imported private data or real credentials.\n";
const ORACLE_FILES = [
  ".factory/completion.yaml",
  ".factory/project.yaml",
  ".factory/tasks/SLICE-001.yaml",
  ".factory/tasks/SLICE-002.yaml",
  ".gitignore",
  "ARCHITECTURE.md",
  "COMPLETION.md",
  "ORIGINAL_BRIEF.md",
  "PROJECT.md",
  "README.md",
  "docs/DECISIONS.md",
  "docs/VERIFICATION.md",
];
const FROZEN_PATHS = [
  "ORIGINAL_BRIEF.md",
  "PROJECT.md",
  "ARCHITECTURE.md",
  "COMPLETION.md",
  "docs/DECISIONS.md",
  "docs/VERIFICATION.md",
  ".factory/completion.yaml",
  ".factory/project.yaml",
  ".factory/tasks/SLICE-001.yaml",
  ".factory/tasks/SLICE-002.yaml",
];
const factoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

class ProofError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new ProofError(
        "USAGE",
        "usage: cp08-oracle-proof --subject <path> --oracle <sha> --release <sha> --reviewer <name>",
      );
    }
    if (!new Set(["--subject", "--oracle", "--release", "--reviewer"]).has(flag)) {
      throw new ProofError("USAGE", `unknown argument: ${flag}`);
    }
    if (values.has(flag)) throw new ProofError("USAGE", `duplicate argument: ${flag}`);
    values.set(flag, value);
  }
  const subject = values.get("--subject");
  const oracle = values.get("--oracle");
  const release = values.get("--release");
  const reviewer = values.get("--reviewer");
  if (!subject || !oracle || !release || !reviewer) {
    throw new ProofError(
      "USAGE",
      "usage: cp08-oracle-proof --subject <path> --oracle <sha> --release <sha> --reviewer <name>",
    );
  }
  if (!/^[a-f0-9]{40}$/.test(oracle) || !/^[a-f0-9]{40}$/.test(release)) {
    throw new ProofError("USAGE", "oracle and release must be full lowercase Git SHA-1 values");
  }
  return { subject, oracle, release, reviewer };
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

async function git(subject, args, { allowFailure = false } = {}) {
  const result = await run("git", ["-C", subject, ...args]);
  if (!allowFailure && result.exitCode !== 0) {
    throw new ProofError("GIT_FAILED", "Git could not verify the acceptance subject", {
      operation: args[0],
      exit_code: result.exitCode,
    });
  }
  return result;
}

function text(result) {
  return result.stdout.toString("utf8").trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function treeFile(subject, commit, path) {
  const result = await git(subject, ["show", `${commit}:${path}`]);
  return result.stdout;
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const subject = await realpath(input.subject);
  const topLevel = text(await git(subject, ["rev-parse", "--show-toplevel"]));
  if ((await realpath(topLevel)) !== subject) {
    throw new ProofError("SUBJECT_NOT_ROOT", "subject must be the canonical Git repository root");
  }
  if (subject === (await realpath(factoryRoot))) {
    throw new ProofError("SUBJECT_NOT_SEPARATE", "the CP-08 subject must be a separate repository");
  }

  const head = text(await git(subject, ["rev-parse", "HEAD"]));
  if (head !== input.release) {
    throw new ProofError("RELEASE_HEAD_MISMATCH", "checked-out HEAD is not the declared release", {
      expected: input.release,
      actual: head,
    });
  }
  const status = (await git(subject, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  if (status.length !== 0) {
    throw new ProofError("SUBJECT_DIRTY", "acceptance subject has uncommitted or untracked files");
  }

  const roots = text(await git(subject, ["rev-list", "--max-parents=0", input.release]))
    .split(/\r?\n/)
    .filter(Boolean);
  if (roots.length !== 1 || roots[0] !== input.oracle) {
    throw new ProofError(
      "ORACLE_NOT_FIRST_COMMIT",
      "declared oracle is not the release history root",
      {
        roots,
      },
    );
  }
  const ancestry = await git(
    subject,
    ["merge-base", "--is-ancestor", input.oracle, input.release],
    { allowFailure: true },
  );
  if (ancestry.exitCode !== 0) {
    throw new ProofError("ORACLE_NOT_ANCESTOR", "declared oracle is not an ancestor of release");
  }

  const oracleFiles = text(await git(subject, ["ls-tree", "-r", "--name-only", input.oracle]))
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  if (JSON.stringify(oracleFiles) !== JSON.stringify([...ORACLE_FILES].sort())) {
    throw new ProofError(
      "ORACLE_TREE_UNEXPECTED",
      "first oracle commit must contain only the frozen truth and contracts",
      { files: oracleFiles },
    );
  }

  const oracleBrief = await treeFile(subject, input.oracle, "ORIGINAL_BRIEF.md");
  if (!oracleBrief.equals(Buffer.from(ORIGINAL_BRIEF, "utf8"))) {
    throw new ProofError("ORIGINAL_BRIEF_MISMATCH", "oracle brief is not the accepted CP-08 brief");
  }

  const frozenDigests = {};
  for (const path of FROZEN_PATHS) {
    const before = await treeFile(subject, input.oracle, path);
    const after = await treeFile(subject, input.release, path);
    if (!before.equals(after)) {
      throw new ProofError(
        "FROZEN_SOURCE_CHANGED",
        "a frozen oracle source changed after implementation",
        {
          path,
          oracle_sha256: sha256(before),
          release_sha256: sha256(after),
        },
      );
    }
    frozenDigests[path] = sha256(before);
  }

  const validate = await run(
    process.execPath,
    [resolve(factoryRoot, "dist/src/cli.js"), "validate", "--root", subject, "--json"],
    { cwd: factoryRoot },
  );
  if (validate.exitCode !== 0) {
    throw new ProofError("FACTORY_VALIDATE_FAILED", "Factory rejected the release contracts", {
      exit_code: validate.exitCode,
    });
  }
  let report;
  try {
    report = JSON.parse(validate.stdout.toString("utf8"));
  } catch {
    throw new ProofError("FACTORY_VALIDATE_INVALID", "Factory validate did not return JSON");
  }
  if (
    report.ok !== true ||
    report.project_id !== "factory-read-later-acceptance" ||
    report.task_count !== 2 ||
    report.condition_count !== 6 ||
    JSON.stringify(report.task_order) !== JSON.stringify(["SLICE-001", "SLICE-002"])
  ) {
    throw new ProofError("FACTORY_VALIDATE_UNEXPECTED", "Factory validation shape changed", {
      project_id: report.project_id,
      task_count: report.task_count,
      condition_count: report.condition_count,
      task_order: report.task_order,
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: 1,
        check_id: "cp08-frozen-oracle",
        status: "pass",
        subject: basename(subject),
        oracle_commit: input.oracle,
        release_commit: input.release,
        original_brief_sha256: sha256(oracleBrief),
        frozen_source_digests: frozenDigests,
        oracle_tracked_files: oracleFiles.length,
        oracle_application_files: 0,
        factory_validation: {
          exit_code: validate.exitCode,
          project_id: report.project_id,
          task_count: report.task_count,
          condition_count: report.condition_count,
          task_order: report.task_order,
        },
        reviewer: input.reviewer,
        recorded_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
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
