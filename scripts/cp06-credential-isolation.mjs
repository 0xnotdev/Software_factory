import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export async function proveDummyCredentialIsolation(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const proofRoot = await mkdtemp(
    join(resolve(options.tmpRoot ?? tmpdir()), "factory-cp06-auth-proof-"),
  );
  const source = join(proofRoot, "dummy-source-auth.json");
  const target = join(proofRoot, "dummy-target-auth.json");
  await writeFile(source, JSON.stringify({ fixture: "dummy", token: "not-real" }));
  await writeFile(target, "");
  const hashBefore = await fileHash(source);
  try {
    bindReadOnlyOntoSelf(source, { root, spawnSyncImpl: options.spawnSyncImpl });
    bindReadOnlyFile(source, target, { root, spawnSyncImpl: options.spawnSyncImpl });
    await assertDestructiveCredentialWritesDenied([source, target]);
    assertReadOnlyMount(source, { spawnSyncImpl: options.spawnSyncImpl });
    assertReadOnlyMount(target, { spawnSyncImpl: options.spawnSyncImpl });
    const hashAfter = await fileHash(source);
    if (hashAfter !== hashBefore) {
      throw new Error("dummy credential source changed during isolation proof");
    }
    return { source, target, source_unchanged: true, atomic_replacement_denied: true };
  } finally {
    unmountQuietly(target, { root, spawnSyncImpl: options.spawnSyncImpl });
    unmountQuietly(source, { root, spawnSyncImpl: options.spawnSyncImpl });
    await rm(proofRoot, { recursive: true, force: true });
  }
}

export async function mountLiveCredentialReadOnly(options) {
  const root = resolve(options.root ?? process.cwd());
  const source = resolve(options.source);
  const target = resolve(options.target);
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile()) throw new Error("Pi credential source is not a regular file");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "", { flag: "w", mode: 0o600 });
  await access(target, constants.R_OK | constants.W_OK);
  try {
    bindReadOnlyOntoSelf(source, { root, spawnSyncImpl: options.spawnSyncImpl });
    bindReadOnlyFile(source, target, { root, spawnSyncImpl: options.spawnSyncImpl });
    assertReadOnlyMount(source, { spawnSyncImpl: options.spawnSyncImpl });
    assertReadOnlyMount(target, { spawnSyncImpl: options.spawnSyncImpl });
    return {
      source,
      target,
      cleanup() {
        unmountQuietly(target, { root, spawnSyncImpl: options.spawnSyncImpl });
        unmountQuietly(source, { root, spawnSyncImpl: options.spawnSyncImpl });
      },
    };
  } catch (error) {
    unmountQuietly(target, { root, spawnSyncImpl: options.spawnSyncImpl });
    unmountQuietly(source, { root, spawnSyncImpl: options.spawnSyncImpl });
    throw error;
  }
}

export async function assertDestructiveCredentialWritesDenied(paths, operations = {}) {
  const write = operations.writeFile ?? writeFile;
  const move = operations.rename ?? rename;
  const remove = operations.rm ?? rm;
  for (const target of paths) {
    await expectDenied(`write to ${target}`, () => write(target, "unauthorized mutation"));
    const replacement = join(dirname(target), `.replacement-${process.pid}-${Date.now()}`);
    await write(replacement, "unauthorized replacement");
    try {
      await expectDenied(`atomic replacement of ${target}`, () => move(replacement, target));
    } finally {
      await remove(replacement, { force: true });
    }
  }
}

function bindReadOnlyOntoSelf(path, options) {
  checkedSpawn("mount", ["--bind", path, path], options);
  checkedSpawn("mount", ["-o", "remount,bind,ro", path], options);
}

function bindReadOnlyFile(source, target, options) {
  checkedSpawn("mount", ["--bind", source, target], options);
  checkedSpawn("mount", ["-o", "remount,bind,ro", target], options);
}

function assertReadOnlyMount(path, options = {}) {
  const result = (options.spawnSyncImpl ?? spawnSync)(
    "findmnt",
    ["--noheadings", "--output", "OPTIONS", "--target", path],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `read-only credential isolation unavailable: ${result.stderr ?? "findmnt failed"}`,
    );
  }
  const optionSets = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
  if (!optionSets.some((options) => options.includes("ro"))) {
    throw new Error(`credential mount is not read-only: ${path}`);
  }
}

function checkedSpawn(command, args, options = {}) {
  const result = (options.spawnSyncImpl ?? spawnSync)(command, args, {
    cwd: options.root,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `read-only credential isolation unavailable: ${result.stderr ?? `${command} failed`}`,
    );
  }
  return result;
}

function unmountQuietly(path, options = {}) {
  (options.spawnSyncImpl ?? spawnSync)("umount", [path], { cwd: options.root, encoding: "utf8" });
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
