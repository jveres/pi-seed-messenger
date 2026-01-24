/**
 * Crew - Action Router
 * 
 * Routes crew actions to their respective handlers.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs, AgentMailMessage } from "../lib.js";
import * as handlers from "../handlers.js";
import type { CrewParams, AppendEntryFn } from "./types.js";
import { result } from "./utils/result.js";
import { ensureAgentsInstalled } from "./utils/install.js";

// Handlers will be implemented in Phase 2-4
// For now, we import them conditionally when they exist

type DeliverFn = (msg: AgentMailMessage) => void;
type UpdateStatusFn = (ctx: ExtensionContext) => void;

/**
 * Execute a crew action.
 * 
 * Routes action strings like "epic.create" to the appropriate handler.
 */
export async function executeCrewAction(
  action: string,
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  deliverMessage: DeliverFn,
  updateStatus: UpdateStatusFn,
  appendEntry: AppendEntryFn
) {
  // Parse action: "epic.create" → group="epic", op="create"
  const dotIndex = action.indexOf('.');
  const group = dotIndex > 0 ? action.slice(0, dotIndex) : action;
  const op = dotIndex > 0 ? action.slice(dotIndex + 1) : null;

  // ═══════════════════════════════════════════════════════════════════════
  // Actions that DON'T require registration
  // ═══════════════════════════════════════════════════════════════════════

  // join - this is how you register
  if (group === 'join') {
    return handlers.executeJoin(state, dirs, ctx, deliverMessage, updateStatus, params.spec);
  }

  // autoRegisterPath - config management, not agent operation
  if (group === 'autoRegisterPath') {
    if (!params.autoRegisterPath) {
      return result("Error: autoRegisterPath requires value ('add', 'remove', or 'list').",
        { mode: "autoRegisterPath", error: "missing_value" });
    }
    return handlers.executeAutoRegisterPath(params.autoRegisterPath);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // All other actions require registration
  // ═══════════════════════════════════════════════════════════════════════
  if (!state.registered) {
    return handlers.notRegisteredError();
  }

  switch (group) {
    // ═══════════════════════════════════════════════════════════════════════
    // Coordination actions (delegate to existing handlers)
    // ═══════════════════════════════════════════════════════════════════════
    case 'status':
      return handlers.executeStatus(state, dirs);

    case 'list':
      return handlers.executeList(state, dirs);

    case 'spec':
      if (!params.spec) {
        return result("Error: spec path required.", { mode: "spec", error: "missing_spec" });
      }
      return handlers.executeSetSpec(state, dirs, ctx, params.spec);

    case 'send':
      return handlers.executeSend(state, dirs, params.to, false, params.message, params.replyTo);

    case 'broadcast':
      return handlers.executeSend(state, dirs, undefined, true, params.message, params.replyTo);

    case 'reserve':
      if (!params.paths || params.paths.length === 0) {
        return result("Error: paths required for reserve action.", { mode: "reserve", error: "missing_paths" });
      }
      return handlers.executeReserve(state, dirs, ctx, params.paths, params.reason);

    case 'release':
      return handlers.executeRelease(state, dirs, ctx, params.paths ?? true);

    case 'rename':
      if (!params.name) {
        return result("Error: name required for rename action.", { mode: "rename", error: "missing_name" });
      }
      return handlers.executeRename(state, dirs, ctx, params.name, deliverMessage, updateStatus);

    case 'swarm':
      return handlers.executeSwarm(state, dirs, params.spec);

    case 'claim':
      if (!params.taskId) {
        return result("Error: taskId required for claim action.", { mode: "claim", error: "missing_taskId" });
      }
      return handlers.executeClaim(state, dirs, ctx, params.taskId, params.spec, params.reason);

    case 'unclaim':
      if (!params.taskId) {
        return result("Error: taskId required for unclaim action.", { mode: "unclaim", error: "missing_taskId" });
      }
      return handlers.executeUnclaim(state, dirs, params.taskId, params.spec);

    case 'complete':
      if (!params.taskId) {
        return result("Error: taskId required for complete action.", { mode: "complete", error: "missing_taskId" });
      }
      return handlers.executeComplete(state, dirs, params.taskId, params.notes, params.spec);

    // ═══════════════════════════════════════════════════════════════════════
    // Crew actions (Phase 2-4 handlers)
    // ═══════════════════════════════════════════════════════════════════════
    case 'epic': {
      if (!op) {
        return result("Error: epic action requires operation (e.g., 'epic.create').",
          { mode: "epic", error: "missing_operation" });
      }
      // Dynamic import to avoid errors until handlers are created
      try {
        const epicHandlers = await import("./handlers/epic.js");
        return epicHandlers.execute(op, params, state, dirs, ctx);
      } catch {
        return result(`Error: epic.${op} handler not yet implemented.`,
          { mode: "epic", error: "not_implemented", operation: op });
      }
    }

    case 'task': {
      if (!op) {
        return result("Error: task action requires operation (e.g., 'task.start').",
          { mode: "task", error: "missing_operation" });
      }
      try {
        const taskHandlers = await import("./handlers/task.js");
        return taskHandlers.execute(op, params, state, dirs, ctx);
      } catch {
        return result(`Error: task.${op} handler not yet implemented.`,
          { mode: "task", error: "not_implemented", operation: op });
      }
    }

    case 'plan': {
      // Auto-install agents if missing
      ensureAgentsInstalled();
      try {
        const planHandler = await import("./handlers/plan.js");
        return planHandler.execute(params, state, dirs, ctx);
      } catch {
        return result("Error: plan handler not yet implemented.",
          { mode: "plan", error: "not_implemented" });
      }
    }

    case 'work': {
      // Auto-install agents if missing
      ensureAgentsInstalled();
      try {
        const workHandler = await import("./handlers/work.js");
        return workHandler.execute(params, state, dirs, ctx, appendEntry);
      } catch {
        return result("Error: work handler not yet implemented.",
          { mode: "work", error: "not_implemented" });
      }
    }

    case 'review': {
      // Auto-install agents if missing
      ensureAgentsInstalled();
      try {
        const reviewHandler = await import("./handlers/review.js");
        return reviewHandler.execute(params, state, dirs, ctx);
      } catch {
        return result("Error: review handler not yet implemented.",
          { mode: "review", error: "not_implemented" });
      }
    }

    case 'interview': {
      try {
        const interviewHandler = await import("./handlers/interview.js");
        return interviewHandler.execute(params, state, dirs, ctx);
      } catch {
        return result("Error: interview handler not yet implemented.",
          { mode: "interview", error: "not_implemented" });
      }
    }

    case 'sync': {
      try {
        const syncHandler = await import("./handlers/sync.js");
        return syncHandler.execute(params, state, dirs, ctx);
      } catch {
        return result("Error: sync handler not yet implemented.",
          { mode: "sync", error: "not_implemented" });
      }
    }

    case 'crew': {
      if (!op) {
        return result("Error: crew action requires operation (e.g., 'crew.status').",
          { mode: "crew", error: "missing_operation" });
      }
      try {
        const statusHandlers = await import("./handlers/status.js");
        return statusHandlers.execute(op, params, state, dirs, ctx);
      } catch {
        return result(`Error: crew.${op} handler not yet implemented.`,
          { mode: "crew", error: "not_implemented", operation: op });
      }
    }

    case 'checkpoint': {
      if (!op) {
        return result("Error: checkpoint action requires operation (e.g., 'checkpoint.save').",
          { mode: "checkpoint", error: "missing_operation" });
      }
      try {
        const checkpointHandlers = await import("./handlers/checkpoint.js");
        return checkpointHandlers.execute(op, params, state, dirs, ctx);
      } catch {
        return result(`Error: checkpoint.${op} handler not yet implemented.`,
          { mode: "checkpoint", error: "not_implemented", operation: op });
      }
    }

    default:
      return result(`Unknown action: ${action}`, { mode: "error", error: "unknown_action", action });
  }
}
