/**
 * @kern/tui — component model.
 *
 * Minimal structural interfaces shared by our custom components
 * (Box, StatusBar, ToolCard, …) so they can compose inside the
 * pi-tui renderer. IME cursor positioning is owned by pi-tui.
 */

export interface Component {
  render(width: number): string[];
  handleInput?(key: string): boolean;
  invalidate(): void;
}

export interface Focusable extends Component {
  focused: boolean;
}
