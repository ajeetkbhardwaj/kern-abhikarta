# 05 — Composition (`@kern/coding-agent`, `@kern/cli`)

How the kernel becomes a concrete agent. The rule: **agent types are
compositions of kernel pieces, never kernel edits.**

## 5.1 Facade (`createAgentSession`)

```mermaid
flowchart TD
    A["createAgentSession({cwd, policy, budgets, ...})"] --> B["SessionStore + SessionManager<br/>(create or resume)"]
    A --> C["ToolRegistry + DefaultPolicy<br/>+ read/write/edit/bash"]
    A --> D["ResourceLoader.load(cwd)<br/>→ ContextBuilder.setSystemExtra"]
    B --> E["AgentRuntime<br/>(model, tools, sessions, context, budgets, compactor)"]
    C --> E
    D --> E
    E --> F["AgentSession { prompt, subscribe, budgetUsage }"]
```

Options and their defaults:

| Option | Default | Meaning |
|---|---|---|
| `policy` | conservative `DEFAULT_POLICY_CONFIG` | Partial override of approval, allow/deny lists, autonomy |
| `budgets` | 50 / 30 / 200 / 10 min | Partial override of turn/call/time caps |
| `requestApproval` | absent (= deny) | Approval sink for write/exec/destructive ops |
| `loadResources` | `true` | AGENTS.md + skill catalog |
| `enableCompaction` | `true` | Automatic compaction at safe boundaries |
| `model` | no-op fake | **Inject a real `ModelAdapter` here** |
| `resume` | `false` | Resume most-recent session for cwd |
| `storageRoot` | `~/.kern/agent/sessions` | Override for tests and isolation |

`AgentSession` is the entire public surface: `prompt(text, {signal?})`,
`subscribe(listener)`, `budgetUsage()`. TUI, RPC, tests, and subagents all
build on these three methods.

## 5.2 CLI (`@kern/cli`, print mode)

Thin by design: parse flags → create session → subscribe → prompt.
Flags: `--read-only` (allowlist `read` only), `--max-turns N`, `--cwd DIR`,
`--no-resources`, `--no-compaction`, `--resume`, `--help`.

Two rules the CLI follows that every future UI must copy:

1. **Approval**: TTY gets an interactive `[y/N]` prompt; non-TTY denies.
   Fail closed, always.
2. **Streams**: human text on stdout, machine/status on stderr. stdout stays
   clean for piping; this is what keeps future `--mode json` / RPC viable.

## 5.3 Building a new agent type

A new agent type (analyst, reviewer, researcher, …) is a small module that:

1. Calls `createAgentSession` with its own composition:
   - analyst → `policy: { allowlistTools: ["read"] }`, tight budgets
   - reviewer → read-only + a `comment` skill in `.agents/skills/`
   - researcher → registers a `web_fetch` tool (`sideEffect: "network"`)
     plus explicit network policy grants
2. Supplies its own system prompt section (via `systemExtra` or a wrapper
   around the builder) and its own skills directory.
3. Renders `AgentEvent`s in its own UI without touching kernel state.

```mermaid
flowchart LR
    K["kernel<br/>(stable)"] --> F["createAgentSession"]
    F --> C1["coder agent<br/>full tools, ask-approval"]
    F --> C2["analyst agent<br/>read-only, tight budgets"]
    F --> C3["reviewer agent<br/>read + comment skill"]
    C1 --> U1["TUI / CLI / RPC"]
    C2 --> U1
    C3 --> U1
```

If a second agent type cannot be built without editing kernel files, that
friction — not speculation — defines the next kernel seam. Generality is
earned from duplication, never guessed in advance.
