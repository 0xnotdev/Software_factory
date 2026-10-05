import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertHardenedProof, assertUnsafeControl, runIsolationProbe } from "../scripts/cp06-auth-security.mjs";
import { openProbeOutput, openAnchoredDirectory, readArtifactFile, writeArtifactFile } from "../scripts/cp06-probe-fixture.mjs";
import { superviseCredentialChild, supervisorFailureRecord } from "../scripts/cp06-namespace-supervisor.mjs";
import { dummyWorkerContext, dummyWorkerEvidence } from "../scripts/cp06-dummy-worker-evidence.mjs";
import { withCompiledHelper } from "./fixtures/cp06-compiled-helper.mjs";
import { openPinnedDirectory } from "../scripts/cp06-guarded-read.mjs";

const state = resolve(".factory/state/cp06-correction");

test("real hardened probe executes retained read-only descriptors and inherited DUMMY denials", async () => {
  await withCompiledHelper("review-kernel", async ({ binaries, helperFd }) => {
    const outputRoot = join(state, "DUMMY-review-kernel", "auth-security");
    const options = { root: process.cwd(), outputRoot, binaries };
    try {
      assertUnsafeControl(await runIsolationProbe({ ...options, mode: "unsafe-probe" }));
      const proof = await runIsolationProbe({ ...options, mode: "hardened-probe" });
      assertHardenedProof(proof);
      const missing = structuredClone(proof);
      missing.child.direct_namespace_syscalls.stdout = missing.child.direct_namespace_syscalls.stdout.split("\n").filter((line) => !line.startsWith("inherited_ptrace_attach=")).join("\n");
      assert.throws(() => assertHardenedProof(missing));
      const probeFd = openSync(binaries.syscallProbe, constants.O_RDONLY | constants.O_CLOEXEC);
      try {
        const closed = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--propagation", "private", "--", "setpriv", "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--securebits=+noroot,+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked", "--", "/proc/self/fd/3", "/proc/self/fd/4", "/DUMMY-no-mount"], {
          stdio: ["ignore", "pipe", "pipe", helperFd, probeFd], encoding: "utf8", timeout: 20_000,
        });
        assert.equal(closed.status, 70);
        assert.equal(closed.stdout, "");
      } finally { closeSync(probeFd); }
    } finally { await rm(join(state, "DUMMY-review-kernel"), { recursive: true, force: true }); }
  });
});

test("full semantic contracts reject forged nested evidence inside independently awaited cleanup", async () => {
  const context = dummyWorkerContext();
  const good = dummyWorkerEvidence(context);
  const variants = [
    { ...good, response: { status: "PASS", evidence_gaps: [] } },
    { ...good, response: { ...good.response, evidence_gaps: [] } },
    { ...good, event_stream: { ...good.event_stream, extra: "DUMMY-SECRET" } },
    { ...good, event_stream: { ...good.event_stream, event_count: 2 } },
    { ...good, event_stream: { ...good.event_stream, read_audit: { ...good.event_stream.read_audit, expected_sha256: "a".repeat(64), returned_sha256: "a".repeat(64), returned_bytes: 1 } } },
    { ...good, pi_install: { ...good.pi_install, extra: "DUMMY-SECRET" } },
  ];
  for (const child of [good, ...variants]) {
    for (const cleanupFails of [false, true]) {
      let cleaned = 0;
      let caught;
      try {
        await superviseCredentialChild({ mode: "worker", source: "/DUMMY-source", target: "/DUMMY-target", helper: "/DUMMY-helper", syscallProbe: "/DUMMY-probe" }, {
          workerContext: context,
          mount: async () => ({ mountIds: { source: "1", target: "2" }, parentMounts: ["DUMMY"], verifyIntegrity: async () => true, cleanup: async () => {
            await new Promise((done) => setTimeout(done, 1)); cleaned++;
            if (cleanupFails) throw new Error("DUMMY-SECRET");
          } }),
          spawn: () => ({ status: 0, stdout: JSON.stringify(child) }),
        });
      } catch (error) { caught = error; }
      assert.equal(cleaned, 1);
      if (child === good && !cleanupFails) assert.equal(caught, undefined);
      else {
        const record = supervisorFailureRecord(caught);
        assert.equal(JSON.stringify(record).includes("DUMMY-SECRET"), false);
        const codes = record.causes.length ? record.causes.map((cause) => cause.code) : [record.code];
        assert.deepEqual(codes, [...(child === good ? [] : ["CP06_CHILD_OUTPUT_INVALID"]), ...(cleanupFails ? ["CP06_CREDENTIAL_CLEANUP_FAILED"] : [])]);
      }
    }
  }
});

