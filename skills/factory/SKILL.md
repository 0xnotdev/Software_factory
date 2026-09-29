---
name: factory
description: Use Factory to turn reviewed project intent into validated task contracts, bounded source-attributed context, and a safe Firstmate backlog preview. Use when initializing or validating a Factory project, preparing worker context, or previewing and publishing tasks to a named Firstmate home.
compatibility: Requires the Factory CLI plus separately installed ctx and tasks-axi CLIs; Firstmate owns dispatch.
---

# Factory workflow

Factory validates and packages work; Pi makes semantic judgments; CTX retrieves durable Markdown; tasks-axi owns the backlog; Firstmate alone dispatches workers.

## Establish the boundary

1. Identify the canonical Git project root and the exact, named Firstmate home. Never infer a home from a nearby checkout.
2. Find the real CLI: use `factory` only if `command -v factory` succeeds. In the Factory source checkout, run `npm run build` and use `node dist/src/cli.js` instead. Call that executable `<factory-cli>` below.
3. Run the read-only probe:

```sh
<factory-cli> doctor --root <project-root> --home <named-firstmate-home> --json
```

Stop on a mismatched home/project, stale CTX index, unsupported backend or tool version, contradictory authority, missing consequential product decision, sensitive access request, or publication conflict. Do not weaken the delivery mode.

## Prepare reviewed contracts

1. Before task decomposition, write concise product and architecture truth and independently author `.factory/completion.yaml` from observable behavior and risks.
2. Run `<factory-cli> init --root <project-root> --json`. It creates scaffolding but does not invent product choices.
3. Author `.factory/project.yaml` and bounded task contracts under `.factory/tasks/`. Prefer vertical slices, explicit acceptance IDs and evidence, a serial backbone, and at most three genuinely independent ready tasks.
4. Run `<factory-cli> validate --root <project-root> --json`; repair every schema, graph, path, coverage, and decision-block diagnostic.

Use the exact contracts in [`../../docs/CONTRACTS.md`](../../docs/CONTRACTS.md). For methodology and decision format, read [`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md). Original project documents remain authoritative; CTX excerpts and generated summaries do not replace decisive exact reads.

## Build bounded worker context

For each ready task, run:

```sh
<factory-cli> context <TASK-ID> --root <project-root> --json
```

Before generation, make `context.required` the reviewed task-local source selection: include every known original that can decide an acceptance or risk condition, but no unrelated documents as insurance. Factory reads those originals exactly and constrains CTX retrieval to the same document paths. Inspect the pack and receipt for the exact task contract, required originals, source and contract digests, CTX generation/retrieval mode, relevance, and token/byte bounds. Regenerate after any source, contract, or index change. Never place secrets, credentials, source archives, or agent transcripts in a pack.

Give a fresh worker only the task-local brief, exact contract, bounded pack, and existing evidence—not a previous agent transcript. If a decisive source is absent, have the worker name it and make one targeted exact-original read, verify provenance, record the corrected assumption, and add that exact path to `context.required` before regeneration when it is durable authority. Do not widen every pack, hide raw retrieved excerpts, or omit a critical constraint to make retrieval appear complete.

## Risk and task review

Classify by failure consequence, not diff size, and use the higher class when observed risk exceeds the contract:

- **bounded:** ordinary project checks and Firstmate's standard delivery policy;
- **normal:** targeted integration/e2e evidence, then a fresh semantic review when feasible;
- **critical:** explicit trust-boundary constraints, isolated negative tests, independent review, and human resolution of consequential policy. Use disposable identities only—never real accounts or secrets.

Before semantic review, record the exact deterministic commands, exits, artifacts, and tested SHA. Give the reviewer the task contract, focused diff, relevant architecture and exact-original correction reads, and observed evidence—not the worker transcript. A finding must cite an acceptance ID, demonstrated scenario, or concrete risk. Repair it and rerun the changed behavior plus affected checks, record an evidence-backed disagreement, or block; unresolved critical findings cannot pass.

This is task-local evidence policy, not another shipping gate. Do not call, embed, or rerun no-mistakes from Factory, and do not alter Firstmate routing or approvals. Firstmate's configured delivery invokes its normal gate once; Factory receipts may reference those resulting artifacts.

## Preview, then publish

Always run the read-only preview first:

```sh
<factory-cli> sync --dry-run --root <project-root> --home <named-firstmate-home> --json
```

Require the reported backlog hash to be unchanged, review every `create`, `unchanged`, `blocked`, and `conflict` record, and obtain human review of this exact named-home preview. Only then may the operator explicitly run:

```sh
<factory-cli> sync --apply --root <project-root> --home <named-firstmate-home> --json
```

Apply must repeat preflight and fail closed. Never edit a backlog file directly, overwrite an edited item, use a different home, or treat publication as dispatch. Firstmate chooses ready work and owns dispatch, worker lifecycle, and delivery approvals.

## Current command limit

The implemented Factory CLI commands are `doctor`, `init`, `validate`, `context TASK-ID`, `sync --dry-run|--apply`, `evidence TASK-ID`, and `status` (including `status --json`). Use the actual installed CLI help when syntax matters. Do not invent `/factory`, `factory run`, or `factory inspect` invocations. Backlog closure alone never proves product completion.
