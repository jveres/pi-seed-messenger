/**
 * Pi Messenger - Configuration
 * 
 * Priority (highest to lowest):
 * 1. Project: .pi/pi-messenger.json
 * 2. Extension-specific: ~/.pi/agent/pi-messenger.json
 * 3. Main settings: ~/.pi/agent/settings.json → "messenger" key
 * 4. Defaults
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MessengerConfig {
  // Auto-register on startup (default: false - require explicit join)
  autoRegister: boolean;
  // Paths where auto-register is enabled (when autoRegister is false)
  autoRegisterPaths: string[];
  // Only see agents in the same folder (default: false)
  scopeToFolder: boolean;
  // Context injection
  contextMode: "full" | "minimal" | "none";
  // Registration message (sent once on joining)
  registrationContext: boolean;
  // Include reply hint in messages
  replyHint: boolean;
  // Include sender details on first message from each agent
  senderDetailsOnFirstContact: boolean;
}

const DEFAULT_CONFIG: MessengerConfig = {
  autoRegister: false,
  autoRegisterPaths: [],
  scopeToFolder: false,
  contextMode: "full",
  registrationContext: true,
  replyHint: true,
  senderDetailsOnFirstContact: true,
};

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function matchesAutoRegisterPath(cwd: string, paths: string[]): boolean {
  const normalizedCwd = cwd.replace(/\/+$/, ""); // Remove trailing slashes
  
  for (const pattern of paths) {
    const expanded = expandHome(pattern).replace(/\/+$/, "");
    
    // Simple glob support: trailing /* matches any subdirectory
    if (expanded.endsWith("/*")) {
      const base = expanded.slice(0, -2);
      if (normalizedCwd === base || normalizedCwd.startsWith(base + "/")) {
        return true;
      }
    } else if (expanded.endsWith("*")) {
      // Prefix match: /path/prefix* matches /path/prefix-anything
      const prefix = expanded.slice(0, -1);
      if (normalizedCwd.startsWith(prefix)) {
        return true;
      }
    } else {
      // Exact match
      if (normalizedCwd === expanded) {
        return true;
      }
    }
  }
  
  return false;
}

export function saveAutoRegisterPaths(paths: string[]): void {
  const configPath = join(homedir(), ".pi", "agent", "pi-messenger.json");
  let existing: Record<string, unknown> = {};
  
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Start fresh if malformed
    }
  }
  
  existing.autoRegisterPaths = paths;
  
  const dir = join(homedir(), ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(existing, null, 2));
}

export function getAutoRegisterPaths(): string[] {
  const configPath = join(homedir(), ".pi", "agent", "pi-messenger.json");
  if (!existsSync(configPath)) return [];
  
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return Array.isArray(config.autoRegisterPaths) ? config.autoRegisterPaths : [];
  } catch {
    return [];
  }
}

export function loadConfig(cwd: string): MessengerConfig {
  const projectPath = join(cwd, ".pi", "pi-messenger.json");
  const extensionGlobalPath = join(homedir(), ".pi", "agent", "pi-messenger.json");
  const mainSettingsPath = join(homedir(), ".pi", "agent", "settings.json");

  // Load from main settings.json (lowest priority of the three sources)
  let settingsConfig: Partial<MessengerConfig> = {};
  const mainSettings = readJsonFile(mainSettingsPath);
  if (mainSettings && typeof mainSettings.messenger === "object" && mainSettings.messenger !== null) {
    settingsConfig = mainSettings.messenger as Partial<MessengerConfig>;
  }

  // Load extension-specific global config
  const extensionConfig = readJsonFile(extensionGlobalPath) as Partial<MessengerConfig> | null;

  // Load project config (highest priority)
  const projectConfig = readJsonFile(projectPath) as Partial<MessengerConfig> | null;

  const merged = { 
    ...DEFAULT_CONFIG, 
    ...settingsConfig,
    ...(extensionConfig ?? {}), 
    ...(projectConfig ?? {}) 
  };

  // Apply contextMode shortcuts
  if (merged.contextMode === "none") {
    return {
      autoRegister: merged.autoRegister === true,
      autoRegisterPaths: Array.isArray(merged.autoRegisterPaths) ? merged.autoRegisterPaths : [],
      scopeToFolder: merged.scopeToFolder === true,
      contextMode: "none",
      registrationContext: false,
      replyHint: false,
      senderDetailsOnFirstContact: false,
    };
  }

  if (merged.contextMode === "minimal") {
    return {
      autoRegister: merged.autoRegister === true,
      autoRegisterPaths: Array.isArray(merged.autoRegisterPaths) ? merged.autoRegisterPaths : [],
      scopeToFolder: merged.scopeToFolder === true,
      contextMode: "minimal",
      registrationContext: false,
      replyHint: true,
      senderDetailsOnFirstContact: false,
    };
  }

  // "full" mode uses individual settings
  return {
    autoRegister: merged.autoRegister === true,
    autoRegisterPaths: Array.isArray(merged.autoRegisterPaths) ? merged.autoRegisterPaths : [],
    scopeToFolder: merged.scopeToFolder === true,
    contextMode: "full",
    registrationContext: merged.registrationContext !== false,
    replyHint: merged.replyHint !== false,
    senderDetailsOnFirstContact: merged.senderDetailsOnFirstContact !== false,
  };
}
