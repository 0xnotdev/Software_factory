import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const REQUIRED_VFS_OPTIONS = ["ro", "nosuid", "nodev", "noexec"];

export async function proveDummyCredentialIsolation(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const proofRoot = await mkdtemp(
    join(resolve(options.tmpRoot ?? tmpdir()), "factory-cp06-auth-proof-"),
  );
  const source = join(proofRoot, "DUMMY-source-auth.json");
  const target = join(proofRoot, "agent", "DUMMY-target-auth.json");
  await writeFile(source, JSON.stringify({ fixture: "DUMMY", token: "DUMMY-NOT-REAL" }));
  const hashBefore = await fileHash(source);
  let mount;
  try {
    mount = await mountLiveCredentialReadOnly({
      root,
      source,
      target,
      mountHelper: options.mountHelper,
      spawnSyncImpl: options.spawnSyncImpl,
    });
    await assertDestructiveCredentialWritesDenied([source, target]);
    const hashAfter = await fileHash(source);
    if (hashAfter !== hashBefore) {
      throw new Error("DUMMY credential source changed during isolation proof");
    }
    return {
      source,
      target,
      source_unchanged: true,
      destructive_operations_denied: true,
      mount_ids: mount.mountIds,
    };
  } finally {
    await mount?.cleanup();
    await rm(proofRoot, { recursive: true, force: true });
  }
}

/**
 * Pin one regular credential inode, bind it over both its source path and a fresh
 * regular target, and make both mount instances read-only before closing the FD.
 * The native helper consumes the retained source and destination descriptors.
 * This function must run only in the private setup namespace.
 */
export async function mountLiveCredentialReadOnly(options) {
  const root = resolve(options.root ?? process.cwd());
  const source = resolveRequiredPath(options.source, "credential source");
  const target = resolveRequiredPath(options.target, "credential target");
  const helper = resolveRequiredPath(options.mountHelper, "credential mount helper");
  const maxBytes = options.maxBytes ?? MAX_CREDENTIAL_BYTES;
  const spawn = options.spawnSyncImpl ?? spawnSync;
  const statPath = options.lstatImpl ?? lstat;
  const protectParents = options.protectParents !== false;
  const sourceLeaf = options.sourceLeaf ?? basename(source);
  const targetLeaf = options.targetLeaf ?? basename(target);
  let handle;
  let sourceParentHandle;
  let targetParentHandle;
  let sourceMountPath = source;
  let targetMountPath = target;
  const mountStack = [];
  let parentHandlesTransferred = false;
  try {
    sourceParentHandle = await openParent(options.sourceParentAnchor, dirname(source));
    const sourceParentPath =
      options.sourceParentAnchor ?? `/proc/${process.pid}/fd/${sourceParentHandle.fd}`;
    sourceMountPath = join(sourceParentPath, sourceLeaf);
    handle = await open(
      sourceMountPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
    );
    const pinned = await handle.stat({ bigint: true });
    const named = await statPath(sourceMountPath, { bigint: true });
    assertPinnedRegularFile(pinned, named, maxBytes);

    targetParentHandle = await openParent(options.targetParentAnchor, dirname(target), {
      create: true,
    });
    const targetParentPath =
      options.targetParentAnchor ?? `/proc/${process.pid}/fd/${targetParentHandle.fd}`;
    targetMountPath = join(targetParentPath, targetLeaf);
    const placeholder = await createPlaceholder(targetMountPath);
    await options.beforeMount?.({ sourceMountPath, targetMountPath });

    const mountOptions = { helper, root, spawn };
    bindFile(mountOptions, handle, pinned, sourceParentHandle, sourceLeaf, pinned, source);
    mountStack.push({ path: sourceMountPath, recursive: false });
    bindFile(mountOptions, handle, pinned, targetParentHandle, targetLeaf, placeholder, target);
    mountStack.push({ path: targetMountPath, recursive: false });
    const parentMounts = [];
    if (protectParents) {
      const parents = await uniqueParents([
        { handle: sourceParentHandle, path: sourceParentPath, visible: dirname(source) },
        { handle: targetParentHandle, path: targetParentPath, visible: dirname(target) },
      ]);
      for (const parent of parents) {
        bindTree(mountOptions, parent);
        mountStack.push({ path: parent.path, recursive: true });
        parentMounts.push(inspectReadOnlyMount(parent.path, { spawn }));
      }
    }

    const sourceMount = inspectReadOnlyMount(sourceMountPath, { spawn });
    const targetMount = inspectReadOnlyMount(targetMountPath, { spawn });
    if (sourceMount.id === targetMount.id) {
      throw new Error("credential source and target did not receive distinct mount instances");
    }
    for (const path of [sourceMountPath, targetMountPath]) {
      const mounted = await statPath(path, { bigint: true });
      if (!mounted.isFile() || !sameStatIdentity(pinned, mounted)) {
        throw new Error(`credential mount identity changed: ${path}`);
      }
    }
    await handle.close();
    handle = undefined;

    let cleaned = false;
    parentHandlesTransferred = true;
    return {
      source,
      target,
      sourceIdentity: statIdentity(pinned),
      mountIds: { source: sourceMount.id, target: targetMount.id },
      parentMounts: parentMounts.map((entry) => ({ id: entry.id, target: entry.target })),
      async verifyIntegrity() {
        for (const path of [sourceMountPath, targetMountPath]) {
          const mounted = await statPath(path, { bigint: true });
          if (!mounted.isFile() || !sameStatIdentity(pinned, mounted)) return false;
        }
        const currentSourceMount = inspectReadOnlyMount(sourceMountPath, { spawn });
        const currentTargetMount = inspectReadOnlyMount(targetMountPath, { spawn });
        if (currentSourceMount.id !== sourceMount.id || currentTargetMount.id !== targetMount.id) {
          return false;
        }
        for (const expected of parentMounts) {
          const current = inspectReadOnlyMount(expected.target, { spawn });
          if (current.id !== expected.id) return false;
        }
        return true;
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        const failures = [];
        unmountAll(mountStack, { root, spawn, failures });
        for (const [label, parentHandle] of [
          ["source", sourceParentHandle],
          ["target", targetParentHandle],
        ]) {
          try {
            await parentHandle?.close();
          } catch (error) {
            failures.push(error?.message ?? `${label} parent close failed`);
          }
        }
        sourceParentHandle = undefined;
        targetParentHandle = undefined;
        if (failures.length > 0) {
          throw new Error(`credential mount cleanup failed: ${failures.join("; ")}`);
        }
      },
    };
  } catch (error) {
    const cleanupFailures = [];
    unmountAll(mountStack, { root, spawn, failures: cleanupFailures });
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures.map((message) => new Error(message))],
        "credential mount setup and cleanup failed",
      );
    }
    throw error;
  } finally {
    await handle?.close();
    if (!parentHandlesTransferred) {
      await sourceParentHandle?.close();
      await targetParentHandle?.close();
    }
  }
}

