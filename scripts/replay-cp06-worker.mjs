#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, process.env.CP06_OUTPUT ?? ".factory/state/cp06-correction");
const workerRoot = join(outputRoot, "worker");
const fixtureRoot = join(outputRoot, "ten-pack", "repo");
const initialPackPath = join(outputRoot, "ten-pack", "raw", "auth-initial-missing.pack.md");
const contractPath = join(root, "test/fixtures/cp06-context/cases/AUTH-before.yaml");
const originalPath = join(fixtureRoot, "docs/AUTH.md");
await mkdir(workerRoot, { recursive: true });

const contract = await readFile(contractPath, "utf8");
const pack = await readFile(initialPackPath, "utf8");
const prompt = `You are a fresh task reviewer. You have no previous worker transcript. Review only the bounded handoff below. First inspect the task and pack. If a decisive authoritative source is missing, report MISSING_SOURCE and use the read tool exactly once on the supplied exact-original path; do not scan or read any other project file. Then return a concise JSON object with keys status, missing_source, reads, corrected_constraints, evidence_gaps, and broad_scan. Do not modify files.\n\nEXACT TASK CONTRACT\n---\n${contract}\n---\n\nBOUNDED PACK\n---\n${pack}\n---\n\nEXISTING DETERMINISTIC EVIDENCE\n---\nThe in-memory auth fixture currently reports absent/forged credentials as 401 and concealed cross-account GET/PUT/DELETE as 404 with unchanged state. Review whether the handoff states every decisive acceptance constraint; do not assume unshown semantics.\n---\n\nSUPPLIED EXACT-ORIGINAL PATH (read only if needed)\n${originalPath}\n`;
const promptPath = join(workerRoot, "prompt.txt");
const eventStreamPath = join(workerRoot, "event-stream.jsonl");
const outputPath = join(workerRoot, "output.txt");
const stderrPath = join(workerRoot, "stderr.txt");
await writeFile(promptPath, prompt);

const provider = process.env.CP06_PI_PROVIDER ?? "openai-codex";
const model = process.env.CP06_PI_MODEL ?? "gpt-5.6-sol";
const args = [
  "--provider",
  provider,
  "--model",
  model,
  "--thinking",
  "high",
  "--mode",
  "json",
  "--no-session",
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
  "--skill",
  "skills/factory",
  "--tools",
  "read",
  prompt,
];
const result = spawnSync("pi", args, {
  cwd: root,
  encoding: "utf8",
  env: process.env,
  timeout: 600_000,
});
await writeFile(eventStreamPath, result.stdout ?? "");
await writeFile(stderrPath, result.stderr ?? "");
if (result.error !== undefined || result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  throw new Error(`fresh Pi worker exited ${result.status}`);
}
const events = parseEventStream(result.stdout ?? "");
const responseText = finalAssistantText(events);
await writeFile(outputPath, responseText);
const response = parseResponse(responseText);
const readAudit = auditReadEvents(events, originalPath);
if (!readAudit.ok) {
  throw new Error(`fresh worker violated the event-stream read oracle: ${readAudit.reason}`);
}
const requiredConstraints = [
  /authenticated principal/i,
  /request-supplied owner fields? (?:are )?ignored/i,
  /credentials?.*401/i,
  /cross-account.*404/i,
  /(?:not mutate|no mutation|unchanged state)/i,
];
const constraintText = Array.isArray(response.corrected_constraints)
  ? response.corrected_constraints.join(" ")
  : "";
if (
  response.status !== "MISSING_SOURCE" ||
  response.broad_scan !== false ||
  !requiredConstraints.every((constraint) => constraint.test(constraintText))
) {
  throw new Error(
    `fresh worker response did not satisfy the targeted-read oracle: ${responseText}`,
  );
}

