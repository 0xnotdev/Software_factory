import { runCommand } from "./process.js";

const GIT_TIMEOUT_MS = 8_000;

export async function currentCommit(root: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const commit = result.stdout.trim();
  if (result.exit_code !== 0 || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`Cannot resolve the release-candidate Git SHA: ${result.stderr.trim()}`);
  }
  return commit;
}
