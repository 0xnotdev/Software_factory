import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function canonicalWorkerPaths(input, credentialTarget, credentialSource) {
  const root = canonicalExactPath(input.root, "root");
  const fixtureRoot = canonicalExactPath(input.fixture_root, "fixture_root");
  const contractPath = canonicalExactPath(input.contract_path, "contract_path");
  const packPath = canonicalExactPath(input.pack_path, "pack_path");
  const originalPath = canonicalExactPath(input.original_path, "original_path");
  if (!isWithin(fixtureRoot, originalPath)) {
    throw new Error("worker original_path escapes its fixture root");
  }
  const credentialPaths = [credentialTarget, credentialSource]
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => resolve(value));
  if (credentialPaths.includes(originalPath)) {
    throw new Error("worker original_path overlaps a credential path");
  }
  return { root, fixtureRoot, contractPath, packPath, originalPath };
}

export function createGuardedReadTool({ sdk, root, expectedOriginalPath }) {
  if (typeof sdk?.createReadTool !== "function") {
    throw new Error("Pi SDK guarded read constructor is unavailable");
  }
  const canonicalOriginal = canonicalExactPath(expectedOriginalPath, "expected original");
  const read = sdk.createReadTool(root);
  if (read?.name !== "read" || typeof read.execute !== "function") {
    throw new Error("Pi SDK read tool surface is unsupported");
  }
  return {
    ...read,
    async execute(toolCallId, args, ...rest) {
      assertAllowedRead(args, canonicalOriginal);
      return read.execute.call(read, toolCallId, args, ...rest);
    },
  };
}

export function assertAllowedRead(args, expectedOriginalPath) {
  if (
    args === null ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !["path", "offset", "limit"].includes(key)) ||
    args.path !== expectedOriginalPath
  ) {
    throw new Error("read denied: only the canonical supplied original is allowed");
  }
  const hasOffset = Object.hasOwn(args, "offset");
  const hasLimit = Object.hasOwn(args, "limit");
  if (hasOffset !== hasLimit) throw new Error("read denied: incomplete explicit range");
  if (
    hasOffset &&
    (args.offset !== 1 || !Number.isSafeInteger(args.limit) || args.limit < 1)
  ) {
    throw new Error("read denied: explicit range must start at one with a positive limit");
  }
}

function canonicalExactPath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`worker ${label} must be absolute`);
  }
  const resolved = resolve(value);
  let canonical;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    throw new Error(`worker ${label} is unavailable`);
  }
  if (canonical !== resolved) throw new Error(`worker ${label} must already be canonical`);
  return canonical;
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
