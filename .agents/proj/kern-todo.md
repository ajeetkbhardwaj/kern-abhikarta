# Kern Todo — Kernel for Building Agents (not another agent)

Identity: **Kern is the engine; agent types are composed on top of it.**
Kern never becomes a coding agent, a TUI, or a product. Every item below
must pass one test: *does an agent-builder need this from the core, or can
they build it themselves on top?* If the latter, it is out.

## The kernel contract (what Kern guarantees to agent-builders)

1. **Turn loop** — prompt → model → tools → model → response, serialized,
   budgeted, cancellable, observable.
2. **Durable state** — append-only versioned log, branching, resume,
   compaction; reloadable without live config (reproducible).
3. **Capability control** — tools register with honest annotations; policy
   denies by default; approvals and budgets are hard guarantees, not hints.
4. **Observation** — typed events sufficient to build any UI; kernel state
   is never mutated from outside.
5. **Composition API** — one stable facade to build any agent type from.

## In scope / out of scope

IN (kernel): loop, state, policy, budgets, events, model boundary,
resource-discovery interfaces, composition facade, replay/verify tooling.

OUT (agent-type or product concerns, never kernel work): TUI, RPC/JSON
modes, MCP clients, extension runtimes, prompt-template galleries, skill
content, session naming/deletion UX, themes, packaging, telemetry.

## Todo

### K0 — Format safety
- [ ] **K0.1 Migration framework.** `migrate(entries, fromVersion)`;
      unknown future major fails closed. Acceptance: v1 fixture loads after
      a v2 bump.
- [ ] **K0.2 Stable ids.** 8-char hex entry ids (interop-friendly); keep
      `seq` (ours — powers cutoffs and replay).

### K1 — Reproducibility guarantees (core contract repair)
- [ ] **K1.1 Persisted system checkpoints.** First request per session
      stores prompt sections + tool loadout; later changes stored as
      patches. Context rebuild replays them. Acceptance: session file
      alone rebuilds the exact prompt — no live config needed.
- [ ] **K1.2 Persisted usage.** Usage entries (model calls, compactions)
      with provider/model/tokens/cost; excluded from context, included in
      totals. Acceptance: session totals computable from the file.
- [ ] **K1.3 Checkpointed compactions.** Compaction entries carry
      `tokensBefore`, `usage`, and the system/tool checkpoint.
      Acceptance: post-compaction resume needs no live config.

### K2 — Capability model (annotations, not names)
- [ ] **K2.1 MCP-style hints** on tools (`readOnlyHint`,
      `destructiveHint`, `idempotentHint`, `openWorldHint`); policy
      derives approval from hints, names only as override. Acceptance:
      a custom tool with `destructiveHint` requires approval with zero
      policy configuration.
- [ ] **K2.2 Registered vs active tools**, loadout changes recorded via
      K1.1 patches. Acceptance: deactivating a tool mid-session persists
      and rebuilds.
- [ ] **K2.3 Structured results.** Optional `outputSchema` +
      `structuredContent`; data-carrying failures return `isError`
      instead of throwing. Acceptance: typed round-trip for one tool.

### K3 — Loop semantics (correctness under real use)
- [ ] **K3.1 Prompt queue.** `prompt()` mid-turn rejects unless `steer`
      (after current turn+tools) or `followUp` (after the run).
      Acceptance: scripted slow model shows zero interleaving.
- [ ] **K3.2 Dispose.** Abort work, drop listeners, invalidate session.
      Acceptance: use-after-dispose rejects.
- [ ] **K3.3 Parallel read-only tools.** Concurrent iff all `readOnlyHint`
      and arg-independent; persisted in call order. Acceptance: 3×read ≈
      1×read wall-time, deterministic JSONL order.

### K4 — Model boundary, proven with reality
- [x] **K4.1 One real provider adapter** (OpenAI-compatible: OpenAI,
      NVIDIA, local servers): streaming arg fragments, usage
      normalization, stop reasons, malformed-call recovery,
      auth-vs-transient classification. Verified against a mock
      OpenAI-compatible server (text/reasoning deltas, fragmented tool
      args, usage, 401→`E_MODEL_AUTH`) and full kernel turn
      (model→read→final). CLI: `--model/--api-key/--base-url/--nvidia/
      --list-models`, `/model` switching persisted as `model_change`.
      Still open: run against a real endpoint (needs key).
- [ ] **K4.2 Thinking levels** plumbed request→adapter→message record.
      (Adapter already passes `reasoning_budget` + `enable_thinking`
      through; persistence on assistant messages still missing.)
      Acceptance: mid-session switch recorded and honored.
- [ ] **K4.3 Real token accounting** (tokenizer or provider usage) feeding
      the compaction gate; char-estimate removed. Acceptance: gate within
      5% of provider-reported context.

### K5 — Composition API (what builders actually import)
- [ ] **K5.1 Frozen facade.** `createAgentSession` options +
      `AgentSession` (`prompt`/`subscribe`/`budgetUsage`/`dispose`)
      declared stable with semver; everything else internal.
      Acceptance: a second agent type imports only the facade.
- [ ] **K5.2 Resource loader as interface.** Default filesystem
      implementation + injectable custom loader. Acceptance: test injects
      in-memory resources, no filesystem touched.
- [ ] **K5.3 Minimal hook points.** `before_agent_start` (adjust
      prompt/tools per run) and `tool_call` mutate/block — the smallest
      set an agent-builder needs; full extension systems stay out.
      Acceptance: a 20-line hook adds a prompt section and blocks one
      tool class.

### K6 — Proof (the kernel earns the name)
- [ ] **K6.1 Second agent type, zero kernel edits.** Read-only analyst
      composed purely via K5.1. Acceptance: builds, runs, and any
      friction is filed as a kernel bug, not worked around.
- [ ] **K6.2 Replay tool.** Rebuild state from a session file and
      re-verify events/invariants offline. Acceptance: recorded session
      replays to identical observable events.
- [ ] **K6.3 Persistent tests.** Registry/policy, invariants, cutoff,
      quarantine, queue, replay. Acceptance: `vitest` green, no zero-file
      suites.

## Dropped from the old Pi-mirroring todo
TUI, RPC/JSON modes, MCP, extension runtime, prompt-template expansion,
session names/trash delete, virtual models, cache warming, subagents —
agent-type or product work. Revisit only when a real agent built on Kern
demands them, with evidence.

## Agreements (unchanged)
Fail closed except compaction (fail open). No global unsafe toggle.
Generality from duplication, never guessed. Typecheck every step.
`protocol` dependency-free, `agent-core` UI-free.
