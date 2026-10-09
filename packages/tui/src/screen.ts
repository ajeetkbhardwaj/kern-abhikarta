/**
 * @kern/tui — Screen backed by `@earendil-works/pi-tui` TuiMainScreen.
 *
 * Thin adapter preserving our historical `Screen` API (children, focus,
 * input hook, overlay stack, start/stop/render) while delegating all
 * rendering, raw-mode/input ownership, and overlay compositing to pi-tui's
 * main-screen renderer (scrollback preserved, synchronized output,
 * differential repaint).
 */

import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { Component } from "./component.js";

export type InputResult = { consume: boolean } | undefined;
export type InputHook = (key: string) => InputResult;

export class Screen {
  private readonly inner: TuiMainScreen;
  private readonly overlays: { component: Component; handle: OverlayHandle }[] = [];
  private removeHookListener: (() => void) | null = null;

  constructor() {
    this.inner = new TuiMainScreen(new ProcessTerminal());
  }

  /**
   * Underlying pi-tui screen. Needed where pi-tui-native construction
   * requires a TUI instance (e.g. the pi-tui `Editor`).
   */
  get tui(): TuiMainScreen {
    return this.inner;
  }

  addChild(c: Component): void {
    this.inner.addChild(c);
  }

  removeChild(c: Component): void {
    this.inner.removeChild(c);
  }

  setFocus(c: Component | null): void {
    this.inner.setFocus(c);
  }

  setInputHook(hook: InputHook | null): void {
    if (this.removeHookListener) {
      this.removeHookListener();
      this.removeHookListener = null;
    }
    if (hook) {
      // pi-tui delivers whole input chunks (not splitKeys units):
      // pass data through as-is. Our InputResult shape matches
      // pi-tui's listener result ({consume?, data?}).
      this.removeHookListener = this.inner.addInputListener((data) => hook(data));
    }
  }

  showOverlay(c: Component): void {
    const handle = this.inner.showOverlay(c, {
      anchor: "center",
      width: "80%",
      maxHeight: "80%",
    });
    this.overlays.push({ component: c, handle });
  }

  hideOverlay(): void {
    const top = this.overlays.pop();
    top?.handle.hide();
  }

  hasOverlay(): boolean {
    return this.overlays.length > 0;
  }

  overlayTop(): Component | null {
    return this.overlays.length > 0
      ? (this.overlays[this.overlays.length - 1] as { component: Component }).component
      : null;
  }

  start(): void {
    // TuiBase.start() owns raw mode (via Terminal.start), bracketed paste,
    // and cursor hiding — do not enable any of those here.
    this.inner.start();
  }

  stop(): void {
    this.inner.stop();
  }

  requestRender(): void {
    this.inner.requestRender();
  }

  renderNow(): void {
    this.inner.renderNow();
  }
}
