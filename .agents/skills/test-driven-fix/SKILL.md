---
name: test-driven-fix
description: Investigate failing tests, isolate regressions, fix the cause, and verify with the smallest relevant test run. Use when the user asks to debug, repair, or validate a bug fix.
allowed-tools:
  - read
  - grep
  - bash
  - edit
---

# Test-driven fix workflow

Use this skill when the task is about fixing a bug or regression, especially when tests already fail or the user expects a validation-first workflow.

## Goal

Diagnose the smallest correct fix and verify it with a targeted test run instead of broad speculation.

## Workflow

1. Start from the failing signal:
   - read the test file
   - identify the exact assertion or failure message
   - locate the nearest implementation under test

2. Reproduce the failure with the narrowest command possible.
   - Prefer a specific file, pattern, or package test over the entire repo.
   - Keep output focused and actionable.

3. Form a hypothesis before editing.
   - State what the code is doing wrong.
   - State what the expected behavior should be.
   - Make the cause explicit before changing logic.

4. Apply the smallest valid fix.
   - Prefer surgical edits over refactors.
   - Preserve existing package boundaries and public interfaces.
   - Keep changes scoped to the failing behavior.

5. Validate with the smallest relevant check.
   - Run the specific failing test file first.
   - If needed, run the closest package suite or targeted command.
   - Do not run the whole repo unless the task justifies it.

6. Report back with:
   - root cause
   - files changed
   - verification command
   - result summary

## Guardrails

- Do not change unrelated behavior.
- Do not expand the test surface for no reason.
- If a failing test is missing or insufficient, add the minimum test that captures the bug.
- Prefer stable local validation over broad speculation.
- When the issue is architectural, keep the fix in the correct package and avoid mixing UI and runtime behavior.
