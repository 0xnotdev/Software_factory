#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  openAnchoredDirectory,
  openProbeOutput,
  writeArtifactEntry,
  readArtifactFile,
  withArtifactParent,
  removeAnchoredEntry,
} from "./cp06-probe-fixture.mjs";
import { readPinnedRegularFile } from "./cp06-guarded-read.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSource = join(root, "test/fixtures/cp06-context");
const outputRoot = resolve(root, process.env.CP06_OUTPUT ?? ".factory/state/cp06-correction");
const output = openProbeOutput({ root, outputRoot, create: true, runner: true });
const proofDirectory = openAnchoredDirectory(output.anchor, "ten-pack", { reset: true });
const rawDirectory = openAnchoredDirectory(proofDirectory.anchor, "raw");
const proofRoot = proofDirectory.anchor;
const fixtureDirectory = openAnchoredDirectory(proofRoot, "repo");
const fixtureRoot = fixtureDirectory.anchor;
const rawRoot = rawDirectory.anchor;
const cli = join(root, "dist/src/cli.js");
const ctx = resolveTool(process.env.CTX_BIN ?? "ctx");
configureOfflineCtxModelDir();
const reviewer = process.env.CP06_REVIEWER ?? "Pi CP-06 correction worker";
const commands = [];
const preparedArtifacts = new Map();

copyFixtureTree(fixtureSource, fixtureRoot);
openAnchoredDirectory(fixtureRoot, ".factory/state").close();
const oracle = JSON.parse(await readFile(join(fixtureRoot, "oracle.json"), "utf8"));
const fixedAuth = await readFile(join(fixtureRoot, ".factory/tasks/AUTH-001.yaml"), "utf8");
const beforeAuth = await readFile(join(fixtureRoot, "cases/AUTH-before.yaml"), "utf8");
const workerBeforeAuth = await readFile(join(fixtureRoot, "cases/AUTH-worker-before.yaml"), "utf8");
await writeFile(join(fixtureRoot, ".factory/tasks/AUTH-001.yaml"), beforeAuth);

run("git-init", "git", ["init", "-q", fixtureRoot], { cwd: root });
run("git-author-name", "git", ["config", "user.name", "Factory CP-06 fixture"], {
  cwd: fixtureRoot,
});
run("git-author-email", "git", ["config", "user.email", "factory-cp06@example.invalid"], {
  cwd: fixtureRoot,
});
run("git-add", "git", ["add", "."], { cwd: fixtureRoot });
run("git-commit", "git", ["commit", "-qm", "seed CP-06 ten-pack fixture"], {
  cwd: fixtureRoot,
});
run("ctx-init", ctx, ["init", fixtureRoot, "--json"], { cwd: fixtureRoot });

const globalSources = ["PROJECT.md", "ARCHITECTURE.md"];
const topicalSources = oracle.tasks.map((entry) => entry.target);
for (const path of [
  ...globalSources,
  ...topicalSources.filter((path) => path !== "docs/AUTH.md"),
]) {
  run(
    `ctx-add-${slug(path)}`,
    ctx,
    ["add", path, "--root", fixtureRoot, "--authority", "normative", "--priority", "100", "--json"],
    {
      cwd: fixtureRoot,
    },
  );
}
run("ctx-index-without-auth", ctx, ["index", "--root", fixtureRoot, "--json"], {
  cwd: fixtureRoot,
  timeout: 120_000,
});
const initialStatus = jsonRun(
  "ctx-status-without-auth",
  ctx,
  ["status", "--root", fixtureRoot, "--json"],
  {
    cwd: fixtureRoot,
  },
);
assertSemantic(initialStatus, "initial status");

