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

Select `context.required` according to [`CONTRACTS.md`](../../docs/CONTRACTS.md#task-factorytaskssave-001yaml), including its empty-selection rule. Inspect the pack and receipt for source and contract digests, CTX generation/retrieval mode, relevance, and token/byte bounds. Regenerate after any source, contract, or index change. Never place secrets, credentials, source archives, or agent transcripts in a pack.

Use [`WORKFLOW.md`'s task-local worker brief and omitted-source procedure](../../docs/WORKFLOW.md#task-local-worker-brief) for fresh handoffs and targeted correction reads.

## Risk and task review

Follow the risk classes, check ordering, review packet, and finding dispositions in [`WORKFLOW.md`](../../docs/WORKFLOW.md#risk-and-review). Use disposable identities for critical negative tests, never real accounts or secrets; unresolved critical findings block delivery.

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

The implemented Factory CLI commands are `doctor`, `init`, `validate`, `context TASK-ID`, `sync --dry-run|--apply`, `evidence TASK-ID`, and `status` (including `status --json`). Use the actual installed CLI help when syntax matters. If the optional reviewed Factory Pi package is loaded, `/factory status`, `/factory validate`, and `/factory context TASK-ID` forward the same CLI arguments in the session working directory; explicit `--root` and `--home` still apply. Inspect the displayed CLI exit or `factory-result.details.exit_code`, not the Pi prompt acknowledgement. Build the local package first and use `/reload` after changes; see [`../../docs/probes/CP-07.md`](../../docs/probes/CP-07.md) for current-version discovery and proof commands. Do not invent `/factory run`, `factory run`, or `factory inspect` invocations. Backlog closure alone never proves product completion.
