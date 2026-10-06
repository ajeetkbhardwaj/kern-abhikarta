/**
 * @kern/tui — interactive orchestrator on our own component framework.
 *
 * Main-screen renderer (native scrollback), transcript Container, streaming
 * Markdown with syntax highlighting, Editor with slash/file completion,
 * SelectList overlays for approvals / model picker / history, Loader
 * spinner while busy. Observes `AgentEvent`s; acts only via `AgentSession`.
 */

import { writeFile, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AgentEvent, Logger, ModelAdapter } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import type { AgentSession } from "@kern/coding-agent";
import type { SessionManager } from "@kern/session-store";
import { createAdapterFor, discoverModels, type ModelsFile } from "@kern/model";
import { theme } from "./theme.js";
import { Screen } from "./screen.js";
import { Container, Text, Spacer } from "./components.js";
import { Editor, defaultEditorTheme } from "./editor.js";
import { SelectList, Loader, defaultSelectListTheme } from "./select-list.js";
import { Markdown, defaultMarkdownTheme } from "./markdown.js";
import { KernAutocomplete } from "./autocomplete.js";
import { matchesKey } from "./keys.js";

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

const COMMANDS = [
  { name: "help", description: "show this list" },
  { name: "model", description: "pick provider/model (auto-listed)" },
  { name: "compact", description: "summarize history into a checkpoint" },
  { name: "diff", description: "show working-tree changes" },
  { name: "new", description: "start a fresh session" },
  { name: "export", description: "dump transcript to markdown" },
  { name: "budget", description: "show turn/call/time usage" },
  { name: "clear", description: "clear the screen" },
  { name: "quit", description: "exit the session" },
];

