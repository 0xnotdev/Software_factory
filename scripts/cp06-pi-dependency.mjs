import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyPinnedPackage } from "./cp06-package-integrity.mjs";

const packageName = "@earendil-works/pi-ai";
const supportedVersion = "0.85.1";

/** Resolve Pi's import-only pi-ai dependency from the explicitly selected Pi package. */
export function resolvePinnedPiAi(piRootArg) {
  const piRoot = realpathSync(resolve(piRootArg));
  const piMetadataPath = join(piRoot, "package.json");
  const piMetadata = JSON.parse(readFileSync(piMetadataPath, "utf8"));
  if (
    piMetadata.name !== "@earendil-works/pi-coding-agent" ||
    piMetadata.version !== supportedVersion ||
    piMetadata.dependencies?.[packageName] !== `^${supportedVersion}`
  ) {
    throw new Error("selected Pi package does not declare the supported pi-ai dependency");
  }

  const parent = pathToFileURL(piMetadataPath).href;
  const entryUrl = import.meta.resolve(packageName, parent);
  if (!entryUrl.startsWith("file:")) throw new Error("resolved pi-ai entry is not a local file");
  const entry = realpathSync(fileURLToPath(entryUrl));
  const dependencyRoot = findPackageRoot(entry, packageName);
  const dependencyMetadataPath = join(dependencyRoot, "package.json");
  const dependencyMetadata = JSON.parse(readFileSync(dependencyMetadataPath, "utf8"));
  if (dependencyMetadata.name !== packageName || dependencyMetadata.version !== supportedVersion) {
    throw new Error("resolved pi-ai dependency is not exact version 0.85.1");
  }

  const selectedInstallNodeModules = dirname(dirname(piRoot));
  const nestedNodeModules = join(piRoot, "node_modules");
  if (
    !isWithin(selectedInstallNodeModules, dependencyRoot) &&
    !isWithin(nestedNodeModules, dependencyRoot)
  ) {
    throw new Error("resolved pi-ai dependency is outside the selected Pi installation");
  }

  const integrity = verifyPinnedPackage(dependencyRoot, packageName);
  return {
    entryUrl,
    provenance: {
      ...integrity,
      name: dependencyMetadata.name,
      version: dependencyMetadata.version,
      root: dependencyRoot,
      entry,
      resolution: "esm-import-condition",
      package_sha256: sha256(readFileSync(dependencyMetadataPath)),
      entry_sha256: sha256(readFileSync(entry)),
    },
  };
}

export async function importPinnedPiAi(piRootArg) {
  const selected = resolvePinnedPiAi(piRootArg);
  return { module: await import(selected.entryUrl), provenance: selected.provenance };
}

function findPackageRoot(entry, expectedName) {
  let directory = dirname(entry);
  for (;;) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (metadata.name === expectedName) return directory;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("resolved pi-ai package root is unavailable");
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
