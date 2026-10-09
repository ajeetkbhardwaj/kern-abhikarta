# Kern User Guide & Manual

Kern is a minimal terminal coding agent: a from-first-principles kernel
(turn loop, tools, session store, model adapter — all written from scratch
in this repo under `packages/`) with a fullscreen terminal UI built on the
MIT-licensed `@earendil-works/pi-tui` library (renderer, editor, pickers,
markdown) styled in Pi's dark theme.

This manual covers installation, both run modes, model setup, every slash command, every keybinding, approvals/safety, tools, sessions, project memory, budgets/compaction, and troubleshooting.

> Rule of thumb: all state lives under `~/.kern/`. Nothing is sent anywhere except to the model provider you configure.

---

## 1. Install & run

**Requirements:** Node.js 22.19+ (required by the TUI framework), `pnpm`.

```bash
git clone <kern-repo> && cd kern
pnpm install
pnpm kern --help        # CLI help
pnpm typecheck           # tsc --noEmit
pnpm test                # vitest run
```

**Launcher:** until Kern is published to npm, `pnpm kern` runs `tsx packages/cli/src/main.ts` (`package.json:15`). For publishing it as installable packages, see Part B of `Guide.md` (verified esbuild single-file `kern` bundle).

### Two run modes (`packages/cli/src/main.ts`)

| Mode | Command | Best for |
|---|---|---|
| **Interactive TUI** | `pnpm kern` (default on a TTY) or `pnpm kern -i` | Daily coding work |
| **Print mode** | `pnpm kern "do X"` or `pnpm kern --print "…"` | Scripts, pipes, CI |

Selection logic: interactive if `--interactive` is passed, or when there is no `--print`, no positional prompt, and stdin+stdout are both TTYs. Otherwise single-prompt mode runs `flags.prompt || "What is in README.md?"`, streams `text_delta` to stdout and tool/compaction/retry/error status to stderr (pipe-safe).

### CLI flags (exact, `parseArgs` in `packages/cli/src/main.ts`)

```
--read-only        Only the read tool (--read-only maps to allowlistTools: ["read"])
--max-turns N      Cap agent turns for this run (positive integer → budgets.maxTurns)
--cwd DIR          Workspace root (default: process.cwd())
--no-resources     Skip AGENTS.md / skill discovery
--no-compaction    Disable automatic compaction
--resume           Resume the most recent session
--interactive, -i  Interactive TUI (default when TTY and no prompt given)
--print            Force single-prompt print mode
--list-models      List available models (configured + live) and exit
--provider NAME    Provider from models.json (or KERN_PROVIDER)
--model ID         Model id, optionally provider/id (or KERN_MODEL)
--base-url URL     Override endpoint base URL (or KERN_BASE_URL)
--api-key KEY      Override API key (or KERN_API_KEY)
--help, -h         This message
```

Unknown `--*` flags throw. `--model provider/id` splits on `/`; `--provider` + `--model id` also works.

**Env equivalents:** `KERN_PROVIDER`, `KERN_MODEL`, `KERN_BASE_URL`, `KERN_API_KEY`, `KERN_LOG=debug` (stderr logs). Precedence: **flag → env → config file**.

**Print-mode events** (stdout vs stderr): `text_delta` → stdout; `tool_execution_start/end`, `auto_compaction_start/end`, `auto_retry_start`, `agent_error` → stderr; final newline after assistant `message_end`.

---

## 2. Connect a model (cloud or local)

Kern talks to any **OpenAI-compatible endpoint** — OpenAI, OpenRouter, NVIDIA, Ollama, LM Studio, llama.cpp, and most proxies. One dialect (`POST {baseUrl}/chat/completions` with SSE streaming, `packages/model/src/openai.ts`); no provider-specific code.

**Built-in presets** (`PROVIDER_PRESETS`, `packages/model/src/discovery.ts:64`):

| Preset | Base URL | Key |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `ollama` | `http://localhost:11434/v1` | none (loopback) |
| `lmstudio` | `http://localhost:1234/v1` | none (loopback) |
| `llamacpp` | `http://localhost:8080/v1` | none (llama-server) |

