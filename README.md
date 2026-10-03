# Factory: build package

**Status:** development CLI with CP-06 corrections in progress. Product completion requires the independent gates in [COMPLETION.md](COMPLETION.md); checkpoint state is owned by [BUILD_PLAN.md](BUILD_PLAN.md).

Factory is a thin layer for turning a software product brief into independently verifiable work for an existing Pi + Firstmate setup. Its purpose is to minimize the intelligence, context, and human attention required to transform intent into verified software.

## Read in this order

1. [PROJECT.md](PROJECT.md) — purpose, scope, operating principles.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — components, interfaces, persistent state, failure behavior.
3. [COMPLETION.md](COMPLETION.md) — observable V0 and V1 exit criteria.
4. [BUILD_PLAN.md](BUILD_PLAN.md) — build checkpoints and proof gates.
5. [AGENTS.md](AGENTS.md) — instruction to the implementing agent.

Read [docs/CONTRACTS.md](docs/CONTRACTS.md) when implementing validation, [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) when touching CTX/Pi/Firstmate, [docs/WORKFLOW.md](docs/WORKFLOW.md) when designing the Factory skill, and [docs/RESEARCH.md](docs/RESEARCH.md) for sources and decisions. [docs/BOOTSTRAP_PROMPTS.md](docs/BOOTSTRAP_PROMPTS.md) contains copyable Pi instructions for the initial checkpoints.

## Common usage

From this source checkout:

```sh
npm ci
npm run build
node dist/src/cli.js --help
node dist/src/cli.js validate --root <project-root> --json
node dist/src/cli.js context <TASK-ID> --root <project-root> --json
```

Prepare reviewed contracts and a deliberate offline CTX authority set first; see [docs/CONTRACTS.md](docs/CONTRACTS.md) and the [Factory skill](skills/factory/SKILL.md) for the workflow and named-home publication safeguards. Do not copy an archived CTX repository or a Firstmate home into a target project. Factory does not dispatch workers or choose delivery policy.

CP-06's development proof commands, exact SDK requirements, evidence interpretation, and platform limits are owned by [docs/probes/CP-06.md](docs/probes/CP-06.md). A DUMMY proof or closed backlog is not product completion.

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
