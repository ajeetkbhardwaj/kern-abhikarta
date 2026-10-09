# 07 — Status: Done, Missing, Next

Last verified: typecheck green; 20/20 model unit tests pass
(`packages/model/test/discovery.test.ts`); live pty runs green
(submit → settle → quit; full `/connect` wizard against a stub
endpoint; auth-recovery dialog; fullscreen dock layout).

## 7.1 Done

- Protocol contracts + Zod schemas + validation helpers + redaction.
- JSONL store with load validation, trailing-line quarantine, tree
  invariants (fail closed), `seq` tracking.
- Tool registry with validate→policy→execute ordering, `DefaultPolicy`
  (deny-by-default), realpath safety, hardened bash (process-group kill,
  timeouts, abort), registry timeouts, arg validation, binary/size guards.
- Agent loop with budgets, token-aware snapshots, compaction engine
  (gated, structured, incremental, fail-open), retry with jitter + events,
  cancellation without partial writes.
- Resource loader (AGENTS.md walk-up, catalog-only skills).
- Facade with policy/budget/approval/resource/compaction/model/resume
  options; CLI print mode with safe flags and TTY-gated approval.
- **Model layer (`@kern/model`).** OpenAI-compatible streaming adapter
  (`POST {baseUrl}/chat/completions` SSE, tool-call assembly, usage
  mapping, classified `KernError`s); provider discovery via
  `GET {baseUrl}/models`; presets (openai, openrouter, nvidia, ollama,
  lmstudio, llamacpp); `~/.kern/models.json` + project override merging;
  secrets in `~/.kern/auth.json` (0600), never in config; credential
  precedence flag → auth.json → config → env → loopback; displayName /
  whitelist / blacklist filtering; last-used tracking.
- **Interactive TUI (`@kern/tui`, see `08-tui.md`).** Fullscreen Pi-style
  UI on `@earendil-works/pi-tui` (MIT): docked prompt, Pi dark theme,
  12 slash commands, `/connect` wizard with live endpoint test,
  arrow-key approvals with destructive-pattern danger style,
  auth-failure recovery, toasts, queue, suggestions, shell mode,
  `@file` mentions. Verified live under pty.
- **Persistent tests, started.** 20 unit tests cover auth, masking,
  provider save/test, filtering, last-used (`discovery.test.ts`).

## 7.2 Missing (in priority order)

1. **Real tokenizer.** Char-based estimation (`tokens.ts`) is an explicit
   placeholder; usage-driven accounting already flows through when the
   provider returns it, but local estimation needs a true counter.
2. **Wider test coverage.** Policy decisions, invariant violations,
   compaction cutoff, JSONL quarantine, and TUI flows have no automated
   tests yet — only the model store does.
3. **Second agent type.** A read-only analyst composed without kernel edits
   is the experiment that proves Kern is genuinely a kernel — and the
   friction it surfaces defines the true extension seam.
4. **Not yet started, by design:** RPC/JSON modes, extension runtime,
   MCP, subagents. All fit behind `AgentSession` when evidence demands them.

## 7.3 Working agreements

- Minimal edits; typecheck after every step; no speculative generality.
- `protocol` stays dependency-free; `agent-core` stays UI-free.
- Fail closed everywhere except compaction (fail open) — see `06`.
- No global unsafe toggle, ever.
- The TUI's only third-party dependency is `@earendil-works/pi-tui`
  (MIT); everything else in `packages/tui` is Kern's own orchestration.
