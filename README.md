# Factory: build package

**Status:** CP-08 release candidate. The CLI, optional Pi commands, and greenfield read-later acceptance have executed the independent V0/V1 gates with the platform limits recorded in [the CP-08 evidence ledger](docs/probes/CP-08.md). Final no-mistakes PR/CI delivery remains separate; checkpoint state is owned by [BUILD_PLAN.md](BUILD_PLAN.md).

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

## Optional Pi commands

Use Node 24 for development/proofs (`npm ci && npm run build`). The source package registers the Factory skill and `extensions/factory.ts`; Pi supplies its own host SDK. The pinned development SDK is for typechecking/offline tests, not a bundled production host.

Try the reviewed local package without changing settings:

```sh
pi --offline -e /absolute/path/to/Factory
```

Or install it deliberately with `pi install /absolute/path/to/Factory --local` in the target project, review/grant project trust, and run `/reload` in an existing Pi session. Local packages are not built by Pi: build Factory first and rebuild after CLI changes. Paths with spaces must be quoted at the shell and in command arguments.

```text
/factory status
/factory status --home "/named/disposable home" --json
/factory validate --root "/path with spaces/project" --json
/factory context TASK-ID --token-budget 8000 --json
```

These are foreground wrappers, not model calls. They run only when Pi itself runs on a Node.js interpreter (npm-installed Pi); a Bun-compiled or bundled single-executable Pi binary returns `FACTORY_RUNTIME_UNAVAILABLE` (exit 3) without starting any process, so use the CLI directly there. All CLI options after the selected command are passed through unchanged, including the CLI's diagnostics for missing/extra/unknown arguments. No home is inferred. Quoting only frames argument arrays; it does not evaluate shell substitutions. Use single quotes for literal Windows/UNC paths. There is no `/factory run`, publication, worker launch, or shipping control.

The displayed result includes unmodified stdout/stderr and `exit: N` (with `(signal NAME)` when the CLI was terminated by a signal). The `factory-result` message's `details` keeps separate `stdout`, `stderr`, `exit_code`, `signal`, and `killed` fields; a signal-terminated CLI reports `exit_code` 128 + signal number, never 0. Pi commands return `void`: the persistent Pi process/RPC prompt acknowledgement is **not** the CLI exit status. Consumers must inspect `details.exit_code`; the extension never exits Pi or triggers a model turn. JSON/print consumers should use the CLI directly when they require the CLI's OS exit code/one-object stdout rather than Pi's message envelope.

Current-version discovery, actual `/reload`, parity and residual platform limits are documented in [docs/probes/CP-07.md](docs/probes/CP-07.md). CLI access remains available without the optional extension.

CP-06's development proof commands, exact SDK requirements, evidence interpretation, and platform limits are owned by [docs/probes/CP-06.md](docs/probes/CP-06.md). A DUMMY proof or closed backlog is not product completion.

## Document authority

| Question                       | Owner                  |
| ------------------------------ | ---------------------- |
| Why and what                   | `PROJECT.md`           |
| Component and state decisions  | `ARCHITECTURE.md`      |
| Completed behavior             | `COMPLETION.md`        |
| Build sequence                 | `BUILD_PLAN.md`        |
| Contract fields and validation | `docs/CONTRACTS.md`    |
| External API boundary          | `docs/INTEGRATIONS.md` |
| Agent methodology              | `docs/WORKFLOW.md`     |

If two documents conflict, stop, reconcile the appropriate owner, and record the change in Git before continuing. A CTX excerpt is a pointer to the original Markdown, never a replacement for the original source. External docs listed in `docs/RESEARCH.md` inform design but do not override these decisions.
