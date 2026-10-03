import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pins = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../.factory/cp06-sdk-integrity.json", import.meta.url)),
    "utf8",
  ),
).packages;

export function verifyPinnedPackage(root, name) {
  const pin = pins[name];
  if (pin?.version !== "0.85.1") throw new Error("unsupported CP-06 package pin");
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" && directory === root) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        files.push([
          relative(root, path).split("\\").join("/"),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]);
      } else throw new Error("selected CP-06 package contains an unsupported file entry");
    }
  }
  root = resolve(root);
  walk(root);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const manifest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  if (files.length !== pin.file_count || manifest !== pin.manifest_sha256) {
    throw new Error("selected CP-06 package differs from the pinned artifact");
  }
  return { manifest_sha256: manifest, tarball_integrity: pin.tarball_integrity };
}
