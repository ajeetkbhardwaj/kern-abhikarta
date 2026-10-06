/**
 * @kern/tui — interactive orchestrator (regular scrollback mode).
 *
 * Transcript streams into terminal scrollback as events arrive; a raw-mode
 * multiline editor owns the bottom block while idle. While a turn runs the
 * editor suspends, a spinner shows elapsed time + activity, and typed input
 * queues for the next turn (Ctrl+C/Esc aborts instead). Approvals are
 * arrow-key dialogs (Esc declines); the /model picker, history search, and
 * mode cycling all ride the same overlay/key plumbing. The TUI only observes
 * `AgentEvent`s — it never mutates kernel state except through `AgentSession`.
 */

import { writeFile, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { AgentEvent, Logger, ModelAdapter } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import type { AgentSession } from "@kern/coding-agent";
import type { SessionManager } from "@kern/session-store";
import { createAdapterFor, discoverModels, type ModelsFile } from "@kern/model";
import { theme, CLEAR_LINE, CLEAR_SCREEN, SHOW_CURSOR } from "./theme.js";
import { LineEditor } from "./input.js";
import { SelectOverlay } from "./select.js";
import { MarkdownStream } from "./markdown.js";
import { truncateToWidth, splitKeys } from "./text.js";

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
  approvalHook: { current: ((prompt: string, meta?: { toolName: string }) => Promise<boolean | "session">) | null };
}

const COMMANDS: Array<{ name: string; hint: string }> = [
  { name: "/help", hint: "show this list" },
  { name: "/model", hint: "pick provider/model (auto-listed)" },
  { name: "/compact [note]", hint: "summarize history into a checkpoint" },
  { name: "/diff", hint: "show working-tree changes" },
  { name: "/new", hint: "start a fresh session" },
  { name: "/export [file]", hint: "dump transcript to markdown" },
  { name: "/budget", hint: "show turn/call/time usage" },
  { name: "/clear", hint: "clear the screen" },
  { name: "/quit", hint: "exit (also Ctrl+D twice, or Ctrl+C on empty input)" },
];

