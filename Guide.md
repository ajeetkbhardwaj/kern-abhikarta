# Kern User Guide — from installation to every feature

Kern is a minimal terminal coding agent. This guide takes you from zero to
daily use: installing, connecting cloud and local models, chatting in the
terminal, approving actions, and tuning safety.

---

## 1. Install

**Requirements:** Node.js 22.19+.

```bash
git clone <kern-repo> && cd kern
pnpm install
```

Run it (until Kern is published to npm, `pnpm kern` is the launcher):

```bash
pnpm kern --help
```

> All state lives under `~/.kern/` (sessions, `models.json`). Nothing is
> sent anywhere except to the model provider you configure.

---

## 2. Connect a model (cloud or local)

Kern talks to any **OpenAI-compatible endpoint** — OpenAI, OpenRouter,
NVIDIA, Ollama, LM Studio, llama.cpp, and most proxies. No
provider-specific code.

### Option A — config file (recommended)

Create `~/.kern/models.json`:

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

Notes:

- `apiKey` accepts a literal key, `$VAR` / `${VAR}` env interpolation, or
  a leading `!command` (e.g. `"!op read op://vault/key"`) executed at
  request time.
- No key is needed for loopback URLs (`localhost`, `127.0.0.1`) — local
  servers ignore keys, so Ollama/LM Studio work with no credentials.
- A project can override with `<project>/.kern/models.json` (merged per
  provider, models merged by id).

### Option B — environment variables / flags (CI, one-offs)

```bash
export KERN_PROVIDER=openai KERN_MODEL=gpt-4o KERN_API_KEY=sk-...
# or ad-hoc, no config file at all:
KERN_BASE_URL=http://localhost:11434/v1 KERN_MODEL=qwen2.5-coder:7b pnpm kern "…"
```

Flag equivalents: `--provider`, `--model provider/id`, `--base-url`,
`--api-key`. Precedence: **flag → env → config file**.

### Verify

```bash
pnpm kern --list-models
# ollama/qwen2.5-coder:7b [configured]
# openai/gpt-4o [live]              ← auto-discovered via GET /models
# openrouter/… (no credentials)     ← shown but not selectable
```

`[configured]` comes from your file, `[live]` is auto-discovered from the
endpoint. Endpoints without resolvable credentials are listed but disabled —
same rule as the in-app picker.

---

## 3. Two ways to run

| Mode | Command | Best for |
|---|---|---|
| **Interactive TUI** | `pnpm kern` (default on a TTY) or `pnpm kern -i` | Daily coding work |
| **Print mode** | `pnpm kern "do X"` or `pnpm kern --print "…"` | Scripts, pipes, CI |

Print mode streams the answer to stdout, status to stderr (pipe-safe).

---

## 4. Interactive TUI tour

```
kern  ollama/qwen2.5-coder:7b  ·  manual  ·  /home/you/proj
Type a task, or /help for commands.
```

### Typing

- **Enter** sends. **Shift+Enter** (or Alt+Enter) inserts a newline.
- **Tab** accepts ghost-text completion (slash commands, `@files`).
- **Type `/`** to see commands, **type `@`** to attach a file — the editor
  completes paths from your workspace. Attached files are inlined into the
  prompt (`@src/auth.ts` → full contents, 40 KB cap each).
- **Type `!`** to run a shell command directly (`! npm test`): output
  prints immediately *and* the agent responds to it.
- Standard readline keys: `Ctrl+A/E`, `Alt+B/F`, `Ctrl+W`, `Ctrl+K/U/Y`,
  `Ctrl+S` stash/restore, `Ctrl+R` history search, `Ctrl+L` redraw.
- While the agent works, anything you type is **queued** (cap 5) and sent
  next — no need to wait. **Ctrl+C** aborts the turn (queued items still
  send); **Esc** also aborts; **Ctrl+D twice** exits.

### Assistant output

