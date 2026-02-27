import { truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  formatDuration,
  buildSelfRegistration,
  coloredAgentName,
  computeStatus,
  STATUS_INDICATORS,
  agentHasTask,
  type Dirs,
  type MessengerState,
} from "./lib.js";
import * as store from "./store.js";
import { formatFeedLine as sharedFormatFeedLine, type FeedEvent } from "./feed.js";
import type { ViewState } from "./overlay-actions.js";

function idleLabel(timestamp: string | undefined): string {
  if (!timestamp) return "idle";
  const ageMs = Math.max(0, Date.now() - new Date(timestamp).getTime());
  if (!Number.isFinite(ageMs) || ageMs < 30_000) return "active";
  return `idle ${formatDuration(ageMs)}`;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      lines.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf(" ", maxWidth);
    if (breakAt <= 0) breakAt = maxWidth;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return lines;
}

function renderMessageLines(theme: Theme, event: FeedEvent, width: number): string[] {
  const time = new Date(event.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const agentStyled = coloredAgentName(event.agent);
  const rawPreview = event.preview?.trim() ?? "";

  const direction = event.target ? `\u2192 ${event.target}` : "\u2726";
  const singleLen = time.length + 1 + event.agent.length + 1 + (event.target ? 2 + event.target.length : 1) + (rawPreview ? 1 + rawPreview.length : 0);

  if (singleLen <= width && rawPreview) {
    return [truncateToWidth(`${time} ${agentStyled} ${theme.fg("accent", direction)} ${rawPreview}`, width)];
  }

  const header = `${time} ${agentStyled} ${theme.fg("accent", direction)}`;
  if (!rawPreview) return [truncateToWidth(header, width)];

  const indent = "      ";
  const maxBody = width - indent.length;
  const wrapped = wrapText(rawPreview, maxBody);
  const result = [truncateToWidth(header, width)];
  for (const bodyLine of wrapped) {
    result.push(truncateToWidth(`${indent}${bodyLine}`, width));
  }
  return result;
}

export function renderStatusBar(theme: Theme, peerCount: number, width: number): string {
  return truncateToWidth(`${peerCount} peer${peerCount === 1 ? "" : "s"} online`, width);
}

export function renderAgentsRow(
  width: number,
  state: MessengerState,
  dirs: Dirs,
  stuckThresholdMs: number,
): string {
  const allClaims = store.getClaims(dirs);
  const rowParts: string[] = [];
  const seen = new Set<string>();

  const self = buildSelfRegistration(state);
  rowParts.push(`🟢 You (${idleLabel(self.activity?.lastActivityAt ?? self.startedAt)})`);
  seen.add(self.name);

  for (const agent of store.getActiveAgents(state, dirs)) {
    if (seen.has(agent.name)) continue;
    const computed = computeStatus(
      agent.activity?.lastActivityAt ?? agent.startedAt,
      agentHasTask(agent.name, allClaims),
      (agent.reservations?.length ?? 0) > 0,
      stuckThresholdMs,
    );
    const indicator = STATUS_INDICATORS[computed.status];
    const idle = computed.idleFor ? ` ${computed.idleFor}` : "";
    rowParts.push(`${indicator} ${coloredAgentName(agent.name)}${idle}`);
    seen.add(agent.name);
  }

  return truncateToWidth(rowParts.join("  "), width);
}

const DIM_EVENTS = new Set(["join", "leave", "reserve", "release"]);

export function renderFeedSection(theme: Theme, events: FeedEvent[], width: number, lastSeenTs: string | null): string[] {
  if (events.length === 0) return [];
  const lines: string[] = [];
  let lastWasMessage = false;

  for (const event of events) {
    const isNew = lastSeenTs === null || event.ts > lastSeenTs;
    const isMessage = event.type === "message";

    if (lines.length > 0 && isMessage !== lastWasMessage) {
      lines.push(theme.fg("dim", "  ·"));
    }

    if (isMessage) {
      lines.push(...renderMessageLines(theme, event, width));
    } else {
      const formatted = sharedFormatFeedLine(event);
      const dimmed = DIM_EVENTS.has(event.type) || !isNew;
      lines.push(truncateToWidth(dimmed ? theme.fg("dim", formatted) : formatted, width));
    }
    lastWasMessage = isMessage;
  }
  return lines;
}

export function renderLegend(
  theme: Theme,
  width: number,
  viewState: ViewState,
): string {
  if (viewState.inputMode === "message") {
    const text = renderMessageBar(viewState.messageInput);
    return truncateToWidth(theme.fg("accent", text), width);
  }

  if (viewState.notification) {
    if (Date.now() < viewState.notification.expiresAt) {
      return truncateToWidth(viewState.notification.message, width);
    }
    viewState.notification = null;
  }

  return truncateToWidth(theme.fg("dim", "m:Chat  ↑↓:Scroll  Esc:Close"), width);
}

function renderMessageBar(input: string): string {
  const isAt = input.startsWith("@");
  const hint = isAt ? "DM" : "broadcast";
  const tabHint = isAt && !input.includes(" ") ? "  [Tab] Complete" : "";
  return `${hint}: ${input}█  [Enter] Send${tabHint}  [Esc] Cancel`;
}
