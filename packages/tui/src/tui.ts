/**
 * @kern/tui — interactive orchestrator on @earendil-works/pi-tui.
 *
 * Main-screen renderer (native scrollback), transcript Container, streaming
 * Markdown with syntax highlighting, Editor with slash/file completion,
 * SelectList overlays for approvals / model picker / history, Loader
 * spinner while busy. Observes `AgentEvent`s; acts only via `AgentSession`.
 *
 * pi-tui adaptation notes:
 * - Overlays are shown with `showOverlay(c, {anchor:"center", width:"80%",
 *   maxHeight:"80%"})`, which returns a handle with `.hide()`.
 * - SelectList takes no title and no disabled items: titles render as a
 *   `Text` header above the list, and unavailable options get a suffix with
 *   their selection ignored.
 * - Editor has no onEscape: prompt dialogs emulate Esc-cancel via the
 *   input listener, which runs BEFORE focused components (a handled Esc
 *   returns `{consume:true}` to preempt the dialog's editor).
 * - Input keys reach the focused component; overlay roots are wrapped in a
 *   local `OverlayDialog` that forwards keys to the interactive child.
 */

import { writeFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentEvent, Logger, ModelAdapter } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import type { AgentSession } from "@kern/coding-agent";
import type { SessionManager } from "@kern/session-store";
import { createAdapterFor, discoverModels, loadModelsFile, readLastUsed, recordLastUsed, resolveApiKey, saveAuthKey, saveProviderToUserFile, testProvider, PROVIDER_PRESETS, type ModelsFile, type ProviderConfig } from "@kern/model";
import {
  TuiMainScreen,
  ProcessTerminal,
  Editor,
  SelectList,
  Markdown,
  Loader,
  matchesKey,
  type Component,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { theme, statusBg, buildMarkdownTheme, buildSelectTheme, buildEditorTheme, highlightCode } from "./theme.js";
import { Box, StatusBar, ToolCard, Rule, Container, Text, Spacer } from "./components.js";
import { buildAutocomplete } from "./autocomplete.js";

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
  { name: "models", description: "alias for /model" },
  { name: "keys", description: "re-auth the current provider" },
  { name: "connect", description: "connect a provider (key or local URL)" },
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

void statusBg;
void highlightCode;

/**
 * Overlay root: renders a teammate-owned Box, forwards keys to the
 * interactive child. pi-tui focuses the overlay root component, so without
 * this wrapper keys would never reach a SelectList/Editor nested inside.
 */
class OverlayDialog implements Component {
  constructor(
    private readonly root: Component,
    private readonly target: Component,
  ) {}
  render(width: number): string[] {
    return this.root.render(width);
  }
  handleInput(data: string): void {
    this.target.handleInput?.(data);
  }
  invalidate(): void {
    this.root.invalidate();
  }
}

const OVERLAY_OPTS = { anchor: "center" as const, width: "80%" as const, maxHeight: "80%" as const };

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const logger = options.logger ?? nullLogger;
  let session = options.session;
  let manager = options.manager;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY");
  }
  const cwd = resolve(options.cwd);

  const tui = new TuiMainScreen(new ProcessTerminal());
  const transcript = new Container();
  const statusBar = new StatusBar();
  const editor = new Editor(tui, buildEditorTheme(), { autocompleteMaxVisible: 8 });
  const autocomplete = buildAutocomplete(COMMANDS, cwd);
  editor.setAutocompleteProvider(autocomplete);

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
  let lastUserPrompt = "";
  let authOverlayOpen = false;
  /** Assigned after runCommand/runTurn exist; subscribe() may fire earlier. */
  let handleAuthError: (message: string) => void = () => {};
  /** Open text-prompt dialog (Esc cancels via the input listener). */
  let promptDialog: { cancel: () => void } | null = null;
  /** Empty-state suggestion overlay state (digits 1-3 fill, never send). */
  let suggestionsOpen = false;
  let suggestionPick: ((value: string) => void) | null = null;
  const SUGGESTION_DIGITS = ["1", "2", "3"] as const;

  // Toasts live one row above the queue panel: transient notices that
  // auto-expire without disturbing the transcript. Errors stay persistent
  // via err()/say() and never route here.
  const toastLine = new Text("", 0, 0);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let toastToken = 0;
  const toast = (text: string) => {
    const token = ++toastToken;
    toastLine.setText(theme.muted(`● ${text}`));
    tui.requestRender();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (token !== toastToken || exiting) return;
      toastLine.setText("");
      tui.requestRender();
    }, 4000);
  };

  // Queue visibility: numbered list above the editor. Reads `queue` live;
  // callers just mutate the array and request a render.
  const queuePanel: Component = {
    render(_width: number): string[] {
      if (queue.length === 0) return [];
      const rows: string[] = [
        theme.muted(`queued (${queue.length}/${MAX_QUEUE}) · Ctrl+Q clears · ⌫ on empty prompt removes last`),
      ];
      queue.forEach((q, i) => {
        const oneLine = q.replace(/\s+/g, " ").trim();
        const short = oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
        rows.push(theme.muted(`  ${i + 1}. ${short}`));
      });
      return rows;
    },
    invalidate(): void {},
  };
  const renderQueue = () => tui.requestRender();

  tui.addChild(transcript);
  tui.addChild(statusBar);
  tui.addChild(toastLine);
  tui.addChild(queuePanel);
  tui.addChild(editor);
  tui.setFocus(editor);

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
      loader = new Loader(tui, theme.accent, theme.muted, activity);
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
    const head = new Box(
      new Text(`${theme.bold("kern")}  ${m.provider}/${m.modelId}  ·  ${modeLabel()}  ·  ${cwd}`, 1, 0),
      { title: "kern" },
    );
    transcript.addChild(head);
    info("Type a task, or /help for commands.");
    info(HINTS);
    transcript.addChild(new Rule());
    tui.requestRender();
  };

  const printStatus = () => {
    const u = session.budgetUsage();
    const m = session.modelInfo();
    const usage = session.contextUsage();
    const ctx = usage ? `ctx ${Math.round((usage.totalTokens / m.contextWindow) * 100)}%` : "ctx —";
    statusBar.setSegments([
      `${m.provider}/${m.modelId}`,
      modeLabel(),
      ctx,
      `${u.turns} turns · ${u.totalToolCalls} calls · ${(u.wallTimeMs / 1000).toFixed(1)}s`,
    ]);
    tui.requestRender();
  };

  // --- event → transcript -----------------------------------------------------
  let md: Markdown | null = null;
  let mdText = "";
  const cards = new Map<string, ToolCard>();
  const closeAssistant = () => {
    md = null;
    mdText = "";
  };

  /** Persistent error card for auth failures; recovery choices follow via overlay. */
  const showAuthCard = (message: string) => {
    const body = new Text(
      `${theme.error("Auth failed — the model rejected our credentials.")}\n${theme.muted(message)}\n${theme.muted("Pick a fix in the dialog above (Esc dismisses). /keys re-auths, /model switches.")}`,
      0,
      0,
    );
    transcript.addChild(new Box(body, { title: "auth error", mood: "error" }));
    tui.requestRender();
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
            md = new Markdown("", 0, 0, buildMarkdownTheme());
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
        case "tool_execution_start": {
          closeAssistant();
          activity = `running ${event.toolName}`;
          if (loader) loader.setMessage(activity);
          const card = new ToolCard(event.toolName, summarizeArgs(event.arguments));
          cards.set(event.toolCallId, card);
          transcript.addChild(new Box(card, {}));
          tui.requestRender();
          break;
        }
        case "tool_execution_end": {
          const card = cards.get(event.toolCallId);
          cards.delete(event.toolCallId);
          const output = event.result
            ? event.result.content.map((c) => c.text).join("\n")
            : "";
          if (card) {
            if (output) card.appendOutput(output);
            card.finish(event.isError);
          } else {
            say(event.isError ? theme.error(`✖ ${event.toolName} failed`) : theme.success(`✔ ${event.toolName} done`));
          }
          tui.requestRender();
          break;
        }
        case "tool_execution_update": {
          activity = `running ${event.toolName}`;
          if (loader) loader.setMessage(activity);
          const card = cards.get(event.toolCallId);
          if (card && typeof event.delta === "string") card.appendOutput(event.delta);
          tui.requestRender();
          break;
        }
        case "auto_compaction_start":
          activity = "compacting context";
          if (loader) loader.setMessage(activity);
          toast(`compacting context (${event.phase})…`);
          break;
        case "auto_compaction_end":
          toast("context compacted");
          break;
        case "auto_retry_start":
          activity = `retrying (${event.reason})`;
          if (loader) loader.setMessage(activity);
          toast(`retry ${event.attempt} (${event.reason}) in ${event.delayMs}ms`);
          break;
        case "agent_error":
          closeAssistant();
          err(`[error ${event.error.code}] ${event.error.message}`);
          if (event.error.code === "E_MODEL_AUTH") {
            showAuthCard(event.error.message);
            handleAuthError(event.error.message);
          }
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

  // Small local list of destructive shell patterns. Matched against the
  // approval prompt text; hits render the dialog in a danger style.
  const DESTRUCTIVE_PATTERNS: RegExp[] = [
    /\brm\s+.*-[a-z]*r[a-z]*f\b/i,
    /\brm\s+-rf?\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-[a-z]*f\b/,
    /:\(\)\s*\{[^}]*\}\s*;/,
    /\bmkfs\b/,
    /\bdd\b.*\bof=\/dev\//,
    />\s*\/dev\/[a-z]/,
    /\b(shutdown|reboot|halt|poweroff)\b/i,
    /\bDROP\s+(TABLE|DATABASE)\b/i,
  ];

  /** Wrap content + interactive child in a centered overlay; keys forward to the child. */
  const showDialog = (content: Component, target: Component, framed = true): OverlayHandle => {
    const root = framed ? new Box(content, {}) : content;
    return tui.showOverlay(new OverlayDialog(root, target), OVERLAY_OPTS);
  };

  /** Titled single-choice SelectList in a centered overlay. Resolves null on Esc. */
  const pickOne = async (
    title: string,
    items: Array<{ value: string; label: string; description?: string; disabled?: boolean }>,
  ): Promise<string | null> => {
    const disabled = new Set(items.filter((i) => i.disabled).map((i) => i.value));
    const list = new SelectList(
      items.map((i) => ({
        value: i.value,
        label: i.disabled ? `${i.label} (unavailable)` : i.label,
        description: i.description,
      })),
      10,
      buildSelectTheme(),
    );
    const body = new Container();
    body.addChild(new Text(theme.bold(title), 0, 0));
    body.addChild(list);
    const handle = showDialog(body, list);
    return await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        handle.hide();
        tui.setFocus(editor);
        resolve(value);
      };
      list.onSelect = (item) => {
        if (disabled.has(item.value)) {
          toast("That option is unavailable.");
          return;
        }
        finish(item.value);
      };
      list.onCancel = () => finish(null);
    });
  };

  // --- approval dialog ----------------------------------------------------------
  options.approvalHook.current = async (
    prompt: string,
    meta?: { toolName: string },
  ): Promise<boolean | "session"> => {
    const tool = meta?.toolName ?? "tool";
    // The kernel contract carries only (prompt, { toolName }), so the full
    // arguments arrive inside the prompt text — except when a caller passes
    // them through at runtime, in which case we pretty-print them too.
    const runtimeArgs = (meta as unknown as { arguments?: unknown } | undefined)?.arguments;
    let argsDetail = "";
    if (runtimeArgs !== undefined) {
      try {
        const pretty = JSON.stringify(runtimeArgs, null, 2);
        argsDetail = pretty.length > 800 ? pretty.slice(0, 800) + "\n[…truncated…]" : pretty;
      } catch {
        argsDetail = String(runtimeArgs).slice(0, 800);
      }
    }
    const danger = DESTRUCTIVE_PATTERNS.some((re) => re.test(prompt));
    const picked = await new Promise<string | null>((resolve) => {
      const body = new Container();
      body.addChild(new Text(danger ? theme.error(prompt) : theme.warn(prompt), 0, 0));
      if (argsDetail) {
        body.addChild(new Text(theme.muted("arguments:"), 0, 0));
        body.addChild(new Text(theme.muted(argsDetail), 0, 0));
      }
      if (danger) {
        body.addChild(new Text(theme.error("! destructive pattern detected — review carefully"), 0, 0));
      }
      const list = new SelectList(
        [
          { value: "once", label: "Yes, run once", description: "allow just this call" },
          { value: "session", label: `Yes, always allow ${tool}`, description: "no more prompts this session" },
          { value: "no", label: "No", description: "deny (Esc)" },
        ],
        5,
        buildSelectTheme(),
      );
      body.addChild(list);
      const box = new Box(body, {
        title: danger ? `approval (DANGER): ${tool}` : `approval: ${tool}`,
        mood: danger ? "error" : "default",
      });
      const handle = tui.showOverlay(new OverlayDialog(box, list), OVERLAY_OPTS);
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        handle.hide();
        tui.setFocus(editor);
        resolve(value);
      };
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(null);
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
  const withOverlay = async (
    title: string,
    list: SelectList,
    onPick: (value: string) => Promise<void> | void,
  ): Promise<void> => {
    const body = new Container();
    body.addChild(new Text(theme.bold(title), 0, 0));
    body.addChild(list);
    const handle = showDialog(body, list);
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (run: (() => Promise<void> | void) | null) => {
        if (done) return;
        done = true;
        handle.hide();
        tui.setFocus(editor);
        void Promise.resolve(run?.()).finally(() => resolve());
      };
      list.onSelect = (item) => finish(() => onPick(item.value));
      list.onCancel = () => finish(null);
    });
  };

  /**
   * Bordered text prompt. Enter resolves the typed text; Esc resolves null
   * via the global input listener (pi-tui's Editor has no onEscape — the
   * listener runs first and consumes the key). Typed secrets are never
   * echoed back by the caller.
   */
  const promptText = async (title: string, initial?: string): Promise<string | null> => {
    const ed = new Editor(tui, buildEditorTheme());
    if (initial) ed.setText(initial);
    const body = new Container();
    body.addChild(new Text(theme.bold(title), 0, 0));
    body.addChild(new Text(theme.muted("Enter submits · Esc cancels"), 0, 0));
    body.addChild(ed);
    const handle = showDialog(body, ed, false);
    return await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        promptDialog = null;
        handle.hide();
        tui.setFocus(editor);
        resolve(value);
      };
      promptDialog = { cancel: () => finish(null) };
      ed.onSubmit = (text) => finish(text);
    });
  };

  const pickModel = async (initialFilter?: string) => {
    if (busy) {
      toast("Wait for the current turn to settle before switching models.");
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
    const lastUsed = await readLastUsed().catch(() => null);
    const providers = options.modelsFile.providers ?? {};
    const list = new SelectList(
      [...models]
        .sort((a, b) => Number(b.authenticated) - Number(a.authenticated))
        .map((m) => {
          const prov = providers[m.provider]?.displayName || m.provider;
          const isCurrent = m.provider === current.provider && m.id === current.modelId;
          const isLastUsed =
            !isCurrent && lastUsed?.provider === m.provider && lastUsed?.model === m.id;
          return {
            value: `${m.provider}/${m.id}`,
            label: `${prov}/${m.id}${isCurrent ? "  (current)" : isLastUsed ? "  (last used)" : ""}`,
            description: `${m.source}${m.authenticated ? "" : " · no credentials"}`,
          };
        }),
      10,
      buildSelectTheme(),
    );
    if (initialFilter) list.setFilter(initialFilter);
    await withOverlay("model", list, async (value) => {
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
        await recordLastUsed(provider, id).catch(() => undefined);
        ok(`Model: ${provider}/${id}`);
      } catch (error) {
        err(`Model switch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  /** `/connect` wizard: preset → key → test → model → save. Esc at any step cancels with nothing written. */
  const runConnect = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before connecting a provider.");
      return;
    }
    // a. Preset picker.
    const picked = await pickOne("connect — provider", [
      ...PROVIDER_PRESETS.map((p) => ({
        value: p.name,
        label: p.name,
        description: `${p.baseUrl} · ${p.hint}`,
      })),
      { value: "__custom__", label: "Custom…", description: "enter name + base URL manually" },
    ]);
    if (picked === null) {
      toast("Connect cancelled.");
      return;
    }
    let name: string;
    let baseUrl: string;
    let presetEnv = "";
    if (picked === "__custom__") {
      // b. Custom name + URL.
      const rawName = await promptText("provider name ([a-z0-9.-], Esc cancels)");
      if (rawName === null) {
        toast("Connect cancelled.");
        return;
      }
      const clean = rawName.trim().toLowerCase();
      if (!/^[a-z0-9.-]{1,32}$/.test(clean)) {
        err(`Bad provider name ${JSON.stringify(rawName)} — use [a-z0-9.-] (up to 32 chars).`);
        return;
      }
      name = clean;
      const rawUrl = await promptText("base URL", "http://localhost:11434/v1");
      if (rawUrl === null) {
        toast("Connect cancelled.");
        return;
      }
      baseUrl = rawUrl.trim();
      if (!/^https?:\/\//i.test(baseUrl)) {
        err(`Bad baseUrl ${JSON.stringify(rawUrl)} — must start with http:// or https://.`);
        return;
      }
    } else {
      const preset = PROVIDER_PRESETS.find((p) => p.name === picked);
      if (!preset) {
        err(`Unknown preset: ${picked}`);
        return;
      }
      name = preset.name;
      baseUrl = preset.baseUrl;
      presetEnv = preset.apiKeyEnv;
    }

    // c. Key step. Resolves the stored key form: literal, `$VAR`, `!cmd`,
    // or undefined for keyless local servers. Null = cancelled.
    const askKey = async (): Promise<string | undefined | null> => {
      const choice = await pickOne("connect — API key", [
        { value: "enter", label: "Enter key", description: "paste the API key" },
        {
          value: "env",
          label: presetEnv ? `Use $${presetEnv}` : "Use $ENV_VAR",
          description: presetEnv ? `read from ${presetEnv} at runtime` : "read from an env var at runtime",
        },
        { value: "command", label: "Use !command", description: "run a shell command for the key" },
        { value: "none", label: "No key (local)", description: "loopback servers need none" },
      ]);
      if (choice === null) return null;
      if (choice === "none") return undefined;
      if (choice === "enter") {
        const typed = await promptText("API key (Enter submits; value is never echoed back)");
        if (typed === null) return null;
        const t = typed.trim();
        if (!t) {
          toast("Empty key — continuing with no key.");
          return undefined;
        }
        toast("Key entered (not echoed).");
        return t;
      }
      if (choice === "env") {
        const typed = await promptText("env var ($NAME)", presetEnv ? `$${presetEnv}` : "$");
        if (typed === null) return null;
        const t = typed.trim();
        if (!t) return undefined;
        return t.startsWith("$") ? t : `$${t}`;
      }
      const typed = await promptText("credential command (!cmd)", "!");
      if (typed === null) return null;
      const t = typed.trim();
      if (!t || t === "!") return undefined;
      return t.startsWith("!") ? t : `!${t}`;
    };
    let apiKey = await askKey();
    if (apiKey === null) {
      toast("Connect cancelled.");
      return;
    }

    // d. Test loop.
    let liveModels: string[] = [];
    let manualId: string | null = null;
    for (;;) {
      toast(`Testing ${baseUrl} …`);
      let result: Awaited<ReturnType<typeof testProvider>>;
      try {
        result = await testProvider(baseUrl, apiKey, {});
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (result.ok) {
        liveModels = result.models;
        ok(`Connected: ${liveModels.length} model(s) found.`);
        break;
      }
      err(`Test failed: ${result.message}`);
      const fix = await pickOne("connect — test failed", [
        { value: "url", label: "Edit URL", description: baseUrl },
        { value: "key", label: "Edit key", description: "re-enter credential" },
        { value: "manual", label: "Enter model id manually", description: "skip the live test" },
        { value: "cancel", label: "Cancel", description: "write nothing (Esc)" },
      ]);
      if (fix === null || fix === "cancel") {
        toast("Connect cancelled.");
        return;
      }
      if (fix === "url") {
        const typed = await promptText("base URL", baseUrl);
        if (typed === null) {
          toast("Connect cancelled.");
          return;
        }
        baseUrl = typed.trim();
        continue;
      }
      if (fix === "key") {
        const k = await askKey();
        if (k === null) {
          toast("Connect cancelled.");
          return;
        }
        apiKey = k;
        continue;
      }
      const typed = await promptText("model id");
      if (typed === null || !typed.trim()) {
        toast("Connect cancelled.");
        return;
      }
      manualId = typed.trim();
      break;
    }

    // e. Model step.
    let modelId = manualId;
    if (!modelId) {
      if (liveModels.length === 0) {
        toast("No models returned — enter one manually.");
        const typed = await promptText("model id");
        if (typed === null || !typed.trim()) {
          toast("Connect cancelled.");
          return;
        }
        modelId = typed.trim();
      } else {
        const choice = await pickOne("connect — model", [
          ...liveModels.map((m) => ({ value: m, label: m, description: "live" })),
          { value: "__manual__", label: "Enter model id manually…", description: "" },
        ]);
        if (choice === null) {
          toast("Connect cancelled.");
          return;
        }
        if (choice === "__manual__") {
          const typed = await promptText("model id");
          if (typed === null || !typed.trim()) {
            toast("Connect cancelled.");
            return;
          }
          modelId = typed.trim();
        } else {
          modelId = choice;
        }
      }
    }

    const asDefault = await pickOne("set as default?", [
      { value: "yes", label: "Yes", description: "use for new sessions" },
      { value: "no", label: "No", description: "keep current default" },
    ]);
    if (asDefault === null) {
      toast("Connect cancelled.");
      return;
    }
    // If the key is `$VAR`, also record apiKeyEnv so env-based resolution
    // works even when the variable is unset at resolve time.
    let apiKeyEnvOut: string | undefined = presetEnv || undefined;
    const envMatch = apiKey?.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    if (envMatch?.[1]) apiKeyEnvOut = envMatch[1];
    const cfg: ProviderConfig = {
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(apiKeyEnvOut ? { apiKeyEnv: apiKeyEnvOut } : {}),
      models: [{ id: modelId }],
    };
    // saveProviderToUserFile moves a literal apiKey into auth.json itself;
    // call saveAuthKey too for literal keys (idempotent), never for
    // `$VAR` / `!cmd` references (those must stay resolvable, not stored).
    try {
      const saved = await saveProviderToUserFile(name, cfg, { makeDefault: asDefault === "yes" });
      if (apiKey && !apiKey.startsWith("$") && !apiKey.startsWith("!")) {
        await saveAuthKey(name, apiKey);
      }
      ok(`Saved ${saved.summary} → ${saved.path}`);
    } catch (error) {
      err(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    try {
      options.modelsFile = await loadModelsFile(cwd);
      const adapter: ModelAdapter = await createAdapterFor(
        options.modelsFile,
        name,
        modelId,
        { baseUrl, apiKey },
        logger,
      );
      await session.setModel(adapter);
      await recordLastUsed(name, modelId).catch(() => undefined);
      ok(`Model: ${name}/${modelId}`);
      printStatus();
    } catch (error) {
      err(`Model switch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const historySearch = async () => {
    if (busy) return;
    if (recentPrompts.length === 0) {
      toast("No history yet.");
      return;
    }
    const list = new SelectList(
      [...recentPrompts].reverse().map((h) => ({ value: h, label: h.length > 100 ? h.slice(0, 100) + "…" : h })),
      10,
      buildSelectTheme(),
    );
    await withOverlay("history", list, (value) => editor.setText(value));
  };

  const cycleMode = () => {
    if (busy) {
      toast("Mode changes apply when idle.");
      return;
    }
    const current = session.approvalMode();
    const next = current === "ask" ? "auto-allowlist" : "ask";
    if (session.setApprovalMode(next as "ask" | "auto-allowlist")) {
      toast(`Approval mode: ${next === "ask" ? "manual (ask)" : "auto (no per-op prompts; destructive still asks)"}`);
      printStatus();
    } else {
      toast("Approval mode is fixed by the active policy.");
    }
  };

  // --- empty-state suggestions ------------------------------------------------------
  // First run with no session history: 2-3 suggestion chips. Selecting one
  // fills the editor (never auto-sends). Up/Down+Enter via the overlay list,
  // or the 1-3 number keys handled in the global input hook below.
  const SUGGESTIONS = ["Summarize this repo", "Find TODOs", "Run tests"];
  const showSuggestions = async (): Promise<void> => {
    const list = new SelectList(
      SUGGESTIONS.map((s, i) => ({ value: s, label: `${i + 1}. ${s}` })),
      5,
      buildSelectTheme(),
    );
    const body = new Container();
    body.addChild(new Text(theme.bold("try — ↑↓+Enter or 1-3 fills the prompt (no send) · Esc dismisses"), 0, 0));
    body.addChild(list);
    const handle = showDialog(body, list);
    suggestionsOpen = true;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (fill: string | null) => {
        if (done) return;
        done = true;
        suggestionsOpen = false;
        suggestionPick = null;
        handle.hide();
        tui.setFocus(editor);
        if (fill !== null) {
          editor.setText(fill);
          toast(`Filled: ${fill}`);
        }
        resolve();
      };
      suggestionPick = (value) => finish(value);
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(null);
    });
  };

  /** `/keys`: re-auth the CURRENT provider. Tests first; only a 401/403 offers re-entry. */
  const runReauth = async (): Promise<void> => {
    if (busy) {
      toast("Wait for the current turn to settle before re-authenticating.");
      return;
    }
    const current = session.modelInfo();
    const cfg = (options.modelsFile.providers ?? {})[current.provider];
    if (!cfg) {
      err(`Unknown provider ${JSON.stringify(current.provider)} — use /connect to add it.`);
      return;
    }
    toast(`Testing ${current.provider} (${cfg.baseUrl}) …`);
    let key: string | undefined;
    try {
      key = await resolveApiKey(current.provider, cfg, options.apiKey);
    } catch {
      key = undefined;
    }
    let result: Awaited<ReturnType<typeof testProvider>>;
    try {
      result = await testProvider(cfg.baseUrl, key, {});
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) {
      toast(`Key OK for ${current.provider}: ${result.models.length} model(s) found.`);
      return;
    }
    err(`Test failed: ${result.message}`);
    if (!/401|403|rejected/i.test(result.message)) return;
    const choice = await pickOne(`re-auth ${current.provider} — key rejected`, [
      { value: "enter", label: "Re-enter key", description: "paste a new API key" },
      { value: "env", label: "Use $ENV_VAR", description: "read from an env var at runtime" },
      { value: "command", label: "Use !command", description: "run a shell command for the key" },
      { value: "cancel", label: "Cancel", description: "keep the current key (Esc)" },
    ]);
    if (choice === null || choice === "cancel") {
      toast("Re-auth cancelled.");
      return;
    }
    let nextKey: string | undefined;
    if (choice === "enter") {
      const typed = await promptText("API key (Enter submits; value is never echoed back)");
      if (typed === null || !typed.trim()) {
        toast("Re-auth cancelled.");
        return;
      }
      nextKey = typed.trim();
    } else if (choice === "env") {
      const typed = await promptText("env var ($NAME)", `$${cfg.apiKeyEnv ?? ""}`);
      if (typed === null || !typed.trim()) {
        toast("Re-auth cancelled.");
        return;
      }
      const t = typed.trim();
      nextKey = t.startsWith("$") ? t : `$${t}`;
    } else {
      const typed = await promptText("credential command (!cmd)", "!");
      if (typed === null || !typed.trim() || typed.trim() === "!") {
        toast("Re-auth cancelled.");
        return;
      }
      const t = typed.trim();
      nextKey = t.startsWith("!") ? t : `!${t}`;
    }
    try {
      if (nextKey && !nextKey.startsWith("$") && !nextKey.startsWith("!")) {
        await saveAuthKey(current.provider, nextKey);
      } else {
        const merged: ProviderConfig = { ...cfg, apiKey: nextKey };
        await saveProviderToUserFile(current.provider, merged, {});
        options.modelsFile = await loadModelsFile(cwd);
      }
      toast("Key saved — retesting …");
    } catch (error) {
      err(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let retest: Awaited<ReturnType<typeof testProvider>>;
    try {
      const resolved = await resolveApiKey(
        current.provider,
        (options.modelsFile.providers ?? {})[current.provider] ?? cfg,
        nextKey,
      );
      retest = await testProvider(cfg.baseUrl, resolved, {});
    } catch (error) {
      retest = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (retest.ok) toast(`Re-authenticated ${current.provider}: ${retest.models.length} model(s) found.`);
    else err(`Retest failed: ${retest.message}`);
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
      case "/models":
        await pickModel(arg || undefined);
        return true;
      case "/keys":
        await runReauth();
        return true;
      case "/connect":
        await runConnect();
        return true;
      case "/compact": {
        if (busy) {
          toast("A turn is running — compaction will happen automatically if needed.");
          return true;
        }
        try {
          const result = await session.compact(arg || undefined);
          if (!result) toast("Nothing to compact yet.");
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
          toast("Wait for the current turn to settle before starting a new session.");
          return true;
        }
        try {
          const fresh = await options.newSession();
          unsubscribe?.();
          session = fresh.session;
          manager = fresh.manager;
          queue = [];
          renderQueue();
          subscribe();
          transcript.clear();
          printHeader();
          printStatus();
          toast("New session started.");
        } catch (error) {
          err(`New session failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return true;
      }
      case "/export": {
        if (busy) {
          toast("Wait for the current turn to settle before exporting.");
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
  /** One-line arg summary for tool cards (path/command first, capped). */
  const summarizeArgs = (args: unknown): string => {
    if (typeof args !== "object" || args === null) return "";
    const record = args as Record<string, unknown>;
    const first =
      typeof record["path"] === "string"
        ? record["path"]
        : typeof record["command"] === "string"
          ? record["command"]
          : Object.entries(record)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(" ");
    const text = String(first);
    return text.length > 100 ? text.slice(0, 100) + "…" : text;
  };

  const runTurn = (text: string) => {
    busy = true;
    abort = new AbortController();
    activity = "thinking";
    lastUserPrompt = text;
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
          renderQueue();
          if (next !== undefined) {
            toast(`sending queued message${queue.length > 0 ? ` (+${queue.length} more)` : ""}`);
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
        if (queue.length >= MAX_QUEUE) toast(`Queue full (${MAX_QUEUE}) — wait for the turn to settle.`);
        else {
          queue.push(line);
          renderQueue();
          toast(`queued ${queue.length}/${MAX_QUEUE}`);
        }
      }
      return;
    }
    const raw = line.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
    if (!raw.trim()) return;
    const trimmed = raw.trim();
    editor.setText("");
    tui.requestRender();
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

  // Auth-failure recovery (wired to the agent_error handler above). Offers
  // immediate actions; Retry re-submits the last user prompt, /connect and
  // /model reuse the existing runCommand paths.
  handleAuthError = (_message: string) => {
    if (authOverlayOpen) return;
    authOverlayOpen = true;
    void (async () => {
      const pick = await pickOne("auth error — how to recover?", [
        { value: "connect", label: "Reconnect with /connect", description: "run the connect wizard" },
        {
          value: "retry",
          label: "Retry turn",
          description: lastUserPrompt ? "re-submit the last prompt" : "no prompt to retry yet",
          disabled: !lastUserPrompt,
        },
        { value: "model", label: "Switch model (/model)", description: "pick another provider/model" },
        { value: "dismiss", label: "Dismiss", description: "stay here (Esc)" },
      ]);
      authOverlayOpen = false;
      if (pick === "connect") await runCommand("/connect");
      else if (pick === "model") await runCommand("/model");
      else if (pick === "retry") {
        if (!lastUserPrompt) {
          toast("Nothing to retry yet.");
          return;
        }
        if (busy) {
          if (queue.length >= MAX_QUEUE) toast(`Queue full (${MAX_QUEUE}) — retry dropped.`);
          else {
            queue.unshift(lastUserPrompt);
            renderQueue();
            toast("Retry queued — sends when the turn settles.");
          }
          return;
        }
        toast("Retrying last prompt…");
        runTurn(lastUserPrompt);
      } else {
        toast("Auth error dismissed — /connect, /model, or retry when ready.");
      }
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
    tui.renderNow();
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
    toast("Press Ctrl+D again to exit.");
  };

  // --- global keys ----------------------------------------------------------------------------
  // Registered via addInputListener, which runs BEFORE focused components, so
  // Esc-cancel for prompt dialogs is emulated here (pi-tui's Editor has no
  // onEscape): a handled Esc returns {consume:true} to preempt the dialog.
  tui.addInputListener((key) => {
    // Esc cancels an open text-prompt dialog (preempts the dialog's editor).
    if (promptDialog && matchesKey(key, "escape")) {
      promptDialog.cancel();
      return { consume: true };
    }
    if (tui.hasOverlay()) {
      // Number-key quick fill for the empty-state suggestions overlay.
      // Routes through the overlay's own finish path (fill, never send).
      if (suggestionsOpen && suggestionPick) {
        for (let n = 0; n < SUGGESTIONS.length && n < SUGGESTION_DIGITS.length; n++) {
          const digit = SUGGESTION_DIGITS[n];
          if (digit && matchesKey(key, digit)) {
            suggestionPick(SUGGESTIONS[n] ?? "");
            return { consume: true };
          }
        }
      }
      return undefined; // overlays own Esc/arrows/Enter
    }
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
    if (matchesKey(key, "ctrl+q")) {
      if (queue.length > 0) {
        queue = [];
        renderQueue();
        toast("Queue cleared.");
      }
      return { consume: true };
    }
    // Backspace on an empty editor removes the last queued item.
    if (matchesKey(key, "backspace") && editor.getText().length === 0 && queue.length > 0) {
      const removed = queue.pop();
      renderQueue();
      toast(`Removed queued message${removed ? `: ${removed.replace(/\s+/g, " ").trim().slice(0, 60)}` : ""}`);
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+s")) {
      // Stash/restore the draft (pi-tui's Editor has no stashPrompt).
      if (editor.getText().length > 0) {
        stash = editor.getText();
        editor.setText("");
        toast("Draft stashed — Ctrl+S restores it.");
      } else if (stash) {
        editor.setText(stash);
        stash = "";
      }
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+r")) {
      if (!busy) void historySearch();
      return { consume: true };
    }
    if (matchesKey(key, "ctrl+l")) {
      tui.requestRender();
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
  tui.start();
  if (manager.getActiveMessages().length === 0) {
    info("No history yet — pick a suggestion (↑↓+Enter or 1-3 fills the prompt, never sends) or type your own.");
    await showSuggestions();
  }
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (exiting) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}
