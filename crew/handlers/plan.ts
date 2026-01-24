/**
 * Crew - Plan Handler
 * 
 * Orchestrates planning: scouts (parallel) → gap-analyst → create tasks
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { spawnAgents } from "../agents.js";
import { loadCrewConfig } from "../utils/config.js";
import { discoverCrewAgents } from "../utils/discover.js";
import * as store from "../store.js";
import { getCrewDir } from "../store.js";

// Scout agents to run in parallel
const SCOUT_AGENTS = [
  "crew-repo-scout",
  "crew-practice-scout",
  "crew-docs-scout",
  "crew-github-scout",
  "crew-epic-scout",
  "crew-docs-gap-scout",
  "crew-memory-scout",
];

export async function execute(
  params: CrewParams,
  _state: MessengerState,
  _dirs: Dirs,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();
  const config = loadCrewConfig(getCrewDir(cwd));
  const { target, idea } = params;

  if (!target) {
    return result("Error: target required for plan action (epic ID or idea text with idea: true).", {
      mode: "plan",
      error: "missing_target"
    });
  }

  // Determine if we're planning an existing epic or a new idea
  let epicId: string;
  let epicTitle: string;
  let featureDescription: string;

  if (idea) {
    // Create new epic from idea
    const epic = store.createEpic(cwd, target);
    epicId = epic.id;
    epicTitle = target;
    featureDescription = target;
  } else {
    // Plan existing epic
    const epic = store.getEpic(cwd, target);
    if (!epic) {
      return result(`Error: Epic ${target} not found. Use idea: true to create from idea text.`, {
        mode: "plan",
        error: "epic_not_found",
        target
      });
    }
    epicId = epic.id;
    epicTitle = epic.title;
    
    // Get epic spec for description
    const spec = store.getEpicSpec(cwd, epicId);
    featureDescription = spec && !spec.includes("*Spec pending*") 
      ? spec 
      : epicTitle;
  }

  // Discover available scouts
  const availableAgents = discoverCrewAgents(cwd);
  const availableScouts = SCOUT_AGENTS.filter(name => 
    availableAgents.some(a => a.name === name)
  );

  if (availableScouts.length === 0) {
    return result("Error: No scout agents available. Create crew-*-scout.md agents in ~/.pi/agent/agents/", {
      mode: "plan",
      error: "no_scouts"
    });
  }

  // Check for gap-analyst
  const hasAnalyst = availableAgents.some(a => a.name === "crew-gap-analyst");
  if (!hasAnalyst) {
    return result("Error: crew-gap-analyst agent not found. Required for plan synthesis.", {
      mode: "plan",
      error: "no_analyst"
    });
  }

  // Phase 1: Run scouts in parallel
  const scoutTasks = availableScouts.map(agent => ({
    agent,
    task: `Analyze for feature: "${featureDescription}"\n\nEpic ID: ${epicId}\nEpic Title: ${epicTitle}\n\nProvide context for planning this feature.`
  }));

  const scoutResults = await spawnAgents(
    scoutTasks,
    config.concurrency.scouts,
    cwd
  );

  // Aggregate scout findings
  const scoutFindings: string[] = [];
  const failedScouts: string[] = [];

  for (const r of scoutResults) {
    if (r.exitCode === 0 && r.output) {
      scoutFindings.push(`## ${r.agent}\n\n${r.output}`);
    } else {
      failedScouts.push(r.agent);
    }
  }

  if (scoutFindings.length === 0) {
    return result("Error: All scouts failed. Check agent configurations.", {
      mode: "plan",
      error: "all_scouts_failed",
      failedScouts
    });
  }

  // Phase 2: Run gap-analyst to synthesize findings
  const aggregatedFindings = scoutFindings.join("\n\n---\n\n");
  
  const [analystResult] = await spawnAgents([{
    agent: "crew-gap-analyst",
    task: `Synthesize scout findings and create task breakdown for epic.

Epic ID: ${epicId}
Epic Title: ${epicTitle}

## Scout Findings

${aggregatedFindings}

Create a task breakdown following the exact output format specified in your instructions.`
  }], 1, cwd);

  if (analystResult.exitCode !== 0) {
    return result(`Error: Gap analyst failed: ${analystResult.error ?? "Unknown error"}`, {
      mode: "plan",
      error: "analyst_failed",
      scoutResults: scoutFindings.length
    });
  }

  // Phase 3: Parse analyst output and create tasks
  const tasks = parseTasksFromOutput(analystResult.output);

  if (tasks.length === 0) {
    // Store the analysis as epic spec even if no tasks parsed
    store.setEpicSpec(cwd, epicId, analystResult.output);
    
    return result(`Plan analysis complete but no tasks could be parsed.\n\nAnalysis saved to epic spec. Review and create tasks manually.`, {
      mode: "plan",
      epicId,
      analysisLength: analystResult.output.length,
      scoutsRun: scoutFindings.length,
      failedScouts
    });
  }

  // Create tasks in store
  const createdTasks: { id: string; title: string; dependsOn: string[] }[] = [];
  const titleToId = new Map<string, string>();

  // First pass: create tasks without dependencies
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const created = store.createTask(cwd, epicId, task.title, task.description);
    createdTasks.push({ id: created.id, title: task.title, dependsOn: task.dependsOn });
    titleToId.set(task.title.toLowerCase(), created.id);
    // Also map "task N" format
    titleToId.set(`task ${i + 1}`, created.id);
  }

  // Second pass: resolve and update dependencies
  for (const task of createdTasks) {
    if (task.dependsOn.length > 0) {
      const resolvedDeps: string[] = [];
      for (const dep of task.dependsOn) {
        const depId = titleToId.get(dep.toLowerCase());
        if (depId && depId !== task.id) {
          resolvedDeps.push(depId);
        }
      }
      if (resolvedDeps.length > 0) {
        store.updateTask(cwd, task.id, { depends_on: resolvedDeps });
      }
    }
  }

  // Update epic spec with full analysis
  store.setEpicSpec(cwd, epicId, analystResult.output);
  store.updateEpic(cwd, epicId, { status: "active" });

  // Build result text
  const taskList = createdTasks.map(t => {
    const deps = t.dependsOn.length > 0 ? ` (deps: ${t.dependsOn.join(", ")})` : "";
    return `  - ${t.id}: ${t.title}${deps}`;
  }).join("\n");

  const text = `✅ Planning complete for **${epicId}**: ${epicTitle}

**Scouts run:** ${scoutFindings.length}/${availableScouts.length}
${failedScouts.length > 0 ? `**Failed scouts:** ${failedScouts.join(", ")}\n` : ""}
**Tasks created:** ${createdTasks.length}

${taskList}

**Next steps:**
- Review tasks: \`pi_messenger({ action: "epic.show", id: "${epicId}" })\`
- Start work: \`pi_messenger({ action: "work", target: "${epicId}" })\``;

  return result(text, {
    mode: "plan",
    epicId,
    epicTitle,
    scoutsRun: scoutFindings.length,
    failedScouts,
    tasksCreated: createdTasks.map(t => ({ id: t.id, title: t.title }))
  });
}

// =============================================================================
// Task Parsing
// =============================================================================

interface ParsedTask {
  title: string;
  description: string;
  dependsOn: string[];
}

/**
 * Parses tasks from gap-analyst output.
 * 
 * Expected format:
 * ### Task 1: [Title]
 * [Description...]
 * Dependencies: none | Task 1, Task 2
 */
function parseTasksFromOutput(output: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  
  // Match task blocks
  const taskRegex = /###\s*Task\s*\d+:\s*(.+?)\n([\s\S]*?)(?=###\s*Task\s*\d+:|## |$)/gi;
  let match;

  while ((match = taskRegex.exec(output)) !== null) {
    const title = match[1].trim();
    const body = match[2].trim();

    // Extract dependencies
    const depsMatch = body.match(/Dependencies?:\s*(.+?)(?:\n|$)/i);
    let dependsOn: string[] = [];
    
    if (depsMatch) {
      const depsText = depsMatch[1].trim().toLowerCase();
      if (depsText !== "none" && depsText !== "n/a" && depsText !== "-") {
        // Parse "Task 1, Task 2" or "Task 1" format
        dependsOn = depsText
          .split(/,\s*/)
          .map(d => d.trim())
          .filter(d => d.length > 0);
      }
    }

    // Description is everything except the dependencies line
    const description = body
      .replace(/Dependencies?:\s*.+?(?:\n|$)/i, "")
      .trim();

    tasks.push({ title, description, dependsOn });
  }

  return tasks;
}
