# Factory — product truth

## One sentence

Factory turns a small, explicit software intent and independently written completion conditions into bounded task contracts that Pi can reason about, CTX can contextualize, and Firstmate can execute and ship through its existing controls.

## User and intended outcome

Initial user: one engineer building greenfield software with Pi, Firstmate, Herdr, Treehouse, tasks-axi, no-mistakes, and a separately installed CTX CLI. The engineer wants to own product choices and exceptional decisions while implementation, repair, integration, and evidence gathering proceed through existing workers. Success means starting from a blank project repository and a brief, shipping a working, verifiable application with substantially less checkpoint micromanagement than the current process.

## V0 scope

V0 is a deterministic TypeScript CLI plus instructions for Pi. It can validate project/task/completion contracts, build a bounded CTX context pack, prepare a preview of tasks for a named Firstmate home, publish them safely through tasks-axi, and summarize task status together with project-level completion evidence. A Pi agent authors the contracts and architecture; the CLI never calls a model. A distinct Pi skill and tiny command extension can follow after the CLI is proven.

The target commands are `factory doctor`, `factory init`, `factory validate`, `factory context <task-id>`, `factory sync --dry-run`, `factory sync --apply`, `factory evidence <task-id>`, and `factory status`. `factory run` is reserved for a later version unless a real user test shows it can add value without becoming another supervisor. Firstmate itself starts and supervises work.

## Core rules

1. **Independent completion:** define product acceptance before implementation tasks. Closing the backlog cannot by itself prove the product complete.
2. **One owner per concern:** Pi reasons; Factory validates and packages; CTX retrieves durable Markdown; tasks-axi owns the backlog; Firstmate dispatches; Treehouse owns worktrees; Herdr owns sessions; no-mistakes owns its review and shipping pipeline; Git and CI record code truth.
3. **Explicit authority:** only original project documents define requirements. Retrieval and generated summaries have provenance, freshness, and a bounded budget.
4. **Executable slices:** after a small foundation, plan behavior from entry point through persistence and user observation. Every slice ends with runnable proof.
5. **Human attention at genuine boundaries:** product policy, architecture changes, sensitive access, release, and other irreversible or ambiguous decisions go to the engineer with options and consequences.
6. **Fail closed on integration uncertainty:** mismatched home, stale CTX generation, unsupported tasks-axi version, a changed contract, or conflicting backlog item blocks publication; never silently substitute another path.
7. **Cheap checks first:** use schema, graph, file, type, lint, and test checks before semantic review. Repeated stable review findings should become deterministic checks where possible.
8. **Small concurrency:** let Firstmate select ready tasks; initially request at most three independent workers. This is an operating default, not a claim about a universal optimum.

## Out of scope through V1

No scheduler, custom worktree manager, agent process manager, chat bus, dashboard, vector store, custom model router, hosted service, automatic deploy, continuously running supervisor, or replacement for no-mistakes. No automatic publication to an arbitrary Firstmate home. No claim that CTX can index code or serve as a durable task database. No dependency on live internet for a normal Factory operation; installation and Firstmate shipping may separately use the network.

## Product decisions already made

| Decision | Rationale |
| --- | --- |
| One repository for Factory's instructions and CLI | Keeps V0 reviewable and dogfoodable. |
| TypeScript for CLI and possible Pi extension | Pi's supported extension surface is TypeScript; no need for a second implementation runtime. |
| YAML contracts in a project repository | Human-readable, Git-reviewable source of intent; parsed and schema-checked by CLI. |
| JSON output option for every read command | Stable machine consumption; human-readable output remains default. |
| Local generated state under `.factory/state/`, ignored by Git | Source contracts remain reviewable while transient packs and receipts do not pollute PRs. |
| Publication requires a specified, probed Firstmate home | Firstmate's code root and operational home can differ; relative tasks-axi paths may otherwise target the wrong backlog. |
| No custom orchestrator in V0 | Firstmate already owns worker lifecycle and delivery modes. |

## Decisions made per target project

The factory's user chooses product audience, first complete journey, privacy/retention, data boundaries, deployment target, acceptable external services, and release authority. Pi may draft options and recommend one but must not invent an answer to a material product decision. If the answer is missing, record a decision block and continue only work independent of it.
