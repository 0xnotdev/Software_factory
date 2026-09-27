# Research and source decisions

**Reviewed:** 26 September 2026. Sources below are primary upstream documentation or original research. They justify architecture; they do not prove the operator's installed versions. Recheck APIs during CP-00. The CTX observations come from the user's saved `CTX-context tool (3).zip` source snapshot in their Library, particularly its `README.md` and `src/ctx/cli.py`.

| Source | Observation used | Design consequence |
| --- | --- | --- |
| [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) | Packages bundle extensions, skills, prompts; current documentation names `@earendil-works/pi-*` peers. | One eventual Pi package; probe installed namespace before compiling extension. |
| [Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) | Name/description discovered early; body read on demand; `/skill:name` available. | Keep operational skill short, link references; CP-04 not CP-00. |
| [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) | `pi.registerCommand()` supports slash commands. | Optional thin command wrapper after CLI proof. |
| [Firstmate README](https://github.com/kunchenguid/firstmate) | Repository based agent distro with project modes, own worktrees and sessions. | Factory publishes work but does not spawn or supervise agents. |
| [Firstmate configuration](https://github.com/kunchenguid/firstmate/blob/main/docs/configuration.md) | Effective home may differ from code root; `.tasks.toml` resolves from tasks-axi working directory; manual and alternate backends exist; dispatch profiles are Firstmate owned. | Explicit home probe and fail-closed publication; no independent model router. |
| [tasks-axi README](https://github.com/kunchenguid/tasks-axi) | Caller supplied IDs, `show --full`, `ready`, `block`, `add`, `update` are documented. | Stable join key, dependency publication, inspect-before-update. Probe exact CLI flags locally. |
| [no-mistakes introduction](https://github.com/kunchenguid/no-mistakes/blob/main/docs/src/content/docs/start-here/introduction.md) | Existing structured review, test evidence, docs, lint, push, PR and CI pipeline with approvals. | Link evidence; do not recreate shipping. |
| [OpenAI harness engineering](https://openai.com/index/harness-engineering/) | Agent success depends on environment, scaffolding and tight feedback loops. | Invest in contracts and sensors before high concurrency. |
| [Thoughtworks harness engineering](https://martinfowler.com/articles/harness-engineering.html) | Computational controls are fast and deterministic; inferential controls add semantic judgment. | Validate graph/schema/tests before paying for a fresh semantic review. |
| [SWE-Gate](https://arxiv.org/abs/2609.04167) | Original benchmark reports many functional-test-passing repairs violating additional review constraints. | Acceptance includes nonfunctional and review constraints, not just green tests. |
| [SWE-Review](https://arxiv.org/abs/2607.06065) | Original study evaluates a generate → review → revise loop. | Findings feed bounded repair and retest; review is not a terminal opinion. |
| [DeepSWE](https://arxiv.org/abs/2607.07946) | Original benchmark discusses verifier limitations when tests encode only one known implementation. | Independent product oracle and executable behavior proof matter; tests require sound design. |
| [GitHub status checks](https://docs.github.com/en/pull-requests/reference/status-checks) | Required checks can gate merges on protected branches. | Project release report includes fresh CI status on the candidate SHA. |

## Verified from the archived CTX source

- CLI first: Pi's bash tool calls `ctx pack`; no Pi built-in MCP client should be assumed from that snapshot.
- Source exactness: CTX returns source ranges/provenance; the original Markdown remains authoritative.
- Offline normal operation: the embedding download is explicit; `ctx doctor --offline --json` and `ctx index --no-embeddings` are described.
- Search/index can fall back to structural and lexical retrieval, with mode visible in metadata.
- CTX supports `status`, `pack`, `lines`, `sync`, `checkpoint` commands; CP-00 must inspect actual locally installed behavior.

## Assumptions to disprove first

1. **Pi package namespace:** the operator's Pi may lag or differ from current docs. Install nothing globally just to satisfy a speculative import.
2. **Firstmate home binding:** the code checkout might not be the operational home; wrong cwd is an actual write hazard.
3. **tasks-axi compatibility:** another backend or a manual home may not accept the publication behavior assumed for the default markdown backend.
4. **CTX freshness:** the saved archive may be behind the global install. Probe with a disposable corpus, then adjust this spec if needed.
5. **Oracle validity:** independent authorship reduces correlated omissions but does not make every completion check complete or correct. Review the frozen oracle against real user flows.
6. **Concurrency benefit:** three ready tasks can still conflict on shared schemas or migrations. Schedule around actual ownership and integration evidence.

## Research limits

This research grounds the first buildable wedge and integration choices; it is not a proof that an unattended greenfield factory is feasible in the operator's exact environment. Public GitHub `main` can change, a user's archived CTX source is not their installed version, and published software-engineering studies do not establish a productivity multiplier for this Factory. CP-00 and the greenfield product trial are the falsification points.
