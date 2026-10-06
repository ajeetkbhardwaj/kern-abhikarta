# Kern Todo — What Is Actually Needed

Derived from: (a) Kern's own kernel philosophy (kernel = stable core engine,
agent types compose on top), (b) Pi's current published design
(`pi.dev/docs/latest`, repo `earendil-works/pi`), used as the reference
implementation to align with where cheap and to differ from where deliberate.

## Research findings (Pi vs Kern deltas that matter)

1. **Session versions + auto-migration.** Pi is on session format v3
   (v1 linear → v2 tree → v3 renames), migrated automatically on load.
   Kern has `SESSION_ENTRY_VERSION = 1` and zero migration machinery.
   Any format change we make later will strand existing sessions.
2. **System prompt is persisted, not recomputed.** Pi stores the prompt +
   tool loadout as leading system messages; later changes are patch messages
   (`sections` by name, `toolsAdded`/`toolsRemoved`). Replaying the file
   yields the exact prompt. Kern rebuilds the prompt from live config, so a
   session file alone is **not** reproducible — our core contract is broken.
3. **Usage is persisted.** Pi records `usage` entries (incl. `cache_warm`,
   nested-call usage bubbled up, cost) that feed session totals but stay out
   of the tree/context. Kern records no usage anywhere; totals, cost, and
   usage-based compaction triggers have no durable source.
4. **Compaction entries carry checkpoints.** Pi stores `summary` +
   `firstKeptEntryId` + `tokensBefore` + full system/tool checkpoint +
   usage. Kern stores summary + `replacesThroughId` only.
5. **Branch switches can keep a summary.** Pi's `branch_summary` captures the
   abandoned path. Kern's `BranchEntry` is a bare marker.
6. **Tools have annotations + exposure, not just names.** Pi follows MCP
   hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
   `openWorldHint`) and exposures
   (`direct`/`model-only`/`codemode`/`deferred`/`hidden`); the permission
   example keys approval off annotations. Kern's policy keys off tool
   **names** — brittle, non-standard, breaks with custom/MCP tools.
7. **Events are actionable, not notify-only.** Pi has `before_agent_start`
   (mutate prompt/tools), `tool_call` (mutate input or block),
   composable `tool_result`, `turn_end`/`agent_before_settle` (append entries
   + request one continuation), and the hard rule that `agent_settled` is
   notification-only. Kern's bus is observe-only; extensions (when they come)
   will have nothing to hook.
8. **Prompt-while-streaming has queue semantics.** Pi forces the choice:
   `steer` (enters after current turn + its tools) vs `followUp` (after the
   run). `prompt()` without that choice rejects. Kern has no queue — a
   second prompt mid-turn races the loop.
9. **Session runtime ops exist.** Pi: `newSession` / `switchSession` /
   `fork` / `importFromJsonl`, with subscription rebinding after replacement,
   and `dispose()` (abort + invalidate + remove listeners). Kern: create,
   resume-most-recent, `branchTo`. No fork-to-file, no import, no dispose.
10. **Settings are a replaceable service.** Pi: file-backed or in-memory
    `SettingsManager` owned by the session. Kern: `PolicyConfig` passed at
    construction, no file discovery (`~/.kern`, project config).
11. **Models are a runtime, not a field.** Pi: `ModelRuntime`,
    `thinkingLevel`, scoped models, virtual models, `registerProvider` for
    custom providers. Kern: single injected adapter, fake by default,
    `packages/model` an empty scaffold.
12. **Resource loading is an interface.** Pi: `ResourceLoader` replaceable,
    inline extensions with `replaceable` flags, built-ins as extensions.
    Kern: concrete `ResourceLoader`, no seam.
13. **Pi has NO built-in permission system** — it delegates to
    containerization (docs: Gondolin/Docker/OpenShell). Kern's policy engine
    is a deliberate difference: keep it, but rebase it on annotations (6)
    so custom tools inherit sane defaults.
14. **Missing surfaces:** TUI lib (differential rendering), print/JSON/RPC
    modes, prompt templates (expanded before user messages), session names
    for `/resume`, trash-safe delete, telemetry contracts (opt-in).

## Todo (ordered, no filler)

### Phase 0 — Format safety (before any format change)
- [ ] **T0.1 Migration framework.** `migrate(entries, fromVersion)` in
      session-store; header `version` checked on load; unknown future major
      fails closed with a clear error. Acceptance: a v1 fixture loads after
      we bump to v2.
- [ ] **T0.2 Align entry ids with Pi.** 8-char hex ids (`newId` change),
      header keeps `id`/`sessionId`/`cwd`. Keep `seq` (ours, Pi lacks it —
      it powers cutoffs/replay). Acceptance: existing tests updated, smoke
      session readable by the parser example shape.

### Phase 1 — Reproducibility (core contract repair)
- [ ] **T1.1 Persist system checkpoints.** On first request per session,
      append a system message with prompt sections + tool declarations;
      on prompt/toolset change, append patch messages (`toolsAdded`/
      `toolsRemoved`, sections by name). Context rebuild replays them.
      Acceptance: delete config + skills, reload session file only, rebuilt
      prompt is byte-identical.
- [ ] **T1.2 Persist usage entries.** `usage` entry kind for model calls,
      compaction summaries, (later) cache warming; include provider,
      model, token counts, cost when known. Excluded from context, included
      in totals. Acceptance: session totals computable from file alone.
