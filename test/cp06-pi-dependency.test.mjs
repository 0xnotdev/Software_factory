import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePinnedPiInstall } from "../scripts/cp06-pi-install.mjs";

const resolverUrl = pathToFileURL(resolve("scripts/cp06-pi-dependency.mjs")).href;

test("Pi selection requires the explicit task-local package and executable paths", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-pi-install-"));
  const installRoot = join(projectRoot, ".factory/state/cp06-sdk");
  const packageRoot = join(
    installRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const entry = join(packageRoot, "dist/cli.js");
  const bin = join(installRoot, "node_modules/.bin/pi");
  try {
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(installRoot, "node_modules/.bin"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.85.1",
        bin: { pi: "dist/cli.js" },
      }),
    );
    await writeFile(entry, "#!/usr/bin/env node\n");
    await writeFile(join(packageRoot, "dist/index.js"), "export const sdk = 'DUMMY';\n");
    await chmod(entry, 0o755);
    await symlink("../@earendil-works/pi-coding-agent/dist/cli.js", bin);
    const invocations = [];
    const selected = resolvePinnedPiInstall({
      projectRoot,
      packageRoot,
      executable: bin,
      spawnSyncImpl(command, args) {
        invocations.push([command, ...args]);
        return { status: 0, stdout: "0.85.1\n", stderr: "" };
      },
    });
    assert.equal(selected.root, packageRoot);
    assert.equal(selected.executable, bin);
    assert.deepEqual(invocations, [[bin, "--version"]]);
    assert.match(selected.provenance.package_sha256, /^[a-f0-9]{64}$/);
    assert.match(selected.provenance.executable_sha256, /^[a-f0-9]{64}$/);
    assert.match(selected.provenance.sdk_entry_sha256, /^[a-f0-9]{64}$/);

    for (const substitution of [
      { packageRoot: undefined, executable: bin },
      { packageRoot, executable: undefined },
      { packageRoot: join(projectRoot, "unrelated/pi-coding-agent"), executable: bin },
      { packageRoot, executable: entry },
    ]) {
      assert.throws(() =>
        resolvePinnedPiInstall({ projectRoot, ...substitution, spawnSyncImpl() {} }),
      );
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "exact hoisted import-only dependency", version: "0.85.1", expectedExit: 0 },
  { name: "newer hoisted import-only dependency", version: "0.99.2", expectedExit: 1 },
]) {
  test(`pinned Pi dependency resolver handles ${scenario.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-pi-layout-"));
    const piRoot = join(directory, "node_modules", "@earendil-works", "pi-coding-agent");
    const aiRoot = join(directory, "node_modules", "@earendil-works", "pi-ai");
    try {
      await mkdir(piRoot, { recursive: true });
      await mkdir(join(aiRoot, "dist"), { recursive: true });
      await writeFile(
        join(piRoot, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          version: "0.85.1",
          type: "module",
          dependencies: { "@earendil-works/pi-ai": "^0.85.1" },
        }),
      );
      await writeFile(
        join(aiRoot, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-ai",
          version: scenario.version,
          type: "module",
          exports: { ".": { import: "./dist/index.js" } },
        }),
      );
      await writeFile(join(aiRoot, "dist/index.js"), 'export const marker = "DUMMY-import";\n');
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-import-meta-resolve",
          "--input-type=module",
          "--eval",
          `const {importPinnedPiAi}=await import(${JSON.stringify(resolverUrl)});const result=await importPinnedPiAi(process.argv[1]);console.log(JSON.stringify({marker:result.module.marker,provenance:result.provenance}));`,
          piRoot,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(result.status, scenario.expectedExit, result.stderr);
      if (scenario.expectedExit === 0) {
        const output = JSON.parse(result.stdout);
        assert.equal(output.marker, "DUMMY-import");
        assert.equal(output.provenance.version, "0.85.1");
        assert.equal(output.provenance.resolution, "esm-import-condition");
        assert.equal(output.provenance.root, aiRoot);
        assert.match(output.provenance.package_sha256, /^[a-f0-9]{64}$/);
        assert.match(output.provenance.entry_sha256, /^[a-f0-9]{64}$/);
      } else {
        assert.match(result.stderr, /not exact version 0\.85\.1/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
