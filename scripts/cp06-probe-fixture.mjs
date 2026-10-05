import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  ftruncateSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const original = Buffer.from("DUMMY ORIGINAL");
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export function openProbeOutput({ root, outputRoot, create = false, runner = false }) {
  const state = resolve(root, ".factory/state");
  const selected = resolve(outputRoot);
  const subpath = relative(state, selected);
  if (
    selected !== outputRoot ||
    subpath === "" ||
    subpath === ".." ||
    subpath.startsWith("../") ||
    !(runner
      ? subpath === "cp06-correction" || subpath.startsWith("cp06-correction/")
      : subpath === "cp06-auth-security" || subpath.split("/").includes("auth-security"))
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

export function openAnchoredDirectory(
  parentAnchor,
  relativePath,
  { create = true, reset = false } = {},
) {
  const components = String(relativePath)
    .split("/")
    .filter((component) => component.length > 0);
  if (
    components.length === 0 ||
    components.some(
      (component) => component === "." || component === ".." || component.includes("\0"),
    )
  ) {
    throw new Error("DUMMY proof output child path is invalid");
  }
  let currentFd;
  let currentAnchor = parentAnchor;
  try {
    for (const [index, component] of components.entries()) {
      const path = join(currentAnchor, component);
      if (reset && index === components.length - 1) {
        removeAnchoredEntry(currentAnchor, component);
      }
      if (create) {
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      const nextFd = openSync(path, directoryFlags);
      if (currentFd !== undefined) closeSync(currentFd);
      currentFd = nextFd;
      currentAnchor = `/proc/${process.pid}/fd/${currentFd}`;
    }
    const outputFd = currentFd;
    currentFd = undefined;
    return {
      anchor: `/proc/${process.pid}/fd/${outputFd}`,
      identity: fstatSync(outputFd, { bigint: true }),
      close() {
        closeSync(outputFd);
      },
    };
  } finally {
    if (currentFd !== undefined) closeSync(currentFd);
  }
}

export function removeAnchoredEntry(parentAnchor, name, { beforeDescend } = {}) {
  assertArtifactName(name);
  const path = join(parentAnchor, name);
  let entry;
  try {
    entry = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!entry.isDirectory()) {
    unlinkSync(path);
    return;
  }
  beforeDescend?.(path);
  const fd = openSync(path, directoryFlags);
  try {
    if (!sameInode(entry, fstatSync(fd, { bigint: true }))) {
      throw new Error("DUMMY proof directory identity changed during removal");
    }
    const anchor = `/proc/${process.pid}/fd/${fd}`;
    for (const child of readdirSync(anchor)) {
      removeAnchoredEntry(anchor, child, { beforeDescend });
    }
  } finally {
    closeSync(fd);
  }
  rmdirSync(path);
}

function assertArtifactName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new Error("DUMMY proof artifact name is invalid");
  }
}

export function writeAnchoredFile(parentAnchor, name, data, options) {
  return writeAnchoredEntry(parentAnchor, name, data, options).sha256;
}

export function writeAnchoredEntry(parentAnchor, name, data, { replace = false, expected } = {}) {
  assertArtifactName(name);
  const bytes = Buffer.from(data);
  const path = join(parentAnchor, name);
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      (replace ? 0 : constants.O_EXCL) |
      constants.O_NOFOLLOW |
      constants.O_CLOEXEC,
    0o600,
  );
  try {
    const created = fstatSync(fd, { bigint: true });
    if (!created.isFile() || created.nlink !== 1n) {
      throw new Error("DUMMY proof artifact is not one fresh regular file");
    }
    if (
      !sameInode(created, lstatSync(path, { bigint: true })) ||
      (replace && (expected === undefined || !sameInode(expected, created)))
    ) {
      throw new Error("DUMMY proof artifact identity changed");
    }
    if (replace) ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    if (!sameInode(created, lstatSync(path, { bigint: true }))) {
      throw new Error("DUMMY proof artifact identity changed");
    }
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: { dev: created.dev, ino: created.ino },
    };
  } finally {
    closeSync(fd);
  }
}

