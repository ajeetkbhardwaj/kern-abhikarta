# Kern Kernel — Status (Steps D–J complete)

## Completed
- [x] **A**: Protocol Zod schemas + `seq` on BaseEntry + validation helpers
- [x] **B**: Session JSONL validation on load (trailing-malformed quarantine) + tree invariants enforced on load (acyclic, parents exist, leaf exists, seq non-decreasing) + `lastSeq` tracking
- [x] **C**: Deny-by-default `DefaultPolicy` + `PolicyConfig` (allowlist/denylist, origin tracking, destructive-command detection, sensitive-path block, approval modes `ask|never|auto-allowlist`)
- [x] **D**: Tool hardening — arg validation against inputSchema (`E_TOOL_INVALID_ARGS`), realpath-enforced `safePath` (fail closed on escape), sensitive-path + binary guards in `read`, write size cap, bash process-group kill (SIGTERM→SIGKILL), per-call + registry-level timeouts, abort propagation
- [x] **E**: Budgets (`maxTurns`, `maxToolCallsPerTurn`, `maxTotalToolCalls`, `maxWallTimeMs` via `BudgetTracker`) + token estimation (`tokens.ts`) + context usage on every `ContextSnapshot`
- [x] **F**: `Compactor` — budget-gate evaluation (`S+T+H+R+M<=W`), structured checkpoint prompt (goal/constraints/workspace/progress/decisions/errors/next-steps/artifacts), incremental (feeds previous checkpoint), auto-hooks `before_prompt` + `after_agent_end`, failure is fail-open with diagnostic
- [x] **G**: `ResourceLoader` — AGENTS.md walk-up discovery, `.agents/skills` + `.pi/skills` discovery, frontmatter parsing, **catalog-only** system section (full bodies read on demand via `read`)
- [x] **H**: Retry with backoff+jitter + `auto_retry_start/end` events (only transient kinds), cancellation threaded through turn→model→tools, abort = `agent_end(aborted)` + diagnostic, no partial writes
- [x] **I**: Facade wiring — `createAgentSession` accepts policy/budgets/approval/resources/compaction/model/resume; CLI flags `--read-only --max-turns --cwd --no-resources --no-compaction --resume --help`, TTY approval prompt, non-TTY denies, logs to stderr only
- [x] **J**: Smoke verified (isolated HOME): session JSONL chain header→user→assistant with seq; scripted-model `read` returns file content with correct event order; sensitive path denied; `../../` escape fails closed; invalid args rejected pre-execution; branch keeps both children; resume reconstructs active branch

## Defaults (conservative, non-negotiable)
- Approval `ask` for write/edit/bash/destructive; reads allowed; unknown tools denied with reason
- Workspace-only + realpath enforcement on; sensitive paths blocked; network off (no network tools exist)
- Redaction on; telemetry off (none exists); budgets 50 turns / 30 per-turn / 200 total / 10min wall
- No global unsafe toggle — granular per-capability controls only

## Known gaps / next (not yet built)
- `packages/model` is an empty scaffold — no real provider adapter yet (OpenAI/Anthropic). Fake model is default.
- No TUI, no RPC/JSON modes, no extension runtime, no MCP — all behind the same `AgentSession` seam when added.
- Token counting is char-based estimate (~4 chars/token); swap for a real tokenizer or provider `usage` when adapters land.
- No persistent tests yet (`vitest` configured, zero test files). Priority: registry/policy, invariants, compactor cutoff, replay.
- `SessionManager.resume` picks most-recent by mtime; no `--session` pinning in CLI yet.
