import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const original = Buffer.from("DUMMY ORIGINAL");
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export function openProbeOutput({ root, outputRoot, create = false }) {
  const state = resolve(root, ".factory/state");
  const selected = resolve(outputRoot);
  const subpath = relative(state, selected);
  if (
    selected !== outputRoot ||
    subpath === "" ||
    subpath === ".." ||
    subpath.startsWith("../") ||
    !(subpath === "cp06-auth-security" || subpath.split("/").includes("auth-security"))
  )
    throw new Error("DUMMY proof root is outside task-local auth-security state");

  const projectFd = openSync(root, directoryFlags);
  let currentFd = projectFd;
  try {
    const components = [".factory", "state", ...subpath.split("/")];
    let scanFd = projectFd;
    try {
      for (const component of components) {
        const path = join(`/proc/${process.pid}/fd/${scanFd}`, component);
        try {
          const entry = lstatSync(path);
          if (!entry.isDirectory()) throw new Error("DUMMY proof output contains a non-directory");
          const nextFd = openSync(path, directoryFlags);
          if (scanFd !== projectFd) closeSync(scanFd);
          scanFd = nextFd;
        } catch (error) {
          if (error?.code !== "ENOENT" || !create) throw error;
          break;
        }
      }
    } finally {
      if (scanFd !== projectFd) closeSync(scanFd);
    }
    for (const component of components) {
      const path = join(`/proc/${process.pid}/fd/${currentFd}`, component);
      if (create) {
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      const nextFd = openSync(path, directoryFlags);
      if (currentFd !== projectFd) closeSync(currentFd);
      currentFd = nextFd;
    }
    const outputFd = currentFd;
    currentFd = projectFd;
    return {
      path: selected,
      anchor: `/proc/${process.pid}/fd/${outputFd}`,
      identity: fstatSync(outputFd, { bigint: true }),
      close() {
        closeSync(outputFd);
      },
    };
  } finally {
    if (currentFd !== projectFd) closeSync(currentFd);
    closeSync(projectFd);
  }
}

export async function createProbeFixture({ root, outputRoot, spawn = spawnSync }) {
  const output = openProbeOutput({ root, outputRoot });
  let rootFd;
  let sourceDirFd;
  let agentDirFd;
  let sourceFd;
  let directory;
  let mounted = false;
  try {
    directory = await mkdtemp(join(output.anchor, "DUMMY-probe-"));
    checkedMount(spawn, ["-t", "tmpfs", "-o", "mode=0700,nosuid,nodev,noexec", "tmpfs", directory]);
    mounted = true;
    rootFd = openSync(directory, directoryFlags);
    const anchoredRoot = `/proc/${process.pid}/fd/${rootFd}`;
    await mkdir(join(anchoredRoot, "source"), { mode: 0o700 });
    await mkdir(join(anchoredRoot, "agent"), { mode: 0o700 });
    sourceDirFd = openSync(join(anchoredRoot, "source"), directoryFlags);
    agentDirFd = openSync(join(anchoredRoot, "agent"), directoryFlags);
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
    const sourceParent = fstatSync(sourceDirFd, { bigint: true });
    const targetParent = fstatSync(agentDirFd, { bigint: true });
    return {
      source,
      target,
      cwd: anchoredRoot,
      beforeHash,
      assertSafePaths({ mounted = false } = {}) {
        if (
          !sameInode(sourceParent, lstatSync(join(anchoredRoot, "source"), { bigint: true })) ||
          !sameInode(targetParent, lstatSync(join(anchoredRoot, "agent"), { bigint: true })) ||
          !sameInode(pinned, lstatSync(source, { bigint: true }))
        )
          throw new Error("DUMMY fixture path identity changed");
        if (mounted) {
          if (!sameInode(pinned, lstatSync(target, { bigint: true }))) {
            throw new Error("DUMMY fixture target identity changed");
          }
        } else {
          try {
            lstatSync(target);
            throw new Error("DUMMY fixture target was replaced");
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
      },
      sourceUnchanged() {
        try {
          const named = lstatSync(source, { bigint: true });
          const current = fstatSync(sourceFd, { bigint: true });
          return (
            sameInode(pinned, named) &&
            named.isFile() &&
            sameInode(pinned, current) &&
            current.size === pinned.size &&
            named.size === pinned.size &&
            hashPinned(sourceFd, Number(pinned.size)) === beforeHash
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
        closeSync(sourceDirFd);
        closeSync(agentDirFd);
        closeSync(rootFd);
        checkedMount(spawn, ["--", directory], "umount");
        mounted = false;
        await rm(directory, { recursive: true, force: true });
        output.close();
      },
    };
  } catch (error) {
    if (sourceFd !== undefined) closeSync(sourceFd);
    if (sourceDirFd !== undefined) closeSync(sourceDirFd);
    if (agentDirFd !== undefined) closeSync(agentDirFd);
    if (rootFd !== undefined) closeSync(rootFd);
    if (mounted) checkedMount(spawn, ["--", directory], "umount");
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    output.close();
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
