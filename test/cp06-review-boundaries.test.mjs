import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, openSync, readdirSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertHardenedProof,
  assertUnsafeControl,
  runIsolationProbe,
} from "../scripts/cp06-auth-security.mjs";
import {
  createProbeFixture,
  openProbeOutput,
  openAnchoredDirectory,
  readArtifactFile,
  writeArtifactEntry,
  writeArtifactFile,
} from "../scripts/cp06-probe-fixture.mjs";
import {
  superviseCredentialChild,
  supervisorFailureRecord,
} from "../scripts/cp06-namespace-supervisor.mjs";
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
      missing.child.direct_namespace_syscalls.stdout =
        missing.child.direct_namespace_syscalls.stdout
          .split("\n")
          .filter((line) => !line.startsWith("inherited_ptrace_attach="))
          .join("\n");
      assert.throws(() => assertHardenedProof(missing));
      const probeFd = openSync(binaries.syscallProbe, constants.O_RDONLY | constants.O_CLOEXEC);
      try {
        const closed = spawnSync(
          "unshare",
          [
            "--user",
            "--map-root-user",
            "--mount",
            "--propagation",
            "private",
            "--",
            "setpriv",
            "--no-new-privs",
            "--bounding-set=-all",
            "--inh-caps=-all",
            "--ambient-caps=-all",
            "--securebits=+noroot,+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked",
            "--",
            "/proc/self/fd/3",
            "/proc/self/fd/4",
            "/DUMMY-no-mount",
          ],
          {
            stdio: ["ignore", "pipe", "pipe", helperFd, probeFd],
            encoding: "utf8",
            timeout: 20_000,
          },
        );
        assert.equal(closed.status, 70);
        assert.equal(closed.stdout, "");
      } finally {
        closeSync(probeFd);
      }
    } finally {
      await rm(join(state, "DUMMY-review-kernel"), { recursive: true, force: true });
    }
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
    {
      ...good,
      event_stream: {
        ...good.event_stream,
        read_audit: {
          ...good.event_stream.read_audit,
          expected_sha256: "a".repeat(64),
          returned_sha256: "a".repeat(64),
          returned_bytes: 1,
        },
      },
    },
    { ...good, pi_install: { ...good.pi_install, extra: "DUMMY-SECRET" } },
    {
      ...good,
      pi_install: {
        ...good.pi_install,
        package_root: "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
      },
    },
    { ...good, pi_install: { ...good.pi_install, sdk_entry_sha256: "a".repeat(64) } },
    {
      ...good,
      pi_install: {
        ...good.pi_install,
        package_artifact: {
          ...good.pi_install.package_artifact,
          tarball_integrity: "sha512-DUMMY-SECRET",
        },
      },
    },
    {
      ...good,
      pi_install: {
        ...good.pi_install,
        dependency: {
          ...good.pi_install.dependency,
          root: "/usr/lib/node_modules/@earendil-works/pi-ai",
        },
      },
    },
    {
      ...good,
      pi_install: {
        ...good.pi_install,
        dependency: { ...good.pi_install.dependency, tarball_integrity: "sha512-DUMMY-SECRET" },
      },
    },
  ];
  for (const child of [good, ...variants]) {
    for (const cleanupFails of [false, true]) {
      let cleaned = 0;
      let caught;
      try {
        await superviseCredentialChild(
          {
            mode: "worker",
            source: "/DUMMY-source",
            target: "/DUMMY-target",
            helper: "/DUMMY-helper",
            syscallProbe: "/DUMMY-probe",
          },
          {
            workerContext: context,
            mount: async () => ({
              mountIds: { source: "1", target: "2" },
              parentMounts: ["DUMMY"],
              verifyIntegrity: async () => true,
              cleanup: async () => {
                await new Promise((done) => setTimeout(done, 1));
                cleaned++;
                if (cleanupFails) throw new Error("DUMMY-SECRET");
              },
            }),
            spawn: () => ({ status: 0, stdout: JSON.stringify(child) }),
          },
        );
      } catch (error) {
        caught = error;
      }
      assert.equal(cleaned, 1);
      if (child === good && !cleanupFails) assert.equal(caught, undefined);
      else {
        const record = supervisorFailureRecord(caught);
        assert.equal(JSON.stringify(record).includes("DUMMY-SECRET"), false);
        const codes = record.causes.length
          ? record.causes.map((cause) => cause.code)
          : [record.code];
        assert.deepEqual(codes, [
          ...(child === good ? [] : ["CP06_CHILD_OUTPUT_INVALID"]),
          ...(cleanupFails ? ["CP06_CREDENTIAL_CLEANUP_FAILED"] : []),
        ]);
      }
    }
  }
});

