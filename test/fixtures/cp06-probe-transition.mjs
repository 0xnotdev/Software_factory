import { strict as assert } from "node:assert";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createProbeFixture } from "../../scripts/cp06-probe-fixture.mjs";
import {
  superviseCredentialChild,
  supervisorFailureRecord,
} from "../../scripts/cp06-namespace-supervisor.mjs";

const [mode, scenario, sentinel] = process.argv.slice(2);
const root = process.cwd();
const outputRoot = resolve(root, ".factory/state/cp06-correction/auth-security");
if (!["unsafe-probe", "hardened-probe"].includes(mode)) process.exit(64);
const secretBefore = await readFile(sentinel);
let fixture;
let mounts = 0;
let launches = 0;
let failure;
if (["unchanged", "append", "truncate", "rewrite"].includes(scenario)) {
  fixture = await createProbeFixture({ root, outputRoot });
  try {
    assert.equal(fixture.sourceUnchanged(), true);
    if (scenario === "append") await appendFile(fixture.source, " DUMMY appended");
    if (scenario === "truncate") await truncate(fixture.source, 5);
    if (scenario === "rewrite") await writeFile(fixture.source, "DUMMY ALTERED!", { flag: "r+" });
    assert.equal(fixture.sourceUnchanged(), scenario === "unchanged");
  } finally {
    await fixture.cleanup();
  }
} else {
  try {
    await superviseCredentialChild(
      {
        mode,
        source: outputRoot,
        target: "-",
        helper: "/DUMMY-helper",
        syscallProbe: "/DUMMY-probe",
      },
      {
        async createProbeFixture() {
          fixture = await createProbeFixture({ root, outputRoot });
          if (scenario === "source-ancestor") {
            const named = join(fixture.cwd, "source");
            await rename(named, join(fixture.cwd, "source-moved"));
            await symlink(dirname(sentinel), named);
          } else if (scenario === "target-slot") {
            await symlink(sentinel, fixture.target);
          } else throw new Error("unsupported DUMMY scenario");
          return fixture;
        },
        mount() {
          mounts++;
          throw new Error("DUMMY mount must not run");
        },
        spawn() {
          launches++;
          throw new Error("DUMMY adversary must not run");
        },
      },
    );
    throw new Error("substituted DUMMY fixture was accepted");
  } catch (error) {
    failure = supervisorFailureRecord(error);
    assert.equal(failure.code, "CP06_ISOLATION_SETUP_FAILED");
    assert.equal(mounts, 0);
    assert.equal(launches, 0);
  }
}
assert.deepEqual(await readFile(sentinel), secretBefore);
console.log(
  JSON.stringify({ mode, scenario, mounts, launches, failure, sentinel_unchanged: true }),
);
