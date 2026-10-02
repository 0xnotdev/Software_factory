import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const resolverUrl = pathToFileURL(resolve("scripts/cp06-pi-dependency.mjs")).href;

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
