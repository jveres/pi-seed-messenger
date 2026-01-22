/**
 * Pi Messenger - Config Overlay Component
 */

import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { getAutoRegisterPaths, saveAutoRegisterPaths, matchesAutoRegisterPath } from "./config.js";

export class MessengerConfigOverlay implements Component, Focusable {
  focused = false;

  private paths: string[];
  private selectedIndex = 0;
  private dirty = false;
  private statusMessage = "";

  constructor(
    private tui: TUI,
    private theme: Theme,
    private done: () => void
  ) {
    this.paths = getAutoRegisterPaths();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      if (this.dirty) {
        saveAutoRegisterPaths(this.paths);
      }
      this.done();
      return;
    }

    if (matchesKey(data, "a")) {
      this.addCurrentPath();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "d") || matchesKey(data, "backspace")) {
      this.deleteSelected();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.paths.length > 0) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.paths.length > 0) {
        this.selectedIndex = Math.min(this.paths.length - 1, this.selectedIndex + 1);
        this.tui.requestRender();
      }
      return;
    }
  }

  private addCurrentPath(): void {
    const cwd = process.cwd();
    if (this.paths.includes(cwd)) {
      this.statusMessage = "Already in list";
      return;
    }
    this.paths.push(cwd);
    this.selectedIndex = this.paths.length - 1;
    this.dirty = true;
    this.statusMessage = "Added current folder";
  }

  private deleteSelected(): void {
    if (this.paths.length === 0) return;
    
    const removed = this.paths[this.selectedIndex];
    this.paths.splice(this.selectedIndex, 1);
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.paths.length - 1));
    this.dirty = true;
    this.statusMessage = `Removed: ${removed.split("/").pop()}`;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(0, width - 4);
    const lines: string[] = [];
    const cwd = process.cwd();
    const isCurrentInList = matchesAutoRegisterPath(cwd, this.paths);

    // Title
    lines.push(this.theme.fg("accent", "Messenger Config"));
    lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));
    lines.push("");

    // Current folder status
    const cwdDisplay = truncateToWidth(cwd, Math.max(10, innerWidth - 20));
    lines.push(`Current folder: ${cwdDisplay}`);
    const statusColor = isCurrentInList ? "accent" : "dim";
    lines.push(`Auto-register: ${this.theme.fg(statusColor, isCurrentInList ? "YES" : "NO")}`);
    lines.push("");

    // Path list
    lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));
    lines.push("Auto-register paths:");
    lines.push("");

    if (this.paths.length === 0) {
      lines.push(this.theme.fg("dim", "  (none configured)"));
    } else {
      for (let i = 0; i < this.paths.length; i++) {
        const path = this.paths[i];
        const isSelected = i === this.selectedIndex;
        const isCurrent = path === cwd;
        
        const marker = isSelected ? "▸ " : "  ";
        const suffix = isCurrent ? this.theme.fg("dim", " (current)") : "";
        const pathDisplay = truncateToWidth(path, Math.max(10, innerWidth - 15));
        
        if (isSelected) {
          lines.push(this.theme.fg("accent", marker + pathDisplay) + suffix);
        } else {
          lines.push(marker + pathDisplay + suffix);
        }
      }
    }

    lines.push("");
    lines.push(this.theme.fg("dim", "─".repeat(innerWidth)));

    // Status message
    if (this.statusMessage) {
      lines.push(this.theme.fg("accent", this.statusMessage));
    } else {
      lines.push("");
    }

    // Help
    const help = "[a] Add current  [d] Delete  [↑↓] Navigate  [Esc] Save & close";
    lines.push(this.theme.fg("dim", help));

    return lines;
  }

  invalidate(): void {
    // Clear status message on next action
    this.statusMessage = "";
  }

  dispose(): void {}
}
