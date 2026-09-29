import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const cliPath = resolve(here, "../src/cli.js");
const sourceFixtures = resolve(repoRoot, "test/fixtures/ctx");

const projectContract = `schema_version: 1
id: context-fixture
name: Context Fixture
intent: Prove bounded task context generation.
audience: Factory maintainers.
goals: [Generate attributed context]
non_goals: [Publish tasks]
constraints:
  - Credentials never enter a context pack.
  - Context generation never invokes a shell.
documents:
  required: [PROJECT.md, ARCHITECTURE.md]
completion: .factory/completion.yaml
`;

const completionContract = `schema_version: 1
project: context-fixture
conditions:
  - id: C-CTX
    outcome: A bounded attributed context pack is generated.
    method: executable
    check_id: context-integration
    evidence: evidence/context.json
`;

const taskContract = `schema_version: 1
id: CTX-001
title: Save context; touch CONTEXT-PWNED
outcome: A worker receives exact requirements and relevant implementation notes.
depends_on: []
complexity: normal
risk: normal
acceptance:
  - id: A-CTX
    statement: The pack is bounded and every excerpt is attributed.
advances: [C-CTX]
context:
  topics: [persistence, restart, provenance]
  required: [PROJECT.md, ARCHITECTURE.md]
evidence:
  required: [integration]
delivery: project-default
`;

test("context writes exact mandatory sources, merges overlapping excerpts, and records provenance", async () => {
  const fixture = await seeded("success with spaces");
  try {
    const result = await factory(fixture, { mode: "semantic" });
    assert.equal(result.exit, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const payload = parseObject(result.stdout);
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.ok, true);
    assert.equal(payload.command, "context");
    assert.equal(payload.task_id, "CTX-001");
    assert.equal(payload.ctx.index_generation, 7);
    assert.equal(payload.ctx.retrieval_mode, "HYBRID_SEMANTIC");
    assert.equal(payload.previous_receipt_valid, false);
    assert.ok(payload.bytes <= payload.byte_budget);
    assert.ok(payload.estimated_tokens <= payload.token_budget);

    const pack = await readFile(join(fixture.root, payload.pack_path), "utf8");
    const project = await readFile(join(fixture.root, "PROJECT.md"), "utf8");
    const architecture = await readFile(join(fixture.root, "ARCHITECTURE.md"), "utf8");
    assert.ok(pack.includes(project));
    assert.ok(pack.includes(architecture));
    assert.match(pack, /Source: `PROJECT\.md`/);
    assert.match(pack, /CTX generation: `7`/);
    assert.equal(
      count(pack, "The overlapping excerpt sentinel appears exactly once in the source."),
      1,
    );
    await assert.rejects(stat(join(fixture.root, "CONTEXT-PWNED")));

    const receipt = parseObject(await readFile(join(fixture.root, payload.receipt_path), "utf8"));
    assert.equal(receipt.task_id, "CTX-001");
    assert.match(receipt.contract_sha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.project_contract_sha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.pack_sha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.source_digests["PROJECT.md"], payload.source_digests["PROJECT.md"]);
    assert.equal(
      receipt.source_digests["ARCHITECTURE.md"],
      payload.source_digests["ARCHITECTURE.md"],
    );
    assert.match(receipt.source_digests["docs/EXTRA.md"], /^[a-f0-9]{64}$/);
    assert.equal(receipt.ctx.index_generation, 7);
    assert.equal(receipt.ctx.retrieval_mode, "HYBRID_SEMANTIC");
  } finally {
    await fixture.dispose();
  }
});

