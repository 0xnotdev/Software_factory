import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContractIssue } from "./load.js";

const IGNORE_RULE = "/.factory/state/";

export interface InitResult {
  schema_version: 1;
  ok: true;
  command: "init";
  root: string;
  created: string[];
}

export async function initProject(root: string): Promise<InitResult> {
  const created: string[] = [];
  await ensureDirectory(root, ".factory", created);
  await ensureDirectory(root, ".factory/tasks", created);
  await ensureDirectory(root, ".factory/state", created);

  const ignore = join(root, ".gitignore");
  let prior = "";
  try {
    const info = await lstat(ignore);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ContractIssue(
        "PATH_ESCAPE",
        ".gitignore",
        "Expected a regular, non-symlink .gitignore",
      );
    }
    prior = await readFile(ignore, "utf8");
  } catch (error) {
    if (error instanceof ContractIssue) throw error;
    if (!isMissing(error)) throw error;
  }
  if (!prior.split(/\r?\n/).includes(IGNORE_RULE)) {
    const separator = prior.length > 0 && !prior.endsWith("\n") ? "\n" : "";
    await writeFile(ignore, `${prior}${separator}${IGNORE_RULE}\n`, "utf8");
    created.push(IGNORE_RULE);
  }
  return { schema_version: 1, ok: true, command: "init", root, created };
}

async function ensureDirectory(root: string, path: string, created: string[]): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  try {
    await mkdir(absolute);
    created.push(path);
  } catch (error) {
    if (!isExists(error)) throw error;
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(absolute)) !== absolute) {
      throw new ContractIssue(
        "PATH_ESCAPE",
        path,
        "Expected an ordinary directory within the repository",
      );
    }
  }
}

function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