const authQuery = [
  "Bind item ownership to authenticated principal",
  "Creation ignores request-supplied ownership and cross-account operations remain concealed.",
  "A-AUTH: Missing or forged credentials return 401 and cross-account read update and delete return non-mutating 404.",
  "principal ownership tenancy forged credentials",
].join("\n");
const broad = run(
  "bad-unscoped-auth",
  ctx,
  ["pack", authQuery, "--root", fixtureRoot, "--token-budget", "3500", "--json"],
  {
    cwd: fixtureRoot,
    expected: [0],
    timeout: 120_000,
  },
);
const broadJson = parseJsonIfPresent(broad.stdout);
if (broadJson === null || !Array.isArray(broadJson.items)) {
  throw new Error("bad-path probe did not return a successful real-CTX pack");
}
const broadPaths = itemPaths(broadJson);
const broadIrrelevant = broadPaths.filter(
  (path) => path.startsWith("docs/") && path !== "docs/AUTH.md",
);
if (broadIrrelevant.length === 0) {
  throw new Error("bad-path probe did not expose unrelated topical retrieval");
}
const broadIrrelevantEvidence = await Promise.all(
  broadIrrelevant.map(async (path) => {
    const item = broadJson.items.find(
      (candidate) => candidate?.source?.provenance?.document_path === path,
    );
    const claimedSha256 = item?.source?.provenance?.document_sha256;
    const actualSha256 = await fileHash(join(fixtureRoot, path));
    if (claimedSha256 !== actualSha256) {
      throw new Error(`bad-path provenance digest does not match exact original ${path}`);
    }
    return { path, document_sha256: actualSha256 };
  }),
);
if (broadPaths.includes("docs/AUTH.md")) {
  throw new Error("bad-path probe unexpectedly retrieved deliberately unindexed docs/AUTH.md");
}

const partialDisconfirming = run(
  "disconfirming-partial-ctx",
  ctx,
  [
    "pack",
    "Delete an owned record without disclosing another principal's record",
    "--root",
    fixtureRoot,
    "--document",
    "docs/DELETION.md",
    "--token-budget",
    "1300",
    "--json",
  ],
  { cwd: fixtureRoot, expected: [0], timeout: 120_000 },
);
const partialDisconfirmingJson = parseJsonIfPresent(partialDisconfirming.stdout);
if (partialDisconfirmingJson?.completeness_status !== "PARTIAL") {
  throw new Error("disconfirming real-CTX probe did not retain its asserted PARTIAL result");
}

const initialAuth = factoryContext("auth-initial-missing", "AUTH-001", 0);
const initialAuthPack = await readFile(join(fixtureRoot, initialAuth.pack_path), "utf8");
await copyArtifact(initialAuth.pack_path, "auth-initial-missing.pack.md");
await copyArtifact(initialAuth.receipt_path, "auth-initial-missing.receipt.json");
if (initialAuthPack.includes("docs/AUTH.md")) {
  throw new Error("initial AUTH handoff unexpectedly contains the missing decisive original");
}
await writeFile(join(fixtureRoot, ".factory/tasks/AUTH-001.yaml"), workerBeforeAuth);
const workerInitialAuth = factoryContext("auth-worker-missing", "AUTH-001", 0);
const workerInitialPack = await readFile(join(fixtureRoot, workerInitialAuth.pack_path), "utf8");
await copyArtifact(workerInitialAuth.pack_path, "auth-worker-missing.pack.md");
await copyArtifact(workerInitialAuth.receipt_path, "auth-worker-missing.receipt.json");
if (
  workerInitialPack.includes("docs/AUTH.md") ||
  workerInitialPack.includes("request-supplied ownership")
) {
  throw new Error("fresh-worker handoff did not omit the decisive creation ownership rule");
}
await writeFile(join(fixtureRoot, ".factory/tasks/AUTH-001.yaml"), beforeAuth);