async function openParent(anchor, path, { create = false } = {}) {
  if (anchor !== undefined) {
    return open(anchor, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_CLOEXEC);
  }
  const directoryFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_CLOEXEC;
  let handle = await open("/", directoryFlags);
  try {
    for (const component of resolve(path).split("/").filter(Boolean)) {
      const child = join(`/proc/${process.pid}/fd/${handle.fd}`, component);
      if (create) {
        try {
          await mkdir(child, { mode: 0o700 });
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      const next = await open(child, directoryFlags);
      await handle.close();
      handle = next;
    }
    const parent = handle;
    handle = undefined;
    return parent;
  } finally {
    await handle?.close();
  }
}

async function createPlaceholder(path) {
  const placeholder = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_CLOEXEC,
    0o600,
  );
  try {
    const identity = await placeholder.stat({ bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n) {
      throw new Error("credential target placeholder is not one fresh regular file");
    }
    return identity;
  } finally {
    await placeholder.close();
  }
}

async function uniqueParents(parents) {
  const unique = new Map();
  for (const parent of parents) {
    const identity = await parent.handle.stat({ bigint: true });
    const key = `${identity.dev}:${identity.ino}`;
    if (!unique.has(key)) unique.set(key, { ...parent, identity });
  }
  return [...unique.values()].sort(
    (left, right) => right.visible.split("/").length - left.visible.split("/").length,
  );
}

function bindFile(options, sourceHandle, sourceIdentity, parentHandle, leaf, expected, visible) {
  checkedSpawn(
    options.helper,
    [
      "--cp06-bind-file",
      String(sourceIdentity.dev),
      String(sourceIdentity.ino),
      leaf,
      String(expected.dev),
      String(expected.ino),
      visible,
    ],
    { ...options, fds: [sourceHandle.fd, parentHandle.fd] },
  );
}

function bindTree(options, parent) {
  checkedSpawn(
    options.helper,
    ["--cp06-bind-tree", String(parent.identity.dev), String(parent.identity.ino), parent.visible],
    { ...options, fds: [parent.handle.fd] },
  );
}

function unmountAll(mounted, options) {
  for (const entry of [...mounted].reverse()) unmount(entry.path, { ...options, ...entry });
}

export async function assertDestructiveCredentialWritesDenied(paths, operations = {}) {
  const write = operations.writeFile ?? writeFile;
  const move = operations.rename ?? rename;
  const remove = operations.unlink ?? unlink;
  const makeSymlink = operations.symlink ?? symlink;
  const makeHardlink = operations.link ?? link;
  const cleanup = operations.rm ?? rm;
  const scratchRoot = operations.scratchRoot ?? tmpdir();
  for (const target of paths) {
    await expectDenied(`write to ${target}`, () => write(target, "DUMMY unauthorized mutation"));
    await expectDenied(`unlink of ${target}`, () => remove(target));
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const replacement = join(scratchRoot, `.DUMMY-replacement-${nonce}`);
    const symbolic = join(scratchRoot, `.DUMMY-symlink-${nonce}`);
    const hard = join(scratchRoot, `.DUMMY-hardlink-${nonce}`);
    await write(replacement, "DUMMY unauthorized replacement");
    try {
      await expectDenied(`atomic replacement of ${target}`, () => move(replacement, target));
      await expectDenied(`symlink replacement of ${target}`, async () => {
        await remove(target);
        await makeSymlink("/tmp/DUMMY-does-not-exist", target);
      });
      await expectDenied(`hardlink of ${target}`, () => makeHardlink(target, hard));
    } finally {
      await cleanup(replacement, { force: true });
      await cleanup(symbolic, { force: true });
      await cleanup(hard, { force: true });
    }
  }
}

export function inspectReadOnlyMount(path, options = {}) {
  const spawn = options.spawn ?? options.spawnSyncImpl ?? spawnSync;
  const result = spawn(
    "findmnt",
    ["--json", "--noheadings", "--output", "ID,TARGET,VFS-OPTIONS", "--target", path],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `read-only credential isolation unavailable: ${result.stderr ?? "findmnt failed"}`,
    );
  }
  let entry;
  try {
    const parsed = JSON.parse(result.stdout);
    [entry] = parsed.filesystems ?? [];
  } catch (cause) {
    throw new Error("read-only credential mount inspection returned invalid JSON", { cause });
  }
  const optionsList = String(entry?.["vfs-options"] ?? "").split(",");
  if (
    entry === undefined ||
    ![resolve(path), realpathSync(path)].includes(resolve(entry.target)) ||
    !REQUIRED_VFS_OPTIONS.every((option) => optionsList.includes(option))
  ) {
    throw new Error(`credential mount lacks required read-only VFS flags: ${path}`);
  }
  return { id: String(entry.id), target: resolve(entry.target), options: optionsList };
}

export function statIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    nlink: String(stat.nlink),
    mode: String(stat.mode),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
  };
}

