/**
 * @kern/tui — interactive orchestrator (regular scrollback mode).
 *
 * Transcript streams into terminal scrollback as events arrive; a raw-mode
 * single-line editor owns the bottom line while idle. While a turn runs the
 * editor suspends (Ctrl+C aborts); approvals and the /model picker take over
 * stdin temporarily. The TUI only observes `AgentEvent`s — it never mutates
 * kernel state except through the `AgentSession` API.
 */

import type { AgentEvent, Logger, ModelAdapter } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import type { AgentSession } from "@kern/coding-agent";
import { createAdapterFor, discoverModels, type ModelsFile } from "@kern/model";
import { theme, CLEAR_LINE, CLEAR_SCREEN, SHOW_CURSOR } from "./theme.js";
import { LineEditor } from "./input.js";
import { SelectOverlay } from "./select.js";
import { terminalWidth, truncateToWidth, splitKeys } from "./text.js";

export interface InteractiveOptions {
  session: AgentSession;
  modelsFile: ModelsFile;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  cwd: string;
  logger?: Logger;
  /** Called by the kernel approval sink. Set by the CLI wiring. */
  approvalHook: { current: ((prompt: string) => Promise<boolean>) | null };
}

const COMMANDS: Array<{ name: string; hint: string }> = [
  { name: "/help", hint: "show this list" },
  { name: "/model", hint: "pick provider/model (auto-listed)" },
  { name: "/budget", hint: "show turn/call/time usage" },
  { name: "/clear", hint: "clear the screen" },
  { name: "/quit", hint: "exit (also Ctrl+D, or Ctrl+C on empty line)" },
];

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const logger = options.logger ?? nullLogger;
  const { session } = options;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY");
  }

  const editor = new LineEditor({ prompt: "› " });
  let busy = false;
  let abort: AbortController | null = null;
  let overlayOpen = false;
  let keyQueue: string[] = [];
  let keyWaiters: Array<(k: string) => void> = [];
  let exiting = false;

  const readKey = (): Promise<string> => {
    const next = keyQueue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => keyWaiters.push(resolve));
  };

  const print = (s: string) => process.stdout.write(s + "\n");
  const info = (s: string) => process.stdout.write(theme.muted(s) + "\n");

  const printHeader = () => {
    const m = session.modelInfo();
    print(theme.bold("kern") + theme.muted(`  ${m.provider}/${m.modelId}  ·  ${options.cwd}`));
    info("Type a task, or /help for commands.");
  };

  const printStatus = () => {
    const u = session.budgetUsage();
    const m = session.modelInfo();
    info(`— ${m.provider}/${m.modelId} · ${u.turns} turns · ${u.totalToolCalls} calls · ${(u.wallTimeMs / 1000).toFixed(1)}s`);
  };

  // --- event → transcript -------------------------------------------------
  let assistantOpen = false;
  const closeAssistant = () => {
    if (assistantOpen) {
      process.stdout.write("\n");
      assistantOpen = false;
    }
  };

  session.subscribe((event: AgentEvent) => {
    if (exiting) return;
    switch (event.type) {
      case "text_delta":
        if (!assistantOpen) {
          process.stdout.write(theme.bold("assistant") + "\n");
          assistantOpen = true;
        }
        process.stdout.write(event.delta);
        break;
      case "reasoning_delta":
        break; // hidden by default in v1
      case "message_end":
        closeAssistant();
        break;
      case "tool_execution_start":
        closeAssistant();
        print(theme.tool(`◈ ${event.toolName}`) + theme.muted(` ${truncateToWidth(JSON.stringify(event.arguments), 100)}`));
        break;
      case "tool_execution_end":
        print(event.isError ? theme.error(`✖ ${event.toolName} failed`) : theme.success(`✔ ${event.toolName} done`));
        break;
      case "auto_compaction_start":
        info(`[compacting context (${event.phase})…]`);
        break;
      case "auto_compaction_end":
        info("[context compacted]");
        break;
      case "auto_retry_start":
        info(`[retry ${event.attempt} (${event.reason}) in ${event.delayMs}ms]`);
        break;
      case "agent_error":
        closeAssistant();
        print(theme.error(`[error ${event.error.code}] ${event.error.message}`));
        break;
      case "agent_settled":
        closeAssistant();
        break;
      default:
        break;
    }
  });

  // --- approvals (kernel sink delegates here while TUI owns stdin) -------
  options.approvalHook.current = async (prompt: string): Promise<boolean> => {
    editor.suspend();
    process.stdout.write(theme.warn(`\nApproval required: ${prompt}\nAllow? [y/N] `));
    const key = (await readKey()).toLowerCase();
    const ok = key === "y";
    print(ok ? theme.success("approved") : theme.muted("denied"));
    if (!busy) editor.resume();
    return ok;
  };

  // --- /model picker -------------------------------------------------------
  const pickModel = async (initialFilter?: string) => {
    if (busy) {
      info("Wait for the current turn to settle before switching models.");
      return;
    }
    let models;
    try {
      models = await discoverModels(options.modelsFile, {
        provider: options.providerName,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
      });
    } catch (error) {
      print(theme.error(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (models.length === 0) {
      print(theme.error("No models found. Add providers to ~/.kern/models.json or set KERN_BASE_URL."));
      return;
    }
    const current = session.modelInfo();
    overlayOpen = true;
    editor.suspend();
    const overlay = new SelectOverlay(
      "model",
      [...models]
        .sort((a, b) => Number(b.authenticated) - Number(a.authenticated))
        .map((m) => ({
          label: `${m.provider}/${m.id}${m.provider === current.provider && m.id === current.modelId ? "  (current)" : ""}`,
          hint: `${m.source}${m.authenticated ? "" : " · no credentials"}`,
          value: m,
        })),
    );
    if (initialFilter) (overlay as unknown as { filter: string }).filter = initialFilter;
    const picked = await overlay.run(readKey);
    overlayOpen = false;
    if (!picked) {
      info("Model unchanged.");
      editor.resume();
      return;
    }
    try {
      const adapter: ModelAdapter = await createAdapterFor(
        options.modelsFile,
        picked.provider,
        picked.id,
        { baseUrl: options.baseUrl, apiKey: options.apiKey },
        logger,
      );
      await session.setModel(adapter);
      print(theme.success(`Model: ${picked.provider}/${picked.id}`));
    } catch (error) {
      print(theme.error(`Model switch failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    editor.resume();
  };

  // --- slash commands ------------------------------------------------------
  const runCommand = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    switch (cmd) {
      case "/help":
        for (const c of COMMANDS) print(`  ${theme.accent(c.name)}  ${theme.muted(c.hint)}`);
        return true;
      case "/quit":
      case "/exit":
        return false;
      case "/clear":
        process.stdout.write(CLEAR_SCREEN);
        printHeader();
        return true;
      case "/budget":
        printStatus();
        return true;
      case "/model":
        await pickModel(rest.join(" ") || undefined);
        return true;
      default:
        print(theme.error(`Unknown command: ${cmd ?? ""}. Try /help.`));
        return true;
    }
  };

  // --- prompt submission ----------------------------------------------------
  const submit = (line: string) => {
    if (busy || exiting) return;
    const text = line.trim();
    if (!text) {
      editor.resume();
      return;
    }
    if (text.startsWith("/")) {
      void (async () => {
        editor.suspend();
        let keep = true;
        try {
          keep = await runCommand(text);
        } catch (error) {
          print(theme.error(String(error)));
        }
        if (!keep) {
          void exit();
          return;
        }
        editor.resume();
      })();
      return;
    }
    busy = true;
    abort = new AbortController();
    editor.suspend();
    info("[working — Ctrl+C to abort]");
    session
      .prompt(text, { signal: abort.signal })
      .catch((error: unknown) => {
        print(theme.error(`Turn failed: ${error instanceof Error ? error.message : String(error)}`));
      })
      .finally(() => {
        busy = false;
        abort = null;
        if (!exiting) {
          printStatus();
          editor.resume();
        }
      });
  };

  const exit = async () => {
    if (exiting) return;
    exiting = true;
    abort?.abort();
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(SHOW_CURSOR);
    print(theme.muted("bye."));
  };

  // --- stdin ----------------------------------------------------------------
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    for (const key of splitKeys(chunk)) {
      if (overlayOpen) {
        const waiter = keyWaiters.shift();
        if (waiter) waiter(key);
        else keyQueue.push(key);
        continue;
      }
      if (busy) {
        if (key === "\u0003") abort?.abort();
        continue;
      }
      // approval prompt reads through readKey even when idle
      if (keyWaiters.length > 0) {
        const waiter = keyWaiters.shift();
        if (waiter) waiter(key);
        continue;
      }
      editor.handleKey(key);
    }
  });

  printHeader();
  const width = terminalWidth();
  void width;
  editor.start({
    onSubmit: submit,
    onAbort: () => abort?.abort(),
    onExit: () => void exit(),
  });

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (exiting) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}
