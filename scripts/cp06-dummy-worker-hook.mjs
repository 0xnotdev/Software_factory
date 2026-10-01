// Development-only local provider instrumentation. Never a live semantic proof.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = process.env.CP06_DUMMY_PI_ROOT;
const countersPath = process.env.CP06_DUMMY_COUNTERS;
const scenario = process.env.CP06_DUMMY_SCENARIO;
if (!piRoot || !countersPath || !scenario) throw new Error("DUMMY proof configuration missing");
const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")));
const { AuthStorage } = await import(pathToFileURL(join(piRoot, "dist/core/auth-storage.js")));
const ai = await import(
  pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"))
);
const input = JSON.parse(readFileSync(process.argv[3], "utf8"));
const counts = {
  fixture_origin: true,
  default_storage: 0,
  network: 0,
  refresh: 0,
  to_auth: 0,
  runtime_create: 0,
};
AuthStorage.create = () => {
  counts.default_storage++;
  throw new Error("DUMMY forbids default AuthStorage");
};
globalThis.fetch = async () => {
  counts.network++;
  throw new Error("DUMMY forbids network");
};
const create = sdk.ModelRuntime.create;
sdk.ModelRuntime.create = async function (options) {
  counts.runtime_create++;
  if (
    !options.credentials ||
    options.modelsPath !== null ||
    options.refreshOnCreate !== false ||
    options.allowModelNetwork !== false
  )
    throw new Error("DUMMY unsafe runtime options");
  const runtime = await create.call(this, options);
  const faux = ai.fauxProvider({
    provider: "openai-codex",
    models: [{ id: "DUMMY-model" }],
    tokensPerSecond: scenario === "timeout" ? 1 : 100_000,
  });
  faux.provider.auth = {
    oauth: {
      async refresh() {
        counts.refresh++;
        throw new Error("DUMMY refresh forbidden");
      },
      async toAuth(credential) {
        counts.to_auth++;
        if (credential.access !== "DUMMY-ACCESS") throw new Error("DUMMY credential required");
        return { apiKey: "DUMMY-LOCAL" };
      },
    },
  };
  runtime.registerNativeProvider(faux.provider);
  const gap = {
    id: "creation-time-ownership",
    status: "unverified",
    missing_checks: ["principal-derived-owner", "request-owner-ignored"],
  };
  const response = {
    status: "MISSING_SOURCE",
    missing_source: "docs/AUTH.md",
    reads: [input.original_path],
    corrected_constraints: [
      "ownership comes only from the authenticated principal; request-supplied owner fields are ignored",
    ],
    evidence_gaps:
      scenario === "empty-gap"
        ? []
        : [{ ...gap, ...(scenario === "contradictory-gap" ? { status: "pass" } : {}) }],
    broad_scan: false,
  };
  if (scenario === "missing-gap") delete response.evidence_gaps;
  faux.setResponses([
    ai.fauxAssistantMessage(
      ai.fauxToolCall("read", { path: input.original_path }, { id: "DUMMY-actual-worker-read" }),
      { stopReason: "toolUse" },
    ),
    ai.fauxAssistantMessage(JSON.stringify(response), { stopReason: "stop" }),
  ]);
  return runtime;
};
process.on("exit", (exit) => writeFileSync(countersPath, JSON.stringify({ ...counts, exit })));
