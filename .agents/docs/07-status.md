# 07 — Status: Done, Missing, Next

Last verified: typecheck green; smoke tests passed (isolated HOME run:
JSONL chain with `seq`, scripted-model tool call with correct event order,
sensitive-path denial, `../../` escape blocked, invalid-args rejection,
branch preservation, resume reconstruction).

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

## 7.2 Missing (in priority order)

1. **Real model adapter.** `packages/model` is an empty scaffold; the fake
   model is the default. One provider adapter (OpenAI first) against the
   existing `ModelAdapter` contract is the single highest-value step — it
   tests the riskiest boundary (streaming arg fragments, usage fields, stop
   reasons, malformed calls) with reality.
2. **Real tokenizer.** Char-based estimation is an explicit placeholder;
   replace with a true counter or provider `usage`-driven accounting.
3. **Persistent tests.** `vitest` is configured, zero test files exist.
   Priority: registry/policy decisions, invariant violations, compaction
   cutoff, JSONL quarantine, replay of a recorded session.
4. **Second agent type.** A read-only analyst composed without kernel edits
   is the experiment that proves Kern is genuinely a kernel — and the
   friction it surfaces defines the true extension seam.
5. **Not yet started, by design:** TUI, RPC/JSON modes, extension runtime,
   MCP, subagents. All fit behind `AgentSession` when evidence demands them.

## 7.3 Working agreements

- Minimal edits; typecheck after every step; no speculative generality.
- `protocol` stays dependency-free; `agent-core` stays UI-free.
- Fail closed everywhere except compaction (fail open) — see `06`.
- No global unsafe toggle, ever.