- Replies render as Markdown with **syntax-highlighted code blocks**.
- Tool activity shows as cards: `◈ bash` → `✔ bash done` / `✖ read failed`.
- A spinner shows elapsed time and current activity (`running bash`,
  `compacting context`, …).
- The status line always shows
  `model · mode · turns · calls · seconds · ctx %`.

---

## 5. Slash commands

| Command | What it does |
|---|---|
| `/help` | This list + key hints |
| `/model [filter]` | Searchable picker over all discovered models; switches mid-session (recorded in history) |
| `/compact [note]` | Summarize history into a checkpoint now |
| `/diff` | Show working-tree changes (`git diff --stat` + status) |
| `/new` | Start a fresh session |
| `/export [file]` | Dump the transcript (messages, tool calls, checkpoints) to Markdown |
| `/budget` | Turns / tool calls / wall time / context % |
| `/clear` | Clear the screen |
| `/quit` | Exit |

---

## 6. Approvals and safety (read this once)

Kern **asks before acting**, mechanically — not via prompt wording:

- `read` is always allowed. `write` / `edit` / `bash` pop an
  **arrow-key dialog**: *Yes, run once* · *Yes, always allow this tool this
  session* · *No (Esc)*.
- **Destructive commands** (`rm -rf`, `git reset --hard`, …) *always* ask,
  even in auto mode. Credential paths (`.ssh/`, `.env`, keys) are blocked.
  Anything outside your workspace is denied.
- A denied action returns an error *to the agent*, which works around it —
  the turn continues, it doesn't die.
- **Shift+Tab** cycles approval modes: `manual (ask)` ↔ `auto` (no per-op
  prompts; destructive/sensitive rules still enforced). The mode is shown
  in the header.
- Headless runs (pipes, CI) **deny by default** — there is no one to ask.

---

## 7. Project memory: AGENTS.md, skills, sessions

- **`AGENTS.md`** — put repo conventions in `<project>/AGENTS.md` (walked
  upward, closest wins). It loads into every session automatically.
- **Skills** — reusable playbooks in `.agents/skills/<name>/SKILL.md`
  (frontmatter `name` + `description`). The agent sees the catalog and
  reads a skill on demand. Example: a `review-checklist` skill.
- **Sessions** — every turn persists to
  `~/.kern/agent/sessions/<project>/…jsonl` as a branchable tree.
  `pnpm kern --resume` continues the latest one; `/export` dumps any
  session to Markdown for sharing or review.

---

## 8. Limits and budgets

Every run is capped: **50 turns, 30 tool calls/turn, 200 total,
10-minute wall time** (override with `--max-turns N`; full policy via
config). Long sessions **auto-compact** into structured checkpoints that
preserve exact paths, errors, and decisions — raw history stays on disk.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `No models found` | Add a provider to `~/.kern/models.json` or set `KERN_BASE_URL` + `KERN_MODEL`; check with `--list-models` |
| Auth errors (401/403) | Key precedence is flag → env → `!command` → config. Verify the env var is exported in the shell that launches Kern |
| Endpoint unreachable | Local server running? (`ollama serve`, LM Studio server tab). Cloud URL typo? Firewalled? |
| `Approval required` loops | Use *always allow this session*, or Shift+Tab to auto mode |
| Display garbled | `Ctrl+L` redraws; resize triggers re-render |
| Context % climbing | `/compact` now, or let auto-compaction fire at 75% |
| Debug logs | `KERN_LOG=debug pnpm kern …` (stderr only) |

---

## 10. Quick-start cheat sheet

```bash
pnpm kern --list-models                       # what can I use?
pnpm kern "summarize this repo"               # one-shot
pnpm kern                                     # interactive TUI
# inside: /model → pick ollama model · ask it to fix a failing test
# inside: approve edits with ↓+Enter (always allow) · /diff to review
pnpm kern --read-only "find all TODOs"        # safe inspection
pnpm kern --resume                            # continue last session
```