test("context limits CTX retrieval to the task-local source selection", async () => {
  const fixture = await seeded("source-filter");
  try {
    await writeFile(
      join(fixture.root, "docs/TARGET.md"),
      "# Target authority\n\nOnly this task-local source is relevant.\n",
    );
    await writeFile(
      join(fixture.root, ".factory/tasks/CTX-001.yaml"),
      taskContract.replace(
        "required: [PROJECT.md, ARCHITECTURE.md]",
        "required: [PROJECT.md, ARCHITECTURE.md, docs/TARGET.md]",
      ),
    );

    const result = await factory(fixture, { mode: "source-filter" });
    assert.equal(result.exit, 0, result.stderr || result.stdout);
    const payload = parseObject(result.stdout);
    const pack = await readFile(join(fixture.root, payload.pack_path), "utf8");
    assert.match(pack, /Only this task-local source is relevant\./);
    assert.doesNotMatch(pack, /The overlapping excerpt sentinel/);
    assert.equal(payload.source_digests["docs/EXTRA.md"], undefined);
  } finally {
    await fixture.dispose();
  }
});

test("context permits explicitly reported lexical fallback only when retrieval is sufficient", async () => {
  const fixture = await seeded("lexical");
  try {
    const success = await factory(fixture, { mode: "lexical" });
    assert.equal(success.exit, 0, success.stderr || success.stdout);
    assert.equal(parseObject(success.stdout).ctx.retrieval_mode, "LEXICAL_ONLY");

    await rm(join(fixture.root, ".factory/state/context"), { recursive: true, force: true });
    const insufficient = await factory(fixture, { mode: "lexical-insufficient" });
    assert.equal(insufficient.exit, 3);
    const failure = parseObject(insufficient.stdout);
    assert.equal(failure.error.code, "CONTEXT_BLOCKED");
    assert.match(failure.error.message, /insufficient/i);
    await assertNoPack(fixture.root);
  } finally {
    await fixture.dispose();
  }
});

test("context blocks a stale CTX index without writing a pack", async () => {
  const fixture = await seeded("stale");
  try {
    const result = await factory(fixture, { mode: "stale" });
    assert.equal(result.exit, 3);
    const payload = parseObject(result.stdout);
    assert.equal(payload.error.code, "CONTEXT_BLOCKED");
    assert.equal(payload.error.details.reason, "SOURCE_STALE");
    await assertNoPack(fixture.root);
  } finally {
    await fixture.dispose();
  }
});

test("context blocks a missing mandatory document without fabricating output", async () => {
  const fixture = await seeded("missing-source");
  try {
    await rm(join(fixture.root, "ARCHITECTURE.md"));
    const result = await factory(fixture, { mode: "semantic" });
    assert.equal(result.exit, 3);
    const payload = parseObject(result.stdout);
    assert.equal(payload.error.code, "CONTEXT_BLOCKED");
    assert.match(JSON.stringify(payload.error.details), /ARCHITECTURE\.md/);
    await assertNoPack(fixture.root);
  } finally {
    await fixture.dispose();
  }
});

test("context reports an absent CTX binary as a structured unavailable integration", async () => {
  const fixture = await seeded("missing-ctx");
  try {
    const result = await runFactory(fixture.root, [
      "context",
      "CTX-001",
      "--ctx-bin",
      join(fixture.root, "bin/missing-ctx"),
      "--json",
    ]);
    assert.equal(result.exit, 3);
    const payload = parseObject(result.stdout);
    assert.equal(payload.error.code, "TOOL_UNAVAILABLE");
    assert.equal(payload.error.details.tool, "ctx");
    await assertNoPack(fixture.root);
  } finally {
    await fixture.dispose();
  }
});

test("context rejects token and byte budget overflow without truncating mandatory sources", async () => {
  for (const [flag, value, expected] of [
    ["--token-budget", "100", "TOKEN_BUDGET_EXCEEDED"],
    ["--byte-budget", "400", "BYTE_BUDGET_EXCEEDED"],
  ] as const) {
    const fixture = await seeded(`budget-${flag}`);
    try {
      const result = await factory(fixture, { mode: "semantic", extra: [flag, value] });
      assert.equal(result.exit, 3);
      const payload = parseObject(result.stdout);
      assert.equal(payload.error.code, "CONTEXT_BLOCKED");
      assert.equal(payload.error.details.reason, expected);
      await assertNoPack(fixture.root);
    } finally {
      await fixture.dispose();
    }
  }
});

