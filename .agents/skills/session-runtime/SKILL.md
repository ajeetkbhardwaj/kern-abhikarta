---
name: session-runtime
description: Work on Kern’s session lifecycle, prompt handling, state durability, turn execution, and runtime safety without broad codebase reads. Use for session resume, compaction, history, queues, abort behavior, and runtime error handling.
allowed-tools:
  - read
  - grep
  - bash
  - edit
---

# Session and runtime workflow

Use this skill when the task is about a live agent turn, session state, compaction, queueing, cancellation, resuming, or durable interaction flow.

## Goal

Keep the session flow predictable, durable, and safe while preserving user control and runtime clarity.

## Core behaviors to preserve

- User turns are sequential and recorded.
- Queueing can happen while the agent is busy.
- The session persists to durable JSONL-like storage.
- The runtime can compact long histories.
- Abort and retry behavior must remain explicit and visible.

## Workflow

1. Confirm what part of the lifecycle is involved:
   - new session creation
   - prompt submission
   - active run abort
   - queueing and retry
   - compaction or checkpoint creation
   - export or resume

2. Keep the fix at the right layer:
   - session/store concerns in session-store and runtime state
   - UI concerns in the TUI layer
   - tool execution concerns in the tools layer
   - model failure handling in model/runtime adapters

3. When changing runtime behavior, preserve:
   - durable state consistency
   - explicit abort semantics
   - user feedback in the status row and transcript
   - safe failure handling rather than silent swallow

4. verify the behavior with the smallest relevant action:
   - start a turn
   - stop it with Escape or Ctrl+C
   - ensure model/runtime transition returns to ready state
   - confirm queue or session state remains coherent

## Guardrails

- Do not treat UI-only status as runtime truth.
- Do not lose transparency when a run is cancelled.
- Do not turn silent cancellation into hidden state.
- Do not broaden the fix to unrelated session or storage logic.
