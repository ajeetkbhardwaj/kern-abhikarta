import { createAgentSession } from "@kern/coding-agent";
import { createLogger } from "@kern/protocol";
import { createInterface } from "node:readline";

interface CliFlags {
  prompt: string;
  readOnly: boolean;
  maxTurns?: number;
  cwd: string;
  noResources: boolean;
  noCompaction: boolean;
  resume: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { prompt: "", readOnly: false, cwd: process.cwd(), noResources: false, noCompaction: false, resume: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--read-only") flags.readOnly = true;
    else if (arg === "--no-resources") flags.noResources = true;
    else if (arg === "--no-compaction") flags.noCompaction = true;
    else if (arg === "--resume") flags.resume = true;
    else if (arg === "--max-turns") {
      const next = argv[++i];
      const n = next !== undefined ? Number(next) : NaN;
      if (!Number.isInteger(n) || n <= 0) throw new Error("--max-turns requires a positive integer");
      flags.maxTurns = n;
    } else if (arg === "--cwd") {
      const next = argv[++i];
      if (!next) throw new Error("--cwd requires a directory");
      flags.cwd = next;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  flags.prompt = positional.join(" ") || "What is in README.md?";
  return flags;
}

function printHelp(): void {
  process.stdout.write(
    `kern — minimal coding agent kernel\n\nUsage:\n  kern [flags] "<prompt>"\n\nFlags:\n  --read-only       Only read/grep/find/ls-class tools (here: read only)\n  --max-turns N     Cap agent turns for this run\n  --cwd DIR         Workspace root (default: cwd)\n  --no-resources    Skip AGENTS.md / skill discovery\n  --no-compaction   Disable automatic compaction\n  --resume          Resume the most recent session\n  --help, -h        This message\n`,
  );
}

/** TTY approval prompt. Non-TTY = deny (fail closed). */
function askApproval(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`\nApproval required: ${prompt}\nAllow? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  const logger = createLogger(process.env["KERN_LOG"] === "debug" ? "debug" : "warn");
  const flags = parseArgs(process.argv.slice(2));
  const { session } = await createAgentSession({
    cwd: flags.cwd,
    logger,
    loadResources: !flags.noResources,
    enableCompaction: !flags.noCompaction,
    resume: flags.resume,
    policy: flags.readOnly ? { allowlistTools: ["read"] } : undefined,
    budgets: flags.maxTurns !== undefined ? { maxTurns: flags.maxTurns } : undefined,
    requestApproval: askApproval,
  });
  session.subscribe((ev) => {
    switch (ev.type) {
      case "text_delta":
        process.stdout.write(ev.delta);
        break;
      case "message_end":
        if (ev.message.role === "assistant") process.stdout.write("\n");
        break;
      case "tool_execution_start":
        process.stderr.write(`[tool ${ev.toolName}]\n`);
        break;
      case "tool_execution_end":
        if (ev.isError) process.stderr.write(`[tool ${ev.toolName} failed]\n`);
        break;
      case "auto_compaction_start":
        process.stderr.write(`[compacting (${ev.phase})…]\n`);
        break;
      case "auto_compaction_end":
        process.stderr.write(`[compacted]\n`);
        break;
      case "auto_retry_start":
        process.stderr.write(`[retry ${ev.attempt} (${ev.reason}) in ${ev.delayMs}ms]\n`);
        break;
      case "agent_error":
        process.stderr.write(`[error ${ev.error.code}: ${ev.error.message}]\n`);
        break;
    }
  });
  await session.prompt(flags.prompt);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
