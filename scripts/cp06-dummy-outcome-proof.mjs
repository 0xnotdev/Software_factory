import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withCleanup } from "./cp06-worker-lifecycle.mjs";

/** Exercise the actual SDK worker executable, with only a local faux provider. */
export async function proveDummyWorkerOutcome({ piRoot }) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const directory = await mkdtemp(join(tmpdir(), "factory-cp06-DUMMY-outcome-"));
  return withCleanup(
    async () => {
      await mkdir(join(directory, "docs"));
      const originalPath = join(directory, "docs/AUTH.md");
      await writeFile(
        originalPath,
        "# DUMMY authority\n\nOwnership comes only from the authenticated principal; request-supplied owner fields are ignored.\n",
      );
      const credentialAlias = join(directory, "DUMMY-credential-alias.json");
      const contractPath = join(directory, "DUMMY-contract.yaml");
      const packPath = join(directory, "DUMMY-pack.md");
      await writeFile(
        contractPath,
        "DUMMY critical AUTH ownership task; creation evidence is unverified\n",
      );
      await writeFile(
        packPath,
        "DUMMY globals: offline, preserve tenant privacy, no secrets in context\n",
      );
      const cases = [];
      for (const [scenario, expectedExit] of [
        ["valid", 0],
        ["empty-gap", 75],
        ["missing-gap", 75],
        ["contradictory-gap", 75],
        ["extra-evidence", 75],
        ["constraint-pass", 75],
        ["missing-reads", 75],
        ["credential-read", 75],
        ["symlink-read", 75],
        ["expired", 75],
        ["near-expiry", 75],
        ["timeout", 70],
      ]) {
        const auth = join(directory, `DUMMY-${scenario}-auth.json`);
        const counters = join(directory, `DUMMY-${scenario}-counters.json`);
        const inputPath = join(directory, `DUMMY-${scenario}-input.json`);
        const authBytes = JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "DUMMY-ACCESS",
            refresh: "DUMMY-REFRESH",
            expires:
              scenario === "expired"
                ? 0
                : Date.now() + (scenario === "near-expiry" ? 60_000 : 3_600_000),
          },
        });
        await writeFile(auth, authBytes);
        if (scenario === "symlink-read") await symlink(auth, credentialAlias);
        await writeFile(
          inputPath,
          JSON.stringify({
            schema_version: 1,
            root: directory,
            fixture_root: directory,
            contract_path: contractPath,
            pack_path: packPath,
            original_path: originalPath,
            symlink_path: credentialAlias,
            provider: "openai-codex",
            model: "DUMMY-model",
            timeout_ms: scenario === "timeout" ? 1_000 : 20_000,
            system_prompt: "DUMMY ONLY local exact-original read and structured evidence gap",
          }),
        );
        const result = spawnSync(
          process.execPath,
          [
            "--experimental-import-meta-resolve",
            "--import",
            join(root, "scripts/cp06-dummy-worker-hook.mjs"),
            join(root, "scripts/cp06-sdk-worker.mjs"),
            auth,
            inputPath,
          ],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 40_000,
            maxBuffer: 1024 * 1024,
            env: {
              PATH: process.env.PATH,
              HOME: directory,
              TMPDIR: directory,
              PI_OFFLINE: "1",
              PI_SKIP_VERSION_CHECK: "1",
              CP06_DUMMY_PI_ROOT: piRoot,
              CP06_PROJECT_ROOT: root,
              CP06_PI_PACKAGE_ROOT: piRoot,
              CP06_PI_BIN: join(dirname(dirname(piRoot)), ".bin", "pi"),
              CP06_DUMMY_COUNTERS: counters,
              CP06_DUMMY_SCENARIO: scenario,
            },
          },
        );
        assert.equal(result.error, undefined);
        assert.equal(result.status, expectedExit, `${scenario}: ${result.stderr}`);
        const counts = JSON.parse(await readFile(counters, "utf8"));
        assert.equal(counts.default_storage, 0);
        assert.equal(counts.network, 0);
        assert.equal(counts.refresh, 0);
        assert.equal(await readFile(auth, "utf8"), authBytes);
        if (["expired", "near-expiry"].includes(scenario)) assert.equal(counts.runtime_create, 0);
        if (
          [
            "empty-gap",
            "missing-gap",
            "contradictory-gap",
            "extra-evidence",
            "constraint-pass",
            "missing-reads",
          ].includes(scenario)
        )
          assert.match(result.stderr, /SDK worker outcome failed/);
        if (["credential-read", "symlink-read"].includes(scenario)) {
          assert.match(result.stderr, /SDK event audit failed/);
          assert.equal(result.stdout.includes("DUMMY-ACCESS"), false);
          assert.equal(result.stderr.includes("DUMMY-ACCESS"), false);
        }
        if (scenario === "timeout") assert.match(result.stderr, /worker timed out and was aborted/);
        const output = scenario === "valid" ? JSON.parse(result.stdout) : undefined;
        if (output) {
          assert.equal(output.result, "pass");
          assert.equal(output.event_stream.read_audit.exact_original, true);
          assert.equal(output.event_stream.read_audit.read_count, 1);
          assert.equal(output.response.evidence_gaps[0].status, "unverified");
        } else assert.equal(result.stdout, "");
        await rm(credentialAlias, { force: true });
        cases.push({
          scenario,
          exit_code: result.status,
          expected_exit_code: expectedExit,
          ...counts,
          source_unchanged: true,
          read_audit: output?.event_stream.read_audit,
        });
      }
      return { fixture_origin: true, semantic_acceptance: false, cases };
    },
    () => rm(directory, { recursive: true, force: true }),
  );
}
