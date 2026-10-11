---
name: docs-authoring
description: Create or update project docs so the repo’s actual architecture and behavior are explained clearly without requiring full codebase reading. Use for README, user guides, developer docs, architecture notes, and knowledge capture.
allowed-tools:
  - read
  - grep
  - bash
  - edit
---

# Documentation authoring workflow

Use this skill when the task is to write or update a user guide, developer guide, architecture memo, or repo-level documentation.

## Goal

Write accurate documentation from the project’s actual structure and behavior, using the repo’s known package boundaries and docs rather than broad source spelunking.

## Workflow

1. Start with the canonical repo docs and manifests.
   - `README.md`
   - `.agents/Guide.md`
   - `.agents/Kern-Kernel.md`
   - `.agents/userguidmanual.md`
   - root and package `package.json` files

2. Document the real architecture, not a guessed ideal.
   - describe actual package responsibilities
   - describe actual scripts and entrypoints
   - describe real user flows and safety rules

3. Keep the doc organized by audience:
   - user guide for end users
   - architecture guide for developers and maintainers
   - operational guide for troubleshooting and session behavior

4. Prefer crisp sections and explicit examples.
   - installation / connect / run / safety / commands / troubleshooting
   - examples should use the actual commands available in the repo

5. Keep factual statements tied to the repo’s current behavior.
   - mention TTY vs print mode
   - mention user-owned blank editor if applicable
   - mention escape/cancel behavior if it exists
   - mention provider discovery and config precedence

6. When updating docs, make sure the wording matches the implementation.
   - do not describe old, outdated suggestion screens if the UI no longer does that
   - do not describe commands that were removed unless they still exist

## Documentation standards

- Prefer concise, direct explanations.
- Use examples with actual command names from the repo.
- Call out safety, approval, and session durability clearly.
- If a behavior is intentionally minimal, say so.

## Guardrails

- Do not invent undocumented features.
- Do not describe speculative future features as current behavior.
- Avoid writing long essays when the repo already has a clean architecture doc.
- Keep each doc useful to the intended audience without needing to read the whole codebase.