### Option A — `/connect` wizard (easiest, inside the TUI)

```
/connect
```

1. Pick a preset (or `Custom…` → enter `name` matching `[a-z0-9.-]`, ≤32 chars, then `http(s)://` base URL).
2. Choose auth: **Enter key** (pasted, never echoed) · **Use `$ENV_VAR`** · **Use `!command`** (run at request time) · **No key (local)**.
3. Kern **tests the endpoint live** (`GET {baseUrl}/models`). On failure you get `Edit URL / Edit key / Enter model id manually / Cancel` — Esc at any step cancels with nothing written.
4. Pick a model from the live list (or type the id manually), choose **set as default? Yes/No**.
5. Kern saves, then **switches to it immediately** and records last-used.

Secrets go to `~/.kern/auth.json` (mode `0600`, never echoed back); non-secret config goes to `~/.kern/models.json`. `$VAR` / `!cmd` references stay in `models.json`; literal keys are moved to `auth.json` automatically.

### Option B — config file (manual)

`~/.kern/models.json` (user) merges with `<project>/.kern/models.json` (project override; providers override per-name, model lists merge by id):

```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "$OPENAI_API_KEY",
      "models": [{ "id": "gpt-4o", "contextWindow": 128000 }]
    },
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "models": [{ "id": "qwen2.5-coder:7b", "contextWindow": 32000 }]
    }
  },
  "defaultProvider": "ollama",
  "defaultModel": "qwen2.5-coder:7b"
}
```

Schema (`ProviderConfig`, `discovery.ts`): `baseUrl` (required), `apiKey` (literal, `$VAR`/`${VAR}`, or `!shell-command`), `apiKeyEnv`, `models[]` (`id`, optional per-model `contextWindow`/`maxOutputTokens`), `displayName` (picker label), `whitelist` (narrow first) / `blacklist` (remove after) applied to configured + live ids.

