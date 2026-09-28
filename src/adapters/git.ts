import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { runCommand } from "./process.js";

const GIT_TIMEOUT_MS = 8_000;
const execFileAsync = promisify(execFile);

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

export async function gitFileSha256AtCommit(
  root: string,
  commit: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["cat-file", "-p", `${commit}:${path}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 1_100_000,
      timeout: GIT_TIMEOUT_MS,
    });
    return createHash("sha256").update(stdout).digest("hex");
  } catch {
    return null;
  }
}