run(
  "ctx-add-auth",
  ctx,
  [
    "add",
    "docs/AUTH.md",
    "--root",
    fixtureRoot,
    "--authority",
    "normative",
    "--priority",
    "100",
    "--json",
  ],
  {
    cwd: fixtureRoot,
  },
);
run("ctx-index-with-auth", ctx, ["index", "--root", fixtureRoot, "--json"], {
  cwd: fixtureRoot,
  timeout: 120_000,
});
const fixedStatus = jsonRun(
  "ctx-status-with-auth",
  ctx,
  ["status", "--root", fixtureRoot, "--json"],
  {
    cwd: fixtureRoot,
  },
);
assertSemantic(fixedStatus, "fixed status");
const doctor = jsonRun(
  "ctx-doctor-offline",
  ctx,
  ["doctor", "--offline", "--root", fixtureRoot, "--json"],
  {
    cwd: fixtureRoot,
  },
);
if (doctor.offline_ready !== true || doctor.network_attempted !== false) {
  throw new Error("CTX offline doctor did not prove offline readiness");
}

const globalOnlyTaskPath = join(fixtureRoot, ".factory/tasks/GLOBAL-ONLY.yaml");
const globalOnlyQuery = [
  "Keep credentials and raw worker transcripts out of offline context",
  "A worker applies the mandatory rule that credentials and raw worker transcripts never enter a context pack and normal operation is offline.",
  "A-GLOBAL: The pack contains the mandatory credentials, raw transcript, and offline constraints without topical documents.",
  "credentials raw worker transcripts context pack normal operation offline",
].join("\n");
await writeFile(
  globalOnlyTaskPath,
  `schema_version: 1
id: GLOBAL-ONLY
title: Keep credentials and raw worker transcripts out of offline context
outcome: A worker applies the mandatory rule that credentials and raw worker transcripts never enter a context pack and normal operation is offline.
depends_on: []
complexity: bounded
risk: bounded
acceptance:
  - id: A-GLOBAL
    statement: The pack contains the mandatory credentials, raw transcript, and offline constraints without topical documents.
advances: [C-COPY]
context:
  topics: [credentials, raw worker transcripts, context pack, normal operation, offline]
  required: []
evidence:
  required: [integration]
delivery: project-default
`,
);
const emptySelectionFactory = factoryContext("empty-selection-factory", "GLOBAL-ONLY", 0);
const emptySelectionPack = await readFile(
  join(fixtureRoot, emptySelectionFactory.pack_path),
  "utf8",
);
const emptySelectionTopicalDigests = Object.keys(emptySelectionFactory.source_digests).filter(
  (path) => path.startsWith("docs/"),
);
if (
  emptySelectionTopicalDigests.length > 0 ||
  /^## Retrieved context: docs\//m.test(emptySelectionPack)
) {
  throw new Error("empty task-local selection widened Factory output to topical authority");
}
const emptySelectionCtx = run(
  "empty-selection-real-ctx",
  ctx,
  [
    "pack",
    globalOnlyQuery,
    "--root",
    fixtureRoot,
    "--document",
    "PROJECT.md",
    "--document",
    "ARCHITECTURE.md",
    "--token-budget",
    "3500",
    "--json",
  ],
  { cwd: fixtureRoot, expected: [0], timeout: 120_000 },
);
const emptySelectionCtxJson = parseJsonIfPresent(emptySelectionCtx.stdout);
if (emptySelectionCtxJson?.completeness_status !== "COMPLETE") {
  throw new Error("empty-selection real-CTX probe was not COMPLETE");
}
const emptySelectionProvenance = itemPaths(emptySelectionCtxJson);
if (
  emptySelectionProvenance.length === 0 ||
  emptySelectionProvenance.some((path) => !globalSources.includes(path))
) {
  throw new Error(
    `empty-selection real-CTX provenance escaped mandatory globals: ${emptySelectionProvenance.join(",")}`,
  );
}
const emptySelectionOriginals = await Promise.all(
  emptySelectionProvenance.map(async (path) => {
    const item = emptySelectionCtxJson.items.find(
      (candidate) => candidate?.source?.provenance?.document_path === path,
    );
    const actualSha256 = await fileHash(join(fixtureRoot, path));
    if (item?.source?.provenance?.document_sha256 !== actualSha256) {
      throw new Error(`empty-selection provenance digest does not match ${path}`);
    }
    return { path, document_sha256: actualSha256 };
  }),
);
await rm(globalOnlyTaskPath);