**Credential precedence** (`resolveApiKey`): explicit flag → `auth.json` entry → `!command` (`sh -c`, 10 s timeout) / `$VAR` / literal in config → `apiKeyEnv` / well-known env (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`) → loopback (`localhost`/`127.0.0.1`/`::1`) needs no key.

### Option C — env / flags (CI, one-offs)

```bash
export KERN_PROVIDER=openai KERN_MODEL=gpt-4o KERN_API_KEY=sk-...
KERN_BASE_URL=http://localhost:11434/v1 KERN_MODEL=qwen2.5-coder:7b pnpm kern "…"
```

### Verify

```bash
pnpm kern --list-models
# ollama/qwen2.5-coder:7b [configured]
# openai/gpt-4o [live]              ← auto-discovered via GET /models
# openrouter/… (no credentials)     ← shown but not selectable
```

`[configured]` comes from your file, `[live]` from the endpoint. Entries without resolvable credentials are listed but disabled — same rule as the in-app picker. Corrupt JSON fails as `E_RESOURCE_LOAD`.

---

## 3. Interactive TUI tour

The TUI runs **fullscreen** (alternate screen): a scrollable transcript on
top with the prompt **docked at the bottom** (queue → toast → editor →
status bar, always pinned — it never floats mid-screen). Mouse wheel
scrolls the transcript. On exit your previous terminal contents are
restored, and `bye.` prints to stdout after. Everything renders in Pi's
dark theme (violet accent, green success, red errors, muted grays).

Startup shows a header box (`kern  provider/model · manual · /cwd`), `Type a task, or /help for commands.`, the key-hint line, and — on a fresh session — a suggestions overlay (`Summarize this repo`, `Find TODOs`, `Run tests`; `↑↓+Enter` or `1-3` fills the prompt, never sends; `Esc` dismisses). Dialogs (pickers, approvals, wizard steps) float centered over the transcript.

### Typing & editor (pi-tui `Editor`)

- **Enter** sends. **Shift+Enter** (or Alt+Enter) inserts a newline (multi-line prompt). The editor draws its own frame — that border *is* the prompt box.
- **Tab** accepts the top completion; **Up/Down** navigates the dropdown; **Esc** dismisses it.
- **Type `/`** for slash commands, **type `@`** to attach a file — dropdown with descriptions. File search shells out to the `fd` binary when present on `PATH` (slash-command completion always works, even without `fd`). `@path` files are inlined into the prompt as `<file path="…">…</file>` (40 KB cap each; missing files are sent literally with a notice).
- **Type `!cmd`** to run a shell command directly (`! npm test`): output prints immediately (first 60 lines) *and* the agent responds to it.
- Readline keys: `Ctrl+A/E` line start/end, word jump, word kill, `Ctrl+K/U` kill, `Ctrl+Y` yank, undo history; Kern adds `Ctrl+S` stash/restore draft, `Ctrl+R` history search, `Ctrl+L` redraw.
- Large pastes are handled by the editor (bracketed paste); IME candidate windows position at the hardware cursor.
- Invisible paste smuggling (zero-width/bidi chars) is stripped and you are asked to review before sending.

### While the agent works

- Anything you type is **queued** (cap 5, numbered list above the editor, `Ctrl+Q` clears all, `Backspace` on an empty prompt removes the last queued item). Queued messages send automatically in order when the turn settles.
- **Ctrl+C** aborts the turn; **Ctrl+D twice** (within 800 ms) exits; `/quit` or `/exit` exits.
- A spinner shows elapsed time and current activity (`thinking`, `running bash`, `compacting context`, `retrying (…)`).
- Transient notices appear as one-line **toasts** above the queue (`queued 2/5`, `retry 2 (…)`, `context compacted`, `saved`, mode changes…). Errors stay in the transcript permanently — toasts never hide errors.

### Assistant output (pi-tui `Markdown` + Kern cards)

- Replies render as Markdown via a real parser: headings, bold/italic/strike, links (`text (url)`), quotes (`│ …`), aligned pipe tables, LaTeX-as-Unicode, and **syntax-highlighted fenced code blocks** (keywords/strings/numbers/comments in Pi token colors; `diff` fences get red/green line coloring). Unclosed fences render as code while streaming.
- Tool activity shows as **cards**: `◈ bash …` while running → `✔ done` / `✖ failed`. Live output is capped (`+N more`); `edit` results include a unified diff hunk.
- The **status bar** (pinned to the very last row) always shows `provider/model │ mode │ ctx NN% │ N turns · M calls · S.s`.

---

## 4. Slash commands (exact)

| Command | What it does |
|---|---|
| `/help` (or `?`) | This list + key hints |
| `/model [filter]` | Searchable picker over all discovered models (authenticated first, `(current)` / `(last used)` marks); switches mid-session, recorded in history |
| `/models` | Alias for `/model` |
| `/keys` | Re-auth the current provider: tests the key, on 401/403 offers re-enter / `$VAR` / `!command`, saves, retests |
| `/connect` | Add a provider: preset or custom URL, key, live test, model pick, save, switch (§2, Option A) |
| `/compact [note]` | Summarize history into a checkpoint now (§7) |
| `/diff` | Show working-tree changes (`git diff --stat` + `git status --short`, 20 lines) |
| `/new` | Start a fresh session (queue cleared, transcript cleared) |
| `/export [file]` | Dump transcript (messages, tool calls/results, compactions, model changes, branches) to Markdown (default `kern-session-<id>.md` in cwd) |
| `/budget` | Refresh the status bar: turns / tool calls / wall time / context % |
| `/clear` | Clear the transcript (header + status re-printed) |
| `/quit`, `/exit` | Exit the session (restores your terminal, prints `bye.`) |

Unknown `/foo` → `Unknown command: /foo. Try /help.` Commands that need an idle session (`/model`, `/connect`, `/keys`, `/compact`, `/new`, `/export`) refuse politely while a turn is running.

---

## 5. Approvals & safety (read this once)

Kern **asks before acting**, enforced mechanically by the policy engine — not by prompt wording (`packages/tools/src/policy.ts`, `policy-config.ts`).

- `read` is always allowed. `write` / `edit` / `bash` pop an **arrow-key dialog**: *Yes, run once* · *Yes, always allow this tool this session* · *No (Esc)*.
- **Destructive commands always ask**, even in auto mode: `rm -rf`, `git reset --hard`, `git clean -f`, fork bombs, `mkfs`, `dd … of=/dev/…`, `> /dev/…`, `shutdown/reboot/halt/poweroff`, `DROP TABLE/DATABASE`. The dialog turns red (`approval (DANGER)`) and shows the full arguments.
- Credential/sensitive paths are **blocked** (`.ssh/`, `.aws/`, `id_rsa`, `.npmrc`, `.netrc`, `.env`, `*.pem`), everything **outside the workspace is denied** (symlinks resolved, fail closed), and denylist beats allowlist.
- A denial returns an error *to the agent*, which works around it — the turn continues, it doesn't die.
- **Shift+Tab** cycles approval modes: `manual (ask)` ↔ `auto` (no per-op prompts; destructive/sensitive rules still enforced). The mode shows in the header/status bar. `--read-only` locks the session to the `read` tool only.
- Headless runs (pipes, CI, non-TTY) **deny by default** — plain `[y/N]` prompt in print mode, fail-closed when nobody can answer.

---

## 6. What the agent can do (tools)

Four built-in tools (`packages/tools/src/tools.ts`), registered in `create-agent-session.ts` with a 120 s registry timeout per call:

| Tool | Arguments | Behavior |
|---|---|---|
| `read` | `path`, optional `offset` (1-based), `limit` (≤2000 lines) | File contents with `line: text` numbering, or a `- entry` directory listing. Binary files are refused with their size instead of being injected. Always allowed. |
| `write` | `path`, `content`, `overwrite?` (default false) | Creates parent dirs; refuses directories, existing files without `overwrite`, and payloads >500 KB. Reports `changedPaths`. |
| `edit` | `path`, `oldText`, `newText`, `replaceAll?` | Exact-match replacement; refuses missing text and ambiguous (non-unique) matches unless `replaceAll`. Returns a unified diff hunk (40-line cap) + `changedPaths`. |
| `bash` | `command`, `timeoutMs?` (≤600 s) | Runs `bash -c` in the workspace with process-group kill on timeout/abort (SIGTERM → SIGKILL). Reports exit code, duration, stdout/stderr (bounded, truncation flagged). |

Tool output is bounded (`30_000` bytes / `400` lines default; head 60% + tail with a `[… N chars truncated …]` marker) and validated before policy and execution (`E_TOOL_UNKNOWN`, `E_TOOL_INVALID_ARGS`, `E_TOOL_DENIED`, `E_TOOL_TIMEOUT`, `E_TOOL_FAILED`).

---

## 7. Sessions, memory & project context

### Sessions (branchable tree, JSONL on disk)

Every turn persists to `~/.kern/agent/sessions/<project-slug>/<timestamp>_<s_id>.jsonl` — one JSON object per line (append-only). Entries form a **tree** (`parentId` links), so history can fork; `/export` and `--resume` operate on the active path. Malformed trailing lines are quarantined, not fatal; invariant violations (missing header, cycles, bad parents) throw loudly (`packages/session-store`).

- `pnpm kern --resume` continues the latest session for the cwd.
- `/new` starts fresh; `/export [file]` dumps the active path to Markdown for sharing/review.

### Compaction (long sessions)

Context is measured from real model `usage` (input+output+cache); when `tokens ≥ 75% of window − reserve`, the agent **auto-compacts** (checks run before each prompt and after each turn; `--no-compaction` disables). `/compact [note]` forces it. The model writes a structured checkpoint (`Goal / Constraints / Workspace facts / Progress / Decisions / Errors / Next steps / Critical artifacts` — exact paths, names, and error messages preserved); raw history stays on disk for audit.

### Project memory: AGENTS.md & skills

- **`AGENTS.md`** — repo conventions in `<project>/AGENTS.md` (walked upward, closest wins, up to 4 files, 20 KB each) load into every session automatically (`--no-resources` skips). Put build/test commands, style rules, and scope limits here.
- **Skills** — reusable playbooks in `<project>/.agents/skills/<name>/SKILL.md` (also `.pi/skills/`) with `name:` + `description:` frontmatter (optional `allowed-tools:`). Only the catalog enters the system prompt; the agent `read`s a skill body on demand. If a skill is missing its frontmatter it is skipped with a diagnostic.

### Budgets (every run is capped)

50 turns · 30 tool calls/turn · 200 total tool calls · 10-minute wall time (`DEFAULT_BUDGET_LIMITS`, `DEFAULT_POLICY_CONFIG`). Override turns with `--max-turns N`. `/budget` (or the status bar) shows live usage. Model errors classify to retryable (`rate_limit/timeout/network/overloaded`) with automatic retry + toast, vs fatal (`auth/invalid_request/context_length`) which stop the turn with a persistent error card. Auth failures (`E_MODEL_AUTH`, e.g. HTTP 401) additionally offer **Reconnect with `/connect` · Retry turn · Switch model · Dismiss** — you never hit a dead end.

---

## 8. Files, env vars & reference

**Files**

| Path | Contents / perms |
|---|---|
| `~/.kern/models.json` | Provider configs (no literal secrets) |
| `<project>/.kern/models.json` | Project override (merged per provider) |
| `~/.kern/auth.json` | Literal API keys, `0600` |
| `~/.kern/last-used.json` | Last `provider`/`model` (picker marks it) |
| `~/.kern/agent/sessions/…jsonl` | Branchable session trees |

**Env vars:** `KERN_PROVIDER`, `KERN_MODEL`, `KERN_BASE_URL`, `KERN_API_KEY`, provider key vars (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`), `KERN_LOG=debug`, `NO_COLOR` (any non-empty value disables color).