test("context rejects a required-source symlink escape", async (context) => {
  const fixture = await seeded("symlink-escape");
  const outside = join(dirname(fixture.root), `${basename(fixture.root)}-outside.md`);
  try {
    await writeFile(outside, "# Outside authority\n");
    await mkdir(join(fixture.root, "docs"), { recursive: true });
    try {
      await symlink(outside, join(fixture.root, "docs/ESCAPE.md"));
    } catch (error) {
      if (process.platform === "win32" && errorCode(error) === "EPERM") {
        context.skip("This Windows host does not permit symlink creation");
        return;
      }
      throw error;
    }
    await writeFile(
      join(fixture.root, ".factory/tasks/CTX-001.yaml"),
      taskContract.replace(
        "required: [PROJECT.md, ARCHITECTURE.md]",
        "required: [PROJECT.md, ARCHITECTURE.md, docs/ESCAPE.md]",
      ),
    );
    const result = await factory(fixture, { mode: "semantic" });
    assert.equal(result.exit, 3);
    const payload = parseObject(result.stdout);
    assert.equal(payload.error.code, "CONTEXT_BLOCKED");
    assert.match(JSON.stringify(payload.error.details), /PATH_ESCAPE/);
    await assertNoPack(fixture.root);
  } finally {
    await fixture.dispose();
    await rm(outside, { force: true });
  }
});

test("context rejects CTX text that does not exactly match its claimed original range", async () => {
  const fixture = await seeded("forged-excerpt");
  try {
    const result = await factory(fixture, { mode: "forged" });
    assert.equal(result.exit, 3);
    const payload = parseObject(result.stdout);
    assert.equal(payload.error.code, "CONTEXT_BLOCKED");
    assert.equal(payload.error.details.reason, "PROVENANCE_MISMATCH");
    await assertNoPack(fixture.root);
  } finally {
    await fixture.dispose();
  }
});

test("context invalidates and replaces receipts after source or contract changes", async () => {
  const fixture = await seeded("receipt-invalidation");
  try {
    const first = parseObject((await factory(fixture, { mode: "semantic" })).stdout);
    const firstReceipt = parseObject(
      await readFile(join(fixture.root, first.receipt_path), "utf8"),
    );

    await writeFile(
      join(fixture.root, "PROJECT.md"),
      `${await readFile(join(fixture.root, "PROJECT.md"), "utf8")}\nSource revision two.\n`,
    );
    const sourceChanged = await factory(fixture, { mode: "semantic" });
    assert.equal(sourceChanged.exit, 0, sourceChanged.stderr || sourceChanged.stdout);
    const sourcePayload = parseObject(sourceChanged.stdout);
    assert.equal(sourcePayload.previous_receipt_valid, false);
    assert.ok(sourcePayload.receipt_invalid_reasons.includes("SOURCE_CHANGED:PROJECT.md"));
    const sourceReceipt = parseObject(
      await readFile(join(fixture.root, sourcePayload.receipt_path), "utf8"),
    );
    assert.notEqual(
      sourceReceipt.source_digests["PROJECT.md"],
      firstReceipt.source_digests["PROJECT.md"],
    );

    await writeFile(
      join(fixture.root, ".factory/tasks/CTX-001.yaml"),
      taskContract.replace("exact requirements", "revised exact requirements"),
    );
    const contractChanged = await factory(fixture, { mode: "semantic" });
    assert.equal(contractChanged.exit, 0, contractChanged.stderr || contractChanged.stdout);
    const contractPayload = parseObject(contractChanged.stdout);
    assert.equal(contractPayload.previous_receipt_valid, false);
    assert.ok(contractPayload.receipt_invalid_reasons.includes("CONTRACT_CHANGED"));
    const contractReceipt = parseObject(
      await readFile(join(fixture.root, contractPayload.receipt_path), "utf8"),
    );
    assert.notEqual(contractReceipt.contract_sha256, sourceReceipt.contract_sha256);
  } finally {
    await fixture.dispose();
  }
});

