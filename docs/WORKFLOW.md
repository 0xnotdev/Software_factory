# Factory workflow for Pi and future `skills/factory/SKILL.md`

This document specifies the methodology. CP-04 turns it into a concise, discoverable Pi skill after the CLI primitives exist. Do not install this document as a skill or advertise `/factory` commands before they pass their integration tests.

## New project from zero

1. **Intake:** ask for a short product brief, audience, first meaningful user journey, constraints, and release destination. Infer mundane defaults and expose consequential assumptions. If a decision blocks a slice, record it with two options and tradeoffs; continue independent work.
2. **Focused research:** research only questions that could alter architecture, feasibility, security, or user behavior. Record sources and dates in the target project's reference docs; convert decisions into short ADRs. Research does not automatically become a worker's context.
3. **Project truth:** author a concise `PROJECT.md` with goal, audience, user journeys, non-goals, constraints, and V1 limits. Draft `ARCHITECTURE.md` with component boundaries, data model, trust boundary, deployment shape, and failure handling. Keep technical choices proportionate to the first release.
4. **Independent oracle:** in a separate reasoning pass, author `.factory/completion.yaml` from product intent and risks before decomposing into tasks. Specify observable end-to-end behavior, isolation/security invariants, recovery, and any performance thresholds the project actually needs. Include one negative test for important trust boundaries. Record the current Git SHA of this first oracle so later changes are visible.
5. **Slices and DAG:** choose the first vertical slice that a user can exercise; add a minimal foundation only where it unlocks slices. Tasks should have one independently reviewable outcome, bounded scope, testable acceptance IDs, expected evidence, and dependencies. Prefer a serial backbone of slices with at most three genuinely independent ready tasks. Do not turn one feature into separate backend/frontend/UI megatasks that integrate only at the end.
6. **Validate and retrieve:** use `factory validate`; repair schema/graph gaps; generate a context pack for each task via CTX. Inspect the first few packs for missing mandatory source and irrelevant bulk. Use exact source reads on decisive constraints.
7. **Preview and publish:** run `factory sync --dry-run --home <selected-home>`, inspect which items will be created and which are blocked, then explicitly apply to the selected home. The engineer's direction to execute work authorizes normal publication into the intended Firstmate home; ask only if the home or project identity is genuinely ambiguous.
8. **Execute with Firstmate:** Firstmate chooses ready work and workers through its existing dispatch policy. Each worker receives the task contract, relevant source pack, and evidence expectations; worker tests and repairs locally. Firstmate handles the actual delivery path and approvals required by its configured project mode.
9. **Verify per task and per project:** run deterministic gates first; semantic review receives task, diff, architecture, and observed evidence rather than the worker's full transcript. Repair specific findings and rerun changed checks. Then execute the original project oracle at the release candidate SHA. Failed project behavior creates a reviewed follow-up task. The status report must show backlog and product completion separately.
10. **Release judgment:** present a concise release candidate report with outstanding failures, risks, artifacts, setup instructions, and decision requests. The human owns final release approval.

## Task-local worker brief

```text
Outcome: [one observable behavior]
Contract: .factory/tasks/<ID>.yaml at SHA [digest]
Context: .factory/state/context/<ID>.md at [generation]
Risk: [bounded | normal | critical, with the concrete failure consequence]
Acceptance: [IDs]
Evidence: [commands/observations and artifact destinations]
Dependencies: [satisfied backlog IDs]
Delivery: [Firstmate project mode]
Escalate: product policy, new access, contradictory authoritative docs, or scope change
```

A fresh worker receives this brief, the exact task contract, bounded pack, and existing evidence—not a previous agent transcript. It must verify the pack receipt and source freshness, inspect only relevant code, and run evidence against the actual change. If the pack lacks a source needed to decide or test an acceptance or risk condition, name the missing source, read only the relevant exact-original file or range, verify its digest when available, and record how that read corrected the working assumptions. Do not compensate by loading broad documentation or by dropping a critical constraint. A context pack is supporting material, not an instruction channel with authority above the project's tracked documents.

## Risk and review

| Risk     | Examples                                                                 | Required human/independent check                                                                              |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| bounded  | isolated deterministic refactor, docs typo                               | ordinary project checks; Firstmate's standard delivery policy.                                                |
| normal   | API behavior, persistence, UI journey                                    | targeted integration/e2e evidence and a fresh semantic review when feasible.                                  |
| critical | authentication, tenancy, payments, destructive migration, external sends | explicit design constraints, negative tests, independent review, and human decision for consequential policy. |

Risk is about consequences of error, not code size. Use the higher class when the contract understates an observed consequence, and stop for a human decision when critical policy or access is unresolved.

For each task, keep this order visible in the evidence:

1. Verify contract/pack digests and run the cheapest applicable schema, graph, file, type, lint, unit, and targeted integration checks. Record command, exit, artifact, and tested SHA before requesting semantic review.
2. Build the review packet from the task contract, focused diff, relevant architecture or exact-original correction reads, and observed check evidence. Do not send a previous worker transcript as authority.
3. Apply the table above. Bounded work uses ordinary project checks and Firstmate's delivery policy. Normal work adds targeted integration/e2e evidence and a fresh semantic review when feasible. Critical work additionally requires isolated negative tests, explicit trust-boundary constraints, independent review, and human resolution of consequential policy; fixtures must use disposable identities and no real accounts or secrets.
4. Require each finding to cite an acceptance ID, reproduced scenario, or concrete risk. Disposition it as repaired, evidence-backed disagreement, or blocker. A repair must rerun the changed behavior and every deterministic check it could affect; unresolved critical findings block delivery.

This task review adds signal but is not a shipping pipeline. Factory must not invoke, embed, or rerun no-mistakes; task evidence may reference artifacts from the one normal Firstmate-owned delivery gate. Factory likewise does not change Firstmate routing or approvals. A disagreement is resolved with evidence, not reviewer authority alone.

## Human decision format

```text
DECISION: RAW-CONTENT-RETENTION
Context: [why it matters now]
Option A: discard after classification; [effect]
Option B: retain encrypted for 24 hours; [effect]
Recommendation: [reasoned choice]
Blocked: [only the affected tasks/conditions]
```

Decisions belong in tracked product docs or ADRs once made. A worker does not invent an answer from a previous agent conversation.

## Reports

`factory status` reports counts of queued/in-flight/done from the selected Firstmate home, passed/failed/stale/unverified task evidence and project conditions, the tested release candidate SHA, and only actionable human decisions. Avoid a single percentage that combines backlog with product acceptance. `factory inspect <ID>` and a Pi `/factory` wrapper are later conveniences, not V0 prerequisites.