const testedSha = textCommand("git", ["rev-parse", "HEAD"]);
const manifest = {
  schema_version: 1,
  gate: "P-06-fresh-worker",
  tested_sha: testedSha,
  recorded_at: new Date().toISOString(),
  reviewer: process.env.CP06_REVIEWER ?? "Pi CP-06 correction worker",
  worker: {
    pi_version: textCommand("pi", ["--version"]),
    provider,
    model,
    no_session: true,
    no_context_files: true,
    mode: "json",
    tools: ["read"],
  },
  bounded_handoff: {
    contract_path: relative(contractPath),
    contract_sha256: await fileHash(contractPath),
    pack_path: relative(initialPackPath),
    pack_sha256: await fileHash(initialPackPath),
    evidence: "in-memory auth 401 and concealed non-mutating cross-account 404 observations",
    prompt_path: relative(promptPath),
    prompt_sha256: await fileHash(promptPath),
  },
  event_stream: {
    path: relative(eventStreamPath),
    sha256: await fileHash(eventStreamPath),
    event_count: events.length,
    read_audit: readAudit.summary,
  },
  command:
    "pi --mode json --no-session --no-context-files --no-extensions --no-skills --skill skills/factory --tools read <bounded-handoff>",
  exit_code: result.status,
  output_path: relative(outputPath),
  output_sha256: await fileHash(outputPath),
  stderr_path: relative(stderrPath),
  stderr_sha256: await fileHash(stderrPath),
  response,
  result: "pass",
  limitation:
    "Live model wording is nondeterministic; the script deterministically checks actual read tool-call events and required corrected constraints.",
};
const manifestPath = join(workerRoot, "evidence.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify({
    ok: true,
    gate: manifest.gate,
    tested_sha: testedSha,
    manifest_path: relative(manifestPath),
    manifest_sha256: await fileHash(manifestPath),
    exit_code: result.status,
    status: response.status,
    reads: readAudit.summary.project_read_paths,
    broad_scan: response.broad_scan,
  }),
);

function parseEventStream(output) {
  const events = [];
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Pi JSON event stream line ${index + 1} is not valid JSON: ${error.message}`);
    }
  }
  return events;
}

function finalAssistantText(events) {
  const agentEnd = events.findLast((event) => event.type === "agent_end");
  const messages = Array.isArray(agentEnd?.messages)
    ? agentEnd.messages
    : events
        .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
        .map((event) => event.message);
  const assistant = messages.findLast((message) => message.role === "assistant");
  if (assistant === undefined)
    throw new Error("Pi JSON event stream did not include a final assistant message");
  return messageText(assistant);
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function auditReadEvents(events, expectedOriginalPath) {
  const expectedOriginal = resolve(expectedOriginalPath);
  const allowedSkill = resolve(root, "skills/factory/SKILL.md");
  const readCalls = events
    .filter((event) => event.type === "tool_execution_start" && event.toolName === "read")
    .map((event) => ({
      path: event.args?.path,
      resolved_path: typeof event.args?.path === "string" ? resolve(root, event.args.path) : null,
    }));
  const otherToolCalls = events.filter(
    (event) => event.type === "tool_execution_start" && event.toolName !== "read",
  );
  const invalidReadCalls = readCalls.filter(
    (call) => call.resolved_path !== expectedOriginal && call.resolved_path !== allowedSkill,
  );
  const originalReadCalls = readCalls.filter((call) => call.resolved_path === expectedOriginal);
  const skillReadCalls = readCalls.filter((call) => call.resolved_path === allowedSkill);
  const summary = {
    read_count: readCalls.length,
    project_read_count: originalReadCalls.length,
    project_read_paths: originalReadCalls.map((call) => call.resolved_path),
    allowed_skill_read_count: skillReadCalls.length,
    allowed_skill_read_paths: skillReadCalls.map((call) => call.resolved_path),
    rejected_read_paths: invalidReadCalls.map((call) => call.path),
    other_tool_calls: otherToolCalls.map((event) => event.toolName),
  };
  if (otherToolCalls.length > 0) {
    return {
      ok: false,
      reason: `unexpected tool calls ${summary.other_tool_calls.join(", ")}`,
      summary,
    };
  }
  if (originalReadCalls.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one AUTH original read, saw ${originalReadCalls.length}`,
      summary,
    };
  }
  if (skillReadCalls.length > 1) {
    return {
      ok: false,
      reason: `expected at most one factory skill read, saw ${skillReadCalls.length}`,
      summary,
    };
  }
  if (invalidReadCalls.length > 0) {
    return {
      ok: false,
      reason: `unexpected read paths ${summary.rejected_read_paths.join(", ")}`,
      summary,
    };
  }
  return { ok: true, summary };
}

function parseResponse(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced === null) throw new Error(`fresh worker did not return JSON: ${output}`);
    return JSON.parse(fenced[1]);
  }
}

function textCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

async function fileHash(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