**Global keys (TUI):** `Enter` send · `Shift+Enter`/`Alt+Enter` newline · `Tab` complete · `@` files (needs `fd` on `PATH`) · `!` shell · `↑↓` history/dropdown · `Ctrl+R` history search · `Ctrl+S` stash · `Ctrl+C` abort/clear · `Ctrl+D ×2` exit · `Ctrl+Q` clear queue · `Ctrl+L` redraw · `Shift+Tab` approval mode · `Esc` dismiss/cancel · mouse wheel scrolls transcript.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `No models found` | Add a provider to `~/.kern/models.json` or set `KERN_BASE_URL` + `KERN_MODEL`; check with `--list-models` |
| Auth errors (401/403) | Key precedence: flag → env → `!command` → config → `auth.json`. Verify the env var is exported in the launching shell; use `/keys` to re-auth, or pick **Reconnect** in the auth-error dialog |
| `Can't reach …` / endpoint unreachable | Local server running? (`ollama serve`, LM Studio server tab, `llama-server --port 8080`). Cloud URL typo? Proxy/VPN? `/connect` retests live |
| `Unexpected response body` | Endpoint isn't OpenAI-compatible on `/models` — enter the model id manually in `/connect` |
| `Approval required` loops | *Always allow this session*, or `Shift+Tab` to auto mode (destructive rules still apply) |
| `Unknown command: /foo` | See `/help`; custom slash commands are not supported — use skills via `AGENTS.md` context |
| Display garbled | `Ctrl+L` redraws; fullscreen repaints on resize; try `NO_COLOR=1` |
| `@file` shows nothing | Install `fd` on `PATH` (file search shells out to it; `/` completion works regardless) |
| Context % climbing | `/compact` now, or let auto-compaction fire at 75% |
| Queue full (5) | Wait for the turn to settle, or `Ctrl+Q` to drop queued items |
| Debug logs | `KERN_LOG=debug pnpm kern …` (stderr only) |

---

## 10. Quick-start cheat sheet

```bash
pnpm kern --list-models                       # what can I use?
pnpm kern "summarize this repo"               # one-shot (print mode)
pnpm kern                                     # interactive TUI
# inside: /connect → pick provider → paste key → pick model → switched
# inside: ask it to fix a failing test; approve edits with ↓+Enter; /diff to review
pnpm kern --read-only "find all TODOs"        # safe inspection
pnpm kern --resume                            # continue last session
KERN_LOG=debug pnpm kern "…"                  # debug to stderr
```
