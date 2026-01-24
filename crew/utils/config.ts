/**
 * Crew - Configuration Loading
 * 
 * Loads and merges user-level and project-level configuration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MaxOutputConfig } from "./truncate.js";

const USER_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "pi-messenger.json");
const PROJECT_CONFIG_FILE = "config.json";

export interface CrewConfig {
  concurrency: {
    scouts: number;
    workers: number;
  };
  truncation: {
    scouts: MaxOutputConfig;
    workers: MaxOutputConfig;
    reviewers: MaxOutputConfig;
    analysts: MaxOutputConfig;
  };
  artifacts: {
    enabled: boolean;
    cleanupDays: number;
  };
  memory: { enabled: boolean };
  planSync: { enabled: boolean; crossEpic: boolean };
  review: { enabled: boolean; maxIterations: number };
  work: { maxAttemptsPerTask: number; maxWaves: number; stopOnBlock: boolean };
}

const DEFAULT_CONFIG: CrewConfig = {
  concurrency: {
    scouts: 4,
    workers: 2,
  },
  truncation: {
    scouts: { bytes: 51200, lines: 500 },
    workers: { bytes: 204800, lines: 5000 },
    reviewers: { bytes: 102400, lines: 2000 },
    analysts: { bytes: 102400, lines: 2000 },
  },
  artifacts: { enabled: true, cleanupDays: 7 },
  memory: { enabled: false },
  planSync: { enabled: false, crossEpic: false },
  review: { enabled: true, maxIterations: 3 },
  work: { maxAttemptsPerTask: 5, maxWaves: 50, stopOnBlock: false },
};

function loadJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function deepMerge<T extends object>(target: T, ...sources: Partial<T>[]): T {
  const result = { ...target };
  for (const source of sources) {
    for (const key of Object.keys(source) as (keyof T)[]) {
      const targetVal = result[key];
      const sourceVal = source[key];
      if (sourceVal && typeof sourceVal === "object" && !Array.isArray(sourceVal)) {
        result[key] = deepMerge(targetVal as object, sourceVal as object) as T[keyof T];
      } else if (sourceVal !== undefined) {
        result[key] = sourceVal as T[keyof T];
      }
    }
  }
  return result;
}

/**
 * Load crew configuration with priority: defaults <- user <- project
 */
export function loadCrewConfig(crewDir: string): CrewConfig {
  // User-level config (from ~/.pi/agent/pi-messenger.json -> crew section)
  const userConfig = loadJson(USER_CONFIG_PATH);
  const userCrewConfig = (userConfig.crew ?? {}) as Partial<CrewConfig>;

  // Project-level config (from .pi/messenger/crew/config.json)
  const projectConfig = loadJson(path.join(crewDir, PROJECT_CONFIG_FILE)) as Partial<CrewConfig>;

  // Merge: defaults <- user <- project
  return deepMerge(DEFAULT_CONFIG, userCrewConfig, projectConfig);
}

/**
 * Get truncation config for a specific role.
 */
export function getTruncationForRole(config: CrewConfig, role: string): MaxOutputConfig {
  switch (role) {
    case "scout": return config.truncation.scouts;
    case "worker": return config.truncation.workers;
    case "reviewer": return config.truncation.reviewers;
    case "analyst": return config.truncation.analysts;
    default: return config.truncation.workers;
  }
}
