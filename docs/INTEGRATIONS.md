# External integrations and CP-00 probes

This is an integration contract, not a promise that a particular version is installed on the operator's machine. Capture tool versions, executable locations, and a redacted probe transcript in a CP-00 report. Avoid replacing a verified boundary with an assumed API.

## CTX

The user's archived CTX README describes a Python 3.12+ local CLI, source-provenance excerpts, SQLite/FTS, optional locally verified embeddings, and explicit lexical fallback. Relevant commands include `ctx --version`, `ctx status --json`, `ctx doctor --offline --json`, `ctx pack "..." --token-budget 7000 --json`, `ctx lines ... --json`, and `ctx sync`. Pi uses its bash tool to call CTX; the archived README explicitly says not to assume Pi has a built-in MCP client. The archive is a historical snapshot, not proof of the currently installed `ctx` binary.

CP-00 probes: detect `ctx`; create a disposable Git fixture with two normative Markdown docs; initialize and add docs according to local `ctx --help`; index with `--no-embeddings` so the test does not download anything; run status, offline doctor, pack, and exact lines; record actual JSON fields and failure codes. Confirm stale-source detection by changing a source after indexing. A user's globally installed model may then be tested separately. Do not index the Factory repo until its initial documents are approved.

Context policy: required files are read exactly. The installed `ctx pack` accepts repeated `--document` filters; Factory supplies the task's reviewed `context.required` paths so retrieval ranks only within task-local authority while exact originals remain in the pack. Changed docs invalidate a pack; unavailable local embedding may allow the explicitly reported lexical mode if it retrieves sufficient authority. Query text is data, never shell code. `ctx pack` is one context source, not a substitute for Git, `rg`, or project checks, and Factory does not post-filter CTX output to falsify provenance.

## Pi

Current Pi package docs support a directory with `package.json`, `extensions/`, `skills/`, and `prompts/`. Skills are discovered by name and description, then read on demand. Extensions can register slash commands with `pi.registerCommand`. The documented host package namespace currently resolves to `@earendil-works/pi-coding-agent`; older posts may use `@mariozechner/pi-coding-agent`, so CP-00 must inspect the installed Pi package before selecting imports. Use the conventional package layout first, and only write an explicit manifest when filtering is required.

CP-00 probe: load a tiny temporary package using the installed Pi, confirm `/skill:<name>` invocation and one ephemeral command if relevant, and record the exact version and trust prompt. Do not ship a Factory skill referring to commands that have not been implemented. CP-04 publishes the actual skill after CLI workflows pass. The extension is convenience only; it must not contain an independent planner or process supervisor.

## Firstmate home and tasks-axi

Firstmate describes itself as a repository of instructions, skills, helpers, and operational state, not a generic CLI. Its effective `FM_HOME` may be separate from the tracked code root. The current configuration docs say tasks-axi's `.tasks.toml` paths resolve against the directory where tasks-axi runs; running from the wrong directory can write the wrong backlog. The default markdown home uses `data/backlog.md`; another tasks-axi backend or manual mode may be configured. Firstmate supports named project shipping modes including `no-mistakes`, `direct-PR`, and `local-only`, and owns worktree/session lifecycle. Its dispatch profiles choose actual model/harness/effort.

CP-00 probes: identify the effective home without guessing from environment; confirm the target project is registered in that home and its delivery mode; read `.tasks.toml` and `config/backlog-backend`; inspect installed `tasks-axi --help`, `show`, `ready`, `add`, `block`, `update` and version; use an isolated disposable home to create two dependent tasks, inspect them, and confirm the exact output format. If an official Firstmate helper should mediate backlog writes in the installed revision, follow that helper. Never write directly to a live Firstmate backlog to discover behavior. Any supported non-markdown backend needs its own integration test before publication is enabled.

During a real sync, Factory creates backlog items via the verified tasks-axi path only; Firstmate then dispatches according to its rules. Do not call `fm-spawn` or manipulate Herdr/Treehouse from Factory. The published task ID maps back to the tracked contract and includes its digest. Use `show --full` to detect edits before updating or reconciling; V0 is create-only for existing item safety.

## no-mistakes, Git, CI

no-mistakes documents a review → test → document → lint → push → PR → CI gate with explicit operator approval points. It is not Factory's evidence database and does not make a project oracle redundant. Factory's task evidence may point to its validated artifacts, and project-level checks must run against the final candidate SHA. Respect the project's registered Firstmate delivery mode. An engineer may choose `local-only` for a throwaway fixture and a PR-based mode for a real application; Factory cannot silently select a lower assurance mode.

## Probe matrix

| Probe                                             | Failure response                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| CTX actual version/JSON/CLI flags                 | Block context pack and show install-specific diagnostic.               |
| Pi installed import namespace and skill discovery | Keep CLI usable; defer extension/skill packaging.                      |
| Firstmate home identity and registered project    | Block sync.                                                            |
| tasks-axi version, backend, dependency commands   | Block sync; provide dry-run export for manual inspection only.         |
| no-mistakes gate in intended project mode         | Block automated shipping claims; continue local deterministic checks.  |
| Windows/macOS path behavior                       | Report platform limitation honestly; do not claim cross-platform gate. |

## Primary documents

See `docs/RESEARCH.md` for current upstream documentation URLs and the local CTX source snapshot used to prepare this specification. Recheck upstream at implementation time because interfaces can change.
