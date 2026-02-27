/**
 * Pi Messenger - Chat Overlay Component
 */

import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  extractFolder,
  type MessengerState,
  type Dirs,
} from "./lib.js";
import { readFeedEvents, type FeedEvent, type FeedEventType } from "./feed.js";
import {
  renderStatusBar,
  renderAgentsRow,
  renderFeedSection,
  renderLegend,
} from "./overlay-render.js";
import {
  createViewState,
  handleMessageInput,
  setNotification,
  type ViewState,
} from "./overlay-actions.js";
import { loadConfig } from "./config.js";
import * as store from "./store.js";

export interface OverlayCallbacks {
  onBackground?: (snapshot: string) => void;
}

export class MessengerOverlay implements Component, Focusable {
  get width(): number {
    return Math.min(100, Math.max(40, process.stdout.columns ?? 90));
  }
  focused = false;

  private viewState: ViewState = createViewState();
  private cwd: string;
  private stuckThresholdMs: number;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private state: MessengerState,
    private dirs: Dirs,
    private done: (snapshot?: string) => void,
    private callbacks: OverlayCallbacks,
  ) {
    this.cwd = process.cwd();
    const cfg = loadConfig(this.cwd);
    this.stuckThresholdMs = cfg.stuckThreshold * 1000;

    for (const key of this.state.unreadCounts.keys()) {
      this.state.unreadCounts.set(key, 0);
    }
  }

  handleInput(data: string): void {
    if (data === "\x14") {
      this.done(this.generateSnapshot());
      return;
    }

    if (data === "\x02") {
      this.callbacks.onBackground?.(this.generateSnapshot());
      return;
    }

    if (this.viewState.inputMode === "message") {
      handleMessageInput(data, this.viewState, this.state, this.dirs, this.cwd, this.tui);
      return;
    }

    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }

    if (data === "@" || matchesKey(data, "m")) {
      this.viewState.inputMode = "message";
      this.viewState.messageInput = data === "@" ? "@" : "";
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      this.viewState.feedScrollOffset = Math.max(0, this.viewState.feedScrollOffset - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      this.viewState.feedScrollOffset++;
      this.tui.requestRender();
      return;
    }
  }

  private generateSnapshot(): string {
    const agents = store.getActiveAgents(this.state, this.dirs);
    const lines: string[] = [];
    lines.push(`Messenger snapshot: ${agents.length} peer${agents.length === 1 ? "" : "s"} online`);
    lines.push("");
    lines.push(`Agents: You${agents.length > 0 ? ", " + agents.map(a => a.name).join(", ") : ""}`);

    const recentEvents = readFeedEvents(this.cwd, 5);
    if (recentEvents.length > 0) {
      lines.push("");
      lines.push("Recent activity:");
      for (const event of recentEvents) {
        const time = new Date(event.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
        lines.push(`  ${time} ${event.agent} ${event.type}${event.target ? ` ${event.target}` : ""}${event.preview ? ` — ${event.preview}` : ""}`);
      }
    }

    return lines.join("\n");
  }

  render(_width: number): string[] {
    const w = this.width;
    const innerW = w - 2;
    const sectionW = innerW - 2;
    const border = (s: string) => this.theme.fg("dim", s);
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) => border("│") + pad(" " + content, innerW) + border("│");
    const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");
    const sectionSeparator = this.theme.fg("dim", "─".repeat(sectionW));

    const agents = store.getActiveAgents(this.state, this.dirs);
    const allEvents = readFeedEvents(this.cwd, 50);

    const prevTs = this.viewState.lastSeenEventTs;
    this.detectAndFlashEvents(allEvents, prevTs);

    const lines: string[] = [];

    // Title bar
    const titleContent = this.renderTitleContent();
    const titleText = ` ${titleContent} `;
    const titleLen = visibleWidth(titleContent) + 2;
    const borderLen = Math.max(0, innerW - titleLen);
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;
    lines.push(border("╭" + "─".repeat(leftBorder)) + titleText + border("─".repeat(rightBorder) + "╮"));

    // Status bar
    lines.push(row(renderStatusBar(this.theme, agents.length, sectionW)));
    lines.push(emptyRow());

    // Content area
    const chromeLines = 6;
    const termRows = process.stdout.rows ?? 24;
    const contentHeight = Math.max(8, termRows - chromeLines);

    // Agents row
    const agentsLine = renderAgentsRow(sectionW, this.state, this.dirs, this.stuckThresholdMs);
    const contentLines: string[] = [];
    contentLines.push(agentsLine);
    contentLines.push(sectionSeparator);

    // Feed section fills remaining space
    const feedHeight = contentHeight - 2; // subtract agents row + separator
    const displayEvents = allEvents.slice(-Math.max(feedHeight * 2, 50));
    let feedLines = renderFeedSection(this.theme, displayEvents, sectionW, prevTs);

    if (feedLines.length === 0) {
      feedLines.push(this.theme.fg("dim", "(no activity yet)"));
      feedLines.push("");
      feedLines.push(this.theme.fg("dim", "Use pi_messenger({ action: \"send\", to: \"Name\", message: \"...\" }) to chat."));
    }

    // Scroll handling
    const maxScroll = Math.max(0, feedLines.length - feedHeight);
    this.viewState.feedScrollOffset = Math.max(0, Math.min(this.viewState.feedScrollOffset, maxScroll));
    const scrollStart = feedLines.length - feedHeight - this.viewState.feedScrollOffset;
    const start = Math.max(0, scrollStart);
    const visible = feedLines.slice(start, start + feedHeight);

    contentLines.push(...visible);

    // Pad to fill content height
    while (contentLines.length < contentHeight) {
      contentLines.push("");
    }

    for (const line of contentLines.slice(0, contentHeight)) {
      lines.push(row(line));
    }

    // Legend bar
    lines.push(border("├" + "─".repeat(innerW) + "┤"));
    lines.push(row(renderLegend(this.theme, sectionW, this.viewState)));
    lines.push(border("╰" + "─".repeat(innerW) + "╯"));

    if (allEvents.length > 0) {
      this.viewState.lastSeenEventTs = allEvents[allEvents.length - 1].ts;
    }

    return lines;
  }

  private static readonly SIGNIFICANT_EVENTS = new Set<FeedEventType>([
    "message", "stuck",
  ]);

  private detectAndFlashEvents(events: FeedEvent[], prevTs: string | null): void {
    if (prevTs === null) return;
    const newEvents = events.filter(e => e.ts > prevTs);
    if (newEvents.length === 0) return;

    const significant = newEvents.filter(e => MessengerOverlay.SIGNIFICANT_EVENTS.has(e.type));
    if (significant.length === 0) return;

    const last = significant[significant.length - 1];
    const sameType = significant.filter(e => e.type === last.type);

    let message: string;
    if (sameType.length > 1) {
      message = last.type === "message"
        ? `${sameType.length} new messages`
        : `${sameType.length} ${last.type} events`;
    } else {
      const preview = last.preview ? ` — ${last.preview.slice(0, 40)}` : "";
      message = last.type === "message"
        ? `${last.agent}${preview || " sent a message"}`
        : `${last.agent} ${last.type}`;
    }

    setNotification(this.viewState, this.tui, true, message);
  }

  private renderTitleContent(): string {
    const label = this.theme.fg("accent", "Messenger");
    const folder = this.theme.fg("dim", extractFolder(this.cwd));
    return `${label} ─ ${folder}`;
  }

  invalidate(): void {
    // No cached state
  }

  dispose(): void {
    if (this.viewState.notificationTimer) {
      clearTimeout(this.viewState.notificationTimer);
      this.viewState.notificationTimer = null;
    }
  }
}