function sameStatIdentity(expected, actual) {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.nlink === actual.nlink &&
    expected.mode === actual.mode &&
    expected.mtimeNs === actual.mtimeNs &&
    expected.ctimeNs === actual.ctimeNs
  );
}

function assertPinnedRegularFile(pinned, named, maxBytes) {
  if (!pinned.isFile() || !named.isFile()) {
    throw new Error("Pi credential source is not a regular file");
  }
  if (pinned.dev !== named.dev || pinned.ino !== named.ino) {
    throw new Error("Pi credential source changed while it was pinned");
  }
  if (pinned.nlink !== 1n) {
    throw new Error("Pi credential source must have exactly one hard link");
  }
  if (pinned.size <= 0n || pinned.size > BigInt(maxBytes)) {
    throw new Error("Pi credential source size is outside the allowed bound");
  }
}

function checkedSpawn(command, args, options) {
  const result = options.spawn(command, args, {
    cwd: options.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", ...(options.fds ?? [])],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `read-only credential isolation unavailable: ${result.stderr ?? `${command} failed`}`,
    );
  }
  return result;
}

function unmount(path, options) {
  const result = options.spawn("umount", options.recursive ? ["--recursive", path] : [path], {
    cwd: options.root,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    options.failures.push(
      `${path}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
}

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return resolve(value);
}

async function expectDenied(label, action) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`read-only credential isolation permitted ${label}`);
}

async function fileHash(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
