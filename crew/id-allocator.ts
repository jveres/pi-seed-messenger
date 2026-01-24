/**
 * Crew - ID Allocator
 * 
 * Scan-based ID allocation for epics and tasks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Generates a random 3-character alphanumeric suffix.
 */
function randomSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(3);
  return Array.from(bytes).map(b => chars[b % chars.length]).join("");
}

/**
 * Scans existing epics to determine the next sequence number.
 * Returns epic ID in format: c-N-xxx
 */
export function allocateEpicId(cwd: string): string {
  const epicsDir = path.join(cwd, ".pi", "messenger", "crew", "epics");

  let maxN = 0;
  if (fs.existsSync(epicsDir)) {
    for (const file of fs.readdirSync(epicsDir)) {
      const match = file.match(/^c-(\d+)-[a-z0-9]{3}\.json$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxN) maxN = n;
      }
    }
  }

  return `c-${maxN + 1}-${randomSuffix()}`;
}

/**
 * Scans existing tasks for an epic to determine the next task number.
 * Returns task ID in format: c-N-xxx.M
 */
export function allocateTaskId(cwd: string, epicId: string): string {
  const tasksDir = path.join(cwd, ".pi", "messenger", "crew", "tasks");

  let maxM = 0;
  if (fs.existsSync(tasksDir)) {
    const prefix = `${epicId}.`;
    for (const file of fs.readdirSync(tasksDir)) {
      if (file.startsWith(prefix) && file.endsWith(".json")) {
        const match = file.match(/\.(\d+)\.json$/);
        if (match) {
          const m = parseInt(match[1], 10);
          if (m > maxM) maxM = m;
        }
      }
    }
  }

  return `${epicId}.${maxM + 1}`;
}

/**
 * Parsed ID components.
 */
export type ParsedId =
  | { type: "epic"; n: number; suffix: string }
  | { type: "task"; epicId: string; taskNum: number };

/**
 * Parses an ID to extract its components.
 */
export function parseId(id: string): ParsedId | null {
  // Task ID: c-N-xxx.M
  const taskMatch = id.match(/^(c-\d+-[a-z0-9]{3})\.(\d+)$/);
  if (taskMatch) {
    return {
      type: "task",
      epicId: taskMatch[1],
      taskNum: parseInt(taskMatch[2], 10),
    };
  }

  // Epic ID: c-N-xxx
  const epicMatch = id.match(/^c-(\d+)-([a-z0-9]{3})$/);
  if (epicMatch) {
    return {
      type: "epic",
      n: parseInt(epicMatch[1], 10),
      suffix: epicMatch[2],
    };
  }

  return null;
}

/**
 * Validates that an ID is well-formed.
 */
export function isValidId(id: string): boolean {
  return parseId(id) !== null;
}

/**
 * Checks if an ID is an epic ID.
 */
export function isEpicId(id: string): boolean {
  const parsed = parseId(id);
  return parsed !== null && parsed.type === "epic";
}

/**
 * Checks if an ID is a task ID.
 */
export function isTaskId(id: string): boolean {
  const parsed = parseId(id);
  return parsed !== null && parsed.type === "task";
}

/**
 * Extracts the epic ID from a task ID.
 */
export function getEpicIdFromTaskId(taskId: string): string | null {
  const parsed = parseId(taskId);
  if (parsed?.type === "task") {
    return parsed.epicId;
  }
  return null;
}
