/**
 * Crew - Status Handlers
 * 
 * Operations: status, validate, agents, install, uninstall
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import * as store from "../store.js";
import { discoverCrewAgents } from "../utils/discover.js";
import { 
  installAgents, 
  uninstallAgents, 
  checkAgentStatus,
  getSourceAgentsDir,
  getTargetAgentsDir,
} from "../utils/install.js";

export async function execute(
  op: string,
  params: CrewParams,
  state: MessengerState,
  _dirs: Dirs,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();

  switch (op) {
    case "status":
      return crewStatus(cwd, state);
    case "validate":
      return crewValidate(cwd, params);
    case "agents":
      return crewAgents(cwd);
    case "install":
      return crewInstall(params);
    case "uninstall":
      return crewUninstall();
    default:
      return result(`Unknown crew operation: ${op}`, { mode: "crew", error: "unknown_operation", operation: op });
  }
}

// =============================================================================
// crew.status
// =============================================================================

function crewStatus(cwd: string, state: MessengerState) {
  const epics = store.listEpics(cwd);
  const agents = discoverCrewAgents(cwd);

  // Gather stats
  let totalTasks = 0;
  let doneTasks = 0;
  let inProgressTasks = 0;
  let blockedTasks = 0;
  let todoTasks = 0;

  for (const epic of epics) {
    const tasks = store.getTasks(cwd, epic.id);
    for (const task of tasks) {
      totalTasks++;
      switch (task.status) {
        case "done": doneTasks++; break;
        case "in_progress": inProgressTasks++; break;
        case "blocked": blockedTasks++; break;
        case "todo": todoTasks++; break;
      }
    }
  }

  // Build status text
  const lines: string[] = ["# Crew Status\n"];

  // Agent info
  lines.push(`**Agent:** ${state.agentName || "not registered"}`);
  lines.push(`**Crew agents available:** ${agents.length}`);
  lines.push("");

  // Epic summary
  const activeEpics = epics.filter(e => e.status === "active" || e.status === "planning");
  const completedEpics = epics.filter(e => e.status === "completed");

  lines.push("## Epics");
  lines.push(`- **Active:** ${activeEpics.length}`);
  lines.push(`- **Completed:** ${completedEpics.length}`);
  lines.push(`- **Total:** ${epics.length}`);
  lines.push("");

  // Task summary
  lines.push("## Tasks");
  lines.push(`- ✅ Done: ${doneTasks}`);
  lines.push(`- 🔄 In Progress: ${inProgressTasks}`);
  lines.push(`- 🚫 Blocked: ${blockedTasks}`);
  lines.push(`- ⬜ To Do: ${todoTasks}`);
  lines.push(`- **Total:** ${totalTasks}`);
  
  if (totalTasks > 0) {
    const progress = Math.round(doneTasks / totalTasks * 100);
    lines.push(`- **Progress:** ${progress}%`);
  }
  lines.push("");

  // Active epics detail
  if (activeEpics.length > 0) {
    lines.push("## Active Epics\n");
    for (const epic of activeEpics.slice(0, 5)) {
      const progress = epic.task_count > 0 
        ? `${epic.completed_count}/${epic.task_count}`
        : "0 tasks";
      lines.push(`- **${epic.id}**: ${epic.title} (${progress})`);
    }
    if (activeEpics.length > 5) {
      lines.push(`- *...and ${activeEpics.length - 5} more*`);
    }
  }

  return result(lines.join("\n"), {
    mode: "crew.status",
    epics: {
      active: activeEpics.length,
      completed: completedEpics.length,
      total: epics.length,
    },
    tasks: {
      done: doneTasks,
      in_progress: inProgressTasks,
      blocked: blockedTasks,
      todo: todoTasks,
      total: totalTasks,
    },
    agents: agents.length,
  });
}

// =============================================================================
// crew.validate
// =============================================================================

function crewValidate(cwd: string, params: CrewParams) {
  const epicId = params.id;

  if (epicId) {
    // Validate specific epic
    const validation = store.validateEpic(cwd, epicId);

    if (validation.valid && validation.warnings.length === 0) {
      return result(`✅ Epic ${epicId} is valid with no warnings.`, {
        mode: "crew.validate",
        epic: epicId,
        valid: true,
        errors: [],
        warnings: [],
      });
    }

    const lines: string[] = [`# Validation: ${epicId}\n`];
    
    if (!validation.valid) {
      lines.push("## ❌ Errors\n");
      for (const err of validation.errors) {
        lines.push(`- ${err}`);
      }
      lines.push("");
    }

    if (validation.warnings.length > 0) {
      lines.push("## ⚠️ Warnings\n");
      for (const warn of validation.warnings) {
        lines.push(`- ${warn}`);
      }
    }

    return result(lines.join("\n"), {
      mode: "crew.validate",
      epic: epicId,
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    });
  }

  // Validate all epics
  const epics = store.listEpics(cwd);
  if (epics.length === 0) {
    return result("No epics to validate.", { mode: "crew.validate", results: [] });
  }

  const results: { id: string; valid: boolean; errors: number; warnings: number }[] = [];
  let allValid = true;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const epic of epics) {
    const validation = store.validateEpic(cwd, epic.id);
    results.push({
      id: epic.id,
      valid: validation.valid,
      errors: validation.errors.length,
      warnings: validation.warnings.length,
    });
    if (!validation.valid) allValid = false;
    totalErrors += validation.errors.length;
    totalWarnings += validation.warnings.length;
  }

  const lines: string[] = ["# Crew Validation\n"];
  
  if (allValid && totalWarnings === 0) {
    lines.push("✅ All epics valid with no warnings.\n");
  } else {
    lines.push(`**Errors:** ${totalErrors}  **Warnings:** ${totalWarnings}\n`);
  }

  for (const r of results) {
    const icon = r.valid ? (r.warnings > 0 ? "⚠️" : "✅") : "❌";
    const details = [];
    if (r.errors > 0) details.push(`${r.errors} errors`);
    if (r.warnings > 0) details.push(`${r.warnings} warnings`);
    const detailStr = details.length > 0 ? ` (${details.join(", ")})` : "";
    lines.push(`${icon} ${r.id}${detailStr}`);
  }

  return result(lines.join("\n"), {
    mode: "crew.validate",
    allValid,
    totalErrors,
    totalWarnings,
    results,
  });
}

// =============================================================================
// crew.agents
// =============================================================================

function crewAgents(cwd: string) {
  const agents = discoverCrewAgents(cwd);

  if (agents.length === 0) {
    return result("No crew agents found.\n\nRun `pi_messenger({ action: \"crew.install\" })` to install crew agents.", {
      mode: "crew.agents",
      agents: [],
    });
  }

  const lines: string[] = ["# Crew Agents\n"];

  // Group by role
  const byRole = new Map<string, typeof agents>();
  for (const agent of agents) {
    const role = agent.crewRole ?? "worker";
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role)!.push(agent);
  }

  for (const [role, roleAgents] of byRole) {
    lines.push(`## ${role}\n`);
    for (const agent of roleAgents) {
      const model = agent.model ? ` (${agent.model})` : "";
      lines.push(`- **${agent.name}**${model}`);
      if (agent.description) {
        lines.push(`  ${agent.description.slice(0, 100)}${agent.description.length > 100 ? "..." : ""}`);
      }
    }
    lines.push("");
  }

  return result(lines.join("\n"), {
    mode: "crew.agents",
    agents: agents.map(a => ({
      name: a.name,
      role: a.crewRole,
      model: a.model,
    })),
  });
}

// =============================================================================
// crew.install
// =============================================================================

function crewInstall(params: CrewParams) {
  // Check current status first
  const status = checkAgentStatus();
  
  // If force not specified and everything is current, just report
  const force = params.reason === "force"; // Using reason param as force flag
  
  if (!force && status.missing.length === 0 && status.outdated.length === 0) {
    return result(`✅ All ${status.current.length} crew agents are up to date.\n\nTarget: ${getTargetAgentsDir()}`, {
      mode: "crew.install",
      action: "check",
      current: status.current.length,
      missing: 0,
      outdated: 0,
    });
  }

  // Install agents
  const installResult = installAgents(force);
  
  const lines: string[] = ["# Crew Agent Installation\n"];
  
  if (installResult.errors.length > 0) {
    lines.push("## ❌ Errors\n");
    for (const err of installResult.errors) {
      lines.push(`- ${err}`);
    }
    lines.push("");
  }

  if (installResult.installed.length > 0) {
    lines.push("## ✅ Installed\n");
    for (const agent of installResult.installed) {
      lines.push(`- ${agent}`);
    }
    lines.push("");
  }

  if (installResult.updated.length > 0) {
    lines.push("## 🔄 Updated\n");
    for (const agent of installResult.updated) {
      lines.push(`- ${agent}`);
    }
    lines.push("");
  }

  if (installResult.skipped.length > 0 && force) {
    lines.push("## ⏭️ Skipped (already current)\n");
    for (const agent of installResult.skipped) {
      lines.push(`- ${agent}`);
    }
    lines.push("");
  }

  lines.push(`**Source:** ${getSourceAgentsDir()}`);
  lines.push(`**Target:** ${installResult.targetDir}`);

  const success = installResult.errors.length === 0;
  const summary = success 
    ? `Installed: ${installResult.installed.length}, Updated: ${installResult.updated.length}`
    : `Failed with ${installResult.errors.length} error(s)`;

  return result(lines.join("\n"), {
    mode: "crew.install",
    success,
    installed: installResult.installed,
    updated: installResult.updated,
    skipped: installResult.skipped,
    errors: installResult.errors,
    summary,
  });
}

// =============================================================================
// crew.uninstall
// =============================================================================

function crewUninstall() {
  const uninstallResult = uninstallAgents();

  const lines: string[] = ["# Crew Agent Uninstall\n"];

  if (uninstallResult.errors.length > 0) {
    lines.push("## ❌ Errors\n");
    for (const err of uninstallResult.errors) {
      lines.push(`- ${err}`);
    }
    lines.push("");
  }

  if (uninstallResult.removed.length > 0) {
    lines.push("## 🗑️ Removed\n");
    for (const agent of uninstallResult.removed) {
      lines.push(`- ${agent}`);
    }
    lines.push("");
  }

  if (uninstallResult.notFound.length > 0) {
    lines.push("## ⏭️ Not Found (already removed)\n");
    for (const agent of uninstallResult.notFound) {
      lines.push(`- ${agent}`);
    }
    lines.push("");
  }

  lines.push(`**Target:** ${getTargetAgentsDir()}`);

  const success = uninstallResult.errors.length === 0;

  return result(lines.join("\n"), {
    mode: "crew.uninstall",
    success,
    removed: uninstallResult.removed,
    notFound: uninstallResult.notFound,
    errors: uninstallResult.errors,
  });
}
