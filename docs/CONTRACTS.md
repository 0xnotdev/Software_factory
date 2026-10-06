# Factory contracts, version 1

The CLI reads UTF-8 YAML under `.factory/`. These examples define the public V0 shape; JSON schemas implement the exact keys and reject unknown properties except explicit `metadata`. `schema_version: 1` is required in every file. The complete project is Git-tracked. Generated receipts are not authoritative contracts.

## Project: `.factory/project.yaml`

```yaml
schema_version: 1
id: read-later
name: Read Later
intent: Save articles and find them again from a browser.
audience: Individual readers on desktop.
goals:
  - Save a URL and view it later.
  - Search saved titles and tags.
non_goals:
  - Mobile native application.
  - Shared libraries.
constraints:
  - A user can access only their own items.
  - Credentials never enter a context pack.
documents:
  required:
    - PROJECT.md
    - ARCHITECTURE.md
    - docs/decisions/auth.md
completion: .factory/completion.yaml
```

IDs match `[a-z][a-z0-9-]{1,63}`. `documents.required` are repository-relative `.md` files, case checked and escape checked. The project contract references, but never embeds, the completion contract. Required docs must exist before a context pack can pass. A blank repo gets `PROJECT.md` and `ARCHITECTURE.md` starter headings from the agent's greenfield preparation; `factory init` does not invent product decisions.

## Completion: `.factory/completion.yaml`

```yaml
schema_version: 1
project: read-later
conditions:
  - id: C-001
    outcome: An authenticated user can save a URL and see it after restart.
    method: executable
    check_id: e2e-save-persist
    evidence: e2e/artifacts/save-persist.json
  - id: C-002
    outcome: Another account cannot read the saved item.
    method: executable
    check_id: e2e-tenant-isolation
    evidence: e2e/artifacts/tenant-isolation.json
  - id: C-003
    outcome: A user can understand and accept the first-run experience.
    method: observation
    protocol: Start from clean profile; record whether a first-time user can save and reopen an item unaided.
    evidence: reviews/first-run.md
```

Each condition has a stable unique ID, one outcome, one method, and an expected artifact. `check_id` refers to a reviewed runner entry; it is not a shell command supplied by untrusted YAML. Observation requires a named human disposition and dated artifact. Initially all conditions are `unverified`; the contracts never store pass/fail state.

## Task: `.factory/tasks/SAVE-001.yaml`

```yaml
schema_version: 1
id: SAVE-001
title: Save a URL end to end
outcome: An authenticated reader can submit a URL and reopen it after restart.
depends_on: [AUTH-001, DATA-001]
complexity: normal
risk: normal
acceptance:
  - id: A-001
    statement: A valid URL appears in the saved-items list.
  - id: A-002
    statement: The item remains after service restart.
  - id: A-003
    statement: Another account cannot read the item.
advances: [C-001, C-002]
context:
  topics: [saved items, tenancy, persistence]
  required: [PROJECT.md, ARCHITECTURE.md, docs/decisions/auth.md]
evidence:
  required: [unit, integration, e2e]
delivery: project-default
```

`depends_on` names local task IDs, is acyclic, and cannot name self. `advances` names completion IDs and may be empty only for a task explicitly marked `kind: enabling`; enabling tasks still have testable outcomes. `complexity` is `bounded | normal | critical`; `risk` is `bounded | normal | critical` and controls review policy, not a specific model name. `context.required` is the reviewed task-local authority selection: Factory reads every listed original exactly and passes the same paths as CTX document filters. An empty list explicitly means that no task-specific original is needed; Factory still filters CTX to the project's mandatory `documents.required` authority and never treats the empty selection as unrestricted corpus access. Include each known source that can decide an acceptance or risk condition; do not add broad directories or unrelated documents as insurance. The omitted-source correction procedure is owned by [WORKFLOW.md](WORKFLOW.md#task-local-worker-brief). `delivery` defaults to `project-default` and cannot override the actual Firstmate project mode; if the project mode conflicts with a task request, validation blocks publication. All required evidence categories are verified by evidence receipts rather than assumed from task closure.

## Task receipt: `.factory/state/evidence/SAVE-001.json`

```json
{
  "schema_version": 1,
  "task_id": "SAVE-001",
  "contract_sha256": "<64 hexadecimal characters>",
  "commit": "<full Git SHA>",
  "checks": [
    {
      "id": "integration",
      "status": "pass",
      "command_id": "test-integration",
      "exit_code": 0,
      "artifact": "evidence/save-integration.txt",
      "artifact_sha256": "<64 hexadecimal characters>"
    }
  ],
  "review": { "status": "pending", "artifact": null },
  "recorded_at": "2026-09-26T00:00:00Z"
}
```

The receipt is machine-generated from observed commands and files, not generated from an agent's declaration. It is valid only for its task contract and tested release-candidate commit. The placeholders above document types, not literal values to copy into evidence.

## Completion receipt: `.factory/state/completion/C-001.json`

```json
{
  "schema_version": 1,
  "condition_id": "C-001",
  "completion_sha256": "<64 hexadecimal characters>",
  "commit": "<full Git SHA>",
  "result": {
    "kind": "executable",
    "status": "pass",
    "check_id": "e2e-save-persist",
    "command_id": "test-e2e-save-persist",
    "exit_code": 0,
    "artifact": "e2e/artifacts/save-persist.json",
    "artifact_sha256": "<64 hexadecimal characters>"
  },
  "recorded_at": "2026-09-26T00:00:00Z"
}
```

Executable completion receipts bind one completion condition to the exact `.factory/completion.yaml` digest, release-candidate commit, expected `check_id`, source-of-truth artifact path, artifact digest, and observed exit code. Observation completion receipts use `result.kind: "observation"` with a named `reviewer`, `status`, `artifact`, and `artifact_sha256`. A receipt is stale when its commit is not the current release-candidate SHA or its recorded completion digest is not present in that Git tree.

## Validation invariants

- Every referenced file exists inside the canonical Git worktree and every task/completion ID is unique.
- Every non-enabling task advances at least one condition; every condition has a covering task before sync. Coverage does not itself prove completion.
- No cycles, missing dependencies, or duplicate published IDs; tasks are emitted in stable dependency order.
- A human decision awaiting resolution is represented in a separate decision record and does not masquerade as a task that can be dispatched.
- A required document larger than the context budget is reported as `SOURCE_TOO_LARGE` with a path and suggested targeted exact-read procedure; no silent truncation.
- Semantic quality (good architecture, correct decomposition, meaningful oracle) is reviewed by Pi/human, never inferred from passing JSON schema.
