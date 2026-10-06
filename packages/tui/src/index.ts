/**
 * @kern/tui — terminal UI built from first principles.
 *
 * Own component framework (differential main-screen renderer, synchronized
 * output, multiline editor, markdown, select lists, loader) plus the Kern
 * interactive orchestrator. Architectural patterns follow standard practice
 * for this class of UI (cf. @earendil-works/pi-tui, MIT — ideas studied,
 * code written fresh); all application logic is Kern's own.
 */
export * from "./theme.js";
export * from "./terminal.js";
export * from "./keys.js";
export * from "./text.js";
export * from "./component.js";
export * from "./components.js";
export * from "./markdown.js";
export * from "./editor.js";
export * from "./select-list.js";
export * from "./autocomplete.js";
export * from "./screen.js";
export * from "./tui.js";