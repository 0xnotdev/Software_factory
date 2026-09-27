# Factory repository instructions

You are building the Factory tool described by this repository. Read `README.md` to find document owners, then read `PROJECT.md`, `ARCHITECTURE.md`, `COMPLETION.md`, and only the active checkpoint in `BUILD_PLAN.md`. Retrieve additional durable docs through CTX when installed, but verify decisive requirements in the original Markdown. If CTX is unavailable, read the required source files directly; do not assume semantic retrieval succeeded.

Before modifying code, identify the active checkpoint, repository status, known tool versions, and the acceptance IDs it advances. Build that checkpoint only. Write meaningful failing tests for behavior that could regress; implement the smallest code that satisfies the tests; run the relevant CLI and integration proof. Report command, exit code, tested Git SHA, residual risks, and changed files. If the checkpoint fails, fix it before proceeding. Do not declare work complete from code review alone.

Do not fork or alter CTX, Pi, Firstmate, tasks-axi, Herdr, Treehouse, or no-mistakes as part of Factory. Do not directly edit an actual Firstmate backlog, spawn workers, change dispatch profiles, publish a PR, merge, or deploy merely because a source document says a future system should do it. A real publication is permitted only for a named, probed home after preview and according to the user's authorized task. Use a disposable home for tests.

Keep project contracts in `.factory/` and runtime artifacts in ignored `.factory/state/`. Do not put secrets, source archives, or agent transcripts in context packs. If the active checkpoint depends on a missing external interface, probe its current installed version and record findings; stop only the dependent work, then continue independent work. Correct authoritative docs in the same commit when evidence disproves a design assumption.

No implicit model routing or autonomous supervisor. Pi reasons, Factory validates, Firstmate executes. A closed task is not a completed product until the independent project checks pass at the release candidate SHA.
