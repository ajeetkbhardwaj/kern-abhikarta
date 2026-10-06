import { createAgentSession } from "@kern/coding-agent";
import { createLogger } from "@kern/protocol";
import { discoverModels, loadModelsFile, createAdapterFor } from "@kern/model";
import { createInterface } from "node:readline";

interface CliFlags {
  prompt: string;
  readOnly: boolean;
  maxTurns?: number;
  cwd: string;
  noResources: boolean;
  noCompaction: boolean;
  resume: boolean;
  listModels: boolean;
  interactive: boolean;
  print: boolean;
  hadPrompt?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { prompt: "", readOnly: false, cwd: process.cwd(), noResources: false, noCompaction: false, resume: false, listModels: false, interactive: false, print: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--read-only") flags.readOnly = true;
    else if (arg === "--no-resources") flags.noResources = true;
    else if (arg === "--no-compaction") flags.noCompaction = true;
    else if (arg === "--resume") flags.resume = true;
    else if (arg === "--interactive" || arg === "-i") flags.interactive = true;
    else if (arg === "--print") flags.print = true;
    else if (arg === "--list-models") flags.listModels = true;
    else if (arg === "--provider") {
      const next = argv[++i];
      if (!next) throw new Error("--provider requires a name");
      flags.provider = next;
    } else if (arg === "--model") {
      const next = argv[++i];
      if (!next) throw new Error("--model requires an id (optionally provider/id)");
      flags.model = next;
    } else if (arg === "--base-url") {
      const next = argv[++i];
      if (!next) throw new Error("--base-url requires a URL");
      flags.baseUrl = next;
    } else if (arg === "--api-key") {
      const next = argv[++i];
      if (!next) throw new Error("--api-key requires a value");
      flags.apiKey = next;
    } else if (arg === "--max-turns") {
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
  flags.prompt = positional.join(" ");
  flags.hadPrompt = positional.length > 0;
  return flags;
}

function printHelp(): void {
  process.stdout.write(
    `kern — minimal coding agent kernel\n\nUsage:\n  kern [flags] "<prompt>"\n\nFlags:\n  --read-only       Only read/grep/find/ls-class tools (here: read only)\n  --max-turns N     Cap agent turns for this run\n  --cwd DIR         Workspace root (default: cwd)\n  --no-resources    Skip AGENTS.md / skill discovery\n  --no-compaction   Disable automatic compaction\n  --resume          Resume the most recent session\n  --interactive, -i  Interactive TUI (default when TTY and no prompt given)\n  --print           Force single-prompt print mode\n  --list-models     List available models (configured + live) and exit\n  --provider NAME   Provider from models.json (or KERN_PROVIDER)\n  --model ID        Model id, optionally provider/id (or KERN_MODEL)\n  --base-url URL    Override endpoint base URL (or KERN_BASE_URL)\n  --api-key KEY     Override API key (or KERN_API_KEY)\n  --help, -h        This message\n`,
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
  const provider = flags.provider ?? process.env["KERN_PROVIDER"];
  let model = flags.model ?? process.env["KERN_MODEL"];
  const baseUrl = flags.baseUrl ?? process.env["KERN_BASE_URL"];
  const apiKey = flags.apiKey ?? process.env["KERN_API_KEY"];
  const file = await loadModelsFile(flags.cwd);
  const approvalHook: { current: ((prompt: string, meta?: { toolName: string }) => Promise<boolean | "session">) | null } = { current: null };

  if (flags.listModels) {
    const models = await discoverModels(file, { provider, baseUrl, apiKey });
    for (const m of models) {
      const mark = m.authenticated ? "" : " (no credentials)";
      process.stdout.write(`${m.provider}/${m.id}${mark} [${m.source}]\n`);
    }
    return;
  }

  // `--model provider/id` splits; `--provider` + `--model id` also works.
  let providerName = provider ?? file.defaultProvider;
  if (model && model.includes("/")) {
    const [p, ...rest] = model.split("/");
    providerName = p;
    model = rest.join("/");
  }
  model ??= file.defaultModel;
  let adapter = undefined;
  if (providerName && model) {
    adapter = await createAdapterFor(file, providerName, model, { baseUrl, apiKey }, logger);
    process.stderr.write(`[model ${providerName}/${model}]\n`);
  } else if (baseUrl && model) {
    // Ad-hoc OpenAI-compatible endpoint with no models.json entry.
    const { createOpenAIAdapter } = await import("@kern/model");
    adapter = createOpenAIAdapter({
      provider: providerName ?? "custom",
      modelId: model,
      baseUrl,
      apiKey,
      contextWindow: 128_000,
      maxOutputTokens: 4_000,
      logger,
    });
    process.stderr.write(`[model ${providerName ?? "custom"}/${model} @ ${baseUrl}]\n`);
  }
  const sessionOptions = {
    cwd: flags.cwd,
    logger,
    loadResources: !flags.noResources,
    enableCompaction: !flags.noCompaction,
    resume: flags.resume,
    policy: flags.readOnly ? { allowlistTools: ["read"] } : undefined,
    budgets: flags.maxTurns !== undefined ? { maxTurns: flags.maxTurns } : undefined,
    requestApproval: (prompt: string, meta?: { toolName: string }) => (approvalHook.current ? approvalHook.current(prompt, meta) : askApproval(prompt)),
    ...(adapter ? { model: adapter } : {}),
  };
  const startSession = () => createAgentSession({ ...sessionOptions });
  const { session, manager } = await startSession();

  const wantInteractive =
    flags.interactive || (!flags.print && !flags.hadPrompt && process.stdin.isTTY && process.stdout.isTTY);
  if (wantInteractive) {
    const { runInteractive } = await import("@kern/tui");
    await runInteractive({
      session,
      manager,
      newSession: startSession,
      modelsFile: file,
      providerName: providerName,
      baseUrl,
      apiKey,
      cwd: flags.cwd,
      logger,
      approvalHook,
    });
    return;
  }

  const prompt = flags.prompt || "What is in README.md?";
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
  await session.prompt(prompt);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