const counterfactualBefore = factoryContext("counterfactual-before", "AUTH-001", 0);
const counterfactualBeforePack = await readFile(
  join(fixtureRoot, counterfactualBefore.pack_path),
  "utf8",
);
await copyArtifact(counterfactualBefore.pack_path, "counterfactual-before.pack.md");
await copyArtifact(counterfactualBefore.receipt_path, "counterfactual-before.receipt.json");
await writeFile(join(fixtureRoot, ".factory/tasks/AUTH-001.yaml"), fixedAuth);
const counterfactualAfter = factoryContext("counterfactual-after", "AUTH-001", 0);
const counterfactualAfterPack = await readFile(
  join(fixtureRoot, counterfactualAfter.pack_path),
  "utf8",
);
if (
  counterfactualBeforePack.includes("docs/AUTH.md") ||
  !counterfactualAfterPack.includes("docs/AUTH.md")
) {
  throw new Error("one-condition AUTH counterfactual did not add the decisive original");
}

const packs = [];
for (const task of oracle.tasks) {
  const payload = factoryContext(`fixed-${task.id}`, task.id, 0);
  const packAbsolute = join(fixtureRoot, payload.pack_path);
  const receiptAbsolute = join(fixtureRoot, payload.receipt_path);
  const pack = await readFile(packAbsolute, "utf8");
  const receipt = JSON.parse(await readFile(receiptAbsolute, "utf8"));
  const provenance = packSources(pack);
  const topical = provenance.filter((path) => path.startsWith("docs/"));
  const irrelevant = topical.filter((path) => path !== task.target);
  const missingTarget = !topical.includes(task.target);
  if (missingTarget || irrelevant.length > 0) {
    throw new Error(
      `${task.id} relevance failed: missing=${missingTarget} irrelevant=${irrelevant.join(",")}`,
    );
  }
  const packCopy = join(rawRoot, `${task.id}.pack.md`);
  const receiptCopy = join(rawRoot, `${task.id}.receipt.json`);
  const packSha256 = await writeFile(packCopy, await readFile(packAbsolute));
  const receiptSha256 = await writeFile(receiptCopy, await readFile(receiptAbsolute));
  packs.push({
    task_id: task.id,
    risk: task.risk,
    contract: fileEvidence(join(fixtureRoot, `.factory/tasks/${task.id}.yaml`)),
    target_source: fileEvidence(join(fixtureRoot, task.target)),
    pack: { path: relative(packCopy), sha256: packSha256 },
    receipt: { path: relative(receiptCopy), sha256: receiptSha256 },
    token_budget: payload.token_budget,
    estimated_tokens: payload.estimated_tokens,
    byte_budget: payload.byte_budget,
    bytes: payload.bytes,
    ctx_generation: payload.ctx.index_generation,
    retrieval_mode: payload.ctx.retrieval_mode,
    provenance,
    irrelevant_topical_sources: irrelevant,
    missing_target: missingTarget,
    source_digests: receipt.source_digests,
  });
}

await rm(join(fixtureRoot, ".factory/state/context/AUTH-001.md"), { force: true });
await rm(join(fixtureRoot, ".factory/state/context/AUTH-001.json"), { force: true });
await writeFile(
  join(fixtureRoot, ".factory/tasks/AUTH-001.yaml"),
  fixedAuth.replace("docs/AUTH.md", "docs/ABSENT.md"),
);
const disconfirming = factoryContext("disconfirming-missing-original", "AUTH-001", 3);
let fabricated = true;
try {
  await stat(join(fixtureRoot, ".factory/state/context/AUTH-001.md"));
} catch {
  fabricated = false;
}
if (fabricated || disconfirming.error?.code !== "CONTEXT_BLOCKED") {
  throw new Error("missing-original disconfirming case did not fail closed without a pack");
}