test("worker provenance without an independently trusted expectation is rejected", async () => {
  const { provenance, ...untrusted } = dummyWorkerContext();
  assert.ok(provenance);
  let cleaned = 0;
  await assert.rejects(
    superviseCredentialChild(
      {
        mode: "worker",
        source: "/DUMMY-source",
        target: "/DUMMY-target",
        helper: "/DUMMY-helper",
        syscallProbe: "/DUMMY-probe",
      },
      {
        workerContext: untrusted,
        mount: async () => ({
          mountIds: { source: "1", target: "2" },
          parentMounts: ["DUMMY"],
          verifyIntegrity: async () => true,
          cleanup: async () => {
            cleaned++;
          },
        }),
        spawn: () => ({
          status: 0,
          stdout: JSON.stringify(dummyWorkerEvidence(dummyWorkerContext())),
        }),
      },
    ),
    { code: "CP06_CHILD_OUTPUT_INVALID" },
  );
  assert.equal(cleaned, 1);
});

test("artifact replacement and reads are bound to the prepared inode", async () => {
  const outputRoot = join(state, `DUMMY-review-identity-${process.pid}`);
  const output = openProbeOutput({ root: process.cwd(), outputRoot, create: true, runner: true });
  const child = openAnchoredDirectory(output.anchor, "raw");
  try {
    const path = join(child.anchor, "DUMMY-task.yaml");
    const prepared = writeArtifactEntry(path, "DUMMY prepared");
    assert.equal(readArtifactFile(path, "utf8", { expected: prepared.identity }), "DUMMY prepared");
    assert.equal(
      writeArtifactEntry(path, "DUMMY replaced", { replace: true, expected: prepared.identity })
        .identity.ino,
      prepared.identity.ino,
    );
    assert.throws(
      () => writeArtifactFile(path, "DUMMY unbound", { replace: true }),
      /identity changed/,
    );
    await writeFile(join(outputRoot, "raw", "DUMMY-substitute"), "DUMMY SUBSTITUTE UNCHANGED");
    await rename(
      join(outputRoot, "raw", "DUMMY-substitute"),
      join(outputRoot, "raw", "DUMMY-task.yaml"),
    );
    assert.throws(
      () => writeArtifactFile(path, "DUMMY write", { replace: true, expected: prepared.identity }),
      /identity changed/,
    );
    assert.throws(
      () => readArtifactFile(path, "utf8", { expected: prepared.identity }),
      /identity changed/,
    );
    assert.equal(
      await readFile(join(outputRoot, "raw", "DUMMY-task.yaml"), "utf8"),
      "DUMMY SUBSTITUTE UNCHANGED",
    );
  } finally {
    child.close();
    output.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("ten-pack refuses a prepared contract replaced by another regular inode", async () => {
  await mkdir(state, { recursive: true });
  const directoryRoot = await mkdtemp(join(state, "DUMMY-runner-"));
  const contract = join(directoryRoot, "ten-pack/repo/.factory/tasks/AUTH-001.yaml");
  const hook = join(directoryRoot, "DUMMY-hook.mjs");
  await writeFile(
    hook,
    `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const real = fs.openSync; let done = false; fs.openSync = (path, ...rest) => { if (!done && String(path).endsWith('/AUTH-before.yaml')) { done = true; fs.writeFileSync(${JSON.stringify(`${contract}.DUMMY`)}, 'DUMMY SUBSTITUTE UNCHANGED'); fs.renameSync(${JSON.stringify(`${contract}.DUMMY`)}, ${JSON.stringify(contract)}); } return real(path, ...rest); }; syncBuiltinESMExports();`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", hook, resolve("scripts/replay-cp06-ten-pack.mjs")],
      { env: { ...process.env, CP06_OUTPUT: directoryRoot }, encoding: "utf8", timeout: 30_000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DUMMY proof artifact identity changed/);
    assert.equal(await readFile(contract, "utf8"), "DUMMY SUBSTITUTE UNCHANGED");
  } finally {
    await rm(directoryRoot, { recursive: true, force: true });
  }
});

test("DUMMY fixture cleanup closes every descriptor and removes through its anchor despite failures", async () => {
  const outputRoot = resolve(state, `DUMMY-fixture-${process.pid}`, "auth-security");
  const openDescriptors = () => readdirSync("/proc/self/fd").length;
  try {
    for (const scenario of ["alias-umount-fails", "setup-and-umount-fail", "setup-fails"]) {
      const before = openDescriptors();
      const umounts = [];
      const spawn = (command, args) => {
        const path = args.at(-1);
        if (command === "mount") {
          if (scenario !== "alias-umount-fails") writeFileSync(join(path, "source"), "DUMMY");
        } else if (command === "umount") {
          umounts.push(path.split("/").at(-1));
          if (
            scenario === "alias-umount-fails"
              ? path.endsWith("/DUMMY-alias")
              : scenario === "setup-and-umount-fail"
          )
            return { status: 32 };
        }
        return { status: 0 };
      };
      let caught;
      try {
        const fixture = await createProbeFixture({ root: process.cwd(), outputRoot, spawn });
        await fixture.cleanup();
      } catch (error) {
        caught = error;
      }
      assert.equal(openDescriptors(), before, scenario);
      assert.deepEqual(
        umounts.map((name) => name.replace(/^DUMMY-probe-.*/u, "DUMMY-probe")),
        scenario === "alias-umount-fails" ? ["DUMMY-alias", "DUMMY-probe"] : ["DUMMY-probe"],
      );
      const remaining = (await readdir(outputRoot)).filter((name) =>
        name.startsWith("DUMMY-probe-"),
      );
      if (scenario === "alias-umount-fails") {
        assert.ok(caught instanceof AggregateError);
        assert.deepEqual(
          caught.errors.map((error) => error.message),
          ["private DUMMY fixture mount unavailable"],
        );
        assert.deepEqual(remaining, []);
      } else if (scenario === "setup-and-umount-fail") {
        assert.ok(caught instanceof AggregateError);
        assert.deepEqual(
          caught.errors.map((error) => error.code ?? error.message),
          ["EEXIST", "private DUMMY fixture mount unavailable"],
        );
        assert.equal(remaining.length, 1);
        await rm(join(outputRoot, remaining[0]), { recursive: true });
      } else {
        assert.equal(caught?.code, "EEXIST");
        assert.deepEqual(remaining, []);
      }
    }
  } finally {
    await rm(resolve(state, `DUMMY-fixture-${process.pid}`), { recursive: true, force: true });
  }
});

test("supervisor CLI serializes fixture setup and independent fixture cleanup causes", async () => {
  const locate = (command) =>
    spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).stdout.trim();
  const [realMount, realUmount] = [locate("mount"), locate("umount")];
  const secret = "DUMMY-SECRET-FIXTURE-MARKER";
  const base = resolve(state, `DUMMY-fixture-cli-${process.pid}`);
  const shims = join(base, "shims");
  const outputRoot = join(base, "auth-security");
  const setup = {
    stage: "setup",
    code: "CP06_ISOLATION_SETUP_FAILED",
    exit_code: 73,
    description: "credential namespace setup failed",
  };
  const cleanup = {
    stage: "cleanup",
    code: "CP06_CREDENTIAL_CLEANUP_FAILED",
    exit_code: 74,
    description: "credential mount cleanup failed",
  };
  try {
    for (const umountFails of [true, false]) {
      await rm(base, { recursive: true, force: true });
      await mkdir(shims, { recursive: true });
      for (const [name, body] of [
        [
          "mount",
          `"${realMount}" "$@" || exit $?\ncase "$last" in */DUMMY-probe-*) : > "$last/source" ;; esac`,
        ],
        [
          "umount",
          `case "$last" in */DUMMY-probe-*) ${umountFails ? `printf '%s' '${secret}' >&2; exit 32` : ":"} ;; esac\nexec "${realUmount}" "$@"`,
        ],
      ]) {
        writeFileSync(
          join(shims, name),
          `#!/bin/sh\nfor argument do last="$argument"; done\n${body}\n`,
        );
        chmodSync(join(shims, name), 0o700);
      }
      const result = spawnSync(
        "unshare",
        [
          "--user",
          "--map-root-user",
          "--mount",
          "--propagation",
          "private",
          "--",
          process.execPath,
          "--experimental-import-meta-resolve",
          resolve("scripts/cp06-namespace-supervisor.mjs"),
          "hardened-probe",
          outputRoot,
          "-",
          "/DUMMY-helper",
          "/DUMMY-probe",
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, PATH: `${shims}:${process.env.PATH}` },
        },
      );
      const record = umountFails
        ? {
            schema_version: 1,
            stage: "cleanup",
            code: "CP06_CLEANUP_FAILED",
            exit_code: 74,
            description: "credential namespace cleanup failed",
            causes: [setup, cleanup],
          }
        : { schema_version: 1, ...setup, causes: [] };
      assert.equal(result.status, record.exit_code, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `${JSON.stringify(record)}\n`);
      assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
      const remaining = (await readdir(outputRoot)).filter((name) =>
        name.startsWith("DUMMY-probe-"),
      );
      assert.equal(remaining.length, umountFails ? 1 : 0);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
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
    assert.throws(() =>
      writeArtifactFile(join(child.anchor, "redirected", "DUMMY-sentinel"), "DUMMY write", {
        replace: true,
      }),
    );
    assert.throws(() => openPinnedDirectory(join(outputRoot, "raw", "redirected", "raw")));
    const source = join(child.anchor, "DUMMY-original.txt");
    writeArtifactFile(source, "DUMMY bytes");
    writeArtifactFile(join(child.anchor, "DUMMY-copy.txt"), readArtifactFile(source));
    assert.equal(readArtifactFile(join(child.anchor, "DUMMY-copy.txt"), "utf8"), "DUMMY bytes");
  } finally {
    child.close();
    output.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

for (const [runner, directory, rawName] of [
  ["replay-cp06-ten-pack.mjs", "ten-pack", "git-init.txt"],
  ["replay-cp06-p07.mjs", "p07", "build.txt"],
]) {
  test(`${runner} refuses a substituted raw artifact at its executable boundary`, async () => {
    await mkdir(state, { recursive: true });
    const directoryRoot = await mkdtemp(join(state, "DUMMY-runner-"));
    const sentinel = join(directoryRoot, "DUMMY-sentinel");
    const hook = join(directoryRoot, "DUMMY-hook.mjs");
    await writeFile(sentinel, "DUMMY SENTINEL UNCHANGED");
    await writeFile(
      hook,
      `import child from 'node:child_process'; import {symlinkSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const real = child.spawnSync; child.spawnSync = (command,args,options) => { if (${JSON.stringify(directory)} === 'ten-pack' ? command === 'git' && args[0] === 'init' : command === 'npm') { symlinkSync(${JSON.stringify(sentinel)}, ${JSON.stringify(join(directoryRoot, directory, "raw", rawName))}); return {status:0, stdout:'DUMMY', stderr:''}; } return real(command,args,options); }; syncBuiltinESMExports();`,
    );
    try {
      const result = spawnSync(process.execPath, ["--import", hook, resolve("scripts", runner)], {
        env: { ...process.env, CP06_OUTPUT: directoryRoot },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EEXIST/);
      assert.equal(await readFile(sentinel, "utf8"), "DUMMY SENTINEL UNCHANGED");
    } finally {
      await rm(directoryRoot, { recursive: true, force: true });
    }
  });
}