test("artifact writes, replacements, copies and reads reject redirected leaves and intermediate directories", async () => {
  const outputRoot = join(state, `DUMMY-review-artifacts-${process.pid}`);
  const output = openProbeOutput({ root: process.cwd(), outputRoot, create: true, runner: true });
  const child = openAnchoredDirectory(output.anchor, "raw");
  const sentinel = join(outputRoot, "DUMMY-sentinel");
  await writeFile(sentinel, "DUMMY SENTINEL UNCHANGED");
  try {
    for (const name of ["evidence.json", "DUMMY-counters.json", "raw-copy.txt"]) {
      const path = join(child.anchor, name);
      await symlink(sentinel, join(outputRoot, "raw", name));
      assert.throws(() => writeArtifactFile(path, "DUMMY write"));
      assert.throws(() => writeArtifactFile(path, "DUMMY replace", { replace: true }));
      assert.throws(() => readArtifactFile(path));
      assert.equal(await readFile(sentinel, "utf8"), "DUMMY SENTINEL UNCHANGED");
    }
    await symlink(outputRoot, join(outputRoot, "raw", "redirected"));
    assert.throws(() => writeArtifactFile(join(child.anchor, "redirected", "DUMMY-sentinel"), "DUMMY write", { replace: true }));
    assert.throws(() => openPinnedDirectory(join(outputRoot, "raw", "redirected", "raw")));
    const source = join(child.anchor, "DUMMY-original.txt");
    writeArtifactFile(source, "DUMMY bytes");
    writeArtifactFile(join(child.anchor, "DUMMY-copy.txt"), readArtifactFile(source));
    assert.equal(readArtifactFile(join(child.anchor, "DUMMY-copy.txt"), "utf8"), "DUMMY bytes");
  } finally {
    child.close(); output.close(); await rm(outputRoot, { recursive: true, force: true });
  }
});

for (const [runner, directory, rawName] of [["replay-cp06-ten-pack.mjs", "ten-pack", "git-init.txt"], ["replay-cp06-p07.mjs", "p07", "build.txt"]]) {
  test(`${runner} refuses a substituted raw artifact at its executable boundary`, async () => {
    await mkdir(state, { recursive: true });
    const directoryRoot = await mkdtemp(join(state, "DUMMY-runner-"));
    const sentinel = join(directoryRoot, "DUMMY-sentinel");
    const hook = join(directoryRoot, "DUMMY-hook.mjs");
    await writeFile(sentinel, "DUMMY SENTINEL UNCHANGED");
    await writeFile(hook, `import child from 'node:child_process'; import {symlinkSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const real = child.spawnSync; child.spawnSync = (command,args,options) => { if (${JSON.stringify(directory)} === 'ten-pack' ? command === 'git' && args[0] === 'init' : command === 'npm') { symlinkSync(${JSON.stringify(sentinel)}, ${JSON.stringify(join(directoryRoot, directory, "raw", rawName))}); return {status:0, stdout:'DUMMY', stderr:''}; } return real(command,args,options); }; syncBuiltinESMExports();`);
    try {
      const result = spawnSync(process.execPath, ["--import", hook, resolve("scripts", runner)], { env: { ...process.env, CP06_OUTPUT: directoryRoot }, encoding: "utf8", timeout: 30_000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EEXIST/);
      assert.equal(await readFile(sentinel, "utf8"), "DUMMY SENTINEL UNCHANGED");
    } finally { await rm(directoryRoot, { recursive: true, force: true }); }
  });
}
