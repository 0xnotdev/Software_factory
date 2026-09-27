# Bootstrap prompts for the current Pi workflow

Use these after copying the documents into a new Factory Git repository. The commands in this document are prompts for an agent; they are not Factory CLI commands. Preserve the checkpoints in `BUILD_PLAN.md` as the authority.

## Preparation

```text
Prepare this repository to build Factory. Read README.md, PROJECT.md,
ARCHITECTURE.md, COMPLETION.md, and the relevant integration/research docs.
Run my existing /CTX startup process to identify and index only the
authoritative Markdown. Verify exact retrieval and report any conflicts or
missing sources. Do not implement Factory yet.
```

## CP-00 worker prompt

```text
Implement CP-00 only from BUILD_PLAN.md. Inspect the actual versions of Pi,
CTX, Firstmate, and tasks-axi in this machine before choosing imports or
commands. Use only a disposable Firstmate home for integration probes.
Create factory doctor as a read-only TypeScript CLI, write tests that
demonstrate its failures as well as its success, run the real probes, and
record the outputs in docs/probes/CP-00.md. Do not build orchestration,
planning, context packs, telemetry, a Factory skill, or a UI. Stop at the
CP-00 gate and report precise evidence and assumptions that failed.
```

## Review prompt after each checkpoint

```text
In a fresh context, review the just-completed checkpoint against its
contract, the relevant architecture and integration docs, the Git diff,
test output, and actual CLI behavior. Do not use the worker transcript as
proof. Identify only actionable defects with an acceptance ID, failing
scenario, or concrete source contradiction. Request repair and retest for
blocking defects. Report remaining risks and the tested commit SHA.
```

## Continue after CP-00

```text
Implement CP-01 only from BUILD_PLAN.md. Read docs/CONTRACTS.md and the
CP-00 probe report. Use the commands and package names that were actually
verified in CP-00. Write invalid fixtures before implementing validation.
Run the checkpoint's CLI and test gates, correct any disproved documentation,
and stop with evidence. Do not advance to CP-02 until review is complete.
```

For CP-02/03, replace the checkpoint reference and retrieve the specific integration document. After CP-03, author CP-05 as a Factory task and use the real Firstmate workflow. Treat CP-04's skill as an actual software artifact that must be tested and versioned, rather than a prompt pasted once into Pi.
