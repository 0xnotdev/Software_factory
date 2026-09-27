# Factory: build package

**Status:** implementation specification, 26 September 2026. No Factory software is claimed to exist yet.

Factory is a thin layer for turning a software product brief into independently verifiable work for an existing Pi + Firstmate setup. Its purpose is to minimize the intelligence, context, and human attention required to transform intent into verified software.

## Read in this order

1. [PROJECT.md](PROJECT.md) — purpose, scope, operating principles.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — components, interfaces, persistent state, failure behavior.
3. [COMPLETION.md](COMPLETION.md) — observable V0 and V1 exit criteria.
4. [BUILD_PLAN.md](BUILD_PLAN.md) — build checkpoints and proof gates.
5. [AGENTS.md](AGENTS.md) — instruction to the implementing agent.

Read [docs/CONTRACTS.md](docs/CONTRACTS.md) when implementing validation, [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) when touching CTX/Pi/Firstmate, [docs/WORKFLOW.md](docs/WORKFLOW.md) when designing the Factory skill, and [docs/RESEARCH.md](docs/RESEARCH.md) for sources and decisions. [docs/BOOTSTRAP_PROMPTS.md](docs/BOOTSTRAP_PROMPTS.md) contains copyable Pi instructions for the initial checkpoints.

## Repository bootstrap

Create an empty Git repository for Factory and copy this directory's contents to its root. Do not copy an archived CTX repository or a Firstmate home into it. Review the files, resolve only genuine product decisions, then use your existing `/CTX startup` workflow to index the authoritative Markdown. Begin CP-00 from [BUILD_PLAN.md](BUILD_PLAN.md). The current workspace contains documents only; commands described here are target behavior, not commands that already run.

The baseline interaction is your current research → project truth → checkpoint → worker → independent review process. Once validation and task publication work, use Factory's own backlog to build later checkpoints. Do not assert that dogfooding happened until a real Firstmate worker receives, executes, and closes a Factory task.

## Document authority

| Question | Owner |
| --- | --- |
| Why and what | `PROJECT.md` |
| Component and state decisions | `ARCHITECTURE.md` |
| Completed behavior | `COMPLETION.md` |
| Build sequence | `BUILD_PLAN.md` |
| Contract fields and validation | `docs/CONTRACTS.md` |
| External API boundary | `docs/INTEGRATIONS.md` |
| Agent methodology | `docs/WORKFLOW.md` |

If two documents conflict, stop, reconcile the appropriate owner, and record the change in Git before continuing. A CTX excerpt is a pointer to the original Markdown, never a replacement for the original source. External docs listed in `docs/RESEARCH.md` inform design but do not override these decisions.
