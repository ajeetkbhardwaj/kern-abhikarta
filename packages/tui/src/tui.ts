/**
 * @kern/tui — interactive orchestrator (regular scrollback mode).
 *
 * Transcript streams into terminal scrollback as events arrive; a raw-mode
 * multiline editor owns the bottom block while idle. While a turn runs the
 * editor suspends and a spinner shows elapsed time + current activity
 * (Ctrl+C aborts); approvals and the /model picker take over stdin
 * temporarily. The TUI only observes `AgentEvent`s — it never mutates
 * kernel state except through the `AgentSession` API.
 */

import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentEvent, Logger, ModelAdapter } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import type { AgentSession } from "@kern/coding-agent";
import type { SessionManager } from "@kern/session-store";
import { createAdapterFor, discoverModels, type ModelsFile } from "@kern/model";
import { theme, CLEAR_LINE, CLEAR_SCREEN, SHOW_CURSOR } from "./theme.js";
import { LineEditor } from "./input.js";
import { SelectOverlay } from "./select.js";
import { MarkdownStream } from "./markdown.js";
import { terminalWidth, truncateToWidth, splitKeys } from "./text.js";

export interface InteractiveOptions {
  session: AgentSession;
  manager: SessionManager;
  /** Create a fresh session (used by /new). Same options as startup. */
  newSession: () => Promise<{ session: AgentSession; manager: SessionManager }>;
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
  { name: "/compact [note]", hint: "summarize history into a checkpoint" },
  { name: "/new", hint: "start a fresh session" },
  { name: "/export [file]", hint: "dump transcript to markdown" },
  { name: "/budget", hint: "show turn/call/time usage" },
  { name: "/clear", hint: "clear the screen" },
  { name: "/quit", hint: "exit (also Ctrl+D, or Ctrl+C on empty input)" },
];

