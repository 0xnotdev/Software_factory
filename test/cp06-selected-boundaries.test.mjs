import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { compileIsolationHelpers } from "../scripts/cp06-auth-security.mjs";
import { openAnchoredDirectory, openProbeOutput } from "../scripts/cp06-probe-fixture.mjs";

async function dummyOutput() {
  const base = resolve(".factory/state/cp06-correction");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "DUMMY-selected-boundaries-"));
}

test("compiled helpers execute and hash through retained read-only inode descriptors", async () => {
  const directory = await dummyOutput();
  const outputRoot = join(directory, "auth-security");
  const output = openProbeOutput({ root: process.cwd(), outputRoot, create: true });
  let binaries;
  try {
    binaries = compileIsolationHelpers({
      root: process.cwd(),
      outputRoot,
      anchoredOutputRoot: output.anchor,
    });
    for (const descriptorPath of [binaries.helper, binaries.syscallProbe]) {
      const original = await readFile(descriptorPath);
      const leaf = readlinkSync(descriptorPath);
      await rename(leaf, `${leaf}.original`);
      await writeFile(leaf, "DUMMY replacement must not execute");
      assert.deepEqual(await readFile(descriptorPath), original);
    }
    const execution = spawnSync(
      binaries.helper,
      [process.execPath, "-e", 'process.stdout.write("DUMMY executable control")'],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(execution.error, undefined);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "DUMMY executable control");
    const probe = spawnSync(binaries.syscallProbe, [], { encoding: "utf8", timeout: 15_000 });
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 64);
    binaries.close();
    binaries.close();
    await assert.rejects(readFile(binaries.helper));
  } finally {
    binaries?.close();
    output.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("importing worker serializers preserves evidence and creates no output", async () => {
  const directory = await dummyOutput();
  const workerRoot = join(directory, "worker");
  await mkdir(workerRoot);
  const records = {
    "evidence.json": '{"result":"DUMMY evidence"}\n',
    "blocked.json": '{"result":"DUMMY blocked"}\n',
  };
  for (const [name, bytes] of Object.entries(records)) {
    await writeFile(join(workerRoot, name), bytes);
  }
  const moduleUrl = pathToFileURL(resolve("scripts/replay-cp06-worker.mjs")).href;
  try {
    for (const output of [directory, join(directory, "uncreated")]) {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const {createWorkerBlockedStatus}=await import(${JSON.stringify(moduleUrl)});const result=createWorkerBlockedStatus(new Error("DUMMY"),"audit","DUMMY date");if(result.result!=="blocked")process.exit(1);`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, CP06_OUTPUT: output },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.deepEqual((await readdir(workerRoot)).sort(), Object.keys(records).sort());
      for (const [name, bytes] of Object.entries(records)) {
        assert.equal(await readFile(join(workerRoot, name), "utf8"), bytes);
      }
    }
    await assert.rejects(readdir(join(directory, "uncreated")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("nested directory reset preserves sibling proofs and rejects substituted parents", async () => {
  const directory = await dummyOutput();
  const output = openProbeOutput({
    root: process.cwd(),
    outputRoot: directory,
    create: true,
    runner: true,
  });
  const scenarios = ["expired", "near-expiry", "missing-source-setup"];
  try {
    for (const scenario of scenarios) {
      const child = openAnchoredDirectory(output.anchor, `proofs/${scenario}`, { reset: true });
      try {
        await writeFile(join(child.anchor, "evidence.json"), `DUMMY ${scenario}`);
      } finally {
        child.close();
      }
    }
    await writeFile(join(directory, "proofs/near-expiry/stale.json"), "DUMMY stale");
    const reset = openAnchoredDirectory(output.anchor, "proofs/near-expiry", { reset: true });
    try {
      assert.deepEqual(await readdir(reset.anchor), []);
      await writeFile(join(reset.anchor, "evidence.json"), "DUMMY near-expiry");
    } finally {
      reset.close();
    }
    for (const scenario of scenarios) {
      assert.equal(
        await readFile(join(directory, "proofs", scenario, "evidence.json"), "utf8"),
        `DUMMY ${scenario}`,
      );
    }
    await rename(join(directory, "proofs"), join(directory, "proofs-original"));
    await mkdir(join(directory, "DUMMY-sentinel/expired"), { recursive: true });
    await writeFile(join(directory, "DUMMY-sentinel/expired/evidence.json"), "DUMMY unchanged");
    await symlink(join(directory, "DUMMY-sentinel"), join(directory, "proofs"));
    assert.throws(() => openAnchoredDirectory(output.anchor, "proofs/expired", { reset: true }));
    assert.equal(
      await readFile(join(directory, "DUMMY-sentinel/expired/evidence.json"), "utf8"),
      "DUMMY unchanged",
    );
    for (const scenario of scenarios) {
      assert.equal(
        await readFile(join(directory, "proofs-original", scenario, "evidence.json"), "utf8"),
        `DUMMY ${scenario}`,
      );
    }
  } finally {
    output.close();
    await rm(directory, { recursive: true, force: true });
  }
});
