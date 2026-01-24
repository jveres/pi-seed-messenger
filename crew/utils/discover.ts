/**
 * Crew - Agent Discovery
 * 
 * Discovers agent definitions from user and project directories,
 * with crew-specific filtering by role.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MaxOutputConfig } from "./truncate.js";

export type CrewRole = "scout" | "worker" | "reviewer" | "analyst";

export interface CrewAgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
  // Crew-specific extensions
  crewRole?: CrewRole;
  maxOutput?: MaxOutputConfig;
  parallel?: boolean;
  retryable?: boolean;
}

export interface AgentDiscoveryResult {
  agents: CrewAgentConfig[];
  projectAgentsDir: string | null;
}

/**
 * Parse YAML-like frontmatter from markdown content.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const frontmatterBlock = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();

  const frontmatter: Record<string, unknown> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      let value: unknown = match[2].trim();
      // Handle quoted strings
      if ((value as string).startsWith('"') || (value as string).startsWith("'")) {
        value = (value as string).slice(1, -1);
      }
      // Handle inline YAML objects (e.g., maxOutput: { bytes: 1024, lines: 500 })
      if ((value as string).startsWith("{") && (value as string).endsWith("}")) {
        try {
          // YAML inline objects don't require quoted keys, but JSON does
          const jsonStr = (value as string).replace(/(\w+):/g, '"$1":');
          value = JSON.parse(jsonStr);
        } catch {
          // Keep as string if parse fails
        }
      }
      // Handle booleans
      if (value === "true") value = true;
      if (value === "false") value = false;
      frontmatter[match[1]] = value;
    }
  }
  return { frontmatter, body };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): CrewAgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  const agents: CrewAgentConfig[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name || !frontmatter.description) continue;

    // Parse tools (comma-separated, filter empty)
    const tools = (frontmatter.tools as string)
      ?.split(",")
      .map(t => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name as string,
      description: frontmatter.description as string,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model as string | undefined,
      systemPrompt: body,
      source,
      filePath,
      // Crew extensions
      crewRole: frontmatter.crewRole as CrewRole | undefined,
      maxOutput: frontmatter.maxOutput as MaxOutputConfig | undefined,
      parallel: frontmatter.parallel as boolean | undefined ?? true,
      retryable: frontmatter.retryable as boolean | undefined ?? true,
    });
  }
  return agents;
}

/**
 * Discover all agents from user and/or project directories.
 */
export function discoverAgents(cwd: string, scope: "user" | "project" | "both"): AgentDiscoveryResult {
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
  const projectDir = findProjectAgentsDir(cwd);

  const userAgents = scope !== "project" ? loadAgentsFromDir(userDir, "user") : [];
  const projectAgents = scope !== "user" && projectDir ? loadAgentsFromDir(projectDir, "project") : [];

  // Project overrides user (same name = project wins)
  const agentMap = new Map<string, CrewAgentConfig>();
  for (const a of userAgents) agentMap.set(a.name, a);
  for (const a of projectAgents) agentMap.set(a.name, a);

  return { agents: Array.from(agentMap.values()), projectAgentsDir: projectDir };
}

/**
 * Discover only crew agents (those with crewRole set).
 */
export function discoverCrewAgents(cwd: string): CrewAgentConfig[] {
  return discoverAgents(cwd, "both").agents.filter(a => a.crewRole !== undefined);
}

/**
 * Get crew agents filtered by role.
 */
export function getAgentsByRole(cwd: string, role: CrewRole): CrewAgentConfig[] {
  return discoverCrewAgents(cwd).filter(a => a.crewRole === role);
}
