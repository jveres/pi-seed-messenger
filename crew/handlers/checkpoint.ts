/**
 * Crew - Checkpoint Handlers
 * 
 * Operations: save, restore, delete, list
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import type { CrewParams, Checkpoint } from "../types.js";
import { result } from "../utils/result.js";
import * as store from "../store.js";

export async function execute(
  op: string,
  params: CrewParams,
  _state: MessengerState,
  _dirs: Dirs,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();

  switch (op) {
    case "save":
      return checkpointSave(cwd, params);
    case "restore":
      return checkpointRestore(cwd, params);
    case "delete":
      return checkpointDelete(cwd, params);
    case "list":
      return checkpointList(cwd);
    default:
      return result(`Unknown checkpoint operation: ${op}`, { mode: "checkpoint", error: "unknown_operation", operation: op });
  }
}

// =============================================================================
// checkpoint.save
// =============================================================================

function checkpointSave(cwd: string, params: CrewParams) {
  const id = params.id;
  if (!id) {
    return result("Error: id (epic ID) required for checkpoint.save", { mode: "checkpoint.save", error: "missing_id" });
  }

  const epic = store.getEpic(cwd, id);
  if (!epic) {
    return result(`Error: Epic ${id} not found`, { mode: "checkpoint.save", error: "not_found", id });
  }

  const checkpoint = store.saveCheckpoint(cwd, id);
  if (!checkpoint) {
    return result(`Error: Failed to save checkpoint for ${id}`, { mode: "checkpoint.save", error: "save_failed", id });
  }

  const taskCount = checkpoint.tasks.length;
  const specCount = Object.keys(checkpoint.task_specs).length;

  const text = `✅ Saved checkpoint for epic **${id}**

**Epic:** ${epic.title}
**Tasks:** ${taskCount}
**Task specs:** ${specCount}
**Created:** ${checkpoint.created_at}

Restore with: \`pi_messenger({ action: "checkpoint.restore", id: "${id}" })\``;

  return result(text, {
    mode: "checkpoint.save",
    checkpoint: {
      id: checkpoint.id,
      created_at: checkpoint.created_at,
      taskCount,
      specCount,
    }
  });
}

// =============================================================================
// checkpoint.restore
// =============================================================================

function checkpointRestore(cwd: string, params: CrewParams) {
  const id = params.id;
  if (!id) {
    return result("Error: id (epic ID) required for checkpoint.restore", { mode: "checkpoint.restore", error: "missing_id" });
  }

  const checkpoint = store.getCheckpoint(cwd, id);
  if (!checkpoint) {
    return result(`Error: No checkpoint found for ${id}`, { mode: "checkpoint.restore", error: "not_found", id });
  }

  const restored = store.restoreCheckpoint(cwd, id);
  if (!restored) {
    return result(`Error: Failed to restore checkpoint for ${id}`, { mode: "checkpoint.restore", error: "restore_failed", id });
  }

  const text = `✅ Restored checkpoint for epic **${id}**

**Epic:** ${checkpoint.epic.title}
**Status restored to:** ${checkpoint.epic.status}
**Tasks restored:** ${checkpoint.tasks.length}
**Checkpoint was from:** ${checkpoint.created_at}

⚠️ Current state has been replaced with checkpoint state.`;

  return result(text, {
    mode: "checkpoint.restore",
    checkpoint: {
      id: checkpoint.id,
      created_at: checkpoint.created_at,
      epic: {
        title: checkpoint.epic.title,
        status: checkpoint.epic.status,
      },
      taskCount: checkpoint.tasks.length,
    }
  });
}

// =============================================================================
// checkpoint.delete
// =============================================================================

function checkpointDelete(cwd: string, params: CrewParams) {
  const id = params.id;
  if (!id) {
    return result("Error: id (epic ID) required for checkpoint.delete", { mode: "checkpoint.delete", error: "missing_id" });
  }

  const checkpoint = store.getCheckpoint(cwd, id);
  if (!checkpoint) {
    return result(`Error: No checkpoint found for ${id}`, { mode: "checkpoint.delete", error: "not_found", id });
  }

  const deleted = store.deleteCheckpoint(cwd, id);
  if (!deleted) {
    return result(`Error: Failed to delete checkpoint for ${id}`, { mode: "checkpoint.delete", error: "delete_failed", id });
  }

  return result(`✅ Deleted checkpoint for epic **${id}**`, {
    mode: "checkpoint.delete",
    id,
    deleted: true,
  });
}

// =============================================================================
// checkpoint.list
// =============================================================================

function checkpointList(cwd: string) {
  const checkpointsDir = path.join(store.getCrewDir(cwd), "checkpoints");
  
  if (!fs.existsSync(checkpointsDir)) {
    return result("No checkpoints found.", { mode: "checkpoint.list", checkpoints: [] });
  }

  const files = fs.readdirSync(checkpointsDir).filter(f => f.endsWith(".json"));
  if (files.length === 0) {
    return result("No checkpoints found.", { mode: "checkpoint.list", checkpoints: [] });
  }

  const checkpoints: { id: string; created_at: string; epicTitle: string; taskCount: number }[] = [];

  for (const file of files) {
    const id = file.replace(".json", "");
    const checkpoint = store.getCheckpoint(cwd, id);
    if (checkpoint) {
      checkpoints.push({
        id: checkpoint.id,
        created_at: checkpoint.created_at,
        epicTitle: checkpoint.epic.title,
        taskCount: checkpoint.tasks.length,
      });
    }
  }

  // Sort by created_at descending
  checkpoints.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const lines: string[] = ["# Checkpoints\n"];
  for (const cp of checkpoints) {
    const date = new Date(cp.created_at).toLocaleString();
    lines.push(`- **${cp.id}**: ${cp.epicTitle} (${cp.taskCount} tasks) — ${date}`);
  }

  return result(lines.join("\n"), {
    mode: "checkpoint.list",
    checkpoints,
  });
}