const HINTS = "Enter send · Alt+Enter/Ctrl+J newline · Tab complete · @ files · ! shell · Ctrl+C abort · Esc clear";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ENABLE_PASTE = "\u001b[?2004h";
const DISABLE_PASTE = "\u001b[?2004l";
const INVISIBLE_RE = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u{E0000}-\u{E007F}]/gu;
const MAX_QUEUE = 5;

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const logger = options.logger ?? nullLogger;
  let session = options.session;
  let manager = options.manager;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY");
  }
  const cwd = resolve(options.cwd);

  // --- workspace file cache for @ mentions ----------------------------------
  let fileCache: string[] = [];
  let fileCacheAt = 0;
  const refreshFiles = async (): Promise<void> => {
    try {
      fileCache = await listWorkspaceFiles(cwd);
      fileCacheAt = Date.now();
    } catch {
      // keep the old cache
    }
  };
  await refreshFiles();

  /** Ghost remainder shown dim after the cursor (top match, not yet accepted). */
  const ghostFor = (beforeCursor: string): string => {
    const slash = beforeCursor.match(/(^|\s)(\/[A-Za-z-]*)$/);
    if (slash) {
      const prefix = slash[2] ?? "";
      const matches = COMMANDS.map((c) => c.name).filter((n) => n.startsWith(prefix) && n !== prefix);
      if (matches.length > 0) {
        const extra = matches.length > 1 ? `  (+${matches.length - 1})` : "";
        return (matches[0] ?? "").slice(prefix.length) + extra;
      }
      return "";
    }
    const mention = beforeCursor.match(/(^|\s)@([^\s]*)$/);
    if (mention) {
      const prefix = (mention[2] ?? "").toLowerCase();
      const matches = fileCache.filter((f) => f.toLowerCase().startsWith(prefix)).slice(0, 4);
      if (matches.length > 0) return (matches[0] ?? "").slice(prefix.length);
    }
    return "";
  };

  const editor = new LineEditor({
    prompt: "› ",
    completer: (before) => {
      const g = ghostFor(before);
      if (!g) return null;
      // Accept path: Tab handler asks complete() for the insert text.
      const slash = before.match(/(^|\s)(\/[A-Za-z-]*)$/);
      if (slash) {
        const prefix = slash[2] ?? "";
        const match = COMMANDS.map((c) => c.name).find((n) => n.startsWith(prefix) && n !== prefix);
        if (match) return { insert: match.slice(prefix.length) + " ", ghost: g };
      }
      const mention = before.match(/(^|\s)@([^\s]*)$/);
      if (mention) {
        const prefix = (mention[2] ?? "").toLowerCase();
        const match = fileCache.find((f) => f.toLowerCase().startsWith(prefix));
        if (match) {
          const rest = match.slice(prefix.length);
          return { insert: (rest.length > 0 ? rest : "") + " ", ghost: g };
        }
      }
      return null;
    },
  });
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
  let queue: string[] = [];
  let lastExitAttempt = 0;

  const readKey = (): Promise<string> => {
    const next = keyQueue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => keyWaiters.push(resolve));
  };

  // --- status row + spinner-aware output -------------------------------------------
  // While busy, the last screen row is always exactly one status row
  // (spinner or queue-draft echo), cursor on it, no trailing newline.
  let spinnerVisible = false;
  let spinnerFrame = 0;
  let lastPrintAt = 0;
  let queueDraft: string | null = null;
  const hideSpinner = () => {
    if (spinnerVisible) {
      process.stdout.write(CLEAR_LINE);
      spinnerVisible = false;
    }
  };
  const renderQueueDraft = (): string => {
    const shown = (queueDraft ?? "").replace(/\n/g, "⏎");
    return `… queue: ${shown}`;
  };
  const drawStatus = () => {
    if (exiting || !busy || overlayOpen) return;
    const elapsed = ((Date.now() - turnStartedAt) / 1000).toFixed(0);
    const frame = SPINNER[spinnerFrame++ % SPINNER.length];
    const text = queueDraft !== null ? renderQueueDraft() : `${frame} ${elapsed}s · ${activity} (Ctrl+C/Esc abort, type to queue)`;
    process.stdout.write(CLEAR_LINE + theme.muted(text));
    spinnerVisible = true;
  };
  const print = (s: string) => {
    hideSpinner();
    process.stdout.write(s + "\n");
    lastPrintAt = Date.now();
    if (busy && !overlayOpen) drawStatus();
  };
  const printRaw = (s: string) => {
    hideSpinner();
    process.stdout.write(s);
    lastPrintAt = Date.now();
    if (busy && !overlayOpen) drawStatus();
  };
  const info = (s: string) => print(theme.muted(s));

  const tick = () => {
    if (exiting || !busy || overlayOpen) return;
    if (Date.now() - lastPrintAt < 300) return;
    drawStatus();
  };
  const spinner = setInterval(tick, 120);

  const modeLabel = () => {
    const mode = session.approvalMode();
    return mode === "ask" ? "manual" : mode;
  };

  const printHeader = () => {
    const m = session.modelInfo();
    print(theme.bold("kern") + theme.muted(`  ${m.provider}/${m.modelId}  ·  ${modeLabel()}  ·  ${cwd}`));
    info("Type a task, or /help for commands.");
    info(HINTS);
  };

  const printStatus = () => {
    const u = session.budgetUsage();
    const m = session.modelInfo();
    const usage = session.contextUsage();
    const ctx = usage ? ` · ctx ${Math.round((usage.totalTokens / m.contextWindow) * 100)}%` : "";
    info(`— ${m.provider}/${m.modelId} · ${modeLabel()} · ${u.turns} turns · ${u.totalToolCalls} calls · ${(u.wallTimeMs / 1000).toFixed(1)}s${ctx}`);
  };

  // --- event → transcript -----------------------------------------------------
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

  // --- permission dialog (arrows + Esc; Esc declines) ---------------------------
  options.approvalHook.current = async (
    prompt: string,
    meta?: { toolName: string },
  ): Promise<boolean | "session"> => {
    editor.suspend();
    hideSpinner();
    lastPrintAt = Date.now();
    const tool = meta?.toolName ?? "tool";
    overlayOpen = true;
    const overlay = new SelectOverlay<string>(
      `${theme.warn("Approval:")} ${tool}`,
      [
        { label: "Yes, run once", value: "once" },
        { label: `Yes, always allow ${tool} this session`, value: "session" },
        { label: "No", hint: "Esc", value: "no" },
      ],
    );
    print(theme.muted(prompt));
    const picked = await overlay.run(readKey);
    overlayOpen = false;
    lastPrintAt = Date.now();
    if (picked === "session") {
      print(theme.success(`Always allowing ${tool} for this session.`));
      if (!busy) editor.resume();
      return "session";
    }
    const ok = picked === "once";
    print(ok ? theme.success("approved") : theme.muted("denied"));
    if (!busy) editor.resume();
    return ok;
  };

  // --- transcript export ---------------------------------------------------------
  const exportTranscript = async (file?: string): Promise<void> => {
    const path = manager.getActivePath();
    const target = file ?? join(cwd, `kern-session-${manager.sessionId ?? "export"}.md`);
    const lines: string[] = [`# kern session`, ""];
    const m = session.modelInfo();
    lines.push(`- model: ${m.provider}/${m.modelId}`, `- cwd: ${cwd}`, "");
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

  // --- @mention expansion ----------------------------------------------------------
  const expandMentions = async (text: string): Promise<{ text: string; missing: string[] }> => {
    const missing: string[] = [];
    const refs = [...new Set([...text.matchAll(/(^|\s)@([^\s]+)/g)].map((m) => m[2] ?? ""))].filter(Boolean);
    let out = text;
    for (const ref of refs) {
      const abs = resolve(cwd, ref);
      let content: string;
      try {
        const st = await stat(abs);
        if (!st.isFile()) {
          missing.push(ref);
          continue;
        }
        if (st.size > 40_000) {
          content = (await readFile(abs, "utf8")).slice(0, 40_000) + "\n[…truncated…]";
        } else {
          content = await readFile(abs, "utf8");
        }
      } catch {
        missing.push(ref);
        continue;
      }
      out = out.split(`@${ref}`).join(`<file path="${ref}">\n${content}\n</file>`);
    }
    return { text: out, missing };
  };

  // --- /model picker ------------------------------------------------------------------
  const pickModel = async (initialFilter?: string) => {
    if (busy) {
      info("Runs immediately like other commands — but wait for the turn to settle first.");
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

  // --- history search (Ctrl+R) -----------------------------------------------------------
  const historySearch = async () => {
    if (busy || overlayOpen) return;
    overlayOpen = true;
    editor.suspend();
    const items = recentPrompts.length > 0 ? recentPrompts : ["(no history yet)"];
    const overlay = new SelectOverlay("history", items.map((h) => ({ label: truncateToWidth(h, 100), value: h, disabled: h.startsWith("(") })));
    const picked = await overlay.run(readKey);
    overlayOpen = false;
    if (picked && !picked.startsWith("(")) editor.setText(picked);
    else editor.resume();
  };
  const recentPrompts: string[] = [];

  // --- mode cycle (Shift+Tab) -----------------------------------------------------------------
  const cycleMode = () => {
    if (busy) {
      info("Mode changes apply when idle.");
      return;
    }
    const current = session.approvalMode();
    const next = current === "ask" ? "auto-allowlist" : "ask";
    if (session.setApprovalMode(next as "ask" | "auto-allowlist")) {
      print(theme.accent(`Approval mode: ${next === "ask" ? "manual (ask)" : "auto (no per-op prompts; destructive still asks)"}`));
    } else {
      info("Approval mode is fixed by the active policy.");
    }
  };

  // --- slash commands ------------------------------------------------------------------------------
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
      case "/diff": {
        try {
          const res = await session.callToolAsUser("bash", { command: "git diff --stat; git status --short | head -20" });
          const text = res.content.map((c) => c.text).join("\n") || "(clean)";
          print(theme.bold("working tree"));
          print(text);
          if (res.isError) info("Not a git repository, or git failed.");
        } catch (error) {
          print(theme.error(`Diff failed: ${error instanceof Error ? error.message : String(error)}`));
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
          queue = [];
          subscribe();
          await refreshFiles();
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

  // --- prompt submission -------------------------------------------------------------------------------
  const runTurn = (text: string) => {
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
        queueDraft = null;
        if (!exiting) {
          printStatus();
          void refreshFiles();
          const next = queue.shift();
          if (next !== undefined) {
            info(`[sending queued message${queue.length > 0 ? ` (+${queue.length} more)` : ""}]`);
            runTurn(next);
          } else {
            editor.resume();
          }
        }
      });
  };

  /** `!cmd`: run directly, show output, and have the agent respond to it. */
  const runShellMode = async (command: string) => {
    editor.suspend();
    print(theme.tool(`◈ !${command}`));
    try {
      const res = await session.callToolAsUser("bash", { command });
      const output = res.content.map((c) => c.text).join("\n");
      const lines = output.split("\n").slice(0, 60);
      for (const l of lines) print(theme.muted(`  ${l}`));
      if (output.split("\n").length > 60) info(`[…${output.split("\n").length - 60} more lines in context]`);
      runTurn(`I ran \`${command}\` in shell mode. Output:\n${output}\n\nRespond to it.`);
    } catch (error) {
      print(theme.error(`Shell command failed: ${error instanceof Error ? error.message : String(error)}`));
      editor.resume();
    }
  };

  /** Strip invisible/confusable Unicode. Returns null when clean. */
  const cleanInvisible = (text: string): { cleaned: string; removed: number } => {
    const matches = text.match(INVISIBLE_RE);
    const removed = matches ? matches.length : 0;
    return { cleaned: text.replace(INVISIBLE_RE, ""), removed };
  };

  const submit = (line: string) => {
    if (exiting) return;
    if (busy) return; // typed input queues via the stdin handler, not submit
    const raw = line.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
    if (!raw.trim()) {
      editor.resume();
      return;
    }
    const trimmed = raw.trim();
    if (trimmed === "?") {
      void (async () => {
        editor.suspend();
        await runCommand("/help");
        editor.resume();
      })();
      return;
    }
    if (trimmed.startsWith("!") && !trimmed.startsWith("!=")) {
      const command = trimmed.slice(1).trim();
      if (!command) {
        editor.resume();
        return;
      }
      recentPrompts.push(trimmed);
      void runShellMode(command);
      return;
    }
    if (trimmed.startsWith("/")) {
      void (async () => {
        editor.suspend();
        let keep = true;
        try {
          keep = await runCommand(trimmed);
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
    const { cleaned, removed } = cleanInvisible(raw);
    if (removed > 0) {
      editor.setText(cleaned);
      info(`Removed ${removed} invisible character${removed === 1 ? "" : "s"} · review and press Enter to send.`);
      return;
    }
    void (async () => {
      const { text, missing } = await expandMentions(raw);
      for (const m of missing) info(`@${m}: file not found — sent literally.`);
      recentPrompts.push(raw);
      if (recentPrompts.length > 200) recentPrompts.splice(0, recentPrompts.length - 200);
      runTurn(text);
    })();
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

  const requestExit = () => {
    const now = Date.now();
    if (now - lastExitAttempt < 800) {
      void exit();
      return;
    }
    lastExitAttempt = now;
    info("Press Ctrl+D again to exit.");
  };

  // --- stdin -------------------------------------------------------------------------------------
  process.stdout.write(ENABLE_PASTE);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  // Escape-sequence coalescing: an ESC at the end of a chunk may be the head
  // of an arrow/alt sequence split across reads. Hold it briefly; a lone Esc
  // (cancel/clear) still resolves after the window.
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  let heldChunk = "";
  const dispatch = (chunk: string) => {
    for (const key of splitKeys(chunk)) {
      if (overlayOpen) {
        const waiter = keyWaiters.shift();
        if (waiter) waiter(key);
        else keyQueue.push(key);
        continue;
      }
      if (busy) {
        // Approval prompt reads through readKey even mid-turn.
        if (keyWaiters.length > 0) {
          const waiter = keyWaiters.shift();
          if (waiter) waiter(key);
          continue;
        }
        // Ctrl+C / lone Esc aborts (queued messages still send next).
        if (key === "\u0003" || key === "\u001b") {
          abort?.abort();
          continue;
        }
        // Enter queues the draft; other keys build it on the status row.
        if (key === "\r" || key === "\n") {
          const text = (queueDraft ?? "").trim();
          if (text) {
            if (queue.length >= MAX_QUEUE) {
              print(theme.muted(`Queue full (${MAX_QUEUE}) — wait for the turn to settle.`));
            } else {
              queue.push(queueDraft ?? "");
              queueDraft = null;
              info(`[queued ${queue.length}]`);
            }
          }
          continue;
        }
        if (key === "\u007f" || key === "\b") {
          if (queueDraft !== null && queueDraft.length > 0) {
            queueDraft = queueDraft.slice(0, -1);
            drawStatus();
          }
          continue;
        }
        if (key === "\u0015") {
          queueDraft = null;
          drawStatus();
          continue;
        }
        if (key.startsWith("\u001b[200~")) {
          const pasted = key.replace(/^\u001b\[200~/, "").replace(/\u001b\[201~$/, "");
          queueDraft = (queueDraft ?? "") + pasted;
          drawStatus();
          continue;
        }
        if (key.length === 1 && key >= " " && !/[\u0000-\u001f\u007f]/.test(key)) {
          queueDraft = (queueDraft ?? "") + key;
          drawStatus();
          continue;
        }
        continue;
      }
      // approval prompt reads through readKey even when idle
      if (keyWaiters.length > 0) {
        const waiter = keyWaiters.shift();
        if (waiter) waiter(key);
        continue;
      }
      if (key === "\u001b[Z") {
        cycleMode(); // Shift+Tab
        continue;
      }
      editor.handleKey(key);
    }
  };
  process.stdin.on("data", (chunk: string) => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
      const combined = heldChunk + chunk;
      heldChunk = "";
      dispatch(combined);
      return;
    }
    if (chunk.endsWith("\u001b")) {
      heldChunk = chunk;
      escTimer = setTimeout(() => {
        escTimer = null;
        const pending = heldChunk;
        heldChunk = "";
        dispatch(pending);
      }, 40);
      return;
    }
    dispatch(chunk);
  });

  printHeader();
  editor.start({
    onSubmit: submit,
    onAbort: () => abort?.abort(),
    onExit: requestExit,
    onHistorySearch: () => void historySearch(),
    onModeCycle: cycleMode,
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

/** Workspace-relative file list for @ mentions. Skips heavy/ignored dirs. */
async function listWorkspaceFiles(cwd: string, limit = 3000): Promise<string[]> {
  const skip = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "__pycache__", ".venv", "target"]);
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (out.length >= limit) return;
      if (name.startsWith(".")) {
        if (name !== ".agents" && name !== ".kern") continue;
      }
      if (skip.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) await walk(abs, depth + 1);
      else if (st.isFile()) out.push(relative(cwd, abs).split(sep).join("/"));
    }
  };
  await walk(cwd, 0);
  return out;
}
