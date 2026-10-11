---
name: architecture-review
description: Review Kern’s architecture, package boundaries, and runtime responsibilities without reading the entire repo. Use for design questions, package ownership, and deciding where new logic should live.
allowed-tools:
  - read
  - grep
  - bash
---

# Architecture review workflow

Use this skill when the task is about repo structure, boundaries, runtime responsibilities, or planning work before implementation.

## Goal

Answer architectural questions from the project’s documented system boundaries rather than by scanning the whole codebase.

## Workflow

1. Read the repo-level entry points first:
   - `README.md`
   - `.agents/Guide.md`
   - `.agents/Kern-Kernel.md`
   - `.agents/docs/*.md`
   - root `package.json`

2. Use package manifests to understand ownership:
   - `packages/*/package.json`
   - note which package owns protocol contracts, session store, tools, runtime, model adapters, TUI, and CLI.

3. Reason by package responsibilities, not by file-by-file intuition:
   - `protocol` defines shared contracts and event types
   - `session-store` owns persistence and invariants
   - `tools` owns policy and validation
   - `agent-core` owns runtime loop, budgets, context, retry, compaction
   - `model` owns provider discovery and auth
   - `coding-agent` owns the session facade
   - `tui` and `cli` are presentation layers

4. If a question is about whether logic belongs in runtime or UI, prefer:
   - runtime logic goes into `agent-core`, `session-store`, `model`, or `tools`
   - UI-only state and keyboard handling stays in `tui`
   - CLI flags, argument parsing, and launch behavior stay in `cli`

5. Before proposing a design change, check whether it is:
   - a protocol change
   - a runtime policy change
   - a session/data change
   - a UI-only change
   - a provider/model change

6. If there is no clear evidence from docs or package manifests, keep the proposal small and scoped; avoid broad refactors.

## Decision rules

- Prefer minimal, kernel-first design.
- Keep the core runtime independent from presentation layers.
- Keep durable session state separate from ephemeral UI state.
- Keep all provider-specific behavior behind the model adapter layer.
- Treat the TUI as an observer and controller, not as the source of runtime truth.

## Output style

When answering, provide:
- the package boundary involved
- the architectural reason for that boundary
- any likely impact on session, model, or runtime behavior
- a minimal recommendation with scope and risk

## Guardrails

- Do not expand into the full repo unless the user explicitly asks for a deep implementation review.
- Do not propose new subsystems unless they fit existing package boundaries.
- Prefer documented repo structure over speculative architecture.
