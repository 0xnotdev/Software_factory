import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { verifyPinnedPackage } from "./cp06-package-integrity.mjs";
import { resolvePinnedPiAi } from "./cp06-pi-dependency.mjs";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const SUPPORTED_VERSION = "0.85.1";

export function resolvePinnedPiInstall(options) {
  const projectRoot = realpathSync(resolve(options.projectRoot));
  const selectedRoot = resolve(projectRoot, ".factory/state/cp06-sdk");
  const expectedPackageRoot = join(
    selectedRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const expectedExecutable = join(selectedRoot, "node_modules", ".bin", "pi");
  requireExactPath(options.packageRoot, expectedPackageRoot, "Pi package root");
  requireExactPath(options.executable, expectedExecutable, "Pi executable");

  const packageRoot = realpathSync(expectedPackageRoot);
  if (packageRoot !== expectedPackageRoot) {
    throw new Error("selected Pi package root is not canonical");
  }
  accessSync(expectedExecutable, constants.X_OK);
  const executableEntry = realpathSync(expectedExecutable);
  if (!isWithin(packageRoot, executableEntry)) {
    throw new Error("selected Pi executable resolves outside its package");
  }

  const metadataPath = join(packageRoot, "package.json");
  const sdkEntry = realpathSync(join(packageRoot, "dist/index.js"));
  if (!isWithin(packageRoot, sdkEntry)) {
    throw new Error("selected Pi SDK entry resolves outside its package");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const declaredBin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pi;
  if (
    metadata.name !== PACKAGE_NAME ||
    metadata.version !== SUPPORTED_VERSION ||
    typeof declaredBin !== "string" ||
    realpathSync(resolve(packageRoot, declaredBin)) !== executableEntry
  ) {
    throw new Error("selected task-local Pi package is unsupported");
  }

  const packageIntegrity = verifyPinnedPackage(packageRoot, PACKAGE_NAME);
  const piAi = resolvePinnedPiAi(packageRoot);
  const spawn = options.spawnSyncImpl ?? spawnSync;
  const version = spawn(expectedExecutable, ["--version"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: options.environment ?? process.env,
  });
  if (
    version.error !== undefined ||
    version.status !== 0 ||
    version.stdout.trim() !== SUPPORTED_VERSION
  ) {
    throw new Error("selected task-local Pi executable version is unsupported");
  }

  return {
    root: packageRoot,
    executable: expectedExecutable,
    version: SUPPORTED_VERSION,
    provenance: {
      install_root: selectedRoot,
      package_root: packageRoot,
      package_artifact: packageIntegrity,
      dependency: piAi.provenance,
      executable: expectedExecutable,
      executable_entry: executableEntry,
      sdk_entry: sdkEntry,
      package_sha256: sha256(readFileSync(metadataPath)),
      executable_sha256: sha256(readFileSync(executableEntry)),
      sdk_entry_sha256: sha256(readFileSync(sdkEntry)),
    },
  };
}

function requireExactPath(value, expected, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== expected) {
    throw new Error(`${label} must select the task-local CP-06 installation`);
  }
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
