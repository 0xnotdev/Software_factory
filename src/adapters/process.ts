import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

const MAX_CAPTURE_BYTES = 200_000;

export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise<CommandResult>((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let hardKillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1_000);
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
      resolveResult({
        command,
        args,
        cwd: options.cwd,
        exit_code: error.code === "ENOENT" ? 127 : 1,
        stdout,
        stderr: appendBounded(stderr, error.message),
        duration_ms: Date.now() - started,
        timed_out: timedOut,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
      resolveResult({
        command,
        args,
        cwd: options.cwd,
        exit_code: code,
        stdout,
        stderr,
        duration_ms: Date.now() - started,
        timed_out: timedOut,
      });
    });
  });
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES) return next;
  return next.slice(Math.max(0, next.length - MAX_CAPTURE_BYTES));
}

export interface ExecutableResolution {
  name: string;
  path: string | null;
  found: boolean;
  source: "override" | "path" | "process";
  error?: string;
}

export async function resolveExecutable(
  name: string,
  overridePath?: string,
): Promise<ExecutableResolution> {
  if (overridePath !== undefined) {
    const candidate = resolve(overridePath);
    const ok = await isExecutable(candidate);
    return ok
      ? { name, path: await realpath(candidate), found: true, source: "override" }
      : {
          name,
          path: candidate,
          found: false,
          source: "override",
          error: "override path is not an executable file",
        };
  }

  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = join(directory, name + extension);
      if (await isExecutable(candidate)) {
        return { name, path: await realpath(candidate), found: true, source: "path" };
      }
    }
  }

  return { name, path: null, found: false, source: "path", error: "not found on PATH" };
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function canonicalDirectory(input: string): Promise<string> {
  const resolved = resolve(input);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`${resolved} is not a directory`);
  return await realpath(resolved);
}

export async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function trimOutput(output: string, maxLength = 4000): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n[truncated ${output.length - maxLength} chars]`;
}
