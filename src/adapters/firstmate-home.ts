import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalDirectory, isPathInside, sha256File } from "./process.js";

export interface FirstmateHomeCheck {
  ok: true;
  path: string;
  tasks_toml: string;
  backend: string;
  config_backend: string | null;
  config_backlog_backend: string | null;
  markdown: {
    path: string;
    archive: string | null;
    backlog_path: string;
    backlog_sha256: string;
  };
}

export class FirstmateHomeError extends Error {
  readonly code = "FIRSTMATE_HOME_INVALID";
  readonly exitCode = 3;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "FirstmateHomeError";
    this.details = details;
  }
}

interface TasksTomlShape {
  backend: string | null;
  markdownPath: string | null;
  markdownArchive: string | null;
  unsupportedStringEscapes: string[];
}

export async function inspectFirstmateHome(homeInput: string): Promise<FirstmateHomeCheck> {
  let home: string;
  try {
    home = await canonicalDirectory(homeInput);
  } catch (error) {
    throw new FirstmateHomeError("Firstmate home must be an existing directory", {
      home: resolve(homeInput),
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const tasksToml = resolve(home, ".tasks.toml");
  const tasksTomlText = await readRequiredFile(tasksToml, "missing .tasks.toml in Firstmate home", {
    home,
  });
  const parsed = parseTasksToml(tasksTomlText);
  if (parsed.unsupportedStringEscapes.length > 0) {
    throw new FirstmateHomeError("Unsupported .tasks.toml string escape syntax", {
      home,
      keys: parsed.unsupportedStringEscapes,
    });
  }
  if (parsed.backend !== "markdown") {
    throw new FirstmateHomeError("Only the markdown tasks-axi backend is supported in CP-00", {
      home,
      backend: parsed.backend,
    });
  }
  if (parsed.markdownPath === null || parsed.markdownPath.trim() === "") {
    throw new FirstmateHomeError("Markdown tasks-axi backend is missing markdown.path", { home });
  }

  const configuredBacklogPath = resolve(home, parsed.markdownPath);
  if (!isPathInside(home, configuredBacklogPath)) {
    throw new FirstmateHomeError("Configured backlog path escapes the Firstmate home", {
      home,
      backlog_path: configuredBacklogPath,
    });
  }
  const backlogInfo = await statRegular(
    configuredBacklogPath,
    "configured backlog file does not exist",
    {
      home,
      backlog_path: configuredBacklogPath,
    },
  );
  if (!backlogInfo) {
    throw new FirstmateHomeError("Configured backlog file is not a regular file", {
      home,
      backlog_path: configuredBacklogPath,
    });
  }
  const backlogPath = await realpath(configuredBacklogPath);
  if (!isPathInside(home, backlogPath)) {
    throw new FirstmateHomeError(
      "Configured backlog path escapes the Firstmate home after symlink resolution",
      {
        home,
        configured_backlog_path: configuredBacklogPath,
        backlog_path: backlogPath,
      },
    );
  }

  return {
    ok: true,
    path: home,
    tasks_toml: tasksToml,
    backend: parsed.backend,
    config_backend: await readOptionalTrimmed(resolve(home, "config/backend")),
    config_backlog_backend: await readOptionalTrimmed(resolve(home, "config/backlog-backend")),
    markdown: {
      path: parsed.markdownPath,
      archive: parsed.markdownArchive,
      backlog_path: backlogPath,
      backlog_sha256: await sha256File(backlogPath),
    },
  };
}

async function readRequiredFile(
  path: string,
  message: string,
  details: Record<string, unknown>,
): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new FirstmateHomeError(message, { ...details, path, reason: "not a regular file" });
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof FirstmateHomeError) throw error;
    throw new FirstmateHomeError(message, {
      ...details,
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function statRegular(
  path: string,
  message: string,
  details: Record<string, unknown>,
): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch (error) {
    throw new FirstmateHomeError(message, {
      ...details,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readOptionalTrimmed(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    return text.trim();
  } catch {
    return null;
  }
}

export function parseTasksToml(text: string): TasksTomlShape {
  let section = "";
  const shape: TasksTomlShape = {
    backend: null,
    markdownPath: null,
    markdownArchive: null,
    unsupportedStringEscapes: [],
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (line.length === 0) continue;
    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]?.trim() ?? "";
      continue;
    }
    const keyValue = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1];
    const value = keyValue[2] ?? "";
    if (value.includes("\\")) {
      shape.unsupportedStringEscapes.push(section === "" ? (key ?? "") : `${section}.${key ?? ""}`);
      continue;
    }
    if (section === "" && key === "backend") shape.backend = value;
    if (section === "markdown" && key === "path") shape.markdownPath = value;
    if (section === "markdown" && key === "archive") shape.markdownArchive = value;
  }

  return shape;
}