test("context blocks unignored or tracked runtime destinations", async () => {
  for (const setup of ["missing", "receipt-only", "tracked"]) {
    const fixture = await seeded(`ignore-${setup}`);
    try {
      if (setup === "missing") await rm(join(fixture.root, ".gitignore"));
      if (setup === "receipt-only") {
        await writeFile(join(fixture.root, ".gitignore"), ".factory/state/context/*.json\n");
      }
      if (setup === "tracked") {
        await mkdir(join(fixture.root, ".factory/state/context"));
        await writeFile(join(fixture.root, ".factory/state/context/CTX-001.json"), "tracked");
        await execFileAsync("git", ["add", "-f", ".factory/state/context/CTX-001.json"], {
          cwd: fixture.root,
        });
      }
      const result = await factory(fixture, { mode: "semantic" });
      assert.equal(result.exit, 3, result.stdout);
      assert.equal(parseObject(result.stdout).error.details.reason, "STATE_NOT_IGNORED");
      await assert.rejects(stat(join(fixture.root, ".factory/state/context/CTX-001.md")));
      if (setup === "tracked")
        assert.equal(
          await readFile(join(fixture.root, ".factory/state/context/CTX-001.json"), "utf8"),
          "tracked",
        );
      else await assertNoPack(fixture.root);
    } finally {
      await fixture.dispose();
    }
  }
});

test("context hashes original BOM bytes and invalidates BOM-only changes", async () => {
  const fixture = await seeded("bom");
  try {
    const first = await factory(fixture, { mode: "semantic" });
    assert.equal(first.exit, 0, first.stdout);
    for (const path of [
      "PROJECT.md",
      ".factory/project.yaml",
      ".factory/tasks/CTX-001.yaml",
      "docs/EXTRA.md",
    ]) {
      await writeFile(
        join(fixture.root, path),
        "\uFEFF" + (await readFile(join(fixture.root, path), "utf8")),
      );
    }
    const result = await factory(fixture, { mode: "semantic" });
    assert.equal(result.exit, 0, result.stdout);
    const payload = parseObject(result.stdout);
    const receipt = parseObject(await readFile(join(fixture.root, payload.receipt_path), "utf8"));
    for (const [path, digest] of [
      ["PROJECT.md", receipt.source_digests["PROJECT.md"]],
      [".factory/project.yaml", receipt.project_contract_sha256],
      [".factory/tasks/CTX-001.yaml", receipt.contract_sha256],
    ]) {
      assert.equal(
        digest,
        createHash("sha256")
          .update(await readFile(join(fixture.root, path)))
          .digest("hex"),
      );
    }
    assert.ok(payload.receipt_invalid_reasons.includes("CONTRACT_CHANGED"));
    assert.ok(payload.receipt_invalid_reasons.includes("PROJECT_CONTRACT_CHANGED"));
    assert.ok(payload.receipt_invalid_reasons.includes("SOURCE_CHANGED:PROJECT.md"));
  } finally {
    await fixture.dispose();
  }
});

