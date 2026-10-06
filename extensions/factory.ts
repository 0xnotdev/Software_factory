import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

// Pi loads this source entry from the package manifest, not dist/extensions/.
const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const usage = "usage: /factory status | validate | context <ID> [Factory CLI options]";

// Quoting is only argv framing. No expansion, interpolation, or shell evaluation.
function argumentsFor(input: string): string[] {
  if (input.includes("\0")) throw new Error("NUL is not an argument");
  const args: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];
    if (
      char === "\\" &&
      quote !== "'" &&
      next !== undefined &&
      (next === "\\" || next === '"' || next === "'" || /\s/.test(next))
    ) {
      word += next;
      started = true;
      i++;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unterminated quote");
  if (started) args.push(word);
  if (!["status", "validate", "context"].includes(args[0] ?? "")) throw new Error(usage);
  return args;
}

export default function factory(pi: ExtensionAPI): void {
  pi.registerCommand("factory", {
    description: "Factory CLI: status, validate, context <ID> (no dispatch)",
    handler: async (input, ctx) => {
      let args: string[];
      try {
        args = argumentsFor(input);
      } catch (error) {
        const stderr = `FACTORY_ARGUMENT_ERROR: ${error instanceof Error ? error.message : String(error)}\n`;
        pi.sendMessage(
          {
            customType: "factory-result",
            content: stderr + "exit: 2",
            display: true,
            details: { stdout: "", stderr, exit_code: 2, killed: false },
          },
          { triggerTurn: false },
        );
        return;
      }
      // One awaited foreground CLI. It owns validation, canonical roots, budgets,
      // integration timeouts and errors. Registration/reload starts nothing.
      const result = await pi.exec(process.execPath, [cli, ...args], { cwd: ctx.cwd });
      pi.sendMessage(
        {
          customType: "factory-result",
          display: true,
          content: `${result.stdout}${result.stderr}exit: ${result.code}${result.killed ? " (killed)" : ""}`,
          details: {
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.code,
            killed: result.killed,
          },
        },
        { triggerTurn: false },
      );
    },
  });
}
