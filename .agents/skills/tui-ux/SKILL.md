---
name: tui-ux
description: Improve the Kern TUI experience for users, especially responsiveness, clarity, and minimal command noise. Use when adjusting the terminal interface, prompt flow, status row, editor behavior, or interaction design.
allowed-tools:
  - read
  - grep
  - bash
  - edit
---

# TUI UX workflow

Use this skill for terminal UI work, prompt layout, status indicators, editor behavior, and user-first interaction design.

## Goals

- Keep the interface calm and minimal
- Make progress visible without overwhelming the user
- Keep direct user control in the editor
- Avoid prefilled instructions, forced suggestions, or noisy command clutter

## Core principles

1. The editor belongs to the user.
   - Do not inject canned prompts.
   - Keep the editor blank unless the user types.

2. Progress should be visible near the prompt.
   - Use a compact status row above the editor.
   - Show dynamic states like: thinking, writing, running search, ready.

3. Preserve user intent.
   - Avoid forcing workflows that hide the user’s input.
   - Keep commands optional and discoverable, not intrusive.

4. Reduce clutter.
   - Merge overlapping commands where possible.
   - Keep the command set small and consistent.
   - Prefer a quiet interface over a noisy one.

## Typical tasks

- remove unnecessary suggestion overlays
- add/adjust live activity indicators
- make the status row visually stable and readable
- simplify slash commands and help text
- improve transcript readability
- ensure Escape and Ctrl+C behavior are consistent with the desired UX

## Work pattern

1. Review current TUI layout and status logic in `packages/tui/src/tui.ts`.
2. Identify whether the issue is behavior, clarity, or command noise.
3. Prefer direct, tested UI changes over broad redesigns.
4. Keep the interface minimal and stable.
5. Verify the app still typechecks after the UX change.

## Guardrails

- Do not reintroduce forced prompt suggestions.
- Do not crowd the editor with placeholders or hidden instructions.
- Do not add extra commands unless they are clearly necessary.
- Do not make the interface “busy” when a quiet status line is enough.