test("context deduplicates mandatory and retrieved symlink identities", async () => {
  const fixture = await seeded("aliases");
  try {
    await symlink("../PROJECT.md", join(fixture.root, "docs/PROJECT-ALIAS.md"));
    await symlink("EXTRA.md", join(fixture.root, "docs/EXTRA-ALIAS.md"));
    await writeFile(
      join(fixture.root, ".factory/tasks/CTX-001.yaml"),
      taskContract.replace(
        "required: [PROJECT.md, ARCHITECTURE.md]",
        "required: [PROJECT.md, ARCHITECTURE.md, docs/PROJECT-ALIAS.md]",
      ),
    );
    const result = await factory(fixture, { mode: "aliases" });
    assert.equal(result.exit, 0, result.stdout);
    const payload = parseObject(result.stdout);
    const pack = await readFile(join(fixture.root, payload.pack_path), "utf8");
    assert.equal(count(pack, await readFile(join(fixture.root, "PROJECT.md"), "utf8")), 1);
    assert.equal(
      count(pack, "The overlapping excerpt sentinel appears exactly once in the source."),
      1,
    );
    for (const path of ["docs/PROJECT-ALIAS.md", "docs/EXTRA-ALIAS.md"]) {
      assert.ok(pack.includes(path));
      assert.equal(
        payload.source_digests[path],
        createHash("sha256")
          .update(await readFile(join(fixture.root, path)))
          .digest("hex"),
      );
    }
  } finally {
    await fixture.dispose();
  }
});

