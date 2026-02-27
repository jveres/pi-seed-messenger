import { randomUUID } from "node:crypto";
import { matchesKey, type TUI } from "@mariozechner/pi-tui";
import type { AgentMailMessage, Dirs, MessengerState } from "./lib.js";
import { MAX_CHAT_HISTORY } from "./lib.js";
import { sendMessageToAgent, getActiveAgents } from "./store.js";
import { logFeedEvent } from "./feed.js";

export interface ViewState {
  messageInput: string;
  inputMode: "normal" | "message";
  lastSeenEventTs: string | null;
  notification: { message: string; expiresAt: number } | null;
  notificationTimer: ReturnType<typeof setTimeout> | null;
  mentionCandidates: string[];
  mentionIndex: number;
  feedScrollOffset: number;
}

export function createViewState(): ViewState {
  return {
    messageInput: "",
    inputMode: "normal",
    lastSeenEventTs: null,
    notification: null,
    notificationTimer: null,
    mentionCandidates: [],
    mentionIndex: -1,
    feedScrollOffset: 0,
  };
}

function isPrintable(data: string): boolean {
  return data.length > 0 && data.charCodeAt(0) >= 32;
}

export function setNotification(viewState: ViewState, tui: TUI, success: boolean, message: string): void {
  if (viewState.notificationTimer) clearTimeout(viewState.notificationTimer);
  viewState.notification = { message: `${success ? "✓" : "✗"} ${message}`, expiresAt: Date.now() + 2000 };
  viewState.notificationTimer = setTimeout(() => {
    viewState.notificationTimer = null;
    tui.requestRender();
  }, 2000);
}

function addToChatHistory(state: MessengerState, recipient: string, message: AgentMailMessage): void {
  let history = state.chatHistory.get(recipient);
  if (!history) {
    history = [];
    state.chatHistory.set(recipient, history);
  }
  history.push(message);
  if (history.length > MAX_CHAT_HISTORY) history.shift();
}

function addToBroadcastHistory(state: MessengerState, text: string): void {
  const broadcastMsg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to: "broadcast",
    text,
    timestamp: new Date().toISOString(),
    replyTo: null,
  };
  state.broadcastHistory.push(broadcastMsg);
  if (state.broadcastHistory.length > MAX_CHAT_HISTORY) {
    state.broadcastHistory.shift();
  }
}

function previewText(text: string): string {
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function resetMessageInput(viewState: ViewState): void {
  viewState.inputMode = "normal";
  viewState.messageInput = "";
  viewState.mentionCandidates = [];
  viewState.mentionIndex = -1;
}

function collectMentionCandidates(
  prefix: string,
  state: MessengerState,
  dirs: Dirs,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const agent of getActiveAgents(state, dirs)) {
    if (agent.name === state.agentName) continue;
    if (!seen.has(agent.name)) {
      seen.add(agent.name);
      names.push(agent.name);
    }
  }

  names.push("all");

  if (!prefix) return names;
  const lower = prefix.toLowerCase();
  return names.filter(n => n.toLowerCase().startsWith(lower));
}

function sendDirectMessage(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  target: string,
  text: string,
  tui: TUI,
  viewState: ViewState,
): void {
  try {
    const msg = sendMessageToAgent(state, dirs, target, text);
    addToChatHistory(state, target, msg);
    logFeedEvent(cwd, state.agentName, "message", target, previewText(text));
    resetMessageInput(viewState);
    setNotification(viewState, tui, true, `Sent to ${target}`);
    tui.requestRender();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    setNotification(viewState, tui, false, `Failed to send to ${target}: ${msg}`);
    tui.requestRender();
  }
}

function sendBroadcastMessage(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  text: string,
  tui: TUI,
  viewState: ViewState,
): void {
  const peers = getActiveAgents(state, dirs);
  if (peers.length === 0) {
    setNotification(viewState, tui, false, "No peers available for @all");
    tui.requestRender();
    return;
  }

  let sentCount = 0;
  for (const peer of peers) {
    try {
      sendMessageToAgent(state, dirs, peer.name, text);
      sentCount++;
    } catch {
      // Ignore per-recipient failures
    }
  }

  if (sentCount === 0) {
    setNotification(viewState, tui, false, "Broadcast failed");
    tui.requestRender();
    return;
  }

  addToBroadcastHistory(state, text);
  logFeedEvent(cwd, state.agentName, "message", undefined, previewText(text));
  resetMessageInput(viewState);
  setNotification(viewState, tui, true, `Broadcast to ${sentCount} peer${sentCount === 1 ? "" : "s"}`);
  tui.requestRender();
}

export function handleMessageInput(
  data: string,
  viewState: ViewState,
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  tui: TUI,
): void {
  if (matchesKey(data, "escape")) {
    resetMessageInput(viewState);
    tui.requestRender();
    return;
  }

  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    const input = viewState.messageInput;
    const cycling = viewState.mentionIndex >= 0 && viewState.mentionCandidates.length > 0;
    if (!input.startsWith("@") || (input.includes(" ") && !cycling)) return;

    const reverse = matchesKey(data, "shift+tab");

    if (!cycling) {
      const prefix = input.slice(1);
      viewState.mentionCandidates = collectMentionCandidates(prefix, state, dirs);
      if (viewState.mentionCandidates.length === 0) return;
      viewState.mentionIndex = 0;
    } else {
      const delta = reverse ? -1 : 1;
      viewState.mentionIndex = (viewState.mentionIndex + delta + viewState.mentionCandidates.length) % viewState.mentionCandidates.length;
    }

    viewState.messageInput = `@${viewState.mentionCandidates[viewState.mentionIndex]} `;
    tui.requestRender();
    return;
  }

  if (matchesKey(data, "enter")) {
    const raw = viewState.messageInput.trim();
    if (!raw) return;

    if (raw.startsWith("@all ")) {
      const text = raw.slice(5).trim();
      if (!text) return;
      sendBroadcastMessage(state, dirs, cwd, text, tui, viewState);
      return;
    }

    if (raw.startsWith("@")) {
      const firstSpace = raw.indexOf(" ");
      if (firstSpace <= 1) {
        setNotification(viewState, tui, false, "Use @name <message> or type to broadcast");
        tui.requestRender();
        return;
      }

      const target = raw.slice(1, firstSpace).trim();
      const text = raw.slice(firstSpace + 1).trim();
      if (!target || !text) {
        setNotification(viewState, tui, false, "Use @name <message> or type to broadcast");
        tui.requestRender();
        return;
      }

      sendDirectMessage(state, dirs, cwd, target, text, tui, viewState);
      return;
    }

    sendBroadcastMessage(state, dirs, cwd, raw, tui, viewState);
    return;
  }

  if (matchesKey(data, "backspace")) {
    if (viewState.messageInput.length > 0) {
      viewState.messageInput = viewState.messageInput.slice(0, -1);
      viewState.mentionCandidates = [];
      viewState.mentionIndex = -1;
      tui.requestRender();
    }
    return;
  }

  if (isPrintable(data)) {
    viewState.messageInput += data;
    viewState.mentionCandidates = [];
    viewState.mentionIndex = -1;
    tui.requestRender();
  }
}
