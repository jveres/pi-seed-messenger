/**
 * Crew - Store Operations
 * 
 * All CRUD operations for epics, tasks, specs, and checkpoints.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Epic, Task, TaskEvidence, Checkpoint, EpicStatus } from "./types.js";
import { allocateEpicId, allocateTaskId } from "./id-allocator.js";

// =============================================================================
// Directory Helpers
// =============================================================================

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getCrewDir(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "crew");
}

function getEpicsDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "epics");
}

function getSpecsDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "specs");
}

function getTasksDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "tasks");
}

function getBlocksDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "blocks");
}

function getCheckpointsDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "checkpoints");
}

// =============================================================================
// JSON Helpers
// =============================================================================

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, filePath);
}

function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, filePath);
}

// =============================================================================
// Epic Operations
// =============================================================================

export function createEpic(cwd: string, title: string): Epic {
  const id = allocateEpicId(cwd);
  const now = new Date().toISOString();

  const epic: Epic = {
    id,
    title,
    status: "planning",
    created_at: now,
    updated_at: now,
    task_count: 0,
    completed_count: 0,
  };

  writeJson(path.join(getEpicsDir(cwd), `${id}.json`), epic);

  // Create empty spec file
  writeText(path.join(getSpecsDir(cwd), `${id}.md`), `# ${title}\n\n*Spec pending planning phase*\n`);

  return epic;
}

export function getEpic(cwd: string, epicId: string): Epic | null {
  return readJson<Epic>(path.join(getEpicsDir(cwd), `${epicId}.json`));
}

export function updateEpic(cwd: string, epicId: string, updates: Partial<Epic>): Epic | null {
  const epic = getEpic(cwd, epicId);
  if (!epic) return null;

  const updated: Epic = {
    ...epic,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  writeJson(path.join(getEpicsDir(cwd), `${epicId}.json`), updated);
  return updated;
}

export function listEpics(cwd: string): Epic[] {
  const dir = getEpicsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const epics: Epic[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const epic = readJson<Epic>(path.join(dir, file));
    if (epic) epics.push(epic);
  }

  // Sort by created_at descending (newest first)
  return epics.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function closeEpic(cwd: string, epicId: string): Epic | null {
  const epic = getEpic(cwd, epicId);
  if (!epic) return null;

  // Verify all tasks are done
  const tasks = getTasks(cwd, epicId);
  const allDone = tasks.every(t => t.status === "done");
  if (!allDone) return null;

  return updateEpic(cwd, epicId, {
    status: "completed",
    closed_at: new Date().toISOString(),
  });
}

// =============================================================================
// Epic Spec Operations
// =============================================================================

export function getEpicSpec(cwd: string, epicId: string): string | null {
  return readText(path.join(getSpecsDir(cwd), `${epicId}.md`));
}

export function setEpicSpec(cwd: string, epicId: string, content: string): void {
  writeText(path.join(getSpecsDir(cwd), `${epicId}.md`), content);
  updateEpic(cwd, epicId, {}); // Touch updated_at
}

// =============================================================================
// Task Operations
// =============================================================================

export function createTask(
  cwd: string,
  epicId: string,
  title: string,
  description?: string,
  dependsOn?: string[]
): Task {
  const id = allocateTaskId(cwd, epicId);
  const now = new Date().toISOString();

  const task: Task = {
    id,
    epic_id: epicId,
    title,
    status: "todo",
    depends_on: dependsOn ?? [],
    created_at: now,
    updated_at: now,
    attempt_count: 0,
  };

  writeJson(path.join(getTasksDir(cwd), `${id}.json`), task);

  // Create task spec file
  const specContent = description
    ? `# ${title}\n\n${description}\n`
    : `# ${title}\n\n*Spec pending*\n`;
  writeText(path.join(getTasksDir(cwd), `${id}.md`), specContent);

  // Update epic task count
  const epic = getEpic(cwd, epicId);
  if (epic) {
    updateEpic(cwd, epicId, { task_count: epic.task_count + 1 });
  }

  return task;
}

export function getTask(cwd: string, taskId: string): Task | null {
  return readJson<Task>(path.join(getTasksDir(cwd), `${taskId}.json`));
}

export function updateTask(cwd: string, taskId: string, updates: Partial<Task>): Task | null {
  const task = getTask(cwd, taskId);
  if (!task) return null;

  const updated: Task = {
    ...task,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  writeJson(path.join(getTasksDir(cwd), `${taskId}.json`), updated);
  return updated;
}

export function getTasks(cwd: string, epicId?: string): Task[] {
  const dir = getTasksDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const tasks: Task[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const task = readJson<Task>(path.join(dir, file));
    if (!task) continue;
    if (epicId && task.epic_id !== epicId) continue;
    tasks.push(task);
  }

  // Sort by ID (maintains creation order)
  return tasks.sort((a, b) => {
    const aParts = a.id.split(".");
    const bParts = b.id.split(".");
    const aNum = parseInt(aParts[aParts.length - 1]);
    const bNum = parseInt(bParts[bParts.length - 1]);
    return aNum - bNum;
  });
}

export function getTaskSpec(cwd: string, taskId: string): string | null {
  return readText(path.join(getTasksDir(cwd), `${taskId}.md`));
}

export function setTaskSpec(cwd: string, taskId: string, content: string): void {
  writeText(path.join(getTasksDir(cwd), `${taskId}.md`), content);
  updateTask(cwd, taskId, {}); // Touch updated_at
}

// =============================================================================
// Task Lifecycle Operations
// =============================================================================

export function startTask(cwd: string, taskId: string, agentName: string): Task | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "todo") return null;

  // Capture current git commit
  let baseCommit: string | undefined;
  try {
    baseCommit = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {
    // Not a git repo or git not available
  }

  return updateTask(cwd, taskId, {
    status: "in_progress",
    started_at: new Date().toISOString(),
    base_commit: baseCommit,
    assigned_to: agentName,
    attempt_count: task.attempt_count + 1,
  });
}

export function completeTask(
  cwd: string,
  taskId: string,
  summary: string,
  evidence?: TaskEvidence
): Task | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "in_progress") return null;

  const updated = updateTask(cwd, taskId, {
    status: "done",
    completed_at: new Date().toISOString(),
    summary,
    evidence,
    assigned_to: undefined,
  });

  // Update epic completed count
  if (updated) {
    const epic = getEpic(cwd, task.epic_id);
    if (epic) {
      const newCompletedCount = epic.completed_count + 1;
      updateEpic(cwd, task.epic_id, {
        completed_count: newCompletedCount,
        status: newCompletedCount >= epic.task_count ? "completed" : "active",
      });
    }
  }

  return updated;
}

export function blockTask(cwd: string, taskId: string, reason: string): Task | null {
  const task = getTask(cwd, taskId);
  if (!task) return null;

  // Write block context to blocks directory
  const blockPath = path.join(getBlocksDir(cwd), `${taskId}.md`);
  writeText(blockPath, `# Blocked: ${task.title}\n\n**Reason:** ${reason}\n\n**Blocked at:** ${new Date().toISOString()}\n`);

  return updateTask(cwd, taskId, {
    status: "blocked",
    blocked_reason: reason,
    assigned_to: undefined,
  });
}

export function unblockTask(cwd: string, taskId: string): Task | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "blocked") return null;

  // Remove block file if exists
  const blockPath = path.join(getBlocksDir(cwd), `${taskId}.md`);
  try {
    fs.unlinkSync(blockPath);
  } catch {
    // Ignore if doesn't exist
  }

  return updateTask(cwd, taskId, {
    status: "todo",
    blocked_reason: undefined,
  });
}

export function resetTask(cwd: string, taskId: string, cascade: boolean = false): Task[] {
  const task = getTask(cwd, taskId);
  if (!task) return [];

  const resetTasks: Task[] = [];

  // Reset this task
  const updated = updateTask(cwd, taskId, {
    status: "todo",
    started_at: undefined,
    completed_at: undefined,
    base_commit: undefined,
    assigned_to: undefined,
    summary: undefined,
    evidence: undefined,
    blocked_reason: undefined,
    // Keep attempt_count for tracking
  });
  if (updated) resetTasks.push(updated);

  // If cascade, reset all tasks that depend on this one
  if (cascade) {
    const allTasks = getTasks(cwd, task.epic_id);
    for (const t of allTasks) {
      if (t.depends_on.includes(taskId) && t.status !== "todo") {
        const cascaded = resetTask(cwd, t.id, true);
        resetTasks.push(...cascaded);
      }
    }
  }

  // Update epic completed count if needed
  if (resetTasks.length > 0) {
    const epic = getEpic(cwd, task.epic_id);
    if (epic) {
      const doneTasks = getTasks(cwd, task.epic_id).filter(t => t.status === "done");
      updateEpic(cwd, task.epic_id, {
        completed_count: doneTasks.length,
        status: doneTasks.length < epic.task_count ? "active" : "completed",
      });
    }
  }

  return resetTasks;
}

// =============================================================================
// Ready Tasks (Dependency Resolution)
// =============================================================================

export function getReadyTasks(cwd: string, epicId: string): Task[] {
  const tasks = getTasks(cwd, epicId);
  const doneIds = new Set(tasks.filter(t => t.status === "done").map(t => t.id));

  return tasks.filter(task => {
    // Must be in "todo" status
    if (task.status !== "todo") return false;

    // All dependencies must be done
    return task.depends_on.every(depId => doneIds.has(depId));
  });
}

// =============================================================================
// Checkpoint Operations
// =============================================================================

export function saveCheckpoint(cwd: string, epicId: string): Checkpoint | null {
  const epic = getEpic(cwd, epicId);
  if (!epic) return null;

  const tasks = getTasks(cwd, epicId);
  const epicSpec = getEpicSpec(cwd, epicId) ?? "";

  const taskSpecs: Record<string, string> = {};
  for (const task of tasks) {
    const spec = getTaskSpec(cwd, task.id);
    if (spec) taskSpecs[task.id] = spec;
  }

  const checkpoint: Checkpoint = {
    id: epicId,
    created_at: new Date().toISOString(),
    epic,
    tasks,
    epic_spec: epicSpec,
    task_specs: taskSpecs,
  };

  writeJson(path.join(getCheckpointsDir(cwd), `${epicId}.json`), checkpoint);
  return checkpoint;
}

export function getCheckpoint(cwd: string, epicId: string): Checkpoint | null {
  return readJson<Checkpoint>(path.join(getCheckpointsDir(cwd), `${epicId}.json`));
}

export function restoreCheckpoint(cwd: string, epicId: string): boolean {
  const checkpoint = getCheckpoint(cwd, epicId);
  if (!checkpoint) return false;

  // Restore epic
  writeJson(path.join(getEpicsDir(cwd), `${epicId}.json`), checkpoint.epic);

  // Restore epic spec
  writeText(path.join(getSpecsDir(cwd), `${epicId}.md`), checkpoint.epic_spec);

  // Restore tasks and their specs
  for (const task of checkpoint.tasks) {
    writeJson(path.join(getTasksDir(cwd), `${task.id}.json`), task);
    const spec = checkpoint.task_specs[task.id];
    if (spec) {
      writeText(path.join(getTasksDir(cwd), `${task.id}.md`), spec);
    }
  }

  return true;
}

export function deleteCheckpoint(cwd: string, epicId: string): boolean {
  const filePath = path.join(getCheckpointsDir(cwd), `${epicId}.json`);
  if (!fs.existsSync(filePath)) return false;

  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Validation
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateEpic(cwd: string, epicId: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const epic = getEpic(cwd, epicId);
  if (!epic) {
    return { valid: false, errors: ["Epic not found"], warnings: [] };
  }

  const tasks = getTasks(cwd, epicId);

  // Check for orphan dependencies
  const taskIds = new Set(tasks.map(t => t.id));
  for (const task of tasks) {
    for (const depId of task.depends_on) {
      if (!taskIds.has(depId)) {
        errors.push(`Task ${task.id} depends on non-existent task ${depId}`);
      }
    }
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(taskId: string): boolean {
    if (recursionStack.has(taskId)) return true;
    if (visited.has(taskId)) return false;

    visited.add(taskId);
    recursionStack.add(taskId);

    const task = tasks.find(t => t.id === taskId);
    if (task) {
      for (const depId of task.depends_on) {
        if (hasCycle(depId)) return true;
      }
    }

    recursionStack.delete(taskId);
    return false;
  }

  for (const task of tasks) {
    visited.clear();
    recursionStack.clear();
    if (hasCycle(task.id)) {
      errors.push(`Circular dependency detected involving task ${task.id}`);
    }
  }

  // Check for tasks without specs
  for (const task of tasks) {
    const spec = getTaskSpec(cwd, task.id);
    if (!spec || spec.includes("*Spec pending*")) {
      warnings.push(`Task ${task.id} has no detailed spec`);
    }
  }

  // Check epic spec
  const epicSpec = getEpicSpec(cwd, epicId);
  if (!epicSpec || epicSpec.includes("*Spec pending*")) {
    warnings.push("Epic has no detailed spec");
  }

  // Check task counts
  if (epic.task_count !== tasks.length) {
    warnings.push(`Epic task_count (${epic.task_count}) doesn't match actual tasks (${tasks.length})`);
  }

  const actualDone = tasks.filter(t => t.status === "done").length;
  if (epic.completed_count !== actualDone) {
    warnings.push(`Epic completed_count (${epic.completed_count}) doesn't match actual (${actualDone})`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
