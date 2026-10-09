/**
 * @kern/tui — slash-command + file autocomplete provider.
 *
 * Thin factory over pi-tui's `CombinedAutocompleteProvider`: `/command`
 * completion is ranked in-memory with pi's bundled fuzzy filter, and `@file`
 * / path completion shells out to the `fd` binary. No hand-rolled walker or
 * scorer lives here anymore.
 *
 * `fd` credential: when no `fd` binary is on PATH, pi-tui degrades
 * gracefully (spawn `"error"` → empty file suggestions, no throw), so
 * `/command` completion keeps working but `@file` completion returns
 * nothing. Pass an explicit `fdPath` (or null to disable file search) via
 * the third argument when the orchestrator needs to control this.
 */

import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

export { CombinedAutocompleteProvider };

/**
 * Build the pi-tui autocomplete provider for the prompt editor.
 *
 * @param commands Slash commands (`/name`) offered at the start of a line.
 * @param cwd Workspace root used as the base path for file completion.
 * @param fdPath `fd` binary pi-tui shells out to for file search.
 *   Defaults to `"fd"` (resolved via PATH when present). When the binary
 *   is missing, file suggestions degrade to empty — gracefully, without
 *   throwing — while slash-command completion is unaffected.
 */
export function buildAutocomplete(
  commands: Array<{ name: string; description: string }>,
  cwd: string,
  fdPath: string | null = "fd",
): CombinedAutocompleteProvider {
  return new CombinedAutocompleteProvider(
    commands.map((c) => ({ name: c.name, description: c.description })),
    cwd,
    fdPath,
  );
}