test("context derives mandatory sources from the same captured task bytes", async () => {
  const fixture = await seeded("captured-task");
  try {
    await writeFile(join(fixture.root, "docs/NEW.md"), "New mandatory authority sentinel.\n");
    const hook = join(fixture.root, "read-hook.mjs");
    await writeFile(
      hook,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const original = fs.readFile;
let reads = 0;
fs.readFile = async function(path, ...args) {
  const bytes = await original.call(this, path, ...args);
  if (String(path).endsWith("/CTX-001.yaml") && ++reads === 2) {
    await fs.writeFile(path, bytes.toString().replace("required: [PROJECT.md, ARCHITECTURE.md]", "required: [PROJECT.md, ARCHITECTURE.md, docs/NEW.md]"));
  }
  return bytes;
};
syncBuiltinESMExports();
`,
    );
    const result = await runFactory(
      fixture.root,
      ["context", "CTX-001", "--ctx-bin", fixture.ctx, "--json"],
      { NODE_OPTIONS: `--import=${hook}` },
    );
    assert.equal(result.exit, 0, result.stdout);
    const payload = parseObject(result.stdout);
    const pack = await readFile(join(fixture.root, payload.pack_path), "utf8");
    if (pack.includes("docs/NEW.md")) {
      assert.ok(pack.includes("New mandatory authority sentinel."));
      assert.ok(payload.source_digests["docs/NEW.md"]);
    }
  } finally {
    await fixture.dispose();
  }
});

test("context blocks contract edits after the validated snapshot", async () => {
  const fixture = await seeded("contract-race");
  try {
    const result = await factory(fixture, { mode: "contract-edit" });
    assert.equal(result.exit, 3, result.stdout);
    assert.equal(
      parseObject(result.stdout).error.details.reason,
      "SOURCE_CHANGED_DURING_GENERATION",
    );
    await assertNoPack(fixture.root);
  } finally {
    await fixture.dispose();
  }
});

test("context rejects a later CTX version of captured mandatory authority", async () => {
  for (const mode of ["source-edit", "source-edit-alias"]) {
    const fixture = await seeded(mode);
    try {
      await symlink("../PROJECT.md", join(fixture.root, "docs/PROJECT-ALIAS.md"));
      const result = await factory(fixture, { mode });
      assert.equal(result.exit, 3, result.stdout);
      assert.equal(
        parseObject(result.stdout).error.details.reason,
        "SOURCE_CHANGED_DURING_GENERATION",
      );
      await assertNoPack(fixture.root);
    } finally {
      await fixture.dispose();
    }
  }
});

test("context regenerates malformed receipt shapes", async () => {
  const fixture = await seeded("malformed-receipt");
  try {
    const first = await factory(fixture, { mode: "semantic" });
    assert.equal(first.exit, 0, first.stdout);
    const receiptPath = join(fixture.root, parseObject(first.stdout).receipt_path);
    const valid = parseObject(await readFile(receiptPath, "utf8"));
    for (const malformed of [
      null,
      [],
      42,
      "receipt",
      {},
      { ...valid, ctx: null },
      { ...valid, source_digests: [] },
      { ...valid, source_digests: { "PROJECT.md": 42 } },
      { ...valid, budgets: null },
      { ...valid, schema_version: 2 },
    ]) {
      await writeFile(receiptPath, JSON.stringify(malformed));
      const result = await factory(fixture, { mode: "semantic" });
      assert.equal(result.exit, 0, result.stdout);
      const payload = parseObject(result.stdout);
      assert.equal(payload.previous_receipt_valid, false);
      assert.ok(payload.receipt_invalid_reasons.includes("RECEIPT_INVALID"));
      assert.equal(parseObject(await readFile(receiptPath, "utf8")).schema_version, 1);
    }
    const recovered = await factory(fixture, { mode: "semantic" });
    assert.equal(recovered.exit, 0, recovered.stdout);
    assert.equal(parseObject(recovered.stdout).previous_receipt_valid, true);
  } finally {
    await fixture.dispose();
  }
});

interface Fixture {
  root: string;
  ctx: string;
  dispose(): Promise<void>;
}

async function seeded(name: string): Promise<Fixture> {
  const base = join(repoRoot, "test/.tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `${name}-`));
  await execFileAsync("git", ["init", "-q", root]);
  await writeFile(join(root, ".gitignore"), ".factory/state/\n");
  await mkdir(join(root, ".factory/tasks"), { recursive: true });
  await mkdir(join(root, ".factory/state"), { recursive: true });
  await mkdir(join(root, ".ctx"), { recursive: true });
  await copyFile(join(sourceFixtures, "PROJECT.md"), join(root, "PROJECT.md"));
  await copyFile(join(sourceFixtures, "ARCHITECTURE.md"), join(root, "ARCHITECTURE.md"));
  await mkdir(join(root, "docs"));
  await copyFile(join(sourceFixtures, "EXTRA.md"), join(root, "docs/EXTRA.md"));
  await writeFile(join(root, ".factory/project.yaml"), projectContract);
  await writeFile(join(root, ".factory/completion.yaml"), completionContract);
  await writeFile(join(root, ".factory/tasks/CTX-001.yaml"), taskContract);
  const ctx = await fakeCtx(root);
  return {
    root,
    ctx,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function fakeCtx(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin);
  const path = join(bin, "ctx.cjs");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const mode = process.env.FACTORY_TEST_CTX_MODE || "semantic";
const command = args[0];
const value = (flag) => args[args.indexOf(flag) + 1];
const root = value("--root") || process.cwd();
const hash = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
if (command === "status") {
  if (mode.startsWith("source-edit")) {
    fs.appendFileSync(path.join(root, "PROJECT.md"), "Revised mandatory authority.");
  }
  if (mode === "contract-edit") {
    const contract = path.join(root, ".factory/tasks/CTX-001.yaml");
    fs.writeFileSync(contract, fs.readFileSync(contract, "utf8").replace("required: [PROJECT.md, ARCHITECTURE.md]", "required: [PROJECT.md, ARCHITECTURE.md, docs/EXTRA.md]"));
  }
  if (mode === "stale") {
    console.log(JSON.stringify({category:"SOURCE_STALE",index_generation:7,stale_documents:["PROJECT.md"],missing_documents:[],retrieval_mode:"HYBRID_SEMANTIC",active_channels:["structural","lexical","semantic"]}));
  } else {
    const lexical = mode.startsWith("lexical");
    console.log(JSON.stringify({category:lexical?"EMBEDDINGS_STALE":"CLEAN",index_generation:7,stale_documents:[],missing_documents:[],retrieval_mode:lexical?"LEXICAL_ONLY":"HYBRID_SEMANTIC",active_channels:lexical?["structural","lexical"]:["structural","lexical","semantic"]}));
  }
  process.exit(0);
}
if (command === "doctor") {
  console.log(JSON.stringify({offline_ready:true,network_attempted:false,status:{category:"CLEAN",index_generation:7,retrieval_mode:mode.startsWith("lexical")?"LEXICAL_ONLY":"HYBRID_SEMANTIC"}}));
  process.exit(0);
}
if (command === "pack") {
  const selectedDocuments = args.flatMap((arg, index) => arg === "--document" ? [args[index + 1]] : []);
  const sourceFiltered = mode === "source-filter" && selectedDocuments.includes("docs/TARGET.md");
  const relative = sourceFiltered ? "docs/TARGET.md" : "docs/EXTRA.md";
  const full = fs.readFileSync(path.join(root, relative), "utf8");
  const firstEnd = sourceFiltered ? full.length : full.indexOf("Gamma context ends here.");
  const secondStart = sourceFiltered ? 0 : full.indexOf("The overlapping excerpt sentinel");
  const item = (start, end, text = full.slice(start, end)) => ({source:{source_type:"excerpt",text,provenance:{document_path:relative,document_sha256:hash(full),start_line:1,end_line:6,start_offset:start,end_offset:end,range_sha256:hash(text),index_generation:7}},estimated_tokens:Math.ceil(Buffer.byteLength(text)/3)});
  const items = sourceFiltered ? [item(0, full.length)] : [item(0, firstEnd), item(secondStart, full.length), item(0, firstEnd)];
  if (mode === "aliases") {
    items[1].source.provenance.document_path = "docs/EXTRA-ALIAS.md";
    const original = fs.readFileSync(path.join(root, "docs/PROJECT-ALIAS.md"), "utf8");
    items.push({source:{text:original,provenance:{document_path:"docs/PROJECT-ALIAS.md",document_sha256:hash(original),start_offset:0,end_offset:[...original].length,index_generation:7}}});
  }
  if (mode.startsWith("source-edit")) {
    const document = mode === "source-edit" ? "PROJECT.md" : "docs/PROJECT-ALIAS.md";
    const original = fs.readFileSync(path.join(root, document), "utf8");
    items.push({source:{text:original,provenance:{document_path:document,document_sha256:hash(original),start_offset:0,end_offset:[...original].length,index_generation:7}}});
  }
  if (mode === "forged") items[0] = item(0, firstEnd, "forged text that is absent from the original");
  console.log(JSON.stringify({schema_version:4,requested_token_budget:Number(value("--token-budget")),estimated_tokens:900,items,completeness_status:mode === "lexical-insufficient" ? "PARTIAL" : "COMPLETE",index_generation:7,retrieval_metadata:{retrieval_mode:mode.startsWith("lexical")?"LEXICAL_ONLY":"HYBRID_SEMANTIC",active_channels:mode.startsWith("lexical")?["structural","lexical"]:["structural","lexical","semantic"],require_semantic:false}}));
  process.exit(0);
}
console.error("unexpected ctx arguments", JSON.stringify(args));
process.exit(2);
`;
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

async function factory(
  fixture: Fixture,
  options: { mode: string; extra?: string[] },
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return await runFactory(
    fixture.root,
    ["context", "CTX-001", "--ctx-bin", fixture.ctx, "--json", ...(options.extra ?? [])],
    { FACTORY_TEST_CTX_MODE: options.mode },
  );
}

async function runFactory(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args, "--root", root],
      { cwd: root, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolveResult({
          exit: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.end();
  });
}

async function assertNoPack(root: string): Promise<void> {
  await assert.rejects(stat(join(root, ".factory/state/context/CTX-001.md")));
  await assert.rejects(stat(join(root, ".factory/state/context/CTX-001.json")));
}

function parseObject(text: string): Record<string, any> {
  const value = JSON.parse(text) as unknown;
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}
