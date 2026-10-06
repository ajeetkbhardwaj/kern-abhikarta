/**
 * @kern/tui — interactive orchestrator on the pi-tui framework.
 *
 * Main-screen renderer (native scrollback), transcript Container, Markdown
 * streaming with syntax highlighting, Editor with slash/file completion,
 * SelectList overlays for approvals / model picker / history, Loader
 * spinner while busy. The TUI observes `AgentEvent`s and acts only through
 * the `AgentSession` API — all kernel guarantees hold unchanged.
 */

import { writeFile, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  ProcessTerminal,
  TuiMainScreen,
  Container,
  Text,
  Editor,
  Markdown,
  SelectList,
  CombinedAutocompleteProvider,
  Spacer,
  Loader,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentEvent, Logger, ModelAdapter } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import type { AgentSession } from "@kern/coding-agent";
import type { SessionManager } from "@kern/session-store";
import { createAdapterFor, discoverModels, type ModelsFile } from "@kern/model";
import { theme } from "./theme.js";

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

const COMMANDS: Array<{ name: string; description: string }> = [
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
const INVISIBLE_RE = /[‌‎‏‪-‮⁠-⁤﻿]/gu;

const editorTheme = {
  borderColor: theme.muted,
  selectList: {
    selectedPrefix: theme.accent,
    selectedText: theme.bold,
    description: theme.muted,
    scrollInfo: theme.muted,
    noMatch: theme.muted,
  },
};

const mdTheme = {
  heading: (s: string) => theme.accent(theme.bold(s)),
  link: (s: string) => `\u001b[4;36m${s}\u001b[0m`,
  linkUrl: theme.muted,
  code: theme.tool,
  codeBlock: (s: string) => s,
  codeBlockBorder: theme.muted,
  quote: theme.muted,
  quoteBorder: theme.muted,
  hr: theme.muted,
  listBullet: theme.accent,
  bold: theme.bold,
  italic: (s: string) => `\u001b[3m${s}\u001b[0m`,
  strikethrough: (s: string) => `\u001b[9m${s}\u001b[0m`,
  underline: (s: string) => `\u001b[4m${s}\u001b[0m`,
  highlightCode,
};

/** Minimal keyword/string/comment/number highlighter for fenced code. */
function highlightCode(code: string): string[] {
  const keywords =
    /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|interface|type|enum|def|elif|fn|struct|impl|match|use|pub|echo|then|fi|do|done|null|true|false|None|True|False)\b/g;
  return code.split("\n").map((line) => {
    const comment = line.match(/(\/\/|#|--).*$/);
    let body = line;
    let tail = "";
    if (comment && !/^(\s* погрешность)/.test(line)) {
      const idx = comment.index ?? line.length;
      tail = theme.muted(line.slice(idx));
      body = line.slice(0, idx);
    }
    body = body
      .replace(/("[^"]*"|'[^']*'|`[^`]*`)/g, (m) => theme.tool(m))
      .replace(keywords, (m) => theme.accent(m))
      .replace(/\b(\d[\d._]*)\b/g, (m) => `\u001b[33m${m}\u001b[0m`);
    return body + tail;
  });
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const logger = options.logger ?? nullLogger;
  let session = options.session;
  let manager = options.manager;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY");
  }
  const cwd = resolve(options.cwd);

  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiMainScreen(terminal);
  const transcript = new Container();
  const status = new Text("", 0, 0);
  const editor = new Editor(tui, editorTheme);
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, cwd));

  tui.addChild(transcript);
  tui.addChild(status);
  tui.addChild(editor);
  tui.setFocus(editor);

  let busy = false;
  let abort: AbortController | null = null;
  let exiting = false;
  let unsubscribe: (() => void) | null = null;
  let activity = "thinking";
  let loader: Loader | null = null;
  let loaderMsg = "thinking";
  let queue: string[] = [];
  let lastExitAttempt = 0;
  let stash = "";
  const recentPrompts: string[] = [];

  const say = (text: string) => {
    transcript.addChild(new Text(text, 0, 0));
    tui.requestRender();
  };
  const info = (text: string) => say(theme.muted(text));
  const err = (text: string) => say(theme.error(text));
  const ok = (text: string) => say(theme.success(text));

  const setBusy = (running: boolean) => {
    busy = running;
    if (running) {
      loaderMsg = activity;
      loader = new Loader(tui, theme.accent, theme.muted, loaderMsg);
      transcript.addChild(loader);
      loader.start();
    } else if (loader) {
      loader.stop();
      transcript.removeChild(loader);
      loader = null;
    }
    tui.requestRender();
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
    tui.requestRender();
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
            md = new Markdown("", 0, 0, mdTheme);
            transcript.addChild(md);
          }
          mdText += event.delta;
          md.setText(mdText);
          tui.requestRender();
          break;
        case "reasoning_delta":
          activity = "thinking";
          if (loader) loader.setMessage("thinking");
          break;
        case "message_end":
          closeAssistant();
          transcript.addChild(new Spacer(1));
          tui.requestRender();
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
      const list = new SelectList(
        [
          { value: "once", label: "Yes, run once" },
          { value: "session", label: `Yes, always allow ${tool} this session` },
          { value: "no", label: "No" },
        ],
        5,
        editorTheme.selectList,
      );
      list.onSelect = (item) => {
        tui.hideOverlay();
        tui.setFocus(editor);
        resolve(item.value);
      };
      list.onCancel = () => {
        tui.hideOverlay();
        tui.setFocus(editor);
        resolve(null);
      };
      say(theme.warn(`Approval: ${tool} — ${prompt}`));
      tui.showOverlay(list);
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
  const withOverlay = async <T>(list: SelectList, onPick: (value: string) => Promise<void> | void): Promise<void> => {
    await new Promise<void>((resolve) => {
      list.onSelect = (item) => {
        tui.hideOverlay();
        tui.setFocus(editor);
        void Promise.resolve(onPick(item.value)).finally(() => resolve());
      };
      list.onCancel = () => {
        tui.hideOverlay();
        tui.setFocus(editor);
        resolve();
      };
      tui.showOverlay(list);
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
    const list = new SelectList(
      [...models]
        .sort((a, b) => Number(b.authenticated) - Number(a.authenticated))
        .map((m) => ({
          value: `${m.provider}/${m.id}`,
          label: `${m.provider}/${m.id}${m.provider === current.provider && m.id === current.modelId ? "  (current)" : ""}`,
          description: `${m.source}${m.authenticated ? "" : " · no credentials"}`,
        })),
      10,
      editorTheme.selectList,
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
    const items = recentPrompts.length > 0 ? recentPrompts : [];
    if (items.length === 0) {
      info("No history yet.");
      return;
    }
    const list = new SelectList(
      [...items].reverse().map((h) => ({ value: h, label: h.length > 100 ? h.slice(0, 100) + "…" : h })),
      10,
      editorTheme.selectList,
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

  // --- prompt submission --------------------------------------------------------------------
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
        if (!keep) void exit();
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
    tui.renderNow(true);
    tui.stop();
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
  tui.addInputListener((data) => {
    if (tui.hasOverlay()) return undefined; // overlays own Esc/arrows/Enter
    if (matchesKey(data, "ctrl+c")) {
      if (busy) {
        abort?.abort();
        return { consume: true };
      }
      if (editor.getText().length === 0) requestExit();
      else editor.setText("");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d")) {
      if (editor.getText().length === 0) requestExit();
      return editor.getText().length === 0 ? { consume: true } : undefined;
    }
    if (matchesKey(data, "ctrl+s")) {
      if (editor.getText().length > 0) {
        stash = editor.getText();
        editor.setText("");
      } else if (stash) {
        editor.setText(stash);
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+r")) {
      if (!busy) void historySearch();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+l")) {
      tui.requestRender(true);
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab")) {
      if (!busy) cycleMode();
      return { consume: true };
    }
    return undefined;
  });

  printHeader();
  printStatus();
  tui.start();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (exiting) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}