const HINTS = "Enter send · Alt+Enter newline · Ctrl+C abort · Esc clear input";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ENABLE_PASTE = "\u001b[?2004h";
const DISABLE_PASTE = "\u001b[?2004l";

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const logger = options.logger ?? nullLogger;
  let session = options.session;
  let manager = options.manager;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY");
  }

  const editor = new LineEditor({ prompt: "› " });
  const md = new MarkdownStream();
  let busy = false;
  let abort: AbortController | null = null;
  let overlayOpen = false;
  let keyQueue: string[] = [];
  let keyWaiters: Array<(k: string) => void> = [];
  let exiting = false;
  let unsubscribe: (() => void) | null = null;
  let activity = "thinking";
  let turnStartedAt = 0;

  const readKey = (): Promise<string> => {
    const next = keyQueue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => keyWaiters.push(resolve));
  };

  // --- spinner-aware output -----------------------------------------------
  let spinnerVisible = false;
  let spinnerFrame = 0;
  let lastPrintAt = 0;
  const hideSpinner = () => {
    if (spinnerVisible) {
      process.stdout.write(CLEAR_LINE);
      spinnerVisible = false;
    }
  };
  const print = (s: string) => {
    hideSpinner();
    process.stdout.write(s + "\n");
    lastPrintAt = Date.now();
  };
  const printRaw = (s: string) => {
    hideSpinner();
    process.stdout.write(s);
    lastPrintAt = Date.now();
  };
  const info = (s: string) => print(theme.muted(s));

  const tick = () => {
    if (exiting || !busy || overlayOpen) return;
    if (Date.now() - lastPrintAt < 300) return;
    const elapsed = ((Date.now() - turnStartedAt) / 1000).toFixed(0);
    const frame = SPINNER[spinnerFrame++ % SPINNER.length];
    process.stdout.write(CLEAR_LINE + theme.muted(`${frame} ${elapsed}s · ${activity} (Ctrl+C to abort)`));
    spinnerVisible = true;
  };
  const spinner = setInterval(tick, 120);

  const printHeader = () => {
    const m = session.modelInfo();
    print(theme.bold("kern") + theme.muted(`  ${m.provider}/${m.modelId}  ·  ${options.cwd}`));
    info("Type a task, or /help for commands.");
    info(HINTS);
  };

  const printStatus = () => {
    const u = session.budgetUsage();
    const m = session.modelInfo();
    info(`— ${m.provider}/${m.modelId} · ${u.turns} turns · ${u.totalToolCalls} calls · ${(u.wallTimeMs / 1000).toFixed(1)}s`);
  };

  // --- event → transcript ---------------------------------------------------
  let assistantOpen = false;
  const closeAssistant = () => {
    if (assistantOpen) {
      printRaw(md.flush() + "\n");
      assistantOpen = false;
    }
  };

  const subscribe = () => {
    unsubscribe?.();
    unsubscribe = session.subscribe((event: AgentEvent) => {
      if (exiting) return;
      switch (event.type) {
        case "text_delta":
          if (!assistantOpen) {
            print(theme.bold("assistant"));
            assistantOpen = true;
          }
          printRaw(md.push(event.delta));
          break;
        case "reasoning_delta":
          activity = "thinking";
          break;
        case "message_end":
          closeAssistant();
          md.reset();
          break;
        case "tool_execution_start":
          closeAssistant();
          md.reset();
          activity = `running ${event.toolName}`;
          print(theme.tool(`◈ ${event.toolName}`) + theme.muted(` ${truncateToWidth(JSON.stringify(event.arguments), 120)}`));
          break;
        case "tool_execution_end":
          print(event.isError ? theme.error(`✖ ${event.toolName} failed`) : theme.success(`✔ ${event.toolName} done`));
          break;
        case "tool_execution_update":
          activity = `running ${event.toolName}`;
          break;
        case "auto_compaction_start":
          activity = "compacting context";
          info(`[compacting context (${event.phase})…]`);
          break;
        case "auto_compaction_end":
          info("[context compacted]");
          break;
        case "auto_retry_start":
          activity = `retrying (${event.reason})`;
          info(`[retry ${event.attempt} (${event.reason}) in ${event.delayMs}ms]`);
          break;
        case "agent_error":
          closeAssistant();
          md.reset();
          print(theme.error(`[error ${event.error.code}] ${event.error.message}`));
          break;
        case "agent_settled":
          closeAssistant();
          md.reset();
          break;
        default:
          break;
      }
    });
  };
  subscribe();

  // --- approvals (kernel sink delegates here while TUI owns stdin) ---------
  options.approvalHook.current = async (prompt: string): Promise<boolean> => {
    editor.suspend();
    hideSpinner();
    process.stdout.write(theme.warn(`\nApproval required: ${prompt}\nAllow? [y/N] `));
    const key = (await readKey()).toLowerCase();
    const ok = key === "y";
    print(ok ? theme.success("approved") : theme.muted("denied"));
    if (!busy) editor.resume();
    return ok;
  };

  // --- transcript export -----------------------------------------------------
  const exportTranscript = async (file?: string): Promise<void> => {
    const path = manager.getActivePath();
    const target = file ?? join(options.cwd, `kern-session-${manager.sessionId ?? "export"}.md`);
    const lines: string[] = [`# kern session`, ""];
    const m = session.modelInfo();
    lines.push(`- model: ${m.provider}/${m.modelId}`, `- cwd: ${options.cwd}`, "");
    for (const entry of path) {
      if (entry.type === "message") {
        const msg = entry.message;
        lines.push(`## ${msg.role}`, "");
        for (const block of msg.content) {
          if (block.type === "text") lines.push(block.text, "");
          else if (block.type === "reasoning") lines.push(`> thinking: ${block.text.slice(0, 500)}`, "");
          else if (block.type === "tool_call") lines.push(`\`\`\`tool ${block.name}`, `${JSON.stringify(block.arguments, null, 2)}`, "````", "");
          else if (block.type === "tool_result") {
            lines.push(`**tool result${block.isError ? " (error)" : ""}:**`, "");
            for (const c of block.content) lines.push(c.text, "");
          }
        }
      } else if (entry.type === "compaction") {
        lines.push("## compaction checkpoint", "", entry.summary, "");
      } else if (entry.type === "model_change") {
        lines.push(`*model → ${entry.provider}/${entry.model}*`, "");
      } else if (entry.type === "branch") {
        lines.push(`*branch from ${entry.forkedFromId}${entry.note ? `: ${entry.note}` : ""}*`, "");
      }
    }
    await writeFile(target, lines.join("\n"), "utf8");
    print(theme.success(`Exported to ${target}`));
  };

  // --- /model picker ---------------------------------------------------------
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

  // --- slash commands --------------------------------------------------------
  const runCommand = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/help":
        for (const c of COMMANDS) print(`  ${theme.accent(c.name)}  ${theme.muted(c.hint)}`);
        info(HINTS);
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
        await pickModel(arg || undefined);
        return true;
      case "/compact": {
        if (busy) {
          info("A turn is running — compaction will happen automatically if needed.");
          return true;
        }
        try {
          const result = await session.compact(arg || undefined);
          if (!result) info("Nothing to compact yet.");
          else print(theme.success(`Compacted through ${result.replacesThroughId}.`));
        } catch (error) {
          print(theme.error(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`));
        }
        return true;
      }
      case "/new": {
        if (busy) {
          info("Wait for the current turn to settle before starting a new session.");
          return true;
        }
        try {
          const fresh = await options.newSession();
          unsubscribe?.();
          session = fresh.session;
          manager = fresh.manager;
          subscribe();
          process.stdout.write(CLEAR_SCREEN);
          printHeader();
          info(`New session started (${manager.sessionFile ? basename(manager.sessionFile) : "in-memory"}).`);
        } catch (error) {
          print(theme.error(`New session failed: ${error instanceof Error ? error.message : String(error)}`));
        }
        return true;
      }
      case "/export": {
        if (busy) {
          info("Wait for the current turn to settle before exporting.");
          return true;
        }
        try {
          await exportTranscript(arg || undefined);
        } catch (error) {
          print(theme.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`));
        }
        return true;
      }
      default:
        print(theme.error(`Unknown command: ${cmd ?? ""}. Try /help.`));
        return true;
    }
  };

  // --- prompt submission ------------------------------------------------------
  const submit = (line: string) => {
    if (busy || exiting) return;
    const text = line.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
    if (!text.trim()) {
      editor.resume();
      return;
    }
    if (text.trimStart().startsWith("/")) {
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
    activity = "thinking";
    turnStartedAt = Date.now();
    lastPrintAt = Date.now();
    editor.suspend();
    print(theme.bold("you"));
    for (const t of text.split("\n")) print(theme.muted(`  ${t}`));
    session
      .prompt(text, { signal: abort.signal })
      .catch((error: unknown) => {
        print(theme.error(`Turn failed: ${error instanceof Error ? error.message : String(error)}`));
      })
      .finally(() => {
        busy = false;
        abort = null;
        hideSpinner();
        if (!exiting) {
          printStatus();
          editor.resume();
        }
      });
  };

  const exit = async () => {
    if (exiting) return;
    exiting = true;
    clearInterval(spinner);
    abort?.abort();
    options.approvalHook.current = null;
    process.stdout.write(DISABLE_PASTE);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(SHOW_CURSOR);
    print(theme.muted("bye."));
  };

  // --- stdin ------------------------------------------------------------------
  process.stdout.write(ENABLE_PASTE);
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
