# 08 — TUI (`@kern/tui`)

Scrollback-mode terminal UI on our own zero-dependency component framework:
differential main-screen renderer, synchronized output (CSI 2026),
multiline editor, Markdown with syntax highlighting, searchable select
lists, loader, boxes, status bar, tool cards.

Scrollback-mode terminal UI: transcript streams into native scrollback, a
raw-mode multiline editor owns the bottom block while idle. Zero
dependencies. The TUI observes `AgentEvent`s and acts only through the
`AgentSession` API.

## Layout model

- While idle: the input block is the last screen content; every keystroke
  rewrites it in place with the hardware cursor repositioned.
- While busy: the last screen row is always exactly one status row
  (spinner `⠋ 12s · running bash…` or queue-draft echo `… queue: …`),
  cursor on it, no trailing newline. Every print clears that row first,
  writes, then redraws it — so output and typing never garble.
- Overlays (model picker, history search, approval dialog) suspend the
  editor, render below the cursor, and erase their rows on close.

## Input

Multiline (`Alt+Enter`, `Ctrl+J` where delivered, bracketed paste inserts
literally). Readline bindings: `Ctrl+A/E`, `Alt+B/F` + `Ctrl+←/→`
(alnum word class), `Ctrl+W` (to whitespace), `Alt+D`, `Ctrl+K/U/Y`
(kill ring), `Ctrl+S` stash/restore, `Ctrl+R` history search overlay,
`Tab` accepts ghost completion, `Esc` clears, `Ctrl+L` redraws,
`Ctrl+D` twice exits. Enter submits (`\r` and `\n` both submit — some
pty stacks translate CR→LF); lone `Esc` at a chunk edge waits 40 ms so
split arrow/alt sequences still parse.

Ghost completion: leading or mid-prompt `/command` (with `+N` count) and
`@file` from a cached workspace walk (skips `node_modules/.git/dist…`,
cap 3000). `Tab` inserts the top match. `@path` expands on submit to
`<file path>content</file>` (40 KB cap; missing files stay literal with a
warning). Pasted invisible Unicode (zero-width/bidi/tags, keeping ZWNJ)
is stripped on submit with a review-and-resend notice.

## While a turn runs

Typing builds a queue draft on the status row; `Enter` queues (cap 5),
`Ctrl+C`/lone `Esc` aborts (queued messages still send next, Claude-style).
`!cmd` shell mode runs `bash` directly as user origin (policy still
applies) and feeds the output back as the next prompt.

## Approvals

Arrow-key dialog — *Yes, run once / Yes, always allow {tool} this session /
No (Esc)* — instead of y/N. "Always" calls `allowToolForSession`;
`Esc`/Ctrl+C declines (fail closed). `Shift+Tab` cycles approval modes
`manual (ask)` ↔ `auto` (per-op prompts off; destructive/deny/sensitive
rules still enforced), shown in header and status.

## Rendering

Assistant text is styled per completed line (headings, bold, inline code,
fences, quotes, lists); only fence state crosses lines. Tool cards
(`◈/✔/✖`), compaction/retry notices, and a per-turn status line
(model · mode · turns · calls · seconds · ctx %) complete the transcript.

## Commands

`/help /model /compact [note] /diff /new /export [file] /budget /clear
/quit`. `/new` swaps in a fresh session (resubscribed, file cache
refreshed); `/export` dumps the active path to markdown.

## Visual structure

- Header banner in a titled box (product, model, mode, cwd), divider rule.
- Prompt editor inside a `prompt` box; cursor positioned via marker scan.
- Full-width status bar (model │ mode │ ctx% │ turns/calls/time).
- Tool executions render as live cards: header with arg summary, streamed
  output (capped, "+N more"), ✔/✖ footer with duration. Edit results show
  a unified diff hunk.
- Code fences render as bordered blocks with language label.
- Approval / model / history dialogs are titled boxes; dialogs route input
  to the interactive child via `Box.setInputTarget`.