const testedSha = gitText(root, ["rev-parse", "HEAD"]);
const sourceFiles = [
  ".factory/project.yaml",
  ".factory/completion.yaml",
  "PROJECT.md",
  "ARCHITECTURE.md",
  "oracle.json",
  "cases/AUTH-before.yaml",
  "cases/AUTH-worker-before.yaml",
  ...oracle.tasks.map((entry) => `.factory/tasks/${entry.id}.yaml`),
  ...topicalSources,
];
const manifest = {
  schema_version: 1,
  gate: "P-06",
  tested_sha: testedSha,
  recorded_at: new Date().toISOString(),
  reviewer,
  fixture: {
    tracked_root: "test/fixtures/cp06-context",
    files: Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (path) => [path, await fileHash(join(fixtureSource, path))]),
      ),
    ),
  },
  ctx: {
    version: commandText(ctx, ["--version"]),
    index_generation: fixedStatus.index_generation,
    retrieval_mode: fixedStatus.retrieval_mode,
    active_channels: fixedStatus.active_channels,
    offline_ready: doctor.offline_ready,
    network_attempted: doctor.network_attempted,
  },
  original_failed_measurement_preserved: {
    packs: 10,
    topical_excerpts: 24,
    irrelevant_topical_excerpts: 15,
    packs_with_irrelevant_excerpt: 10,
    missing_targets: 1,
    source: "docs/probes/CP-06.md at PR #8 head 8b945a4ed6fcbb43a8b7aa7ce3a6532a4a23d145",
    disposition: "fail",
  },
  diagnosis: {
    bad_unscoped_path: {
      exit_code: broad.exitCode,
      output_path: broad.outputPath,
      output_sha256: broad.outputSha256,
      provenance: broadPaths,
      irrelevant_topical_sources: broadIrrelevant,
      irrelevant_topical_originals: broadIrrelevantEvidence,
      missing_target: true,
    },
    empty_selection: {
      semantics: "empty task-local authority falls back to mandatory global document filters",
      factory_exit_code: 0,
      factory_output_path: commandById("empty-selection-factory").outputPath,
      factory_output_sha256: commandById("empty-selection-factory").outputSha256,
      factory_topical_source_digests: emptySelectionTopicalDigests,
      ctx_exit_code: emptySelectionCtx.exitCode,
      ctx_output_path: emptySelectionCtx.outputPath,
      ctx_output_sha256: emptySelectionCtx.outputSha256,
      ctx_completeness_status: emptySelectionCtxJson.completeness_status,
      ctx_provenance: emptySelectionOriginals,
    },
    one_condition_counterfactual: {
      unchanged_fields: "all AUTH task fields except context.required",
      before_required: ["PROJECT.md", "ARCHITECTURE.md"],
      after_required: ["PROJECT.md", "ARCHITECTURE.md", "docs/AUTH.md"],
      before_contract_sha256: sha256(beforeAuth),
      after_contract_sha256: sha256(fixedAuth),
      before_pack_sha256: sha256(counterfactualBeforePack),
      after_pack_sha256: sha256(counterfactualAfterPack),
      corrected_constraints: [
        "principal-derived ownership",
        "request owner ignored",
        "missing or forged credential is 401",
        "cross-account read/update/delete is non-mutating non-disclosing 404",
      ],
    },
    disconfirming_partial_case: {
      condition: "a successful document-scoped real-CTX call can remain PARTIAL",
      exit_code: partialDisconfirming.exitCode,
      completeness_status: partialDisconfirmingJson.completeness_status,
      output_path: partialDisconfirming.outputPath,
      output_sha256: partialDisconfirming.outputSha256,
    },
    disconfirming_missing_original_case: {
      condition: "declared required original docs/ABSENT.md does not exist",
      exit_code: 3,
      error_code: disconfirming.error.code,
      output_path: commandById("disconfirming-missing-original").outputPath,
      output_sha256: commandById("disconfirming-missing-original").outputSha256,
      pack_fabricated: fabricated,
    },
  },
  fixed_sample: {
    pack_count: packs.length,
    relevant_pack_count: packs.filter(
      (entry) => !entry.missing_target && entry.irrelevant_topical_sources.length === 0,
    ).length,
    irrelevant_topical_excerpts: packs.reduce(
      (sum, entry) => sum + entry.irrelevant_topical_sources.length,
      0,
    ),
    packs_with_irrelevant_excerpt: packs.filter(
      (entry) => entry.irrelevant_topical_sources.length > 0,
    ).length,
    missing_targets: packs.filter((entry) => entry.missing_target).length,
    packs,
  },
  commands: commands.map(({ stdout, stderr, ...entry }) => entry),
  result: "pass",
  limitations: [
    "The semantic replay is verified on Linux with CTX 1.0.0 and the locally installed model.",
    "The small fixture demonstrates this fixed sample, not universal retrieval precision.",
    "Raw CTX JSON, packs, receipts, and command logs remain ignored scratch under .factory/state.",
  ],
};
const manifestPath = join(proofRoot, "evidence.json");
const manifestSha256 = await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify({
    ok: true,
    gate: "P-06",
    tested_sha: testedSha,
    manifest_path: relative(manifestPath),
    manifest_sha256: manifestSha256,
    fixed_pack_count: packs.length,
    relevant_pack_count: manifest.fixed_sample.relevant_pack_count,
    irrelevant_topical_excerpts: manifest.fixed_sample.irrelevant_topical_excerpts,
    missing_targets: manifest.fixed_sample.missing_targets,
    bad_path_exit: broad.exitCode,
    bad_path_irrelevant_topical_sources: broadIrrelevant,
    disconfirming_partial_exit: partialDisconfirming.exitCode,
    disconfirming_missing_original_exit: 3,
  }),
);