- [ ] **T1.3 Richer compaction entries.** Add `tokensBefore`, `usage`, and
      the system/tool checkpoint to `CompactionEntry`. Acceptance: resume
      after compaction reconstructs prompt without live config.

### Phase 2 — Tool model upgrade (annotations + exposure)
- [ ] **T2.1 MCP-style annotations** on `ToolDefinition`
      (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
      `openWorldHint`, honest defaults: not-read-only, possibly
      destructive). Acceptance: built-ins annotated; policy derives
      approval need from hints, names only as override.
- [ ] **T2.2 Active tool set.** Registered vs active tools; loadout changes
      recorded via the T1.1 patch mechanism. Acceptance: deactivating `bash`
      mid-session persists + rebuilds correctly.
- [ ] **T2.3 Structured results.** Optional `outputSchema` +
      `structuredContent` alongside model-facing `content`; failures with
      data return `isError: true` instead of throwing. Acceptance: one
      JSON-producing tool round-trips typed data.

### Phase 3 — Runtime semantics (concurrency + queue)
- [ ] **T3.1 Parallel read-only tools.** Calls in one message run
      concurrently iff all are `readOnlyHint` and arg-independent;
      persisted in call order. Acceptance: 3×read wall-time ≈ 1×read,
      JSONL order deterministic.
- [ ] **T3.2 Prompt queue.** `prompt()` while streaming rejects unless
      `{ steer }` or `{ followUp }`; steer lands after current turn+tools,
      follow-up after the run. Acceptance: no interleaved turns under a
      scripted slow model.
- [ ] **T3.3 Dispose.** `dispose()` aborts work, removes listeners,
      invalidates further calls. Acceptance: prompt-after-dispose rejects.

### Phase 4 — Model runtime (the riskiest boundary, with reality)
- [ ] **T4.1 One real provider adapter** in `packages/model` (OpenAI
      first): streaming arg fragments, usage normalization, stop reasons,
      malformed-call recovery, auth vs transient classification.
      Acceptance: real end-to-end read→edit→bash→verify on this repo.
- [ ] **T4.2 Thinking levels** plumbed through `ModelRequest` →
      adapter → persisted on assistant messages. Acceptance: level switch
      mid-session recorded + honored.
- [ ] **T4.3 Real token accounting.** Tokenizer (or provider usage) feeds
      the compaction gate; char-estimate removed. Acceptance: gate numbers
      match provider-reported context within 5%.

### Phase 5 — Sessions + settings services
- [ ] **T5.1 Session runtime ops.** `fork` (to new file, root→selected path
      + provenance), `importFromJsonl`, `switchSession` with documented
      subscription rebinding. Acceptance: forked session resumes
      independently; original untouched.
- [ ] **T5.2 Branch summaries.** On branch-away, optional model-written
      summary of the abandoned path (`fromId` → summary).
      Acceptance: summary entry present, context includes it once.
- [ ] **T5.3 Settings layer.** `~/.kern` user config + project config
      discovery, file-backed or in-memory, owned by the session; policy and
      budgets read from it. Acceptance: project `.kern` file changes
      approval behavior with no code change.
- [ ] **T5.4 Session names + safe delete.** Name entry (`/name`),
      `/resume` shows names, delete via trash when available.
      Acceptance: round-trip name + delete in CLI.

### Phase 6 — Actionable events (the extension prerequisite)
- [ ] **T6.1 `before_agent_start`** (inspect/mutate prompt sections +
      tool selection per run). Acceptance: a test hook adds a prompt
      section visible to the model.
- [ ] **T6.2 `tool_call` mutate/block + composable `tool_result`.**
      Acceptance: redaction hook rewrites a result; block hook denies with
      reason and the model sees it.
- [ ] **T6.3 `agent_before_settle`** (append entries + request at most one
      continuation, loop-guarded). Acceptance: hook appends a `custom`
      entry and triggers exactly one extra request.

### Phase 7 — Surfaces (only after 1–6 hold)
- [ ] **T7.1 Prompt templates.** File-based templates expanded before user
      messages enter the loop (slash layer owns expansion, core sees plain
      messages). Acceptance: `/skill:name`-style and template invocations
      in CLI.
- [ ] **T7.2 JSON + RPC modes.** NDJSON event stream; JSON-RPC on stdio;
      stdout stays machine-clean. Acceptance: Python client drives a full
      turn over RPC.
- [ ] **T7.3 TUI.** Differential renderer, transcript/input/statusbar,
      event-only subscription. Acceptance: no full-screen flicker while
      streaming; cancel works.
- [ ] **T7.4 Extension runtime.** TS modules, `registerTool/Command/Flag/
      Provider`, trust-on-first-load from explicit paths only, crash
      isolation, `custom`/`custom_message` entries. Acceptance: untrusted
      extension cannot load silently; throwing extension doesn't kill the
      session.
- [ ] **T7.5 MCP client.** Servers as tool namespaces with their
      annotations; deferred exposure. Acceptance: one stdio MCP server
      round-trips a tool call.

### Explicitly deferred (not TODO)
- Subagents/plan mode, virtual-model routing, cache warming, telemetry
  (opt-in only when asked), cloud deployment, GUI. These are agent-type or
  product concerns, not kernel concerns.

## Working agreements (unchanged)
Fail closed everywhere except compaction (fail open). No global unsafe
toggle. Generality earned from duplication, never guessed. Typecheck after
every step. `protocol` dependency-free, `agent-core` UI-free.
