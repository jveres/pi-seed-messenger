/**
 * Crew Overlay - Epic/Task Visualization
 * 
 * Renders the Crew tab content for the messenger overlay.
 * Shows epic/task tree with status, dependencies, and autonomous mode info.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import * as crewStore from "./crew/store.js";
import { autonomousState } from "./crew/state.js";
import type { Epic, Task } from "./crew/types.js";

// Status icons
const STATUS_ICONS: Record<string, string> = {
  done: "✓",
  in_progress: "●",
  todo: "○",
  blocked: "✗",
};

// Epic status icons
const EPIC_STATUS_ICONS: Record<string, string> = {
  planning: "📝",
  active: "🚀",
  blocked: "🚫",
  completed: "✅",
  archived: "📦",
};

export interface CrewViewState {
  selectedEpicIndex: number;
  scrollOffset: number;
  expandedEpics: Set<string>;
}

export function createCrewViewState(): CrewViewState {
  return {
    selectedEpicIndex: 0,
    scrollOffset: 0,
    expandedEpics: new Set(),
  };
}

/**
 * Render the crew overview content.
 */
export function renderCrewContent(
  theme: Theme,
  cwd: string,
  width: number,
  height: number,
  viewState: CrewViewState
): string[] {
  const lines: string[] = [];
  const epics = crewStore.listEpics(cwd);

  if (epics.length === 0) {
    return renderEmptyState(theme, width, height);
  }

  // Render epic list with tasks
  for (let i = 0; i < epics.length; i++) {
    const epic = epics[i];
    const isExpanded = viewState.expandedEpics.has(epic.id);
    const isSelected = i === viewState.selectedEpicIndex;
    
    // Epic header line
    const epicLine = renderEpicLine(theme, epic, isExpanded, isSelected, width);
    lines.push(epicLine);

    // Task list if expanded
    if (isExpanded) {
      const tasks = crewStore.getTasks(cwd, epic.id);
      for (let j = 0; j < tasks.length; j++) {
        const task = tasks[j];
        const isLast = j === tasks.length - 1;
        const taskLine = renderTaskLine(theme, task, isLast, width);
        lines.push(taskLine);
      }
      
      if (tasks.length === 0) {
        lines.push(theme.fg("dim", "   (no tasks yet)"));
      }
      
      lines.push(""); // Spacer after tasks
    }
  }

  // Add legend
  lines.push("");
  lines.push(renderLegend(theme, width));

  // Ensure we fill the height
  while (lines.length < height) {
    lines.push("");
  }

  // Handle scrolling if content exceeds height
  if (lines.length > height) {
    const startIdx = Math.min(viewState.scrollOffset, lines.length - height);
    return lines.slice(startIdx, startIdx + height);
  }

  return lines.slice(0, height);
}

/**
 * Render the status bar for autonomous mode.
 */
export function renderCrewStatusBar(theme: Theme, cwd: string, width: number): string {
  if (!autonomousState.active || !autonomousState.epicId) {
    // Check for any active epics
    const epics = crewStore.listEpics(cwd);
    const activeEpics = epics.filter(e => e.status === "active");
    
    if (activeEpics.length > 0) {
      const e = activeEpics[0];
      const progress = `${e.completed_count}/${e.task_count}`;
      return truncateToWidth(
        `${EPIC_STATUS_ICONS.active} ${e.id}: ${progress} tasks`,
        width
      );
    }
    
    return theme.fg("dim", "No active work");
  }

  // Autonomous mode active
  const epic = crewStore.getEpic(cwd, autonomousState.epicId);
  const progress = epic ? `${epic.completed_count}/${epic.task_count}` : "?/?";
  
  // Calculate elapsed time
  let elapsed = "";
  if (autonomousState.startedAt) {
    const startTime = new Date(autonomousState.startedAt).getTime();
    const elapsedMs = Date.now() - startTime;
    const minutes = Math.floor(elapsedMs / 60000);
    const seconds = Math.floor((elapsedMs % 60000) / 1000);
    elapsed = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  const readyTasks = crewStore.getReadyTasks(cwd, autonomousState.epicId);
  
  const parts = [
    `Wave ${autonomousState.waveNumber}`,
    `${progress} tasks`,
    `${readyTasks.length} ready`,
  ];
  
  if (elapsed) {
    parts.push(`⏱️ ${elapsed}`);
  }

  return truncateToWidth(
    theme.fg("accent", "● AUTO ") + parts.join(" │ "),
    width
  );
}

// =============================================================================
// Private Helpers
// =============================================================================

function renderEmptyState(theme: Theme, width: number, height: number): string[] {
  const lines: string[] = [];
  const msg = "No epics yet";
  const hint = "Use pi_messenger({ action: \"epic.create\", title: \"...\" })";
  
  const padTop = Math.floor((height - 3) / 2);
  for (let i = 0; i < padTop; i++) lines.push("");
  
  const pad1 = " ".repeat(Math.max(0, Math.floor((width - msg.length) / 2)));
  lines.push(pad1 + msg);
  lines.push("");
  const pad2 = " ".repeat(Math.max(0, Math.floor((width - hint.length) / 2)));
  lines.push(pad2 + theme.fg("dim", hint));
  
  while (lines.length < height) lines.push("");
  return lines;
}

function renderEpicLine(
  theme: Theme,
  epic: Epic,
  isExpanded: boolean,
  isSelected: boolean,
  width: number
): string {
  const icon = EPIC_STATUS_ICONS[epic.status] ?? "?";
  const expandIcon = isExpanded ? "▾" : "▸";
  const selectIndicator = isSelected ? theme.fg("accent", "▸ ") : "  ";
  
  const progress = `${epic.completed_count}/${epic.task_count}`;
  const progressColor = epic.completed_count === epic.task_count && epic.task_count > 0
    ? "accent"
    : "dim";
  
  const line = `${selectIndicator}${expandIcon} ${icon} ${epic.id}: ${epic.title}`;
  const progressText = ` [${progress}]`;
  
  const availableWidth = width - visibleWidth(progressText) - 1;
  const truncatedLine = truncateToWidth(line, availableWidth);
  const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(truncatedLine)));
  
  return truncatedLine + padding + theme.fg(progressColor, progressText);
}

