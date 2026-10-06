import { createAgentSession, type AgentSession } from "@kern/coding-agent";
import { OpenAICompatibleAdapter, listModels, resolveModelConfig } from "@kern/model";
import { createLogger, type AgentEvent, type Logger } from "@kern/protocol";
import { createInterface, type Interface as Readline } from "node:readline";

interface CliFlags {
  prompt: string;
  interactive: boolean;
  readOnly: boolean;
  maxTurns?: number;
  cwd: string;
  noResources: boolean;
  noCompaction: boolean;
  resume: boolean;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  contextWindow?: number;
  listModels: boolean;
  nvidia: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    prompt: "",
    interactive: false,
    readOnly: false,
    cwd: process.cwd(),
    noResources: false,
    noCompaction: false,
    resume: false,
    listModels: false,
    nvidia: false,
  };
  const positional: string[] = [];
  const takeValue = (name: string, i: number): string => {
    const next = argv[i];
    if (!next) throw new Error(`${name} requires a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--interactive" || arg === "-i") flags.interactive = true;
    else if (arg === "--read-only") flags.readOnly = true;
    else if (arg === "--no-resources") flags.noResources = true;
    else if (arg === "--no-compaction") flags.noCompaction = true;
    else if (arg === "--resume") flags.resume = true;
    else if (arg === "--list-models") flags.listModels = true;
    else if (arg === "--nvidia") flags.nvidia = true;
    else if (arg === "--max-turns") {
      const n = Number(takeValue("--max-turns", ++i));
      if (!Number.isInteger(n) || n <= 0) throw new Error("--max-turns requires a positive integer");
      flags.maxTurns = n;
    } else if (arg === "--cwd") flags.cwd = takeValue("--cwd", ++i);
    else if (arg === "--model" || arg === "-m") flags.model = takeValue("--model", ++i);
    else if (arg === "--api-key") flags.apiKey = takeValue("--api-key", ++i);
    else if (arg === "--base-url") flags.baseURL = takeValue("--base-url", ++i);
    else if (arg === "--context-window") {
      const n = Number(takeValue("--context-window", ++i));
      if (!Number.isFinite(n) || n <= 0) throw new Error("--context-window requires a positive number");
      flags.contextWindow = n;
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
  return flags;
}

function printHelp(): void {
  process.stdout.write(
    `kern — minimal coding agent kernel

Usage:
  kern [flags] "<prompt>"        one-shot turn (print mode)
  kern -i [flags]                interactive session

Model flags (OpenAI-compatible: OpenAI, NVIDIA, local servers):
  --model, -m NAME     model id (or KERN_MODEL env)
  --api-key KEY        API key (or KERN_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY)
  --base-url URL       API base URL (or KERN_BASE_URL / OPENAI_BASE_URL)
  --nvidia             shorthand for --base-url https://integrate.api.nvidia.com/v1
  --context-window N   context window tokens (default 128000)
  --list-models        list models available at the endpoint and exit

Session flags:
  --read-only       only the read tool
  --max-turns N     cap agent turns for this run
  --cwd DIR         workspace root (default: cwd)
  --no-resources    skip AGENTS.md / skill discovery
  --no-compaction   disable automatic compaction
  --resume          resume the most recent session
  --help, -h        this message

Interactive commands: /model [/model NAME|list]  /compact [note]  /budget  /new  /help  /quit
`,
  );
}

interface ModelEndpoint {
  apiKey: string;
  baseURL: string;
}

function resolveEndpoint(flags: CliFlags): ModelEndpoint | null {
  if (flags.apiKey) {
    return {
      apiKey: flags.apiKey,
      baseURL: flags.baseURL ?? (flags.nvidia ? "https://integrate.api.nvidia.com/v1" : undefined) ?? process.env["KERN_BASE_URL"] ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
    };
  }
  const key = process.env["KERN_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? process.env["NVIDIA_API_KEY"];
  if (!key) return null;
  return {
    apiKey: key,
    baseURL: flags.baseURL ?? (flags.nvidia ? "https://integrate.api.nvidia.com/v1" : undefined) ?? process.env["KERN_BASE_URL"] ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
  };
}

/** TTY approval prompt. Non-TTY = deny (fail closed). */
function askApproval(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`\nApproval required: ${prompt}\nAllow? [y/N] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

function attachPrinter(session: AgentSession, opts: { stdoutText: boolean }): void {
  session.subscribe((ev: AgentEvent) => {
    switch (ev.type) {
      case "text_delta":
        if (opts.stdoutText) process.stdout.write(ev.delta);
        else process.stdout.write(ev.delta);
        break;
      case "reasoning_delta":
        process.stderr.write(ev.delta);
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
}

async function buildAdapter(flags: CliFlags, logger: Logger): Promise<OpenAICompatibleAdapter | null> {
  const endpoint = resolveEndpoint(flags);
  if (!endpoint) return null;
  const modelName = flags.model ?? process.env["KERN_MODEL"];
  if (!modelName) return null;
  const resolved = resolveModelConfig({ model: modelName, apiKey: endpoint.apiKey, baseURL: endpoint.baseURL, contextWindow: flags.contextWindow });
  if (!resolved) return null;
  logger.info("model_configured", { provider: resolved.providerLabel, model: resolved.model, baseURL: resolved.baseURL, source: resolved.source });
  return new OpenAICompatibleAdapter({ ...resolved, logger });
}

async function main() {
  const logger = createLogger(process.env["KERN_LOG"] === "debug" ? "debug" : "warn");
  const flags = parseArgs(process.argv.slice(2));

  const endpoint = resolveEndpoint(flags);
  if (flags.listModels) {
    if (!endpoint) {
      process.stderr.write("No API key. Provide --api-key or set KERN_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY.\n");
      process.exit(2);
    }
    const ids = await listModels(endpoint.apiKey, endpoint.baseURL);
    for (const id of ids) process.stdout.write(`${id}\n`);
    return;
  }

  const adapter = await buildAdapter(flags, logger);
  if (!adapter) {
    if (flags.interactive || flags.prompt) {
      process.stderr.write(
        "No model configured. Provide --model + --api-key (or KERN_MODEL + KERN_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY env).\n",
      );
      process.exit(2);
    }
  }

  const createSession = () =>
    createAgentSession({
      cwd: flags.cwd,
      logger,
      loadResources: !flags.noResources,
      enableCompaction: !flags.noCompaction,
      resume: flags.resume,
      policy: flags.readOnly ? { allowlistTools: ["read"] } : undefined,
      budgets: flags.maxTurns !== undefined ? { maxTurns: flags.maxTurns } : undefined,
      requestApproval: askApproval,
      model: adapter ?? undefined,
    });

  if (!flags.interactive) {
    const prompt = flags.prompt || "What is in README.md?";
    const { session } = await createSession();
    attachPrinter(session, { stdoutText: true });
    await session.prompt(prompt);
    return;
  }

  await runInteractive(flags, logger, createSession, adapter, endpoint);
}

async function runInteractive(
  flags: CliFlags,
  logger: Logger,
  createSession: () => ReturnType<typeof createAgentSession>,
  adapter: OpenAICompatibleAdapter | null,
  endpoint: ModelEndpoint | null,
) {
  let current = await createSession();
  attachPrinter(current.session, { stdoutText: true });
  let activeAdapter = adapter;
  let busy = false;
  let turnAbort: AbortController | null = null;

  const rl: Readline = createInterface({ input: process.stdin, output: process.stdout, prompt: "kern> " });
  let closed = false;
  let pendingQuit = false;
  const safePrompt = () => {
    if (!closed && !pendingQuit) rl.prompt();
  };
  rl.on("close", () => {
    closed = true;
  });
  process.stdout.write(`kern interactive — model: ${activeAdapter ? `${activeAdapter.info.provider}/${activeAdapter.info.modelId}` : "(none — set --model)"}\n`);
  safePrompt();

  const help = () =>
    process.stdout.write(
      `/model [NAME|list]  show or switch model (lists via API)\n/compact [note]      manual compaction\n/budget              show turn/tool/time usage\n/new                 start a fresh session\n/help                this message\n/quit                exit\n`,
    );

  rl.on("SIGINT", () => {
    if (busy && turnAbort) {
      turnAbort.abort();
      process.stderr.write("\n[aborted]\n");
    } else {
      rl.close();
    }
  });

  rl.on("line", (raw: string) => {
    void (async () => {
      const line = raw.trim();
      if (!line) {
        safePrompt();
        return;
      }
      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        const arg = rest.join(" ");
        switch (cmd) {
          case "quit":
          case "exit":
            if (busy && turnAbort) {
              pendingQuit = true;
              turnAbort.abort();
              process.stderr.write("\n[aborting turn, then exiting…]\n");
            } else {
              rl.close();
            }
            return;
          case "help":
            help();
            break;
          case "budget": {
            const u = current.session.budgetUsage();
            process.stdout.write(`turns=${u.turns} toolCalls=${u.totalToolCalls} wallMs=${u.wallTimeMs}\n`);
            break;
          }
          case "new":
            if (busy) {
              process.stderr.write("A turn is running — wait or abort it first.\n");
              break;
            }
            current = await createSession();
            if (activeAdapter) await current.session.setModel(activeAdapter);
            attachPrinter(current.session, { stdoutText: true });
            process.stdout.write("New session started.\n");
            break;
          case "compact":
            if (busy) {
              process.stderr.write("A turn is running — wait or abort it first.\n");
              break;
            }
            try {
              const result = await current.session.compact(arg || undefined);
              process.stdout.write(`Compacted through ${result.replacesThroughId} (${result.summary.length} chars).\n`);
            } catch (error) {
              process.stderr.write(`Compaction failed: ${error instanceof Error ? error.message : String(error)}\n`);
            }
            break;
          case "model": {
            if (!endpoint) {
              process.stderr.write("No API endpoint configured (need --api-key or env key).\n");
              break;
            }
            if (!arg || arg === "list") {
              try {
                const ids = await listModels(endpoint.apiKey, endpoint.baseURL);
                const cur = activeAdapter?.info.modelId;
                for (const id of ids) process.stdout.write(`${id === cur ? "* " : "  "}${id}\n`);
              } catch (error) {
                process.stderr.write(`Could not list models: ${error instanceof Error ? error.message : String(error)}\n`);
              }
              break;
            }
            if (busy) {
              process.stderr.write("A turn is running — wait or abort it first.\n");
              break;
            }
            try {
              const ids = await listModels(endpoint.apiKey, endpoint.baseURL);
              if (!ids.includes(arg)) {
                process.stderr.write(`Warning: "${arg}" not advertised by the endpoint; switching anyway.\n`);
              }
            } catch (error) {
              process.stderr.write(`Could not verify model list (${error instanceof Error ? error.message : String(error)}); switching anyway.\n`);
            }
            const base = activeAdapter ?? new OpenAICompatibleAdapter({ apiKey: endpoint.apiKey, baseURL: endpoint.baseURL, model: arg, logger });
            activeAdapter = base.withModel(arg);
            await current.session.setModel(activeAdapter);
            process.stdout.write(`Switched to ${activeAdapter.info.provider}/${activeAdapter.info.modelId}.\n`);
            break;
          }
          default:
            process.stderr.write(`Unknown command: /${cmd ?? ""} (try /help)\n`);
            break;
        }
        safePrompt();
        return;
      }
      if (busy) {
        process.stderr.write("A turn is already running — Ctrl+C aborts it.\n");
        safePrompt();
        return;
      }
      busy = true;
      turnAbort = new AbortController();
      try {
        await current.session.prompt(line, { signal: turnAbort.signal });
      } catch (error) {
        if (turnAbort.signal.aborted) process.stderr.write("[aborted]\n");
        else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        busy = false;
        turnAbort = null;
        if (pendingQuit) rl.close();
        else safePrompt();
      }
    })();
  });

  await new Promise<void>((resolve) => rl.on("close", () => resolve()));
  void flags;
  void logger;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
