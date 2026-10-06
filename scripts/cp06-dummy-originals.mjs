export const DUMMY_SDK_ORIGINAL =
  "# DUMMY authority\n\nrequest-supplied owner fields are ignored; ownership comes only from the authenticated principal.\n";
export const DUMMY_OUTCOME_ORIGINAL =
  "# DUMMY authority\n\nOwnership comes only from the authenticated principal; request-supplied owner fields are ignored.\n";
export const DUMMY_PI_PROVENANCE = Object.freeze({
  install_root: "/DUMMY/sdk",
  package_root: "/DUMMY/sdk/package",
  executable: "/DUMMY/sdk/pi",
  executable_entry: "/DUMMY/sdk/package/cli.js",
  sdk_entry: "/DUMMY/sdk/package/index.js",
  package_sha256: "0".repeat(64),
  executable_sha256: "0".repeat(64),
  sdk_entry_sha256: "0".repeat(64),
  package_artifact: Object.freeze({
    manifest_sha256: "0".repeat(64),
    tarball_integrity: "sha512-DUMMY",
  }),
  dependency: Object.freeze({
    entry: "/DUMMY/sdk/ai/index.js",
    root: "/DUMMY/sdk/ai",
    entry_sha256: "0".repeat(64),
    manifest_sha256: "0".repeat(64),
    package_sha256: "0".repeat(64),
    name: "@earendil-works/pi-ai",
    version: "0.85.1",
    resolution: "esm-import-condition",
    tarball_integrity: "sha512-DUMMY",
  }),
});
