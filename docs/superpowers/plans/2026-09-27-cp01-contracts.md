# CP-01: versioned contracts and dependency graph

Base: CP-00 commit `0e2cea51da34065b3f2774ba0d0ecbbafec77a51`. Acceptance: F-01 and F-02. Scope ends after offline `factory init` and `factory validate`; CTX context generation and backlog publication remain later checkpoints.

## Files and responsibilities

- `schemas/{project,task,completion}.schema.json`: the version 1 YAML object shapes, including unknown-key rejection and conditional completion fields.
- `src/types.ts`: parsed contract types and structured validation diagnostics.
- `src/core/load.ts`: bounded, UTF-8, root-contained regular-file reads and safe YAML parsing.
- `src/core/validate.ts`: JSON Schema checks and cross-file invariants, including source documents and condition coverage.
- `src/core/graph.ts`: dependency existence, self-edge, cycle, and deterministic topological order.
- `src/core/init.ts`: idempotent creation of `.factory/tasks`, `.factory/state`, and the exact root `.gitignore` rule, without creating product decisions.
- `src/cli.ts`: `init` and `validate` dispatch and versioned JSON diagnostics, preserving `doctor` behavior.
- `test/contracts.test.ts`: CLI-level contract and graph tests with disposable Git projects.

## Steps

1. Pin the installed `yaml` and `ajv` package versions in the lockfile. Add failing tests for a valid sample and each required invalid case: malformed YAML, unknown field, duplicate IDs, missing completion ID, dependency cycle, path escape, and an oversized required source. Add `init` tests for two runs and preservation of existing `.gitignore` and contracts. Run the new tests and capture the expected failures.
2. Implement `load.ts` and schemas. Parse YAML without custom tags or unlimited aliases, bound file size, reject symlink/realpath escapes and non-UTF-8 text, and return path-specific diagnostics. Run focused tests.
3. Implement graph and cross-file validation. Check IDs, references, document paths, condition coverage, and stable dependency order. Run focused tests and repair failures.
4. Implement `init` and CLI dispatch. Keep `doctor`'s JSON and exit behavior; `validate` exits 0 for a valid project and 2 for invalid contracts. Run CLI smoke commands on a seeded disposable project, then full format/lint/typecheck/test gates on the tested SHA.
5. Record commands, exits, SHA, changed files, and residual risks in a CP-01 probe report. Commit the checkpoint and publish a stacked PR against `fm/factory-cp00` only after local gates pass.

No actual Firstmate backlog, CTX/Pi installation, model configuration, or external project is changed by this checkpoint.
