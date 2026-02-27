/**
 * Pi Messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination - no daemon required.
 */

import { homedir } from "node:os";
import * as fs from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OverlayHandle, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type, type TUnsafe } from "@sinclair/typebox";

function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
import {
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  MAX_CHAT_HISTORY,
  formatRelativeTime,
  stripAnsiCodes,
  extractFolder,
  generateAutoStatus,
  computeStatus,
  agentHasTask,
} from "./lib.js";
import * as store from "./store.js";
import * as handlers from "./handlers.js";
import { MessengerOverlay, type OverlayCallbacks } from "./overlay.js";
import { MessengerConfigOverlay } from "./config-overlay.js";
import { loadConfig, matchesAutoRegisterPath, type MessengerConfig } from "./config.js";
import { logFeedEvent, pruneFeed } from "./feed.js";

let overlayTui: TUI | null = null;
let overlayHandle: OverlayHandle | null = null;

export default function piMessengerExtension(pi: ExtensionAPI) {
  // ===========================================================================
  // State & Configuration
  // ===========================================================================

  const config: MessengerConfig = loadConfig(process.cwd());

  const state: MessengerState = {
    agentName: process.env.PI_AGENT_NAME || "",
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "",
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: config.scopeToFolder,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  };

  const nameTheme = { theme: config.nameTheme, customWords: config.nameWords };

  const baseDir = process.env.PI_MESSENGER_DIR || join(homedir(), ".pi/agent/messenger");
  const dirs: Dirs = {
    base: baseDir,
    registry: join(baseDir, "registry"),
    inbox: join(baseDir, "inbox")
  };

  // ===========================================================================
  // Message Delivery
  // ===========================================================================

  // Loop detection: track recent message timestamps per peer to detect rapid back-and-forth
  const LOOP_WINDOW_MS = 60_000;  // Time window to track exchanges
  const LOOP_MAX_EXCHANGES = 3;   // Max messages from same peer within window before suppressing turn
  const recentExchanges = new Map<string, number[]>(); // peer name → timestamps of received messages

  /**
   * Detect if we're in a rapid echo loop with a peer.
   * Returns true if we've received >= LOOP_MAX_EXCHANGES messages from
   * the same agent within LOOP_WINDOW_MS, indicating a back-and-forth loop.
   */
  function isEchoLoop(from: string): boolean {
    const now = Date.now();
    let timestamps = recentExchanges.get(from);
    if (!timestamps) {
      timestamps = [];
      recentExchanges.set(from, timestamps);
    }

    // Prune old entries outside the window
    timestamps = timestamps.filter(t => now - t < LOOP_WINDOW_MS);
    timestamps.push(now);
    recentExchanges.set(from, timestamps);

    return timestamps.length >= LOOP_MAX_EXCHANGES;
  }

  function deliverMessage(msg: AgentMailMessage): void {
    // Store in chat history (keyed by sender)
    let history = state.chatHistory.get(msg.from);
    if (!history) {
      history = [];
      state.chatHistory.set(msg.from, history);
    }
    history.push(msg);
    if (history.length > MAX_CHAT_HISTORY) history.shift();

    // Increment unread count
    const current = state.unreadCounts.get(msg.from) ?? 0;
    state.unreadCounts.set(msg.from, current + 1);

    // Trigger overlay re-render if open
    overlayTui?.requestRender();

    // Loop detection: suppress triggerTurn if rapid back-and-forth detected
    const loopDetected = isEchoLoop(msg.from);

    // Build message content with optional context
    // Detect if this is a new agent identity (first contact OR same name but different session)
    const sender = store.getActiveAgents(state, dirs).find(a => a.name === msg.from);
    const senderSessionId = sender?.sessionId;
    const prevSessionId = state.seenSenders.get(msg.from);
    const isNewIdentity = !prevSessionId || (senderSessionId && prevSessionId !== senderSessionId);

    // Update seen senders with current sessionId (only if we could look it up)
    if (senderSessionId) {
      state.seenSenders.set(msg.from, senderSessionId);
    }

    let content = "";

    // Add sender details on new identity (first contact or agent restart with same name)
    if (isNewIdentity && config.senderDetailsOnFirstContact && sender) {
      const folder = extractFolder(sender.cwd);
      const locationPart = sender.gitBranch
        ? `${folder} on ${sender.gitBranch}`
        : folder;
      content += `*${msg.from} is in ${locationPart} (${sender.model})*\n\n`;
    }

    // Add reply hint
    const replyHint = config.replyHint
      ? ` — reply: pi_messenger({ action: "send", to: "${msg.from}", message: "..." })`
      : "";

    content += `**Message from ${msg.from}**${replyHint}\n\n${msg.text}`;

    if (msg.replyTo) {
      content = `*(reply to ${msg.replyTo.substring(0, 8)})*\n\n${content}`;
    }

    if (loopDetected) {
      // Loop detected: deliver message for visibility but do NOT trigger a new turn.
      // This breaks the echo loop — the agent sees the message but isn't forced to respond.
      content += `\n\n*(loop suppressed — too many rapid exchanges with ${msg.from}, no reply needed)*`;
      pi.sendMessage(
        { customType: "agent_message", content, display: true, details: msg },
        { triggerTurn: false }
      );
    } else {
      pi.sendMessage(
        { customType: "agent_message", content, display: true, details: msg },
        { triggerTurn: true, deliverAs: "steer" }
      );
    }
  }

  // ===========================================================================
  // Stuck Detection
  // ===========================================================================

  const notifiedStuck = new Set<string>();

  function checkStuckAgents(ctx: ExtensionContext): void {
    if (!config.stuckNotify || !ctx.hasUI || !state.registered) return;

    const thresholdMs = config.stuckThreshold * 1000;
    const peers = store.getActiveAgents(state, dirs);
    const allClaims = store.getClaims(dirs);

    const currentlyStuck = new Set<string>();

    for (const agent of peers) {
      const hasTask = agentHasTask(agent.name, allClaims);
      const computed = computeStatus(
        agent.activity?.lastActivityAt ?? agent.startedAt,
        hasTask,
        (agent.reservations?.length ?? 0) > 0,
        thresholdMs
      );

      if (computed.status === "stuck") {
        currentlyStuck.add(agent.name);

        if (!notifiedStuck.has(agent.name)) {
          notifiedStuck.add(agent.name);
          logFeedEvent(ctx.cwd ?? process.cwd(), agent.name, "stuck");

          const idleStr = computed.idleFor ?? "unknown";
          const taskInfo = hasTask ? " with task in progress" : " with reservation";
          ctx.ui.notify(`\u26A0\uFE0F ${agent.name} appears stuck (idle ${idleStr}${taskInfo})`, "warning");
        }
      }
    }

    for (const name of notifiedStuck) {
      if (!currentlyStuck.has(name)) {
        notifiedStuck.delete(name);
      }
    }
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !state.registered) return;

    checkStuckAgents(ctx);

    const agents = store.getActiveAgents(state, dirs);
    const activeNames = new Set(agents.map(a => a.name));
    const count = agents.length;
    const theme = ctx.ui.theme;

    for (const name of state.unreadCounts.keys()) {
      if (!activeNames.has(name)) {
        state.unreadCounts.delete(name);
      }
    }
    for (const name of notifiedStuck) {
      if (!activeNames.has(name)) {
        notifiedStuck.delete(name);
      }
    }

    // Sum remaining unread counts
    let totalUnread = 0;
    for (const n of state.unreadCounts.values()) totalUnread += n;

    const nameStr = theme.fg("accent", state.agentName);
    const countStr = theme.fg("dim", ` (${count} peer${count === 1 ? "" : "s"})`);
    const unreadStr = totalUnread > 0 ? theme.fg("accent", ` ●${totalUnread}`) : "";

    const activityStr = state.activity.currentActivity
      ? theme.fg("dim", ` · ${state.activity.currentActivity}`)
      : "";

    ctx.ui.setStatus("messenger", `msg: ${nameStr}${countStr}${unreadStr}${activityStr}`);
  }

  function clearAllUnreadCounts(): void {
    for (const key of state.unreadCounts.keys()) {
      state.unreadCounts.set(key, 0);
    }
  }

  const STATUS_HEARTBEAT_MS = 15_000;
  let latestCtx: ExtensionContext | null = null;
  let statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function startStatusHeartbeat(): void {
    if (statusHeartbeatTimer) return;
    statusHeartbeatTimer = setInterval(() => {
      if (latestCtx) updateStatus(latestCtx);
    }, STATUS_HEARTBEAT_MS);
  }

  function stopStatusHeartbeat(): void {
    if (!statusHeartbeatTimer) return;
    clearInterval(statusHeartbeatTimer);
    statusHeartbeatTimer = null;
  }

  // ===========================================================================
  // Registration Context
  // ===========================================================================

  function sendRegistrationContext(ctx: ExtensionContext): void {
    const folder = extractFolder(process.cwd());
    const locationPart = state.gitBranch
      ? `${folder} on ${state.gitBranch}`
      : folder;
    pi.sendMessage({
      customType: "messenger_context",
      content: `You are agent "${state.agentName}" in ${locationPart}. Use pi_messenger({ action: "status" }) to see who's online.

MESSAGING RULES — prevent infinite echo loops:
- NEVER send acknowledgment-only messages (thanks, you're welcome, got it, sure, no problem, sounds good, etc.)
- NEVER reply just to be polite — only send a message when you have substantive information, a question, or a deliverable
- When you receive a message that requires no action, just continue your current work silently
- If a message only needs acknowledgment, do NOT reply — silence IS the acknowledgment`,
      display: false
    }, { triggerTurn: false });
  }

  // ===========================================================================
  // Tool Registration
  // ===========================================================================

  pi.registerTool({
    name: "pi_messenger",
    label: "Pi Messenger",
    description: `Multi-agent messaging and coordination.

Usage (action-based API):
  // Coordination
  pi_messenger({ action: "join" })                              → Join mesh
  pi_messenger({ action: "status" })                            → Get status
  pi_messenger({ action: "list" })                              → List agents with presence
  pi_messenger({ action: "feed", limit: 20 })                   → Activity feed
  pi_messenger({ action: "whois", name: "AgentName" })          → Agent details
  pi_messenger({ action: "set_status", message: "reviewing" })  → Set custom status
  pi_messenger({ action: "reserve", paths: ["src/"] })          → Reserve files
  pi_messenger({ action: "send", to: "Agent", message: "hi" })  → Send message`,
    parameters: Type.Object({
      action: Type.Optional(Type.String({
        description: "Action to perform (e.g., 'join', 'status', 'list', 'send')"
      })),

      // ═══════════════════════════════════════════════════════════════════════
      // MESSAGING & COORDINATION PARAMETERS
      // ═══════════════════════════════════════════════════════════════════════
      spec: Type.Optional(Type.String({ description: "Path to spec/plan file" })),
      notes: Type.Optional(Type.String({ description: "Completion notes" })),
      to: Type.Optional(Type.Any({ description: "Target agent name (string) or multiple names (array)" })),
      message: Type.Optional(Type.String({ description: "Message to send" })),
      replyTo: Type.Optional(Type.String({ description: "Message ID if this is a reply" })),
      reason: Type.Optional(Type.String({ description: "Reason for reservation" })),
      taskId: Type.Optional(Type.String({ description: "Task ID for claim/unclaim/complete" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Paths for reserve/release actions" })),
      name: Type.Optional(Type.String({ description: "Agent name for whois/rename" })),
      limit: Type.Optional(Type.Number({ description: "Number of events to return (for feed action, default 20)" })),
      autoRegisterPath: Type.Optional(StringEnum(["add", "remove", "list"], { description: "Manage auto-register paths: add/remove current folder, or list all" }))
    }),

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      latestCtx = ctx;

      const action = params.action as string | undefined;
      if (!action) {
        return handlers.executeStatus(state, dirs, ctx.cwd ?? process.cwd());
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Actions that DON'T require registration
      // ═══════════════════════════════════════════════════════════════════════
      if (action === "join") {
        const result = handlers.executeJoin(state, dirs, ctx, deliverMessage, updateStatus, params.spec as string | undefined, nameTheme, config.feedRetention);
        if (state.registered && config.registrationContext) {
          sendRegistrationContext(ctx);
        }
        return result;
      }

      if (action === "autoRegisterPath") {
        const subAction = params.autoRegisterPath as "add" | "remove" | "list" | undefined;
        if (!subAction) {
          return { content: [{ type: "text" as const, text: "Error: autoRegisterPath requires value ('add', 'remove', or 'list')." }], details: { mode: "autoRegisterPath", error: "missing_value" } };
        }
        return handlers.executeAutoRegisterPath(subAction);
      }

      // ═══════════════════════════════════════════════════════════════════════
      // All other actions require registration
      // ═══════════════════════════════════════════════════════════════════════
      if (!state.registered) {
        return handlers.notRegisteredError();
      }

      const cwd = ctx.cwd ?? process.cwd();

      switch (action) {
        case "status":
          return handlers.executeStatus(state, dirs, cwd);

        case "list":
          return handlers.executeList(state, dirs, cwd, { stuckThreshold: config.stuckThreshold });

        case "whois": {
          const name = params.name as string | undefined;
          if (!name) {
            return { content: [{ type: "text" as const, text: "Error: name required for whois action." }], details: { mode: "whois", error: "missing_name" } };
          }
          return handlers.executeWhois(state, dirs, cwd, name, { stuckThreshold: config.stuckThreshold });
        }

        case "set_status":
          return handlers.executeSetStatus(state, dirs, ctx, params.message as string | undefined);

        case "feed":
          return handlers.executeFeed(cwd, params.limit as number | undefined);

        case "spec": {
          const specPath = params.spec as string | undefined;
          if (!specPath) {
            return { content: [{ type: "text" as const, text: "Error: spec path required." }], details: { mode: "spec", error: "missing_spec" } };
          }
          return handlers.executeSetSpec(state, dirs, ctx, specPath);
        }

        case "send":
          return handlers.executeSend(state, dirs, cwd, params.to as string | string[] | undefined, false, params.message as string | undefined, params.replyTo as string | undefined);

        case "broadcast":
          return handlers.executeSend(state, dirs, cwd, undefined, true, params.message as string | undefined, params.replyTo as string | undefined);

        case "reserve": {
          const paths = params.paths as string[] | undefined;
          if (!paths || paths.length === 0) {
            return { content: [{ type: "text" as const, text: "Error: paths required for reserve action." }], details: { mode: "reserve", error: "missing_paths" } };
          }
          return handlers.executeReserve(state, dirs, ctx, paths, params.reason as string | undefined);
        }

        case "release":
          return handlers.executeRelease(state, dirs, ctx, (params.paths as string[] | undefined) ?? true);

        case "rename": {
          const newName = params.name as string | undefined;
          if (!newName) {
            return { content: [{ type: "text" as const, text: "Error: name required for rename action." }], details: { mode: "rename", error: "missing_name" } };
          }
          return handlers.executeRename(state, dirs, ctx, newName, deliverMessage, updateStatus);
        }

        case "swarm":
          return handlers.executeSwarm(state, dirs, params.spec as string | undefined);

        case "claim": {
          const taskId = params.taskId as string | undefined;
          if (!taskId) {
            return { content: [{ type: "text" as const, text: "Error: taskId required for claim action." }], details: { mode: "claim", error: "missing_taskId" } };
          }
          return handlers.executeClaim(state, dirs, ctx, taskId, params.spec as string | undefined, params.reason as string | undefined);
        }

        case "unclaim": {
          const taskId = params.taskId as string | undefined;
          if (!taskId) {
            return { content: [{ type: "text" as const, text: "Error: taskId required for unclaim action." }], details: { mode: "unclaim", error: "missing_taskId" } };
          }
          return handlers.executeUnclaim(state, dirs, taskId, params.spec as string | undefined);
        }

        case "complete": {
          const taskId = params.taskId as string | undefined;
          if (!taskId) {
            return { content: [{ type: "text" as const, text: "Error: taskId required for complete action." }], details: { mode: "complete", error: "missing_taskId" } };
          }
          return handlers.executeComplete(state, dirs, taskId, params.notes as string | undefined, params.spec as string | undefined);
        }

        default:
          return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], details: { mode: "error", error: "unknown_action", action } };
      }
    }
  });

  // ===========================================================================
  // Commands
  // ===========================================================================

  pi.registerCommand("messenger", {
    description: "Open messenger overlay, or 'config' to manage settings",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;

      // /messenger config - open config overlay
      if (args[0] === "config") {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => {
            return new MessengerConfigOverlay(tui, theme, done);
          },
          { overlay: true }
        );
        return;
      }

      // /messenger - open chat overlay (auto-joins if not registered)
      if (!state.registered) {
        if (!store.register(state, dirs, ctx, nameTheme)) {
          ctx.ui.notify("Failed to join agent mesh", "error");
          return;
        }
        store.startWatcher(state, dirs, deliverMessage);
        updateStatus(ctx);
      }

      if (overlayHandle && overlayHandle.isHidden()) {
        overlayHandle.setHidden(false);
        clearAllUnreadCounts();
        updateStatus(ctx);
        return;
      }

      const callbacks: OverlayCallbacks = {
        onBackground: (snapshotText) => {
          overlayHandle?.setHidden(true);
          pi.sendMessage({
            customType: "messenger_snapshot",
            content: snapshotText,
            display: true,
          }, { triggerTurn: true });
        },
      };

      const snapshot = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          return new MessengerOverlay(tui, theme, state, dirs, done, callbacks);
        },
        {
          overlay: true,
          onHandle: (handle) => {
            overlayHandle = handle;
          },
        }
      );

      if (snapshot) {
        pi.sendMessage({
          customType: "messenger_snapshot",
          content: snapshot,
          display: true,
        }, { triggerTurn: true });
      }

      // Overlay closed
      clearAllUnreadCounts();
      overlayHandle = null;
      overlayTui = null;
      updateStatus(ctx);
    }
  });

  // ===========================================================================
  // Message Renderer
  // ===========================================================================

  pi.registerMessageRenderer<AgentMailMessage>("agent_message", (message, _options, theme) => {
    const details = message.details;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const safeFrom = stripAnsiCodes(details.from);
        const safeText = stripAnsiCodes(details.text);
        
        const header = theme.fg("accent", `From ${safeFrom}`);
        const time = theme.fg("dim", ` (${formatRelativeTime(details.timestamp)})`);

        const result: string[] = [];
        result.push(truncateToWidth(header + time, width));
        result.push("");

        for (const line of safeText.split("\n")) {
          result.push(truncateToWidth(line, width));
        }

        return result;
      },
      invalidate() {}
    };
  });

  // ===========================================================================
  // Activity Tracking
  // ===========================================================================

  const EDIT_DEBOUNCE_MS = 5000;
  const REGISTRY_FLUSH_MS = 10000;
  const RECENT_WINDOW_MS = 60_000;
  const pendingEdits = new Map<string, ReturnType<typeof setTimeout>>();
  let recentCommit = false;
  let recentCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let recentTestRuns = 0;
  let recentTestTimer: ReturnType<typeof setTimeout> | null = null;
  let recentEdits = 0;
  let recentEditTimer: ReturnType<typeof setTimeout> | null = null;

  function updateLastActivity(): void {
    state.activity.lastActivityAt = new Date().toISOString();
  }

  function incrementToolCount(): void {
    state.session.toolCalls++;
  }

  function setCurrentActivity(activity: string): void {
    state.activity.currentActivity = activity;
  }

  function clearCurrentActivity(): void {
    state.activity.currentActivity = undefined;
  }

  function setLastToolCall(toolCall: string): void {
    state.activity.lastToolCall = toolCall;
  }

  function addModifiedFile(filePath: string): void {
    const files = state.session.filesModified;
    const idx = files.indexOf(filePath);
    if (idx !== -1) files.splice(idx, 1);
    files.push(filePath);
    if (files.length > 20) files.shift();
  }

  function debouncedLogEdit(filePath: string): void {
    const existing = pendingEdits.get(filePath);
    if (existing) clearTimeout(existing);
    pendingEdits.set(filePath, setTimeout(() => {
      logFeedEvent(process.cwd(), state.agentName, "edit", filePath);
      pendingEdits.delete(filePath);
    }, EDIT_DEBOUNCE_MS));
  }

  function scheduleRegistryFlush(ctx: ExtensionContext): void {
    if (state.registryFlushTimer) return;
    state.registryFlushTimer = setTimeout(() => {
      state.registryFlushTimer = null;
      store.flushActivityToRegistry(state, dirs, ctx);
    }, REGISTRY_FLUSH_MS);
  }

  function isGitCommit(command: string): boolean {
    return /\bgit\s+commit\b/.test(command);
  }

  function isTestRun(command: string): boolean {
    return /\b(npm\s+test|npx\s+(jest|vitest|mocha)|pytest|go\s+test|cargo\s+test|bun\s+test)\b/.test(command);
  }

  function extractCommitMessage(command: string): string {
    const match = command.match(/-m\s+["']([^"']+)["']/);
    return match ? match[1] : "";
  }

  function updateAutoStatus(): void {
    if (!state.registered || !config.autoStatus || state.customStatus) return;

    const autoMsg = generateAutoStatus({
      currentActivity: state.activity.currentActivity,
      recentCommit,
      recentTestRuns,
      recentEdits,
      sessionStartedAt: state.sessionStartedAt,
    });

    state.statusMessage = autoMsg;
  }

  function trackRecentCommit(): void {
    recentCommit = true;
    if (recentCommitTimer) clearTimeout(recentCommitTimer);
    recentCommitTimer = setTimeout(() => { recentCommit = false; }, RECENT_WINDOW_MS);
  }

  function trackRecentTest(): void {
    recentTestRuns++;
    if (recentTestTimer) clearTimeout(recentTestTimer);
    recentTestTimer = setTimeout(() => { recentTestRuns = 0; }, RECENT_WINDOW_MS);
  }

  function trackRecentEdit(): void {
    recentEdits++;
    if (recentEditTimer) clearTimeout(recentEditTimer);
    recentEditTimer = setTimeout(() => { recentEdits = 0; }, RECENT_WINDOW_MS);
  }

  function shortenPath(filePath: string): string {
    const parts = filePath.split("/");
    return parts.length > 2 ? parts.slice(-2).join("/") : filePath;
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!state.registered) return;

    updateLastActivity();
    incrementToolCount();
    scheduleRegistryFlush(ctx);

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (toolName === "write" || toolName === "edit") {
      const path = input.path as string;
      if (path) {
        setCurrentActivity(`editing ${shortenPath(path)}`);
        debouncedLogEdit(path);
        trackRecentEdit();
      }
    } else if (toolName === "read") {
      const path = input.path as string;
      if (path) {
        setCurrentActivity(`reading ${shortenPath(path)}`);
      }
    } else if (toolName === "bash") {
      const command = input.command as string;
      if (command) {
        if (isGitCommit(command)) {
          setCurrentActivity("committing");
        } else if (isTestRun(command)) {
          setCurrentActivity("running tests");
        }
      }
    }

    updateAutoStatus();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!state.registered) return;

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (toolName === "write" || toolName === "edit") {
      const path = input.path as string;
      if (path) {
        setLastToolCall(`${toolName}: ${shortenPath(path)}`);
        addModifiedFile(path);
      }
    }

    if (toolName === "bash") {
      const command = input.command as string;
      if (command) {
        const cwd = ctx.cwd ?? process.cwd();
        if (isGitCommit(command)) {
          const msg = extractCommitMessage(command);
          logFeedEvent(cwd, state.agentName, "commit", undefined, msg);
          setLastToolCall(`commit: ${msg}`);
          trackRecentCommit();
        }
        if (isTestRun(command)) {
          const passed = !event.isError;
          logFeedEvent(cwd, state.agentName, "test", undefined, passed ? "passed" : "failed");
          setLastToolCall(`test: ${passed ? "passed" : "failed"}`);
          trackRecentTest();
        }
      }
    }

    clearCurrentActivity();
    updateAutoStatus();
    scheduleRegistryFlush(ctx);
  });

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    startStatusHeartbeat();

    state.isHuman = ctx.hasUI;
    try { fs.rmSync(join(homedir(), ".pi/agent/messenger/feed.jsonl"), { force: true }); } catch {}

    const shouldAutoRegister = config.autoRegister || 
      matchesAutoRegisterPath(process.cwd(), config.autoRegisterPaths);

    if (!shouldAutoRegister) {
      return;
    }

    if (store.register(state, dirs, ctx, nameTheme)) {
      const cwd = ctx.cwd ?? process.cwd();
      store.startWatcher(state, dirs, deliverMessage);
      updateStatus(ctx);
      pruneFeed(cwd, config.feedRetention);
      logFeedEvent(cwd, state.agentName, "join");

      if (config.registrationContext) {
        sendRegistrationContext(ctx);
      }
    }
  });

  function recoverWatcherIfNeeded(): void {
    if (state.registered && !state.watcher && !state.watcherRetryTimer) {
      state.watcherRetries = 0;
      store.startWatcher(state, dirs, deliverMessage);
    }
  }

  pi.on("session_switch", async (_event, ctx) => {
    latestCtx = ctx;
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });
  pi.on("session_fork", async (_event, ctx) => {
    latestCtx = ctx;
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    latestCtx = ctx;
    updateStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    latestCtx = ctx;
    store.processAllPendingMessages(state, dirs, deliverMessage);
    recoverWatcherIfNeeded();
    updateStatus(ctx);

    if (state.registered) {
      const msg = _event.message as unknown as Record<string, unknown> | undefined;
      if (msg && msg.role === "assistant" && msg.usage) {
        const usage = msg.usage as { totalTokens?: number; input?: number; output?: number };
        const total = usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0));
        if (total > 0) {
          state.session.tokens += total;
          scheduleRegistryFlush(ctx);
        }
      }
    }
  });

  pi.on("session_shutdown", async () => {
    stopStatusHeartbeat();
    overlayHandle = null;
    overlayTui = null;
    if (state.registered) {
      logFeedEvent(process.cwd(), state.agentName, "leave");
    }
    if (state.registryFlushTimer) {
      clearTimeout(state.registryFlushTimer);
      state.registryFlushTimer = null;
    }
    for (const timer of pendingEdits.values()) {
      clearTimeout(timer);
    }
    pendingEdits.clear();
    if (recentCommitTimer) { clearTimeout(recentCommitTimer); recentCommitTimer = null; }
    if (recentTestTimer) { clearTimeout(recentTestTimer); recentTestTimer = null; }
    if (recentEditTimer) { clearTimeout(recentEditTimer); recentEditTimer = null; }
    store.stopWatcher(state);
    store.unregister(state, dirs);
  });

  // ===========================================================================
  // Reservation Enforcement
  // ===========================================================================

  pi.on("tool_call", async (event, _ctx) => {
    if (!["edit", "write"].includes(event.toolName)) return;

    const input = event.input as Record<string, unknown>;
    const filePath = typeof input.path === "string" ? input.path : null;
    if (!filePath) return;

    const conflicts = store.getConflictsWithOtherAgents(filePath, state, dirs);
    if (conflicts.length === 0) return;

    const c = conflicts[0];
    const folder = extractFolder(c.registration.cwd);
    const locationPart = c.registration.gitBranch
      ? ` (in ${folder} on ${c.registration.gitBranch})`
      : ` (in ${folder})`;

    const lines = [filePath, `Reserved by: ${c.agent}${locationPart}`];
    if (c.reason) lines.push(`Reason: "${c.reason}"`);
    lines.push("");
    lines.push(`Coordinate via pi_messenger({ action: "send", to: "${c.agent}", message: "..." })`);

    return { block: true, reason: lines.join("\n") };
  });
}
