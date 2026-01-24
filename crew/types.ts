/**
 * Crew - Type Definitions
 * 
 * Complete type definitions for epics, tasks, configuration, and parameters.
 */

import type { MaxOutputConfig } from "./utils/truncate.js";
import type { AgentProgress } from "./utils/progress.js";
import type { CrewAgentConfig } from "./utils/discover.js";

// =============================================================================
// Epic Types
// =============================================================================

export type EpicStatus = "planning" | "active" | "blocked" | "completed" | "archived";

export interface Epic {
  id: string;                    // c-N-xxx format
  title: string;
  status: EpicStatus;
  created_at: string;            // ISO timestamp
  updated_at: string;            // ISO timestamp
  closed_at?: string;            // ISO timestamp (when completed/archived)
  task_count: number;            // Denormalized for quick access
  completed_count: number;       // Denormalized for quick access
}

// =============================================================================
// Task Types
// =============================================================================

export type TaskStatus = "todo" | "in_progress" | "done" | "blocked";

export interface TaskEvidence {
  commits?: string[];            // Commit SHAs
  tests?: string[];              // Test commands/files run
  prs?: string[];                // PR URLs
}

export interface Task {
  id: string;                    // c-N-xxx.M format
  epic_id: string;               // Parent epic ID
  title: string;
  status: TaskStatus;
  depends_on: string[];          // Task IDs this depends on
  created_at: string;            // ISO timestamp
  updated_at: string;            // ISO timestamp
  started_at?: string;           // When task.start was called
  completed_at?: string;         // When task.done was called
  base_commit?: string;          // Git commit SHA at task.start
  assigned_to?: string;          // Agent name currently working on it
  summary?: string;              // Completion summary from task.done
  evidence?: TaskEvidence;       // Evidence from task.done
  blocked_reason?: string;       // Reason from task.block
  attempt_count: number;         // How many times attempted (for auto-block)
}

// =============================================================================
// Checkpoint Types
// =============================================================================

export interface Checkpoint {
  id: string;                    // Epic ID
  created_at: string;
  epic: Epic;
  tasks: Task[];
  epic_spec: string;             // Content of specs/c-N-xxx.md
  task_specs: Record<string, string>;  // task_id -> spec content
}

// =============================================================================
// Crew Params (Tool Parameters)
// =============================================================================

export interface CrewParams {
  // Action
  action?: string;

  // Crew IDs
  id?: string;                   // Epic or task ID (c-N-xxx or c-N-xxx.M)
  taskId?: string;               // Swarm task ID (for claim/unclaim/complete)

  // Creation
  title?: string;
  epic?: string;                 // Parent epic for task operations
  dependsOn?: string[];

  // Orchestration
  target?: string;
  idea?: boolean;

  // Completion
  summary?: string;
  evidence?: TaskEvidence;

  // Content
  content?: string;

  // Review
  type?: "plan" | "impl";

  // Work options
  autonomous?: boolean;
  concurrency?: number;

  // Task reset
  cascade?: boolean;

  // Coordination (existing)
  spec?: string;
  to?: string | string[];
  message?: string;
  replyTo?: string;
  paths?: string[];
  reason?: string;
  name?: string;
  notes?: string;
  release?: string[] | boolean;
  autoRegisterPath?: "add" | "remove" | "list";
}

// =============================================================================
// Review Types
// =============================================================================

export type ReviewVerdict = "SHIP" | "NEEDS_WORK" | "MAJOR_RETHINK";

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  issues?: string[];
  suggestions?: string[];
}

// =============================================================================
// Agent Spawning Types
// =============================================================================

export interface AgentTask {
  agent: string;
  task: string;
  maxOutput?: MaxOutputConfig;
}

export interface AgentResult {
  agent: string;
  exitCode: number;
  output: string;
  truncated: boolean;
  progress: AgentProgress;
  config?: CrewAgentConfig;
  error?: string;
  artifactPaths?: {
    input: string;
    output: string;
    jsonl: string;
    metadata: string;
  };
}

// =============================================================================
// Callback Types
// =============================================================================

export type AppendEntryFn = (type: string, data: unknown) => void;

// =============================================================================
// Generated Task (from plan phase)
// =============================================================================

export interface GeneratedTask {
  title: string;
  description: string;
  dependsOn?: string[];          // Task titles (resolved to IDs during creation)
}
