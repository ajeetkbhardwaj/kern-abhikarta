---
name: model-provider-runtime
description: Handle model provider setup, endpoint selection, auth flow, and runtime integration without depending on full repo exploration. Use for provider setup, model discovery, API auth config, or local/openai-compatible endpoint issues.
allowed-tools:
  - read
  - grep
  - bash
  - edit
---

# Model and provider workflow

Use this skill when the task concerns provider config, model selection, OpenAI-compatible endpoints, local models, or auth/test flows.

## Goal

Keep provider logic aligned with the current repo’s model adapter and configuration conventions.

## Relevant repo facts

- Kern supports OpenAI-compatible endpoints.
- Provider configuration is handled through config files and environment variables.
- Local servers like Ollama, LM Studio, and llama.cpp are supported.
- The in-app `/connect` flow and `/model` flow are the preferred entry points for live configuration.

## Workflow

1. Determine whether the task is about:
   - provider setup
   - model discovery
   - auth resolution
   - config file management
   - runtime environment overrides

2. Prefer the documented model precedence:
   - flag > env > config file

3. Understand the key config behaviors:
   - `apiKey` may be literal, `$ENV_VAR`, or `!command`
   - local loopback providers usually do not need a key
   - live model discovery is done through provider endpoints

4. When debugging provider issues, check these in order:
   - endpoint URL
   - key resolution
   - environment variable export
   - provider config file contents
   - model ID selection
   - provider model list and auth test response

5. Keep fixes scoped to the provider layer.
   - no runtime logic changes unless the problem is truly in session flow
   - no TUI churn unless the issue is in the picker or wizard UX

## Output style

- say whether the issue is configuration, auth, discovery, or runtime selection
- specify the exact precedence or behavior involved
- provide a clear next step or fix recommendation

## Guardrails

- Do not assume a provider is custom-coded; treat it as OpenAI-compatible unless the repo or docs show otherwise.
- Do not rewrite the whole provider stack for a small auth issue.
- Keep the fix local to model discovery, config resolution, or the user-facing picker flow.
