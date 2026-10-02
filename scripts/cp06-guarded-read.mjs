import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_ORIGINAL_BYTES = 50 * 1024;
const MAX_ORIGINAL_LINES = 2_000;

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
  const pinned = readPinnedRegularFile(canonicalOriginal);
  const read = sdk.createReadTool(root, {
    operations: {
      async access(path) {
        if (path !== canonicalOriginal) throw new Error("read denied");
      },
      async readFile(path) {
        if (path !== canonicalOriginal) throw new Error("read denied");
        return Buffer.from(pinned.bytes);
      },
      async detectImageMimeType() {
        return null;
      },
    },
  });
  if (read?.name !== "read" || typeof read.execute !== "function") {
    throw new Error("Pi SDK read tool surface is unsupported");
  }
  return {
    original: Buffer.from(pinned.bytes),
    tool: {
      ...read,
      async execute(toolCallId, args, ...rest) {
        assertAllowedRead(args, canonicalOriginal, pinned.lineCount);
        let current;
        try {
          current = lstatSync(canonicalOriginal, { bigint: true });
        } catch {
          throw new Error("read denied: supplied original changed");
        }
        if (!current.isFile() || !sameIdentity(pinned.identity, current)) {
          throw new Error("read denied: supplied original changed");
        }
        return read.execute.call(read, toolCallId, args, ...rest);
      },
    },
  };
}

export function assertAllowedRead(args, expectedOriginalPath, completeLineLimit = 1) {
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
    (args.offset !== 1 ||
      !Number.isSafeInteger(args.limit) ||
      args.limit < completeLineLimit)
  ) {
    throw new Error("read denied: explicit range must cover the complete original");
  }
}

function readPinnedRegularFile(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      !sameIdentity(before, named) ||
      before.size <= 0n ||
      before.size > BigInt(MAX_ORIGINAL_BYTES)
    ) {
      throw new Error("supplied original is not one bounded pinned regular file");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("supplied original ended while pinned");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, after)) throw new Error("supplied original changed while pinned");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw new Error("supplied original is not valid UTF-8 text");
    }
    const lineCount = text.split("\n").length;
    if (lineCount > MAX_ORIGINAL_LINES) {
      throw new Error("supplied original exceeds the complete-read line bound");
    }
    return { bytes, identity: before, lineCount };
  } finally {
    closeSync(descriptor);
  }
}

function sameIdentity(expected, actual) {
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
