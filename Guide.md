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

### Option A — `/connect` wizard (easiest, in the TUI)

```
/connect
```

Pick a preset (OpenAI, OpenRouter, NVIDIA, Ollama, LM Studio, llama.cpp)
or enter a custom name + base URL, then choose how to authenticate (paste a
key, `$ENV_VAR`, `!command`, or no key for local servers). Kern tests the
endpoint live, lets you pick a model, and saves everything — then switches
to it immediately. Esc cancels at any step with nothing written.

Secrets go to `~/.kern/auth.json` (mode `0600`, never echoed back);
non-secret config goes to `~/.kern/models.json`. Keep them that way.

### Option B — config file (manual)

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

### Option C — environment variables / flags (CI, one-offs)

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
  completes paths from your workspace (file search uses the `fd` binary
  when present on `PATH`; slash-command completion always works). Attached
  files are inlined into the
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
| `/connect` | Add a provider: preset or custom URL, key, live test, save, switch |
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

---

# Part B — Developer guide: publishing Kern as npm packages

How to turn this monorepo into installable packages (`npm i -g kern`
/ `npx kern`). Current state: all 8 packages are `private: true`,
version `0.0.1`, with `exports` pointing at TypeScript source (runs
under `tsx`, not publishable as-is). Two routes below; **Option A is
recommended** — the library APIs are pre-1.0 and churning, so don't
promise stability you can't keep.

## Current packaging facts (verify before you publish)

- No `bin`, no `license` field, no `files` allowlist in any
  `package.json`; root `engines` says Node `>=20` but `@kern/tui`
  (via `@earendil-works/pi-tui`) needs Node `>=22.19`.
- `packages/cli/src/main.ts` has no shebang and runs `main()` on
  import — fine for a bundled bin entry, wrong for a library.
- `tsconfig.json` sets `noEmit: true` (typecheck only); publishing
  needs a build step, not the typecheck config.
- The runnable artifact today is an **esbuild single-file bundle**:
  `packages/cli/dist/kern.mjs` (gitignored, rebuilt, not committed).

## Option A — one `kern` bin package (recommended)

Ship a single self-contained executable; keep `@kern/*` private.

```bash
# 1. Build the bundle (verified command — pi-tui inlined, 854 KB)
node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild \
  packages/cli/src/main.ts --bundle --platform=node --target=node22 \
  --format=esm --outfile=packages/cli/dist/kern.mjs \
  --banner:js='#!/usr/bin/env node' --log-level=warning
chmod +x packages/cli/dist/kern.mjs

# 2. Smoke-test the artifact (all three must pass)
./packages/cli/dist/kern.mjs --help
./packages/cli/dist/kern.mjs --list-models --cwd /tmp
printf '\x1b' | script -qec "./packages/cli/dist/kern.mjs -i --cwd /tmp" /dev/null
#    ^ fullscreen TUI boots (alt-screen engages, header renders)

# 3. Publish under a new top-level folder, e.g. packages/kern-bin/package.json:
```

```json
{
  "name": "kern",
  "version": "0.1.0",
  "license": "MIT",
  "description": "Kern — minimal terminal coding agent",
  "type": "module",
  "bin": { "kern": "./dist/kern.mjs" },
  "files": ["dist/kern.mjs"],
  "engines": { "node": ">=22.19.0" }
}
```

```bash
# 4. Copy the bundle in, dry-run, publish
cp ../cli/dist/kern.mjs ./dist/kern.mjs
npm pack --dry-run   # must list ONLY dist/kern.mjs + package.json
npm publish --access public
```

Users then run `npm i -g kern` / `npx kern "…"` — no `tsx`, no clone,
plain Node 22+. The bundle carries `zod`, `marked`, and pi-tui's JS;
pi-tui's optional native clipboard module degrades gracefully when
absent (verified: no `ERR_MODULE_NOT_FOUND` at boot).

## Option B — publish all `@kern/*` libraries + bin

Only when the APIs stabilize. Per package: drop `"private": true`,
set a real version (single `0.1.0` across all, bumped together),
add `"license": "MIT"` + `"files": ["dist"]`, compile with `tsc`
into `dist` (add a `tsconfig.build.json` with `noEmit: false`,
`declaration: true`, per-package `outDir`), repoint
`exports`/`types` at `./dist/index.js`, add the `bin` entry to
`@kern/cli` (plus a `#!/usr/bin/env node` shebang and an
import-guard so importing the library doesn't launch the CLI).
Publish leaf-first with `pnpm -r publish` — pnpm rewrites
`workspace:*` to the released versions automatically:
`protocol` → `session-store`/`tools`/`model` → `agent-core` →
`coding-agent` → `tui` → `cli`. Keep the esbuild bundle as the
`kern` distribution even here; libraries are for embedders.

## Pre-publish checklist (both options)

- [ ] `pnpm typecheck` clean; `pnpm test` green (20 model tests + new)
- [ ] One live pty pass: boot → submit → settle → `/connect` → `/quit`
- [ ] Version bumped once across every touched `package.json`
- [ ] `LICENSE` (MIT) at repo root; `npm pack --dry-run` file list reviewed
- [ ] `engines` say `>=22.19.0` everywhere (pi-tui floor)
- [ ] `Guide.md` install section updated from `git clone` to `npm i -g kern`
- [ ] First publish uses `--access public` (scoped or not); enable
      npm provenance (`--provenance`) in CI when wired up
