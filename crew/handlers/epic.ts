/**
 * Crew - Epic Handlers
 * 
 * Operations: create, show, list, close, set_spec
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import type { CrewParams } from "../types.js";
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
    case "create":
      return epicCreate(cwd, params);
    case "show":
      return epicShow(cwd, params);
    case "list":
      return epicList(cwd);
    case "close":
      return epicClose(cwd, params);
    case "set_spec":
      return epicSetSpec(cwd, params);
    default:
      return result(`Unknown epic operation: ${op}`, { mode: "epic", error: "unknown_operation", operation: op });
  }
}

// =============================================================================
// epic.create
// =============================================================================

function epicCreate(cwd: string, params: CrewParams) {
  if (!params.title) {
    return result("Error: title required for epic.create", { mode: "epic.create", error: "missing_title" });
  }

  const epic = store.createEpic(cwd, params.title);

  const text = `✅ Created epic **${epic.id}**

**Title:** ${epic.title}
**Status:** ${epic.status}
**Created:** ${epic.created_at}

Next steps:
- Add spec: \`pi_messenger({ action: "epic.set_spec", id: "${epic.id}", content: "..." })\`
- Create tasks: \`pi_messenger({ action: "task.create", epic: "${epic.id}", title: "..." })\`
- Or plan it: \`pi_messenger({ action: "plan", target: "${epic.id}" })\``;

  return result(text, {
    mode: "epic.create",
    epic: {
      id: epic.id,
      title: epic.title,
      status: epic.status,
      created_at: epic.created_at,
    }
  });
}

// =============================================================================
// epic.show
// =============================================================================

function epicShow(cwd: string, params: CrewParams) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for epic.show", { mode: "epic.show", error: "missing_id" });
  }

  const epic = store.getEpic(cwd, id);
  if (!epic) {
    return result(`Error: Epic ${id} not found`, { mode: "epic.show", error: "not_found", id });
  }

  const tasks = store.getTasks(cwd, id);
  const spec = store.getEpicSpec(cwd, id);

  // Build task summary
  const tasksByStatus = {
    todo: tasks.filter(t => t.status === "todo"),
    in_progress: tasks.filter(t => t.status === "in_progress"),
    done: tasks.filter(t => t.status === "done"),
    blocked: tasks.filter(t => t.status === "blocked"),
  };

  let taskSection = "";
  if (tasks.length === 0) {
    taskSection = "*No tasks yet*";
  } else {
    const lines: string[] = [];
    
    if (tasksByStatus.in_progress.length > 0) {
      lines.push("**In Progress:**");
      for (const t of tasksByStatus.in_progress) {
        lines.push(`  🔄 ${t.id}: ${t.title}${t.assigned_to ? ` (${t.assigned_to})` : ""}`);
      }
    }
    
    if (tasksByStatus.blocked.length > 0) {
      lines.push("**Blocked:**");
      for (const t of tasksByStatus.blocked) {
        lines.push(`  🚫 ${t.id}: ${t.title} — ${t.blocked_reason ?? "unknown reason"}`);
      }
    }
    
    if (tasksByStatus.todo.length > 0) {
      lines.push("**To Do:**");
      for (const t of tasksByStatus.todo) {
        const deps = t.depends_on.length > 0 ? ` (depends: ${t.depends_on.join(", ")})` : "";
        lines.push(`  ⬜ ${t.id}: ${t.title}${deps}`);
      }
    }
    
    if (tasksByStatus.done.length > 0) {
      lines.push("**Done:**");
      for (const t of tasksByStatus.done) {
        lines.push(`  ✅ ${t.id}: ${t.title}`);
      }
    }
    
    taskSection = lines.join("\n");
  }

  // Build spec preview (first 500 chars)
  let specPreview = "";
  if (spec && !spec.includes("*Spec pending*")) {
    const truncated = spec.length > 500 ? spec.slice(0, 500) + "..." : spec;
    specPreview = `\n\n**Spec Preview:**\n\`\`\`\n${truncated}\n\`\`\``;
  }

  const progress = epic.task_count > 0 
    ? `${epic.completed_count}/${epic.task_count} tasks (${Math.round(epic.completed_count / epic.task_count * 100)}%)`
    : "No tasks";

  const text = `# Epic ${epic.id}: ${epic.title}

**Status:** ${epic.status}
**Progress:** ${progress}
**Created:** ${epic.created_at}
${epic.closed_at ? `**Closed:** ${epic.closed_at}` : ""}

## Tasks

${taskSection}${specPreview}`;

  return result(text, {
    mode: "epic.show",
    epic,
    tasks,
    hasSpec: spec && !spec.includes("*Spec pending*"),
  });
}

// =============================================================================
// epic.list
// =============================================================================

function epicList(cwd: string) {
  const epics = store.listEpics(cwd);

  if (epics.length === 0) {
    return result("No epics found. Create one with `pi_messenger({ action: \"epic.create\", title: \"...\" })`", {
      mode: "epic.list",
      epics: [],
    });
  }

  const lines: string[] = ["# Epics\n"];
  
  for (const epic of epics) {
    const statusIcon = {
      planning: "📋",
      active: "🔄",
      blocked: "🚫",
      completed: "✅",
      archived: "📦",
    }[epic.status] ?? "❓";

    const progress = epic.task_count > 0 
      ? `${epic.completed_count}/${epic.task_count}`
      : "0 tasks";

    lines.push(`${statusIcon} **${epic.id}**: ${epic.title} [${epic.status}] (${progress})`);
  }

  return result(lines.join("\n"), {
    mode: "epic.list",
    epics: epics.map(e => ({
      id: e.id,
      title: e.title,
      status: e.status,
      task_count: e.task_count,
      completed_count: e.completed_count,
    })),
  });
}

// =============================================================================
// epic.close
// =============================================================================

function epicClose(cwd: string, params: CrewParams) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for epic.close", { mode: "epic.close", error: "missing_id" });
  }

  const epic = store.getEpic(cwd, id);
  if (!epic) {
    return result(`Error: Epic ${id} not found`, { mode: "epic.close", error: "not_found", id });
  }

  const tasks = store.getTasks(cwd, id);
  const incomplete = tasks.filter(t => t.status !== "done");

  if (incomplete.length > 0) {
    const taskList = incomplete.map(t => `  - ${t.id}: ${t.title} (${t.status})`).join("\n");
    return result(`Cannot close epic ${id} — ${incomplete.length} task(s) not done:\n${taskList}`, {
      mode: "epic.close",
      error: "incomplete_tasks",
      id,
      incomplete: incomplete.map(t => ({ id: t.id, status: t.status })),
    });
  }

  const closed = store.closeEpic(cwd, id);
  if (!closed) {
    return result(`Error: Failed to close epic ${id}`, { mode: "epic.close", error: "close_failed", id });
  }

  return result(`✅ Epic **${id}** closed successfully!\n\n**${closed.title}**\nCompleted ${closed.completed_count} tasks.`, {
    mode: "epic.close",
    epic: {
      id: closed.id,
      title: closed.title,
      status: closed.status,
      closed_at: closed.closed_at,
      completed_count: closed.completed_count,
    }
  });
}

// =============================================================================
// epic.set_spec
// =============================================================================

function epicSetSpec(cwd: string, params: CrewParams) {
  const id = params.id;
  if (!id) {
    return result("Error: id required for epic.set_spec", { mode: "epic.set_spec", error: "missing_id" });
  }

  if (!params.content) {
    return result("Error: content required for epic.set_spec", { mode: "epic.set_spec", error: "missing_content" });
  }

  const epic = store.getEpic(cwd, id);
  if (!epic) {
    return result(`Error: Epic ${id} not found`, { mode: "epic.set_spec", error: "not_found", id });
  }

  store.setEpicSpec(cwd, id, params.content);

  // Update epic status to active if still planning
  if (epic.status === "planning") {
    store.updateEpic(cwd, id, { status: "active" });
  }

  return result(`✅ Updated spec for epic **${id}**\n\nSpec length: ${params.content.length} characters`, {
    mode: "epic.set_spec",
    id,
    specLength: params.content.length,
  });
}
