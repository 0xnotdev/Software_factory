# Factory — independent completion contract

Factory is judged by behavior in an isolated, reproducible environment. A passing unit suite alone does not satisfy this contract. Record the command, exit status, output path, tested Git SHA, date, and reviewer for every gate. Failed or unrun is not passed.

## V0: useful bootstrap tool

| ID | Condition | Proof |
| --- | --- | --- |
| F-01 | An empty Git project can be initialized without overwriting existing files or inventing product choices. | Run `factory init` twice; second run is idempotent; a separately authored sample validates. |
| F-02 | Malformed, ambiguous, duplicate, cyclic, unresolved, and escaping contracts fail with actionable diagnostics. | Table-driven fixture tests and actual CLI exit codes. |
| F-03 | A valid project produces a bounded, source-attributed CTX pack; mandatory documents appear and source digests can be checked. | Integration test against local CTX fixture repository, capture JSON and pack. |
| F-04 | Stale index, missing required document, missing CTX, and insufficient budget stop context generation without fabricating a pack. | Fault injection with read-only fixtures. |
| F-05 | `sync --dry-run` reads a named Firstmate test home and does not change a byte in its backlog. | Backlog hash before and after; preview of create/unchanged/conflict. |
| F-06 | `sync --apply` publishes a dependency-ordered fixture through the installed tasks-axi CLI; retry creates no duplicates. | Disposable home fixture, tasks-axi `show`/`ready` proof, two identical syncs. |
| F-07 | Wrong home, unregistered project, manual/incompatible backend, and edited existing task block a write. | Separate negative integration cases and unchanged backlog hash. |
| F-08 | CLI commands work with spaces in paths, on supported host OSes, and without network during normal use. | Linux and Windows smoke runs; CI macOS if accessible; network-disabled fixture test. |
| F-09 | A worker can consume the task brief without prior agent transcript and retrieve exact original docs when needed. | Blind task handoff exercise with an isolated worker context. |

V0 exits only after F-01 through F-09 pass. A mock tasks-axi alone is insufficient for F-06. If Windows is not available, state V0 as Linux-verified and Windows-unverified; never silently claim portability.

## V1: workflow usable from a greenfield brief

| ID | Condition | Proof |
| --- | --- | --- |
| P-01 | Pi produces product truth, minimal architecture, completion contract, and task DAG from an empty repo and short brief, with genuinely unresolved decisions called out. | Archived original brief, authored docs, decision log, DAG validation. |
| P-02 | At least one end-to-end vertical slice is delivered through Firstmate, using its own task launch, worktree/session, and configured shipping mode. | Firstmate task record, worktree/PR or local merge record, executed slice test. |
| P-03 | Task evidence is linked to the exact task contract and tested Git SHA; a failed or stale result cannot be marked passed. | Mutate contract and commit in fixture; verify status becomes stale. |
| P-04 | Product completion reports independently from backlog status and remains incomplete when a project-level check fails after every task closes. | Deliberately fail one end-to-end test after closing tasks; inspect `factory status`. |
| P-05 | A real nontrivial application goes from blank repository and brief to a reviewable release candidate through at least two vertical slices. | Working local app, setup steps, executed e2e suite, task and acceptance evidence. |
| P-06 | Typical bounded tasks receive only relevant authoritative knowledge; missing source prompts targeted reads, without hiding critical project constraints. | Sample 10 packs; inspect provenance and token counts; record misses and corrections. |
| P-07 | Low-risk deterministic checks run before expensive review; review findings are repaired or recorded as blockers. | Run log and reviewer findings, final retest after repair. |
| P-08 | A stopped process or interrupted publication can be safely resumed without duplicate backlog records or false completion. | Kill/restart fault injection against disposable home. |

V1 requires P-01 through P-08 and a human inspection of the actual application. Deployment requires separate explicit authorization from the product owner and is outside this gate. The greenfield app is a test subject, not evidence that Factory works for every project.

## Operational measurements

Record, do not optimize blindly: time from brief to first usable slice; human interventions categorized as product decision, access, defect, or noise; CTX pack tokens and missing-source rate; task repair rounds; stale evidence detections; task publication conflicts; project-level checks that caught failures after task closure. Compare to a matched manual baseline only if you actually measure it. No promised percentage productivity improvement.

## Stop conditions

If tests pass but an acceptance condition contradicts observed behavior, the product is incomplete. If Firstmate and tasks-axi integration cannot pass F-06 without unsafe home writes, stop the adapter and use a reviewed manual handoff while redesigning it. If CTX repeatedly omits a required project source, make that source mandatory or fix retrieval rather than widening every pack to the entire repository.