export function readAnchoredFile(parentAnchor, name, { expected } = {}) {
  assertArtifactName(name);
  const path = join(parentAnchor, name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
  try {
    const pinned = fstatSync(fd, { bigint: true });
    if (
      !pinned.isFile() ||
      pinned.nlink !== 1n ||
      !sameInode(pinned, lstatSync(path, { bigint: true })) ||
      (expected !== undefined && !sameInode(expected, pinned))
    ) {
      throw new Error("DUMMY proof artifact identity changed");
    }
    const bytes = readFileSync(fd);
    const current = fstatSync(fd, { bigint: true });
    if (!sameInode(pinned, lstatSync(path, { bigint: true })) ||
        current.size !== pinned.size || current.mtimeNs !== pinned.mtimeNs ||
        current.ctimeNs !== pinned.ctimeNs) {
      throw new Error("DUMMY proof artifact identity changed");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function withArtifactParent(path, action) {
  const match = String(path).match(new RegExp(`^(/proc/${process.pid}/fd/\\d+)/(.+)$`, "u"));
  if (!match) throw new Error("DUMMY proof artifact must use a retained directory");
  const components = match[2].split("/");
  const name = components.pop();
  assertArtifactName(name);
  const parent = components.length ? openAnchoredDirectory(match[1], components.join("/"), { create: false }) : null;
  try {
    return action(parent?.anchor ?? match[1], name);
  } finally {
    parent?.close();
  }
}

export function writeArtifactFile(path, data, options) {
  return writeArtifactEntry(path, data, options).sha256;
}

export function writeArtifactEntry(path, data, options) {
  return withArtifactParent(path, (anchor, name) => writeAnchoredEntry(anchor, name, data, options));
}

export function readArtifactFile(path, encoding, options) {
  const bytes = withArtifactParent(path, (anchor, name) => readAnchoredFile(anchor, name, options));
  return encoding ? bytes.toString(encoding) : bytes;
}

export async function createProbeFixture({ root, outputRoot, spawn = spawnSync }) {
  const output = openProbeOutput({ root, outputRoot, create: true });
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
      credentialAnchors: {
        sourceParent: `/proc/${process.pid}/fd/${sourceDirFd}`,
        targetParent: `/proc/${process.pid}/fd/${agentDirFd}`,
        sourceLeaf: "DUMMY-auth.json",
        targetLeaf: "DUMMY-auth.json",
      },
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
        const failures = releaseFixture({
          spawn,
          output,
          descriptors: [sourceFd, sourceDirFd, agentDirFd, rootFd],
          directory,
          mounted,
          alias: join(anchoredRoot, "DUMMY-alias"),
        });
        mounted = false;
        if (failures.length > 0) {
          throw new AggregateError(failures, "DUMMY fixture cleanup failed");
        }
      },
    };
  } catch (error) {
    const failures = releaseFixture({
      spawn,
      output,
      descriptors: [sourceFd, sourceDirFd, agentDirFd, rootFd],
      directory,
      mounted,
    });
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], "DUMMY fixture setup and cleanup failed");
    }
    throw error;
  }
}

function releaseFixture({ spawn, output, descriptors, directory, mounted, alias }) {
  const failures = [];
  const attempt = (action) => {
    try {
      action();
      return true;
    } catch (error) {
      failures.push(error);
      return false;
    }
  };
  if (alias !== undefined) {
    attempt(() => {
      const mountedAlias = spawn("findmnt", ["--mountpoint", alias, "--noheadings"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      if (mountedAlias.status === 0) checkedMount(spawn, ["--", alias], "umount");
    });
  }
  for (const fd of descriptors) {
    if (fd !== undefined) attempt(() => closeSync(fd));
  }
  const unmounted = !mounted || attempt(() => checkedMount(spawn, ["--", directory], "umount"));
  if (directory !== undefined && unmounted) {
    attempt(() => removeAnchoredEntry(output.anchor, basename(directory)));
  }
  attempt(() => output.close());
  return failures;
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
