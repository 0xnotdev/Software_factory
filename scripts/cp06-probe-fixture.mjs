import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const original = Buffer.from("DUMMY ORIGINAL");

export async function createProbeFixture({ root, outputRoot, spawn = spawnSync }) {
  const state = resolve(root, ".factory/state");
  const selected = resolve(outputRoot);
  const subpath = relative(state, selected);
  if (
    subpath.startsWith("..") ||
    subpath === "" ||
    !subpath.split("/").includes("auth-security") ||
    selected !== outputRoot
  )
    throw new Error("DUMMY proof root is outside task-local auth-security state");

  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const projectFd = openSync(root, directoryFlags);
  let factoryFd;
  let stateFd;
  try {
    factoryFd = openSync(`/proc/${process.pid}/fd/${projectFd}/.factory`, directoryFlags);
    stateFd = openSync(`/proc/${process.pid}/fd/${factoryFd}/state`, directoryFlags);
  } finally {
    if (factoryFd !== undefined) closeSync(factoryFd);
    closeSync(projectFd);
  }
  let outputFd;
  let traversedFd;
  let rootFd;
  let sourceFd;
  let directory;
  let mounted = false;
  try {
    for (const component of subpath.split("/")) {
      const nextFd = openSync(
        join(`/proc/${process.pid}/fd/${traversedFd ?? stateFd}`, component),
        directoryFlags,
      );
      if (traversedFd !== undefined) closeSync(traversedFd);
      traversedFd = nextFd;
    }
    outputFd = traversedFd;
    traversedFd = undefined;
    if (
      lstatSync(selected, { bigint: true }).ino !== fstatSync(outputFd, { bigint: true }).ino ||
      lstatSync(selected, { bigint: true }).dev !== fstatSync(outputFd, { bigint: true }).dev
    ) {
      throw new Error("DUMMY proof root identity changed");
    }
    directory = await mkdtemp(join(`/proc/${process.pid}/fd/${outputFd}`, "DUMMY-probe-"));
    checkedMount(spawn, ["-t", "tmpfs", "-o", "mode=0700,nosuid,nodev,noexec", "tmpfs", directory]);
    mounted = true;
    rootFd = openSync(directory, directoryFlags);
    const anchoredRoot = `/proc/${process.pid}/fd/${rootFd}`;
    await mkdir(join(anchoredRoot, "source"), { mode: 0o700 });
    await mkdir(join(anchoredRoot, "agent"), { mode: 0o700 });
    const source = join(anchoredRoot, "source/DUMMY-auth.json");
    const target = join(anchoredRoot, "agent/DUMMY-auth.json");
    await writeFile(source, original, { flag: "wx", mode: 0o600 });
    sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const pinned = fstatSync(sourceFd, { bigint: true });
    if (
      !pinned.isFile() ||
      pinned.nlink !== 1n ||
      !sameInode(pinned, lstatSync(source, { bigint: true }))
    ) {
      throw new Error("DUMMY source identity changed");
    }
    const beforeHash = hashPinned(sourceFd, original.length);
    return {
      source,
      target,
      cwd: anchoredRoot,
      beforeHash,
      sourceUnchanged() {
        try {
          const named = lstatSync(source, { bigint: true });
          return (
            sameInode(pinned, named) &&
            named.isFile() &&
            hashPinned(sourceFd, original.length) === beforeHash
          );
        } catch {
          return false;
        }
      },
      async cleanup() {
        const alias = join(anchoredRoot, "DUMMY-alias");
        const mountedAlias = spawn("findmnt", ["--mountpoint", alias, "--noheadings"], {
          encoding: "utf8",
          timeout: 10_000,
        });
        if (mountedAlias.status === 0) checkedMount(spawn, ["--", alias], "umount");
        closeSync(sourceFd);
        closeSync(rootFd);
        checkedMount(spawn, ["--", directory], "umount");
        mounted = false;
        await rm(directory, { recursive: true, force: true });
        closeSync(outputFd);
        closeSync(stateFd);
      },
    };
  } catch (error) {
    if (sourceFd !== undefined) closeSync(sourceFd);
    if (rootFd !== undefined) closeSync(rootFd);
    if (mounted) checkedMount(spawn, ["--", directory], "umount");
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    if (outputFd !== undefined) closeSync(outputFd);
    if (traversedFd !== undefined) closeSync(traversedFd);
    closeSync(stateFd);
    throw error;
  }
}

function hashPinned(fd, length) {
  const buffer = Buffer.alloc(length);
  if (readSync(fd, buffer, 0, length, 0) !== length) return null;
  return createHash("sha256").update(buffer).digest("hex");
}

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function checkedMount(spawn, args, command = "mount") {
  const result = spawn(command, args, { encoding: "utf8", timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("private DUMMY fixture mount unavailable");
  }
}
