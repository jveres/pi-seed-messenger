/**
 * Pi Messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination - no daemon required.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  MAX_CHAT_HISTORY,
  formatRelativeTime,
  stripAnsiCodes,
  extractFolder,
  displaySpecPath,
} from "./lib.js";
import * as store from "./store.js";
import * as handlers from "./handlers.js";
import { MessengerOverlay } from "./overlay.js";
import { MessengerConfigOverlay } from "./config-overlay.js";
import { loadConfig, matchesAutoRegisterPath, type MessengerConfig } from "./config.js";

let overlayTui: TUI | null = null;

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
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: config.scopeToFolder
  };

  const baseDir = process.env.PI_MESSENGER_DIR || join(homedir(), ".pi/agent/messenger");
  const dirs: Dirs = {
    base: baseDir,
    registry: join(baseDir, "registry"),
    inbox: join(baseDir, "inbox")
  };

  // ===========================================================================
  // Message Delivery
  // ===========================================================================

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
      ? ` — reply: pi_messenger({ to: "${msg.from}", message: "..." })`
      : "";

    content += `**Message from ${msg.from}**${replyHint}\n\n${msg.text}`;

    if (msg.replyTo) {
      content = `*(reply to ${msg.replyTo.substring(0, 8)})*\n\n${content}`;
    }

    pi.sendMessage(
      { customType: "agent_message", content, display: true, details: msg },
      { triggerTurn: true, deliverAs: "steer" }
    );
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !state.registered) return;

    const agents = store.getActiveAgents(state, dirs);
    const activeNames = new Set(agents.map(a => a.name));
    const count = agents.length;
    const theme = ctx.ui.theme;

    // Clear unread counts for agents that are no longer active
    for (const name of state.unreadCounts.keys()) {
      if (!activeNames.has(name)) {
        state.unreadCounts.delete(name);
      }
    }

    // Sum remaining unread counts
    let totalUnread = 0;
    for (const n of state.unreadCounts.values()) totalUnread += n;

    const nameStr = theme.fg("accent", state.agentName);
    const countStr = theme.fg("dim", ` (${count} peer${count === 1 ? "" : "s"})`);
    const unreadStr = totalUnread > 0 ? theme.fg("accent", ` ●${totalUnread}`) : "";

    ctx.ui.setStatus("messenger", `msg: ${nameStr}${countStr}${unreadStr}`);
  }

  // ===========================================================================
  // Tool Registration
  // ===========================================================================

  pi.registerTool({
    name: "pi_messenger",
    label: "Pi Messenger",
    description: `Communicate with other pi agents and manage file reservations.

Usage:
  pi_messenger({ join: true })                   → Join the agent mesh
  pi_messenger({ join: true, spec: "path" })     → Join and set working spec
  pi_messenger({ })                              → Status (your name, peers, spec, claim)
  pi_messenger({ list: true })                   → List agents with specs/claims
  pi_messenger({ swarm: true })                  → All specs' claims/completions
  pi_messenger({ swarm: true, spec: "path" })    → One spec's claims/completions
  pi_messenger({ claim: "TASK-01" })             → Claim a task in your spec
  pi_messenger({ complete: "TASK-01", notes: "..." }) → Mark task complete
  pi_messenger({ unclaim: "TASK-01" })           → Release claim without completing
  pi_messenger({ spec: "path" })                 → Set/change your working spec
  pi_messenger({ to: "Name", message: "hi" })    → Send message to one agent
  pi_messenger({ to: ["A", "B"], message: "..." })  → Send to multiple agents
  pi_messenger({ broadcast: true, message: "..." }) → Send to ALL active agents
  pi_messenger({ reserve: ["src/auth/"] })       → Reserve files (trailing slash for directories)
  pi_messenger({ release: ["src/auth/"] })       → Release specific reservations
  pi_messenger({ release: true })                → Release all your reservations
  pi_messenger({ rename: "NewName" })            → Rename yourself
  pi_messenger({ autoRegisterPath: "add" })      → Add current folder to auto-register list
  pi_messenger({ autoRegisterPath: "remove" })   → Remove current folder from auto-register list
  pi_messenger({ autoRegisterPath: "list" })     → Show all auto-register paths

Mode: join > swarm > claim > unclaim > complete > spec > to/broadcast (send) > reserve > release > rename > autoRegisterPath > list > status`,
    parameters: Type.Object({
      join: Type.Optional(Type.Boolean({ description: "Join the agent mesh" })),
      spec: Type.Optional(Type.String({ description: "Path to spec/plan file" })),
      claim: Type.Optional(Type.String({ description: "Task ID to claim" })),
      unclaim: Type.Optional(Type.String({ description: "Task ID to release" })),
      complete: Type.Optional(Type.String({ description: "Task ID to mark complete" })),
      notes: Type.Optional(Type.String({ description: "Completion notes" })),
      swarm: Type.Optional(Type.Boolean({ description: "Get swarm status" })),
      to: Type.Optional(Type.Union([
        Type.String(),
        Type.Array(Type.String())
      ], { description: "Target agent name (string) or multiple names (array)" })),
      broadcast: Type.Optional(Type.Boolean({ description: "Send to all active agents" })),
      message: Type.Optional(Type.String({ description: "Message to send" })),
      replyTo: Type.Optional(Type.String({ description: "Message ID if this is a reply" })),
      reserve: Type.Optional(Type.Array(Type.String(), { description: "Paths to reserve" })),
      reason: Type.Optional(Type.String({ description: "Reason for reservation" })),
      release: Type.Optional(Type.Union([
        Type.Array(Type.String()),
        Type.Boolean()
      ], { description: "Patterns to release (array) or true to release all (boolean)" })),
      rename: Type.Optional(Type.String({ description: "Rename yourself to a new name" })),
      autoRegisterPath: Type.Optional(Type.Union([
        Type.Literal("add"),
        Type.Literal("remove"),
        Type.Literal("list")
      ], { description: "Manage auto-register paths: add/remove current folder, or list all" })),
      list: Type.Optional(Type.Boolean({ description: "List other agents" }))
    }),

    async execute(_toolCallId, params: {
      join?: boolean;
      spec?: string;
      claim?: string;
      unclaim?: string;
      complete?: string;
      notes?: string;
      swarm?: boolean;
      to?: string | string[];
      broadcast?: boolean;
      message?: string;
      replyTo?: string;
      reserve?: string[];
      reason?: string;
      release?: string[] | boolean;
      rename?: string;
      autoRegisterPath?: "add" | "remove" | "list";
      list?: boolean;
    }, _onUpdate, ctx, _signal) {
      const {
        join,
        spec,
        claim,
        unclaim,
        complete,
        notes,
        swarm,
        to,
        broadcast,
        message,
        replyTo,
        reserve,
        reason,
        release,
        rename,
        autoRegisterPath,
        list
      } = params;

      // Join doesn't require registration
      if (join) {
        const joinResult = handlers.executeJoin(state, dirs, ctx, deliverMessage, updateStatus, spec);
        
        // Send registration context after successful join (if configured)
        if (state.registered && config.registrationContext) {
          const folder = extractFolder(process.cwd());
          const locationPart = state.gitBranch
            ? `${folder} on ${state.gitBranch}`
            : folder;
          const specPart = state.spec ? ` working on ${displaySpecPath(state.spec, process.cwd())}` : "";
          pi.sendMessage({
            customType: "messenger_context",
            content: `You are agent "${state.agentName}" in ${locationPart}${specPart}. Use pi_messenger({ swarm: true }) to see task status, pi_messenger({ claim: "TASK-X" }) to claim tasks.`,
            display: false
          }, { triggerTurn: false });
        }
        
        return joinResult;
      }

      // autoRegisterPath doesn't require registration - it's config management
      if (autoRegisterPath) {
        return handlers.executeAutoRegisterPath(autoRegisterPath);
      }

      // All other operations require registration
      if (!state.registered) return handlers.notRegisteredError();

      if (swarm) return handlers.executeSwarm(state, dirs, spec);
      if (claim) return await handlers.executeClaim(state, dirs, ctx, claim, spec, reason);
      if (unclaim) return await handlers.executeUnclaim(state, dirs, unclaim, spec);
      if (complete) return await handlers.executeComplete(state, dirs, complete, notes, spec);
      if (spec) return handlers.executeSetSpec(state, dirs, ctx, spec);
      if (to || broadcast) return handlers.executeSend(state, dirs, to, broadcast, message, replyTo);
      if (reserve && reserve.length > 0) return handlers.executeReserve(state, dirs, ctx, reserve, reason);
      if (release === true || (Array.isArray(release) && release.length > 0)) {
        return handlers.executeRelease(state, dirs, ctx, release);
      }
      if (rename) return handlers.executeRename(state, dirs, ctx, rename, deliverMessage, updateStatus);
      if (list) return handlers.executeList(state, dirs);
      return handlers.executeStatus(state, dirs);
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
          {
            overlay: true,
            overlayOptions: {
              width: "60%",
              maxHeight: "50%",
              anchor: "center",
              margin: 1,
            },
          }
        );
        return;
      }

      // /messenger - open chat overlay (auto-joins if not registered)
      if (!state.registered) {
        if (!store.register(state, dirs, ctx)) {
          ctx.ui.notify("Failed to join agent mesh", "error");
          return;
        }
        store.startWatcher(state, dirs, deliverMessage);
        updateStatus(ctx);
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          return new MessengerOverlay(tui, theme, state, dirs, done);
        },
        {
          overlay: true,
          overlayOptions: {
            width: "80%",
            maxHeight: "45%",
            anchor: "center",
            margin: 1,
          },
        }
      );

      // Overlay closed
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
  // Event Handlers
  // ===========================================================================

  pi.on("session_start", async (_event, ctx) => {
    // Check if auto-register is enabled (global or path-based)
    const shouldAutoRegister = config.autoRegister || 
      matchesAutoRegisterPath(process.cwd(), config.autoRegisterPaths);
    
    if (!shouldAutoRegister) return;

    if (store.register(state, dirs, ctx)) {
      store.startWatcher(state, dirs, deliverMessage);
      updateStatus(ctx);

      // Send registration context (non-displaying, non-triggering)
      if (config.registrationContext) {
        const folder = extractFolder(process.cwd());
        const locationPart = state.gitBranch
          ? `${folder} on ${state.gitBranch}`
          : folder;
        const specPart = state.spec ? ` working on ${displaySpecPath(state.spec, process.cwd())}` : "";
        pi.sendMessage({
          customType: "messenger_context",
          content: `You are agent "${state.agentName}" in ${locationPart}${specPart}. Use pi_messenger({ swarm: true }) to see task status, pi_messenger({ claim: "TASK-X" }) to claim tasks.`,
          display: false
        }, { triggerTurn: false });
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
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });
  pi.on("session_fork", async (_event, ctx) => {
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => updateStatus(ctx));

  pi.on("turn_end", async (_event, ctx) => {
    store.processAllPendingMessages(state, dirs, deliverMessage);
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    store.stopWatcher(state);
    store.unregister(state, dirs);
  });

  // ===========================================================================
  // Reservation Enforcement
  // ===========================================================================

  pi.on("tool_call", async (event, _ctx) => {
    // Only block write operations - reading reserved files is fine
    if (!["edit", "write"].includes(event.toolName)) return;

    const path = event.input.path as string;
    if (!path) return;

    const conflicts = store.getConflictsWithOtherAgents(path, state, dirs);
    if (conflicts.length === 0) return;

    const c = conflicts[0];
    const folder = extractFolder(c.registration.cwd);
    const locationPart = c.registration.gitBranch
      ? ` (in ${folder} on ${c.registration.gitBranch})`
      : ` (in ${folder})`;

    const lines = [path, `Reserved by: ${c.agent}${locationPart}`];
    if (c.reason) lines.push(`Reason: "${c.reason}"`);
    lines.push("");
    lines.push(`Coordinate via pi_messenger({ to: "${c.agent}", message: "..." })`);

    return { block: true, reason: lines.join("\n") };
  });
}