function configureOfflineCtxModelDir() {
  if (process.env.CTX_MODEL_DIR !== undefined && process.env.CTX_MODEL_DIR !== "") return;
  const modelName = "BAAI/bge-small-en-v1.5";
  const revision = "52398278842ec682c6f32300af41344b1c0b0bb2";
  for (const candidate of candidateModelRoots()) {
    const modelDirectory = join(candidate, modelKey(modelName, revision));
    const manifestPath = join(modelDirectory, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        manifest.provider === "fastembed" &&
        manifest.model_name === modelName &&
        manifest.revision === revision &&
        manifest.dimensions === 384
      ) {
        process.env.CTX_MODEL_DIR = candidate;
        return;
      }
    } catch {
      // Keep the proof fail-closed; the later CTX semantic assertion reports the blocker.
    }
  }
}

function candidateModelRoots() {
  const candidates = [];
  const home = process.env.HOME;
  if (home !== undefined && home !== "") candidates.push(join(home, ".cache/ctx/models"));
  const homeMatch = root.match(/^\/(?:home|Users)\/[^/]+/u);
  if (homeMatch !== null) candidates.push(join(homeMatch[0], ".cache/ctx/models"));
  return [...new Set(candidates)];
}

function modelKey(modelName, revision) {
  const readable = modelName.replace(/[^A-Za-z0-9._-]+/g, "--").replace(/^-|-$/g, "");
  const digest = createHash("sha256")
    .update(`${modelName}\0${revision}`)
    .digest("hex")
    .slice(0, 12);
  return `${readable}-${digest}`;
}

function factoryContext(id, taskId, expectedExit) {
  const result = run(
    id,
    process.execPath,
    [cli, "context", taskId, "--root", fixtureRoot, "--ctx-bin", ctx, "--json"],
    {
      cwd: root,
      expected: [expectedExit],
      timeout: 120_000,
    },
  );
  const parsed = parseJsonIfPresent(result.stdout);
  if (parsed === null) throw new Error(`${id} did not return JSON`);
  return parsed;
}

function jsonRun(id, command, args, options) {
  const result = run(id, command, args, options);
  const parsed = parseJsonIfPresent(result.stdout);
  if (parsed === null) throw new Error(`${id} did not return JSON`);
  return parsed;
}

