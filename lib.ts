/**
 * Pi Messenger - Types and Pure Utilities
 */

import type * as fs from "node:fs";
import { basename, isAbsolute, resolve, relative } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface FileReservation {
  pattern: string;
  reason?: string;
  since: string;
}

export interface AgentRegistration {
  name: string;
  pid: number;
  sessionId: string;
  cwd: string;
  model: string;
  startedAt: string;
  reservations?: FileReservation[];
  gitBranch?: string;
  spec?: string;
}

export interface AgentMailMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  replyTo: string | null;
}

export interface ReservationConflict {
  path: string;
  agent: string;
  pattern: string;
  reason?: string;
  registration: AgentRegistration;
}

export interface MessengerState {
  agentName: string;
  registered: boolean;
  watcher: fs.FSWatcher | null;
  watcherRetries: number;
  watcherRetryTimer: ReturnType<typeof setTimeout> | null;
  watcherDebounceTimer: ReturnType<typeof setTimeout> | null;
  reservations: FileReservation[];
  chatHistory: Map<string, AgentMailMessage[]>;
  unreadCounts: Map<string, number>;
  broadcastHistory: AgentMailMessage[];
  seenSenders: Map<string, string>;  // name -> sessionId (detects agent restarts)
  gitBranch?: string;
  spec?: string;
  scopeToFolder: boolean;  // Only see agents in same cwd
}

export interface Dirs {
  base: string;
  registry: string;
  inbox: string;
}

export interface ClaimEntry {
  agent: string;
  sessionId: string;
  pid: number;
  claimedAt: string;
  reason?: string;
}

export interface CompletionEntry {
  completedBy: string;
  completedAt: string;
  notes?: string;
}

export type SpecClaims = Record<string, ClaimEntry>;
export type SpecCompletions = Record<string, CompletionEntry>;
export type AllClaims = Record<string, SpecClaims>;
export type AllCompletions = Record<string, SpecCompletions>;

// =============================================================================
// Constants
// =============================================================================

export const MAX_WATCHER_RETRIES = 5;
export const MAX_CHAT_HISTORY = 50;

const AGENT_COLORS = [
  "38;2;178;129;214",  // purple
  "38;2;215;135;175",  // pink  
  "38;2;254;188;56",   // gold
  "38;2;137;210;129",  // green
  "38;2;0;175;175",    // cyan
  "38;2;23;143;185",   // blue
  "38;2;228;192;15",   // yellow
  "38;2;255;135;135",  // coral
];

const ADJECTIVES = [
  "Swift", "Bright", "Calm", "Dark", "Epic", "Fast", "Gold", "Happy",
  "Iron", "Jade", "Keen", "Loud", "Mint", "Nice", "Oak", "Pure",
  "Quick", "Red", "Sage", "True", "Ultra", "Vivid", "Wild", "Young", "Zen"
];

const NOUNS = [
  "Arrow", "Bear", "Castle", "Dragon", "Eagle", "Falcon", "Grove", "Hawk",
  "Ice", "Jaguar", "Knight", "Lion", "Moon", "Nova", "Owl", "Phoenix",
  "Quartz", "Raven", "Storm", "Tiger", "Union", "Viper", "Wolf", "Xenon", "Yak", "Zenith"
];

// =============================================================================
// Pure Utilities
// =============================================================================

export function generateMemorableName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return adj + noun;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isValidAgentName(name: string): boolean {
  if (!name || name.length > 50) return false;
  return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(name);
}

export function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

export function pathMatchesReservation(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/")) {
    return filePath.startsWith(pattern) || filePath + "/" === pattern;
  }
  return filePath === pattern;
}

export function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

const colorCache = new Map<string, string>();

export function agentColorCode(name: string): string {
  const cached = colorCache.get(name);
  if (cached) return cached;

  let hash = 0;
  for (const char of name) hash = ((hash << 5) - hash) + char.charCodeAt(0);
  const color = AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
  colorCache.set(name, color);
  return color;
}

export function coloredAgentName(name: string): string {
  return `\x1b[${agentColorCode(name)}m${name}\x1b[0m`;
}

export function extractFolder(cwd: string): string {
  return basename(cwd) || cwd;
}

export function resolveSpecPath(specPath: string, cwd: string): string {
  if (isAbsolute(specPath)) return specPath;
  return resolve(cwd, specPath);
}

export function displaySpecPath(absPath: string, cwd: string): string {
  try {
    const rel = relative(cwd, absPath);
    if (rel === "") return ".";
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return "./" + rel;
    }
  } catch {
    // Ignore and fall back to absolute
  }
  return absPath;
}

export function truncatePathLeft(filePath: string, maxLen: number): string {
  if (filePath.length <= maxLen) return filePath;
  if (maxLen <= 1) return '…';
  const truncated = filePath.slice(-(maxLen - 1));
  const slashIdx = truncated.indexOf('/');
  if (slashIdx > 0) {
    return '…' + truncated.slice(slashIdx);
  }
  return '…' + truncated;
}

export type DisplayMode = "same-folder-branch" | "same-folder" | "different";

export function getDisplayMode(agents: AgentRegistration[]): DisplayMode {
  if (agents.length === 0) return "different";
  
  const folders = agents.map(a => extractFolder(a.cwd));
  const uniqueFolders = new Set(folders);
  
  if (uniqueFolders.size > 1) return "different";
  
  const branches = agents.map(a => a.gitBranch).filter(Boolean);
  const uniqueBranches = new Set(branches);
  
  if (uniqueBranches.size <= 1) return "same-folder-branch";
  
  return "same-folder";
}