function renderTaskLine(
  theme: Theme,
  task: Task,
  isLast: boolean,
  width: number
): string {
  const connector = isLast ? "└─" : "├─";
  const icon = STATUS_ICONS[task.status] ?? "?";
  
  // Color the icon based on status
  let coloredIcon: string;
  switch (task.status) {
    case "done":
      coloredIcon = theme.fg("accent", icon);
      break;
    case "in_progress":
      coloredIcon = theme.fg("warning", icon);
      break;
    case "blocked":
      coloredIcon = theme.fg("error", icon);
      break;
    default:
      coloredIcon = theme.fg("dim", icon);
  }

  // Build task suffix (assigned agent or dependencies)
  let suffix = "";
  if (task.status === "in_progress" && task.assigned_to) {
    suffix = ` (${task.assigned_to})`;
  } else if (task.status === "todo" && task.depends_on.length > 0) {
    // Show only task numbers (e.g., "deps: 2, 3" instead of full IDs)
    const depNums = task.depends_on.map(id => {
      const parts = id.split(".");
      return parts[parts.length - 1];
    });
    suffix = ` → deps: ${depNums.join(", ")}`;
  } else if (task.status === "blocked" && task.blocked_reason) {
    // Truncate block reason
    const reason = task.blocked_reason.slice(0, 20);
    suffix = ` [${reason}${task.blocked_reason.length > 20 ? "…" : ""}]`;
  }

  const line = `   ${connector} ${coloredIcon} ${task.id}  ${task.title}`;
  const fullLine = line + theme.fg("dim", suffix);
  
  return truncateToWidth(fullLine, width);
}

function renderLegend(theme: Theme, width: number): string {
  const items = [
    `${theme.fg("accent", STATUS_ICONS.done)} done`,
    `${theme.fg("warning", STATUS_ICONS.in_progress)} in_progress`,
    `${theme.fg("dim", STATUS_ICONS.todo)} todo`,
    `${theme.fg("error", STATUS_ICONS.blocked)} blocked`,
  ];
  
  const legend = "Legend: " + items.join("  ");
  return truncateToWidth(theme.fg("dim", legend), width);
}

/**
 * Toggle expansion of an epic.
 */
export function toggleEpicExpansion(viewState: CrewViewState, epicId: string): void {
  if (viewState.expandedEpics.has(epicId)) {
    viewState.expandedEpics.delete(epicId);
  } else {
    viewState.expandedEpics.add(epicId);
  }
}

/**
 * Navigate to next/prev epic.
 */
export function navigateEpic(viewState: CrewViewState, direction: 1 | -1, epicCount: number): void {
  if (epicCount === 0) return;
  viewState.selectedEpicIndex = Math.max(
    0,
    Math.min(epicCount - 1, viewState.selectedEpicIndex + direction)
  );
}

/**
 * Get the currently selected epic ID.
 */
export function getSelectedEpicId(cwd: string, viewState: CrewViewState): string | null {
  const epics = crewStore.listEpics(cwd);
  if (viewState.selectedEpicIndex >= 0 && viewState.selectedEpicIndex < epics.length) {
    return epics[viewState.selectedEpicIndex].id;
  }
  return null;
}
