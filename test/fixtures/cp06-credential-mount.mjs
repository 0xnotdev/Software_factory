// Runs inside a disposable private user/mount namespace with the compiled
// helper inherited as fd 3. Uses literal DUMMY files only.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mountLiveCredentialReadOnly } from "../../scripts/cp06-credential-isolation.mjs";

const [scenario] = process.argv.slice(2);
const marker = "DUMMY-EXTERNAL-MARKER";
const credential = '{"fixture":"DUMMY","token":"DUMMY-NOT-REAL"}';
const directory = realpathSync(await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-mount-")));
const realSource = join(directory, "source", "DUMMY-auth.json");
const source =
  scenario === "source-ancestor-symlink"
    ? join(directory, "linked", "source", "DUMMY-auth.json")
    : realSource;
const target =
  scenario === "target-ancestor-symlink"
    ? join(directory, "home", "pi-agent", "DUMMY-auth.json")
    : join(directory, "agent", "DUMMY-auth.json");
const external = join(directory, "external");
const externalLeaf = join(external, "DUMMY-auth.json");
await mkdir(dirname(realSource));
await mkdir(join(directory, "agent"));
await mkdir(external);
await writeFile(realSource, credential);
await writeFile(externalLeaf, marker);
if (scenario === "target-ancestor-symlink") await symlink(external, join(directory, "home"));
if (scenario === "source-ancestor-symlink") {
  await mkdir(join(external, "source"));
  await writeFile(join(external, "source", "DUMMY-auth.json"), marker);
  await symlink(external, join(directory, "linked"));
}

const markerReads = [];
async function substitute(leafPath) {
  if (scenario === "target-leaf-symlink") {
    await unlink(leafPath);
    await symlink(externalLeaf, leafPath);
  } else if (scenario === "target-leaf-replaced") {
    await rename(leafPath, join(directory, "DUMMY-placeholder-moved"));
    await writeFile(leafPath, "DUMMY substitute");
  } else if (scenario === "source-leaf-symlink") {
    await rename(source, join(directory, "DUMMY-source-moved"));
    await symlink(externalLeaf, source);
  } else if (scenario === "target-parent-replaced" || scenario === "source-parent-replaced") {
    const parent = dirname(scenario === "target-parent-replaced" ? target : source);
    await rename(parent, `${parent}-moved`);
    await symlink(external, parent);
  } else if (
    !["control", "target-ancestor-symlink", "source-ancestor-symlink"].includes(scenario)
  ) {
    throw new Error("unsupported DUMMY scenario");
  }
}

const result = { scenario };
let mount;
try {
  mount = await mountLiveCredentialReadOnly({
    root: process.cwd(),
    source,
    target,
    mountHelper: `/proc/${process.pid}/fd/3`,
    async beforeMount({ targetMountPath }) {
      await substitute(targetMountPath);
    },
    async lstatImpl(path, options) {
      markerReads.push(await readFile(externalLeaf, "utf8"));
      return lstat(path, options);
    },
  });
  result.mounted = true;
  result.target_bytes = await readFile(target, "utf8");
  try {
    await writeFile(target, "DUMMY write");
    result.target_write = "allowed";
  } catch (error) {
    result.target_write = error.code;
  }
  try {
    await writeFile(join(dirname(target), "DUMMY-entry"), "DUMMY entry");
    result.parent_write = "allowed";
  } catch (error) {
    result.parent_write = error.code;
  }
  result.integrity = await mount.verifyIntegrity();
  await mount.cleanup();
  result.cleanup = "pass";
  result.target_after_cleanup = await readFile(target, "utf8");
} catch (error) {
  result.mounted = mount !== undefined;
  result.error =
    error instanceof AggregateError
      ? "aggregate"
      : ["ELOOP", "ENOTDIR"].includes(error.code)
        ? "no-follow-refused"
        : error.message;
}
if (scenario.endsWith("-ancestor-symlink")) result.external_entries = (await readdir(external)).sort();
markerReads.push(await readFile(externalLeaf, "utf8"));
result.marker_unchanged = markerReads.every((value) => value === marker);
const originalSource =
  scenario === "source-leaf-symlink"
    ? join(directory, "DUMMY-source-moved")
    : scenario === "source-parent-replaced"
      ? join(directory, "source-moved", "DUMMY-auth.json")
      : realSource;
result.source_unchanged = (await readFile(originalSource, "utf8")) === credential;
const listed = spawnSync("findmnt", ["--json", "--list", "--output", "TARGET"], {
  encoding: "utf8",
});
result.remaining_mounts = JSON.parse(listed.stdout).filesystems.filter(({ target: path }) =>
  path.startsWith(`${directory}/`),
).length;
await rm(directory, { recursive: true, force: true });
console.log(JSON.stringify(result));