const HINTS = "Enter send · Shift+Enter newline · Tab complete · @ files · ! shell · Ctrl+C abort";
const MAX_QUEUE = 5;
// Zero-width / bidi / tag invisibles (keeps ZWNJ U+200C for Persian/Indic).
const INVISIBLE_RE = /[​‎‏‪-‮⁠-⁤﻿]/gu;

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const logger = options.logger ?? nullLogger;
  let session = options.session;
  let manager = options.manager;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY");
  }
  const cwd = resolve(options.cwd);

  const screen = new Screen();
  const transcript = new Container();
  const status = new Text("", 0, 0);
  const editor = new Editor("› ");
  const autocomplete = new KernAutocomplete(COMMANDS, cwd);
  editor.setAutocompleteProvider(autocomplete);
  await autocomplete.refreshFiles();

  screen.addChild(transcript);
  screen.addChild(status);
  screen.addChild(editor);
  screen.setFocus(editor);

  let busy = false;
  let abort: AbortController | null = null;
  let exiting = false;
  let unsubscribe: (() => void) | null = null;
  let activity = "thinking";
  let loader: Loader | null = null;
  let queue: string[] = [];
  let lastExitAttempt = 0;
  let stash = "";
  const recentPrompts: string[] = [];

  const say = (text: string) => {
    transcript.addChild(new Text(text, 0, 0));
    screen.requestRender();
  };
  const info = (text: string) => say(theme.muted(text));
  const err = (text: string) => say(theme.error(text));
  const ok = (text: string) => say(theme.success(text));

  const setBusy = (running: boolean) => {
    busy = running;
    if (running) {
      loader = new Loader(() => screen.requestRender(), activity);
      transcript.addChild(loader);
      loader.start();
    } else if (loader) {
      loader.stop();
      transcript.removeChild(loader);
      loader = null;
    }
    screen.requestRender();
  };

  const modeLabel = () => (session.approvalMode() === "ask" ? "manual" : session.approvalMode());

  const printHeader = () => {
    const m = session.modelInfo();
    say(theme.bold("kern") + theme.muted(`  ${m.provider}/${m.modelId}  ·  ${modeLabel()}  ·  ${cwd}`));
    info("Type a task, or /help for commands.");
    info(HINTS);
  };

  const printStatus = () => {
    const u = session.budgetUsage();
    const m = session.modelInfo();
    const usage = session.contextUsage();
    const ctx = usage ? ` · ctx ${Math.round((usage.totalTokens / m.contextWindow) * 100)}%` : "";
    status.setText(theme.muted(`— ${m.provider}/${m.modelId} · ${modeLabel()} · ${u.turns} turns · ${u.totalToolCalls} calls · ${(u.wallTimeMs / 1000).toFixed(1)}s${ctx}`));
    screen.requestRender();
  };

  // --- event → transcript -----------------------------------------------------
  let md: Markdown | null = null;
  let mdText = "";
  const closeAssistant = () => {
    md = null;
    mdText = "";
  };

  const subscribe = () => {
    unsubscribe?.();
    unsubscribe = session.subscribe((event: AgentEvent) => {
      if (exiting) return;
      switch (event.type) {
        case "text_delta":
          if (!md) {
            say(theme.bold("assistant"));
            mdText = "";
            md = new Markdown("", defaultMarkdownTheme);
            transcript.addChild(md);
          }
          mdText += event.delta;
          md.setText(mdText);
          screen.requestRender();
          break;
        case "reasoning_delta":
          activity = "thinking";
          if (loader) loader.setMessage("thinking");
          break;
        case "message_end":
          closeAssistant();
          transcript.addChild(new Spacer(1));
          screen.requestRender();
          break;
        case "tool_execution_start":
          closeAssistant();
          activity = `running ${event.toolName}`;
          if (loader) loader.setMessage(activity);
          say(theme.tool(`◈ ${event.toolName}`));
          break;
        case "tool_execution_end":
          say(event.isError ? theme.error(`✖ ${event.toolName} failed`) : theme.success(`✔ ${event.toolName} done`));
          break;
        case "tool_execution_update":
          activity = `running ${event.toolName}`;
          if (loader) loader.setMessage(activity);
          break;
        case "auto_compaction_start":
          activity = "compacting context";
          if (loader) loader.setMessage(activity);
          info(`[compacting context (${event.phase})…]`);
          break;
        case "auto_compaction_end":
          info("[context compacted]");
          break;
        case "auto_retry_start":
          activity = `retrying (${event.reason})`;
          if (loader) loader.setMessage(activity);
          info(`[retry ${event.attempt} (${event.reason}) in ${event.delayMs}ms]`);
          break;
        case "agent_error":
          closeAssistant();
          err(`[error ${event.error.code}] ${event.error.message}`);
          break;
        case "agent_settled":
          closeAssistant();
          break;
        default:
          break;
      }
    });
  };
  subscribe();

  // --- approval dialog ----------------------------------------------------------
  options.approvalHook.current = async (
    prompt: string,
    meta?: { toolName: string },
  ): Promise<boolean | "session"> => {
    const tool = meta?.toolName ?? "tool";
    const picked = await new Promise<string | null>((resolve) => {
      const list = new SelectList<string>(
        `Approval: ${tool} — ${prompt}`,
        [
          { value: "once", label: "Yes, run once" },
          { value: "session", label: `Yes, always allow ${tool} this session` },
          { value: "no", label: "No" },
        ],
        5,
        defaultSelectListTheme,
      );
      list.onSelect = (item) => {
        screen.hideOverlay();
        screen.setFocus(editor);
        resolve(item.value);
      };
      list.onCancel = () => {
        screen.hideOverlay();
        screen.setFocus(editor);
        resolve(null);
      };
      screen.showOverlay(list);
    });
    if (picked === "session") {
      ok(`Always allowing ${tool} for this session.`);
      return "session";
    }
    const approved = picked === "once";
    say(approved ? theme.success("approved") : theme.muted("denied"));
    return approved;
  };

  // --- transcript export ----------------------------------------------------------
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
    ok(`Exported to ${target}`);
  };

  // --- @mention expansion -----------------------------------------------------------
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
        content = await readFile(abs, "utf8");
        if (content.length > 40_000) content = content.slice(0, 40_000) + "\n[…truncated…]";
      } catch {
        missing.push(ref);
        continue;
      }
      out = out.split(`@${ref}`).join(`<file path="${ref}">\n${content}\n</file>`);
    }
    return { text: out, missing };
  };

  // --- overlays: model picker, history -------------------------------------------------
  const withOverlay = async (list: SelectList<string>, onPick: (value: string) => Promise<void> | void): Promise<void> => {
    await new Promise<void>((resolve) => {
      list.onSelect = (item) => {
        screen.hideOverlay();
        screen.setFocus(editor);
        void Promise.resolve(onPick(item.value)).finally(() => resolve());
      };
      list.onCancel = () => {
        screen.hideOverlay();
        screen.setFocus(editor);
        resolve();
      };
      screen.showOverlay(list);
    });
  };

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
      err(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (models.length === 0) {
      err("No models found. Add providers to ~/.kern/models.json or set KERN_BASE_URL.");
      return;
    }
    const current = session.modelInfo();
    const list = new SelectList<string>(
      "model",
      [...models]
        .sort((a, b) => Number(b.authenticated) - Number(a.authenticated))
        .map((m) => ({
          value: `${m.provider}/${m.id}`,
          label: `${m.provider}/${m.id}${m.provider === current.provider && m.id === current.modelId ? "  (current)" : ""}`,
          description: `${m.source}${m.authenticated ? "" : " · no credentials"}`,
        })),
      10,
      defaultSelectListTheme,
    );
    if (initialFilter) list.setFilter(initialFilter);
    await withOverlay(list, async (value) => {
      const slash = value.indexOf("/");
      const provider = value.slice(0, slash);
      const id = value.slice(slash + 1);
      try {
        const adapter: ModelAdapter = await createAdapterFor(
          options.modelsFile,
          provider,
          id,
          { baseUrl: options.baseUrl, apiKey: options.apiKey },
          logger,
        );
        await session.setModel(adapter);
        ok(`Model: ${provider}/${id}`);
      } catch (error) {
        err(`Model switch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  const historySearch = async () => {
    if (busy) return;
    if (recentPrompts.length === 0) {
      info("No history yet.");
      return;
    }
    const list = new SelectList<string>(
      "history",
      [...recentPrompts].reverse().map((h) => ({ value: h, label: h.length > 100 ? h.slice(0, 100) + "…" : h })),
      10,
      defaultSelectListTheme,
    );
    await withOverlay(list, (value) => editor.setText(value));
  };

  const cycleMode = () => {
    if (busy) {
      info("Mode changes apply when idle.");
      return;
    }
    const current = session.approvalMode();
    const next = current === "ask" ? "auto-allowlist" : "ask";
    if (session.setApprovalMode(next as "ask" | "auto-allowlist")) {
      ok(`Approval mode: ${next === "ask" ? "manual (ask)" : "auto (no per-op prompts; destructive still asks)"}`);
      printStatus();
    } else {
      info("Approval mode is fixed by the active policy.");
    }
  };

  // --- slash commands -------------------------------------------------------------------
  const runCommand = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/help":
        for (const c of COMMANDS) say(`  ${theme.accent("/" + c.name)}  ${theme.muted(c.description)}`);
        info(HINTS);
        return true;
      case "/quit":
      case "/exit":
        return false;
      case "/clear":
        transcript.clear();
        printHeader();
        printStatus();
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
          else ok(`Compacted through ${result.replacesThroughId}.`);
        } catch (error) {
          err(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return true;
      }
      case "/diff": {
        try {
          const res = await session.callToolAsUser("bash", { command: "git diff --stat; git status --short | head -20" });
          const text = res.content.map((c) => c.text).join("\n") || "(clean)";
          say(theme.bold("working tree"));
          say(text);
          if (res.isError) info("Not a git repository, or git failed.");
        } catch (error) {
          err(`Diff failed: ${error instanceof Error ? error.message : String(error)}`);
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
          await autocomplete.refreshFiles();
          transcript.clear();
          printHeader();
          printStatus();
          info(`New session started.`);
        } catch (error) {
          err(`New session failed: ${error instanceof Error ? error.message : String(error)}`);
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
          err(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return true;
      }
      default:
        err(`Unknown command: ${cmd ?? ""}. Try /help.`);
        return true;
    }
  };

  // --- prompt submission ---------------------------------------------------------------------
  const runTurn = (text: string) => {
    busy = true;
    abort = new AbortController();
    activity = "thinking";
    setBusy(true);
    say(theme.bold("you"));
    say(theme.muted(text));
    session
      .prompt(text, { signal: abort.signal })
      .catch((error: unknown) => {
        err(`Turn failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        setBusy(false);
        busy = false;
        abort = null;
        if (!exiting) {
          printStatus();
          void autocomplete.refreshFiles();
          const next = queue.shift();
          if (next !== undefined) {
            info(`[sending queued message${queue.length > 0 ? ` (+${queue.length} more)` : ""}]`);
            runTurn(next);
          }
        }
      });
  };

  /** `!cmd`: run directly, show output, and have the agent respond to it. */
  const runShellMode = async (command: string) => {
    say(theme.tool(`◈ !${command}`));
    try {
      const res = await session.callToolAsUser("bash", { command });
      const output = res.content.map((c) => c.text).join("\n");
      say(theme.muted(output.split("\n").slice(0, 60).join("\n")));
      if (output.split("\n").length > 60) info(`[…${output.split("\n").length - 60} more lines in context]`);
      runTurn(`I ran \`${command}\` in shell mode. Output:\n${output}\n\nRespond to it.`);
    } catch (error) {
      err(`Shell command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const submit = (line: string) => {
    if (exiting) return;
    if (busy) {
      const text = line.trim();
      if (text) {
        if (queue.length >= MAX_QUEUE) info(`Queue full (${MAX_QUEUE}) — wait for the turn to settle.`);
        else {
          queue.push(line);
          info(`[queued ${queue.length}]`);
        }
      }
      return;
    }
    const raw = line.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
    if (!raw.trim()) return;
    const trimmed = raw.trim();
    editor.clear();
    screen.requestRender();
    if (trimmed === "?") {
      void runCommand("/help");
      return;
    }
    if (trimmed.startsWith("!") && !trimmed.startsWith("!=")) {
      const command = trimmed.slice(1).trim();
      if (!command) return;
      recentPrompts.push(trimmed);
      editor.addToHistory(trimmed);
      void runShellMode(command);
      return;
    }
    if (trimmed.startsWith("/")) {
      editor.addToHistory(trimmed);
      void (async () => {
        let keep = true;
        try {
          keep = await runCommand(trimmed);
        } catch (error) {
          err(String(error));
        }
        if (!keep) exit();
      })();
      return;
    }
    const matches = raw.match(INVISIBLE_RE);
    const removed = matches ? matches.length : 0;
    const cleaned = raw.replace(INVISIBLE_RE, "");
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
      editor.addToHistory(raw);
      runTurn(text);
    })();
  };

  editor.onSubmit = submit;

  const exit = () => {
    if (exiting) return;
    exiting = true;
    abort?.abort();
    options.approvalHook.current = null;
    unsubscribe?.();
    say(theme.muted("bye."));
    screen.renderNow();
    screen.stop();
    process.exit(0);
  };

  const requestExit = () => {
    const now = Date.now();
    if (now - lastExitAttempt < 800) {
      exit();
      return;
    }
    lastExitAttempt = now;
    info("Press Ctrl+D again to exit.");
  };

  // --- global keys ----------------------------------------------------------------------------
  screen.setInputHook((key) => {
    if (screen.hasOverlay()) return undefined; // overlays own Esc/arrows/Enter
    if (matchesKey(key, "ctrl+c")) {
      if (busy) {
        abort?.abort();
        return { consume: true };
      }
      if (editor.getText().length === 0) requestExit();
      else editor.setText("");
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+d")) {
      if (editor.getText().length === 0) requestExit();
      return editor.getText().length === 0 ? { consume: true } : undefined;
    }
    if (matchesKey(key, "ctrl+s")) {
      editor.stashPrompt();
      screen.requestRender();
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+r")) {
      if (!busy) void historySearch();
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+l")) {
      screen.requestRender();
      return { consume: true };
    }
    if (matchesKey(key, "shift+tab")) {
      if (!busy) cycleMode();
      return { consume: true };
    }
    return undefined;
  });

  printHeader();
  printStatus();
  screen.start();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (exiting) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}
