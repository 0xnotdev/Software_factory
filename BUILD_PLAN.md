# Factory V0 and V1 build plan

**Goal:** Build the deterministic Factory layer, verify it on the existing Pi/CTX/Firstmate stack, then prove it on one greenfield product.

**Architecture:** Pi authors truth and makes semantic judgments; a TypeScript CLI validates contracts, uses CTX for bounded source context, and publishes into one verified Firstmate home via tasks-axi. Firstmate owns execution and shipping.

**Tech:** Node 20+ and TypeScript, a safe YAML parser, JSON Schema validation, child-process API without shell, Node's test runner or existing project test convention. Exact dependency versions and Pi import namespace are selected after CP-00 probes and recorded in lockfile; no network dependency in normal CLI operation.

**Spec:** `PROJECT.md`, `ARCHITECTURE.md`, `COMPLETION.md`, and `docs/{CONTRACTS,INTEGRATIONS,WORKFLOW}.md`.

## Global constraints

- Do not mutate a real Firstmate home during exploratory probes.
- Do not install an untested Factory skill that instructs Pi to call nonexistent commands.
- Every integration mutation begins with a read-only preview and names the target project and home.
- Keep CTX's original Markdown authoritative and test stale-source handling.
- Do not create a second scheduler, model router, worktree manager, or shipping gate.
- Each checkpoint finishes with a real command/fixture proof and a fresh review of the diff and evidence.
- Use Git commits per checkpoint in the user's own Factory repository. Do not push to any upstream Firstmate, Pi, or CTX repository.

## CP-00 — Establish the actual external boundary

**Deliverable:** A TypeScript repository with `factory doctor --json`, a locked test environment, and `docs/probes/CP-00.md` recording local tool versions and outcomes. The `doctor` command is read-only.

**Implementation files:** `package.json`, `tsconfig.json`, `src/cli.ts`, `src/adapters/{ctx,tasks-axi,firstmate-home}.ts`, `test/doctor.test.ts`. Keep the adapter methods read-only at this point.

**Actions and checks:**

- [ ] Probe installed Node, Git, Pi, CTX, tasks-axi, and a specified disposable Firstmate home using `docs/INTEGRATIONS.md`; record supported syntax, JSON shape, version, backend, and known unavailable pieces.
- [ ] Prove `factory doctor --home <disposable-home> --json` reports each detected boundary and exits nonzero for wrong home or missing tool.
- [ ] Test an ephemeral Pi package/skill separately; do not add Factory's skill yet.
- [ ] Run CLI tests offline and inspect resulting report. **Gate:** real CTX pack and tasks-axi dependency fixture observed, no live backlog modified.

## CP-01 — Versioned contracts and dependency graph

**Deliverable:** `factory init` and `factory validate` operate offline with precise diagnostics.

**Implementation files:** `schemas/*.schema.json`, `src/types.ts`, `src/core/{load,validate,graph}.ts`, `test/{contracts,graph}.test.ts` and fixtures.

- [ ] Write invalid fixtures first: malformed YAML, unknown key, duplicate IDs, missing completion ID, cycle, path escape, and oversized required source.
- [ ] Implement safe loading and schema checks, then graph and cross-file validation using `docs/CONTRACTS.md`.
- [ ] Implement idempotent init with no overwrite and an exact ignore rule for `.factory/state/`.
- [ ] Run test suite and exercise CLI on seeded sample. **Gate:** F-01 and F-02, and Windows path edge cases where a Windows runner exists.

## CP-02 — CTX adapter and task context

**Deliverable:** `factory context TASK-ID --json` writes a bounded, attributed pack and freshness receipt.

**Implementation files:** `src/core/context.ts`, `src/adapters/ctx.ts`, `test/context.test.ts`, CTX fixture Markdown.

- [ ] Write tests for mandatory source, duplicate excerpts, budget overflow, stale index, missing binary, lexical fallback, and symlink escape.
- [ ] Implement argument-array subprocess calls and source validation; make stdout parseable in JSON mode.
- [ ] Run real archived/local CTX CLI against disposable fixture in offline mode. **Gate:** F-03 and F-04; measure first ten pack budgets.

## CP-03 — Backlog publication with safe reconciliation

**Deliverable:** `factory sync --dry-run` and `factory sync --apply` for one verified Firstmate tasks-axi backend.

**Implementation files:** `src/core/plan.ts`, `src/adapters/{tasks-axi,firstmate-home}.ts`, `test/sync.test.ts` and disposable home fixtures.

- [ ] Write tests for wrong home, unregistered project, duplicate ID, human-edited body, partial apply, idempotent retry, and held dependency.
- [ ] Resolve home/project/backend through actual Firstmate data, create a stable publication plan, and implement create-only sync through the probed tasks-axi CLI.
- [ ] Test dry-run by hashing backlog before/after; test apply twice in isolated home and inspect actual `ready`/`show` output.
- [ ] **Gate:** F-05 through F-07; record the exact installed commands and any supported-backend limit. No live home write before a reviewed preview.