function run(id, command, args, options = {}) {
  const cwd = options.cwd ?? root;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: options.timeout ?? 30_000,
  });
  const exitCode = result.status;
  const expected = options.expected ?? [0];
  const output = `command: ${quote([command, ...args])}\ncwd: ${cwd}\nexit: ${exitCode}\n--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`;
  const outputPath = join(rawRoot, `${id}.txt`);
  requireWrite(outputPath, output);
  const entry = {
    id,
    command: quote([command, ...args]),
    cwd: relative(cwd),
    exit_code: exitCode,
    output_path: relative(outputPath),
    output_sha256: sha256(output),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  commands.push(entry);
  if (result.error !== undefined || !expected.includes(exitCode)) {
    process.stderr.write(output);
    throw new Error(`${id} exited ${exitCode}; expected ${expected.join(" or ")}`);
  }
  return { ...entry, exitCode, outputPath: entry.output_path, outputSha256: entry.output_sha256 };
}

function commandById(id) {
  const result = commands.find((entry) => entry.id === id);
  if (result === undefined) throw new Error(`missing command record ${id}`);
  return { outputPath: result.output_path, outputSha256: result.output_sha256 };
}

function parseJsonIfPresent(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function itemPaths(value) {
  if (value === null || !Array.isArray(value.items)) return [];
  return [
    ...new Set(
      value.items
        .map((item) => item?.source?.provenance?.document_path)
        .filter((path) => typeof path === "string"),
    ),
  ];
}

function packSources(pack) {
  const paths = [];
  for (const match of pack.matchAll(
    /^## (?:Required source|Retrieved context): ([^:\n]+)(?::\d+-\d+)?$/gm,
  )) {
    paths.push(match[1]);
  }
  return [...new Set(paths)];
}

function assertSemantic(status, label) {
  if (
    status.category !== "CLEAN" ||
    status.retrieval_mode !== "HYBRID_SEMANTIC" ||
    !Array.isArray(status.active_channels) ||
    !status.active_channels.includes("semantic")
  ) {
    throw new Error(`${label} is not clean HYBRID_SEMANTIC retrieval`);
  }
}

async function copyArtifact(path, name) {
  await writeFile(join(rawRoot, name), await readFile(join(fixtureRoot, path)));
}

function fileEvidence(path) {
  const relativePath = relative(path).replace(relative(fixtureRoot), "test/fixtures/cp06-context");
  const bytes = requireRead(path);
  return { path: relativePath, sha256: sha256(bytes) };
}

function gitText(cwd, args) {
  return commandText("git", args, cwd);
}

function resolveTool(command) {
  if (command.includes("/")) return resolve(command);
  return commandText("which", [command]);
}

function commandText(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
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

function slug(path) {
  return path
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileHash(path) {
  return sha256(requireRead(path));
}

function requireRead(path) {
  return path.startsWith(`/proc/${process.pid}/fd/`)
    ? readArtifactFile(path, undefined, { expected: preparedArtifacts.get(path) })
    : readPinnedRegularFile(path).bytes;
}

function requireWrite(path, value, options) {
  const written = writeArtifactEntry(path, value, {
    ...options,
    expected: preparedArtifacts.get(path),
  });
  preparedArtifacts.set(path, written.identity);
  return written.sha256;
}

async function readFile(path, encoding) {
  const bytes = requireRead(path);
  return encoding ? bytes.toString(encoding) : bytes;
}

async function writeFile(path, value) {
  return requireWrite(path, value, {
    replace: path === join(fixtureRoot, ".factory/tasks/AUTH-001.yaml"),
  });
}

async function rm(path) {
  withArtifactParent(path, removeAnchoredEntry);
  preparedArtifacts.delete(path);
}

function copyFixtureTree(source, destination, logical = destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = openAnchoredDirectory(destination, entry.name);
      try {
        copyFixtureTree(join(source, entry.name), child.anchor, join(logical, entry.name));
      } finally {
        child.close();
      }
    } else if (entry.isFile()) {
      const written = writeArtifactEntry(
        join(destination, entry.name),
        readPinnedRegularFile(join(source, entry.name)).bytes,
      );
      preparedArtifacts.set(join(logical, entry.name), written.identity);
    } else throw new Error("DUMMY fixture contains a nonregular entry");
  }
}
