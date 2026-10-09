import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

export { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

export function buildAutocomplete(
	commands: Array<{ name: string; description: string }>,
	cwd: string,
	fdPath?: string | null,
): CombinedAutocompleteProvider {
	return new CombinedAutocompleteProvider(
		commands.map((c) => ({ name: c.name, description: c.description })),
		cwd,
		fdPath ?? null,
	);
}