## CP-04 — Pi workflow packaging and initial dogfood

**Deliverable:** A discoverable `skills/factory/SKILL.md` with concise operational instructions and links to deeper references, plus an actual Firstmate task to build the next checkpoint.

**Implementation files:** `skills/factory/SKILL.md`, optional `prompts/factory-start.md`, package manifest registration if Pi discovery requires it; validate exact installed Pi behavior.

- [x] Write the skill using `docs/WORKFLOW.md`; explain what the CLI does, when to use it, and when to stop for a real decision.
- [x] Load it in Pi, invoke it explicitly and automatically, and confirm it uses existing commands rather than narrating a fictional `/factory run`.
- [x] Publish CP-05 as a testable task in Factory's own backlog, then observe real Firstmate dispatch and closure. **Gate:** F-09 and the first real task/worker trace. Dogfooding remains unproven if only task publication succeeds.

## CP-05 — Evidence and independent completion

**Deliverable:** `factory evidence TASK-ID` and `factory status --json` distinguish task closure from product conditions and bind evidence to Git SHA.

**Implementation files:** `src/core/{evidence,status}.ts`, `schemas/evidence.schema.json`, `test/{evidence,status}.test.ts`.

- [ ] Test prose-only pass, failed exit, changed contract, changed release SHA, missing artifact, and all-tasks-done/project-test-fails.
- [ ] Implement receipts produced from executed checks, verify hashes, and summarize separate task and product axes.
- [ ] **Gate:** P-03 and P-04 in an isolated sample; failed project condition displays `NOT COMPLETE`.

## CP-06 — Review policy and real workflow exercise

**Deliverable:** Pi's workflow classifies bounded/normal/critical risk, obtains precise review findings, and collects evidence appropriate to the task without rerunning no-mistakes' pipeline inside Factory.

- [x] Create tests/fixtures for critical auth isolation and normal API behavior, plus one simulated reviewer finding that causes repair and retest.
- [x] Run an actual worker task with only task/pack/evidence sources in a fresh context; inspect whether it needs missing docs.
- [x] **Gate:** P-06 and P-07 via the tracked replays in [docs/probes/CP-06.md](docs/probes/CP-06.md), which owns proof interpretation and residual limits; exact-final-head proofs and independent review remain required. No change to Firstmate routing or shipping config by Factory.

CP-06 was independently accepted at `604744e3d09fd11a1eac6a4c80ffab18d6cc64d0` and landed through PR13 as `c2416731991593bea90a6bec2a98b7257fe9aeb1` on 2026-10-06. The confirmed Firstmate landing receipt and exact-head independent audit reconcile the prior unchecked gate; [CP-06 probe interpretation](docs/probes/CP-06.md) and its Linux/strict-agent/null-normalization limitations remain binding. This is not V1 completion or certification of later checkpoints.

## CP-07 — Thin Pi command and status convenience

**Deliverable:** Optional `/factory status`, `/factory validate`, and `/factory context <ID>` Pi commands wrapping the proven CLI. Do not expose `/factory run` unless it has explicit, tested semantics delegated to Firstmate.

**Implementation files:** `extensions/factory.ts`, package manifest, extension smoke tests. The extension must not hold task state or spawn workers.

- [x] Verify command parsing and errors in the installed Pi version.
- [x] Reload and smoke test package. **Gate:** feature parity with the CLI and no new background process.

The development proof and exact-head final validation procedure are owned by [docs/probes/CP-07.md](docs/probes/CP-07.md). Checked implementation steps do not substitute for final-head no-mistakes/CI and independent acceptance.

## CP-08 — End-to-end greenfield acceptance

**Deliverable:** One small, nontrivial read-later application started from an empty separate repo and product brief. It includes account isolation, persistence, search, and a usable UI, delivered in at least two vertical slices.

- [x] Freeze brief and completion oracle before implementation; record decisions and first oracle commit.
- [x] Validate DAG, publish through reviewed sync, dispatch via Firstmate, and gather slice evidence.
- [ ] Execute original project-level checks at release candidate SHA; demonstrate recovery from one interrupted run.
- [ ] **Gate:** P-01, P-02, P-05, P-08 plus all V0 gates; inspect real product manually and list portability limits.

## Build handoff

For each checkpoint, give the implementing worker only this checkpoint, the relevant authoritative documents, current repository code, and the exact probes from the prior checkpoint. Run its tests, inspect failures, repair, perform a fresh review, then commit. Do not spend tokens on a standing supervisor. Once CP-03 is sound, publish later checkpoints as Factory tasks; Firstmate still controls dispatch and shipping.
