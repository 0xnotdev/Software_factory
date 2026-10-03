import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalWorkerPaths, createGuardedReadTool } from "../scripts/cp06-guarded-read.mjs";

test("guarded read denies noncanonical and unauthorized paths before tool access", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-read-"));
  const fixtureRoot = join(root, "fixture");
  const original = join(fixtureRoot, "docs", "AUTH.md");
  const credential = join(root, "DUMMY-auth.json");
  const alias = join(root, "DUMMY-auth-alias");
  await mkdir(join(fixtureRoot, "docs"), { recursive: true });
  await writeFile(original, "DUMMY exact\noriginal");
  await writeFile(credential, "DUMMY secret canary");
  await symlink(credential, alias);
  let accesses = 0;
  const exported = [];
  const sdk = {
    createReadTool(_root, options) {
      return {
        name: "read",
        async execute(_id, args) {
          accesses += 1;
          await options.operations.access(args.path);
          const bytes = await options.operations.readFile(args.path);
          exported.push(bytes.toString("utf8"));
          return { content: [{ type: "text", text: bytes.toString("utf8") }] };
        },
      };
    },
  };
  const guarded = createGuardedReadTool({ sdk, root, expectedOriginalPath: original });
  const tool = guarded.tool;
  try {
    for (const args of [
      { path: credential },
      { path: alias },
      { path: join(root, "PROJECT.md") },
      { path: original, offset: 1 },
      { path: original, limit: 20 },
      { path: original, offset: 2, limit: 20 },
      { path: original, offset: 1, limit: 0 },
      { path: original, offset: 1, limit: 1 },
      { path: original, extra: true },
    ]) {
      await assert.rejects(tool.execute("DUMMY-read", args));
    }
    assert.equal(accesses, 0);
    const complete = await tool.execute("DUMMY-read", { path: original });
    await tool.execute("DUMMY-read", { path: original, offset: 1, limit: 20 });
    assert.equal(complete.content[0].text, "DUMMY exact\noriginal");
    assert.deepEqual(exported, ["DUMMY exact\noriginal", "DUMMY exact\noriginal"]);
    assert.equal(accesses, 2);

    await unlink(original);
    await symlink(credential, original);
    await assert.rejects(tool.execute("DUMMY-raced-read", { path: original }));
    assert.equal(accesses, 2);
    assert.equal(exported.includes("DUMMY secret canary"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker paths reject symlink escapes and credential overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-paths-"));
  const fixtureRoot = join(root, "fixture");
  const original = join(fixtureRoot, "AUTH.md");
  const contract = join(root, "contract.yaml");
  const pack = join(root, "pack.md");
  const alias = join(fixtureRoot, "AUTH-alias.md");
  await mkdir(fixtureRoot);
  await writeFile(original, "DUMMY original");
  await writeFile(contract, "DUMMY contract");
  await writeFile(pack, "DUMMY pack");
  await symlink(original, alias);
  const input = {
    root,
    fixture_root: fixtureRoot,
    contract_path: contract,
    pack_path: pack,
    original_path: original,
  };
  try {
    assert.equal(canonicalWorkerPaths(input, join(root, "auth.json")).originalPath, original);
    assert.throws(() =>
      canonicalWorkerPaths({ ...input, original_path: alias }, credentialPath(root)),
    );
    assert.throws(() => canonicalWorkerPaths(input, original));
    assert.throws(() => canonicalWorkerPaths(input, join(root, "target-auth.json"), original));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function credentialPath(root) {
  return join(root, "auth.json");
}
