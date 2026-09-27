import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { Diagnostic } from "../types.js";

const CONTRACT_BYTE_LIMIT = 1_000_000;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class ContractIssue extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ContractIssue";
  }

  diagnostic(): Diagnostic {
    return { code: this.code, path: this.path, message: this.message };
  }
}

export function assertRelativePath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ContractIssue(
      "PATH_ESCAPE",
      path,
      "Expected a normalized repository-relative path without traversal",
    );
  }
}

export async function resolveInside(root: string, path: string): Promise<string> {
  assertRelativePath(path);
  const candidate = resolve(root, ...path.split("/"));
  if (!inside(root, candidate)) {
    throw new ContractIssue("PATH_ESCAPE", path, "Path escapes the repository root");
  }
  try {
    let current = root;
    for (const part of path.split("/")) {
      const entries = await readdir(current);
      if (!entries.includes(part)) {
        throw new ContractIssue(
          "FILE_MISSING",
          path,
          `Missing or case-mismatched path component: ${part}`,
        );
      }
      current = join(current, part);
      const canonical = await realpath(current);
      if (!inside(root, canonical)) {
        throw new ContractIssue("PATH_ESCAPE", path, "Path resolves outside the repository root");
      }
    }
    return await realpath(candidate);
  } catch (error) {
    if (error instanceof ContractIssue) throw error;
    throw new ContractIssue("FILE_MISSING", path, `Cannot resolve path: ${errorMessage(error)}`);
  }
}

export async function readTextFile(root: string, path: string, maxBytes: number): Promise<string> {
  const absolute = await resolveInside(root, path);
  const info = await stat(absolute);
  if (!info.isFile()) {
    throw new ContractIssue("FILE_NOT_REGULAR", path, "Expected a regular file");
  }
  if (info.size > maxBytes) {
    throw new ContractIssue(
      maxBytes === CONTRACT_BYTE_LIMIT ? "CONTRACT_TOO_LARGE" : "SOURCE_TOO_LARGE",
      path,
      `Source has ${info.size} bytes, above the ${maxBytes} byte limit; use a targeted exact read or split the source`,
    );
  }
  try {
    return decoder.decode(await readFile(absolute));
  } catch (error) {
    throw new ContractIssue("UTF8_INVALID", path, `Cannot decode UTF-8: ${errorMessage(error)}`);
  }
}

export async function readYamlContract(
  root: string,
  path: string,
  captured?: Map<string, string>,
): Promise<unknown> {
  const text = await readTextFile(root, path, CONTRACT_BYTE_LIMIT);
  captured?.set(path, text);
  return parseYamlContract(text, path);
}

export function parseYamlContract(text: string, path: string): unknown {
  const parsed = parseDocument(text.replace(/^\uFEFF/, ""), {
    uniqueKeys: true,
    strict: true,
    version: "1.2",
  });
  if (parsed.errors.length > 0) {
    throw new ContractIssue("YAML_INVALID", path, parsed.errors[0]?.message ?? "Invalid YAML");
  }
  try {
    return parsed.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new ContractIssue("YAML_INVALID", path, errorMessage(error));
  }
}

export async function taskPaths(root: string): Promise<string[]> {
  const path = ".factory/tasks";
  const absolute = await resolveInside(root, path);
  const info = await stat(absolute);
  if (!info.isDirectory()) {
    throw new ContractIssue("FILE_NOT_REGULAR", path, "Expected a task directory");
  }
  const entries = await readdir(absolute);
  return entries
    .filter((entry) => entry.endsWith(".yaml"))
    .sort()
    .map((entry) => `${path}/${entry}`);
}

export function asDiagnostic(error: unknown): Diagnostic {
  if (error instanceof ContractIssue) return error.diagnostic();
  return { code: "INTERNAL_ERROR", path: ".factory", message: errorMessage(error) };
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
