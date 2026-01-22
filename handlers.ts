/**
 * Pi Messenger - Tool and Command Handlers
 */

import { existsSync } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  type AgentRegistration,
  type SpecClaims,
  type SpecCompletions,
  formatRelativeTime,
  extractFolder,
  truncatePathLeft,
  getDisplayMode,
  displaySpecPath,
  resolveSpecPath
} from "./lib.js";
import * as store from "./store.js";
import { getAutoRegisterPaths, saveAutoRegisterPaths, matchesAutoRegisterPath } from "./config.js";

// =============================================================================
// Tool Result Helper
// =============================================================================

function result(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details
  };
}

// =============================================================================
// Not Registered Error
// =============================================================================

export function notRegisteredError() {
  return result(
    "Not registered. Use pi_messenger({ join: true }) to join the agent mesh first.",
    { mode: "error", error: "not_registered" }
  );
}

// =============================================================================
// Tool Execute Functions
// =============================================================================

export function executeJoin(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  deliverFn: (msg: AgentMailMessage) => void,
  updateStatusFn: (ctx: ExtensionContext) => void,
  specPath?: string
) {
  if (state.registered) {
    const agents = store.getActiveAgents(state, dirs);
    return result(
      `Already joined as ${state.agentName}. ${agents.length} peer${agents.length === 1 ? "" : "s"} active.`,
      { mode: "join", alreadyJoined: true, name: state.agentName, peerCount: agents.length }
    );
  }

  if (!store.register(state, dirs, ctx)) {
    return result(
      "Failed to join the agent mesh. Check logs for details.",
      { mode: "join", error: "registration_failed" }
    );
  }

  store.startWatcher(state, dirs, deliverFn);
  updateStatusFn(ctx);

  let specWarning = "";
  if (specPath) {
    state.spec = resolveSpecPath(specPath, process.cwd());
    store.updateRegistration(state, dirs, ctx);
    if (!existsSync(state.spec)) {
      specWarning = `\n\nWarning: Spec file not found at ${displaySpecPath(state.spec, process.cwd())}.`;
    }
  }

  const agents = store.getActiveAgents(state, dirs);
  const folder = extractFolder(process.cwd());
  const locationPart = state.gitBranch ? `${folder} on ${state.gitBranch}` : folder;

  let text = `Joined as ${state.agentName} in ${locationPart}. ${agents.length} peer${agents.length === 1 ? "" : "s"} active.`;

  if (state.spec) {
    text += `\nSpec: ${displaySpecPath(state.spec, process.cwd())}`;
  }

  if (agents.length > 0) {
    text += `\n\nActive peers: ${agents.map(a => a.name).join(", ")}`;
    text += `\n\nUse pi_messenger({ list: true }) for details, or pi_messenger({ to: "Name", message: "..." }) to send.`;
  }

  if (specWarning) {
    text += specWarning;
  }

  return result(text, {
    mode: "join",
    name: state.agentName,
    location: locationPart,
    peerCount: agents.length,
    peers: agents.map(a => a.name),
    spec: state.spec ? displaySpecPath(state.spec, process.cwd()) : undefined
  });
}

export function executeStatus(state: MessengerState, dirs: Dirs) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const agents = store.getActiveAgents(state, dirs);
  const folder = extractFolder(process.cwd());
  const location = state.gitBranch ? `${folder} (${state.gitBranch})` : folder;
  const myClaim = store.getAgentCurrentClaim(dirs, state.agentName);

  let text = `You: ${state.agentName}\n`;
  text += `Location: ${location}\n`;

  if (state.spec) {
    const specDisplay = displaySpecPath(state.spec, process.cwd());
    text += `Spec: ${specDisplay}\n`;
    if (myClaim) {
      text += `Claim: ${myClaim.taskId}${myClaim.reason ? ` - ${myClaim.reason}` : ""}\n`;
    }
  }

  text += `Peers: ${agents.length}\n`;
  if (state.reservations.length > 0) {
    const myRes = state.reservations.map(r => `🔒 ${truncatePathLeft(r.pattern, 40)}`);
    text += `Reservations: ${myRes.join(", ")}\n`;
  }
  text += `\nUse { list: true } for details, { swarm: true } for task status.`;

  return result(text, {
    mode: "status",
    registered: true,
    self: state.agentName,
    folder,
    gitBranch: state.gitBranch,
    peerCount: agents.length,
    spec: state.spec ? displaySpecPath(state.spec, process.cwd()) : undefined,
    claim: myClaim
      ? {
        ...myClaim,
        spec: displaySpecPath(myClaim.spec, process.cwd())
      }
      : undefined,
    reservations: state.reservations
  });
}

export function executeList(state: MessengerState, dirs: Dirs) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const agents = store.getActiveAgents(state, dirs);

  if (agents.length === 0) {
    return result(
      "No other agents currently active.",
      { mode: "list", registered: true, agents: [], self: state.agentName, agentClaims: {} }
    );
  }

  const lines: string[] = [];
  const hasAnySpec = !!state.spec || agents.some(a => a.spec);
  const allClaims = store.getClaims(dirs);
  const agentClaims: Record<string, { spec: string; taskId: string; reason?: string }> = {};

  for (const [specPath, tasks] of Object.entries(allClaims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (claim.agent !== state.agentName) {
        agentClaims[claim.agent] = {
          spec: displaySpecPath(specPath, process.cwd()),
          taskId,
          reason: claim.reason
        };
      }
    }
  }

  function formatReservations(a: AgentRegistration): string[] {
    if (!a.reservations || a.reservations.length === 0) return [];
    return a.reservations.map(r => `🔒 ${truncatePathLeft(r.pattern, 40)}`);
  }

  if (hasAnySpec) {
    const bySpec: Record<string, AgentRegistration[]> = { "No spec": [] };
    for (const a of agents) {
      const key = a.spec ? displaySpecPath(a.spec, process.cwd()) : "No spec";
      if (!bySpec[key]) bySpec[key] = [];
      bySpec[key].push(a);
    }

    const specKeys = Object.keys(bySpec).filter(key => bySpec[key].length > 0);
    const sortedKeys = specKeys
      .filter(key => key !== "No spec")
      .sort((a, b) => a.localeCompare(b));
    if (bySpec["No spec"].length > 0) sortedKeys.push("No spec");

    for (const spec of sortedKeys) {
      lines.push(`${spec}:`);
      for (const a of bySpec[spec]) {
        const claim = agentClaims[a.name];
        const claimStr = claim ? claim.taskId : "(idle)";
        const time = formatRelativeTime(a.startedAt);
        lines.push(`  ${a.name.padEnd(14)} ${claimStr.padEnd(10)} ${a.model.padEnd(18)} ${time}`);
      }
      lines.push("");
    }
  } else {
    const mode = getDisplayMode(agents);
    if (mode === "same-folder-branch") {
      const folder = extractFolder(agents[0].cwd);
      const branch = agents.find(a => a.gitBranch)?.gitBranch;
      const header = branch ? `Peers in ${folder} (${branch}):` : `Peers in ${folder}:`;
      lines.push(header, "");

      for (const a of agents) {
        const time = formatRelativeTime(a.startedAt);
        lines.push(`  ${a.name.padEnd(14)} ${a.model.padEnd(20)} ${time}`);
        for (const res of formatReservations(a)) {
          lines.push(`                 ${res}`);
        }
      }
    } else if (mode === "same-folder") {
      const folder = extractFolder(agents[0].cwd);
      lines.push(`Peers in ${folder}:`, "");

      for (const a of agents) {
        const branch = a.gitBranch ?? "";
        const time = formatRelativeTime(a.startedAt);
        lines.push(`  ${a.name.padEnd(14)} ${branch.padEnd(12)} ${a.model.padEnd(20)} ${time}`);
        for (const res of formatReservations(a)) {
          lines.push(`                 ${res}`);
        }
      }
    } else {
      lines.push("Peers:", "");

      for (const a of agents) {
        const folder = extractFolder(a.cwd);
        const branch = a.gitBranch ?? "";
        const time = formatRelativeTime(a.startedAt);
        lines.push(`  ${a.name.padEnd(14)} ${folder.padEnd(20)} ${branch.padEnd(12)} ${a.model.padEnd(20)} ${time}`);
        for (const res of formatReservations(a)) {
          lines.push(`                 ${res}`);
        }
      }
    }
  }

  return result(
    lines.join("\n").trim(),
    { mode: "list", registered: true, agents, self: state.agentName, agentClaims }
  );
}

export function executeSend(
  state: MessengerState,
  dirs: Dirs,
  to: string | string[] | undefined,
  broadcast: boolean | undefined,
  message?: string,
  replyTo?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (!message) {
    return result(
      "Error: message is required when sending.",
      { mode: "send", error: "missing_message" }
    );
  }

  let recipients: string[];
  if (broadcast) {
    const agents = store.getActiveAgents(state, dirs);
    recipients = agents.map(a => a.name);
    if (recipients.length === 0) {
      return result(
        "No active agents to broadcast to.",
        { mode: "send", error: "no_recipients" }
      );
    }
  } else if (to) {
    recipients = [...new Set(Array.isArray(to) ? to : [to])];
    if (recipients.length === 0) {
      return result(
        "Error: recipient list cannot be empty.",
        { mode: "send", error: "empty_recipients" }
      );
    }
  } else {
    return result(
      "Error: specify 'to' or 'broadcast: true'.",
      { mode: "send", error: "missing_recipient" }
    );
  }

  const sent: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const recipient of recipients) {
    if (recipient === state.agentName) {
      failed.push({ name: recipient, error: "cannot send to self" });
      continue;
    }

    const validation = store.validateTargetAgent(recipient, dirs);
    if (!validation.valid) {
      const errorMap: Record<string, string> = {
        invalid_name: "invalid name",
        not_found: "not found",
        not_active: "no longer active",
        invalid_registration: "invalid registration",
      };
      const errKey = (validation as { valid: false; error: string }).error;
      failed.push({ name: recipient, error: errorMap[errKey] });
      continue;
    }

    try {
      store.sendMessageToAgent(state, dirs, recipient, message, replyTo);
      sent.push(recipient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "write failed";
      failed.push({ name: recipient, error: msg });
    }
  }

  if (sent.length === 0) {
    const failedStr = failed.map(f => `${f.name} (${f.error})`).join(", ");
    return result(
      `Failed to send: ${failedStr}`,
      { mode: "send", error: "all_failed", sent: [], failed }
    );
  }

  let text = `Message sent to ${sent.join(", ")}.`;
  if (failed.length > 0) {
    const failedStr = failed.map(f => `${f.name} (${f.error})`).join(", ");
    text += ` Failed: ${failedStr}`;
  }

  return result(text, { mode: "send", sent, failed });
}

export function executeReserve(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  patterns: string[],
  reason?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (patterns.length === 0) {
    return result(
      "Error: at least one pattern required.",
      { mode: "reserve", error: "empty_patterns" }
    );
  }

  const now = new Date().toISOString();

  for (const pattern of patterns) {
    state.reservations = state.reservations.filter(r => r.pattern !== pattern);
    state.reservations.push({ pattern, reason, since: now });
  }

  store.updateRegistration(state, dirs, ctx);

  return result(`Reserved: ${patterns.join(", ")}`, { mode: "reserve", patterns, reason });
}

export function executeRelease(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  release: string[] | true
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (release === true) {
    const released = state.reservations.map(r => r.pattern);
    state.reservations = [];
    store.updateRegistration(state, dirs, ctx);
    return result(
      released.length > 0 ? `Released all: ${released.join(", ")}` : "No reservations to release.",
      { mode: "release", released }
    );
  }

  const patterns = release;
  const before = state.reservations.length;
  state.reservations = state.reservations.filter(r => !patterns.includes(r.pattern));
  const releasedCount = before - state.reservations.length;

  store.updateRegistration(state, dirs, ctx);

  return result(`Released ${releasedCount} reservation(s).`, { mode: "release", released: patterns });
}

export function executeRename(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  deliverFn: (msg: AgentMailMessage) => void,
  updateStatusFn: (ctx: ExtensionContext) => void
) {
  store.stopWatcher(state);

  const renameResult = store.renameAgent(state, dirs, ctx, newName, deliverFn);

  if (!renameResult.success) {
    store.startWatcher(state, dirs, deliverFn);
    
    const errCode = (renameResult as { success: false; error: string }).error;
    const errorMessages: Record<string, string> = {
      not_registered: "Cannot rename - not registered.",
      invalid_name: `Invalid name "${newName}" - use only letters, numbers, underscore, hyphen.`,
      name_taken: `Name "${newName}" is already in use by another agent.`,
      same_name: `Already named "${newName}".`,
      race_lost: `Name "${newName}" was claimed by another agent.`,
    };
    return result(
      `Error: ${errorMessages[errCode]}`,
      { mode: "rename", error: errCode }
    );
  }

  state.watcherRetries = 0;
  store.startWatcher(state, dirs, deliverFn);
  updateStatusFn(ctx);

  return result(
    `Renamed from "${renameResult.oldName}" to "${renameResult.newName}".`,
    { mode: "rename", oldName: renameResult.oldName, newName: renameResult.newName }
  );
}

export function executeSetSpec(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  specPath: string
) {
  const absPath = resolveSpecPath(specPath, process.cwd());
  state.spec = absPath;
  store.updateRegistration(state, dirs, ctx);
  const display = displaySpecPath(absPath, process.cwd());
  const warning = existsSync(absPath) ? "" : `\n\nWarning: Spec file not found at ${display}.`;
  return result(`Spec set to ${display}${warning}`, { mode: "spec", spec: display });
}

export async function executeClaim(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  taskId: string,
  specPath?: string,
  reason?: string
) {
  const spec = specPath ? resolveSpecPath(specPath, process.cwd()) : state.spec;
  if (!spec) {
    return result(
      "Error: No spec registered. Use `spec` parameter or join with a spec first.",
      { mode: "claim", error: "no_spec" }
    );
  }

  const warning = specPath && !existsSync(spec)
    ? `\n\nWarning: Spec file not found at ${displaySpecPath(spec, process.cwd())}.`
    : "";

  const claimResult = await store.claimTask(
    dirs,
    spec,
    taskId,
    state.agentName,
    ctx.sessionManager.getSessionId(),
    process.pid,
    reason
  );

  const display = displaySpecPath(spec, process.cwd());
  if (store.isClaimSuccess(claimResult)) {
    return result(`Claimed ${taskId} in ${display}${warning}`, {
      mode: "claim",
      spec: display,
      taskId,
      claimedAt: claimResult.claimedAt,
      reason
    });
  }

  if (store.isClaimAlreadyHaveClaim(claimResult)) {
    const existingDisplay = displaySpecPath(claimResult.existing.spec, process.cwd());
    return result(
      `Error: You already have a claim on ${claimResult.existing.taskId} in ${existingDisplay}. Complete or unclaim it first.${warning}`,
      {
        mode: "claim",
        error: "already_have_claim",
        existing: { spec: existingDisplay, taskId: claimResult.existing.taskId }
      }
    );
  }

  // isClaimAlreadyClaimed
  return result(
    `Error: ${taskId} is already claimed by ${claimResult.conflict.agent}.${warning}`,
    { mode: "claim", error: "already_claimed", taskId, conflict: claimResult.conflict }
  );
}

export async function executeUnclaim(
  state: MessengerState,
  dirs: Dirs,
  taskId: string,
  specPath?: string
) {
  const spec = specPath ? resolveSpecPath(specPath, process.cwd()) : state.spec;
  if (!spec) {
    return result("Error: No spec registered.", { mode: "unclaim", error: "no_spec" });
  }

  const warning = specPath && !existsSync(spec)
    ? `\n\nWarning: Spec file not found at ${displaySpecPath(spec, process.cwd())}.`
    : "";

  const unclaimResult = await store.unclaimTask(dirs, spec, taskId, state.agentName);
  const display = displaySpecPath(spec, process.cwd());

  if (store.isUnclaimSuccess(unclaimResult)) {
    return result(`Released claim on ${taskId}${warning}`, { mode: "unclaim", spec: display, taskId });
  }

  if (store.isUnclaimNotYours(unclaimResult)) {
    return result(
      `Error: ${taskId} is claimed by ${unclaimResult.claimedBy}, not you.${warning}`,
      { mode: "unclaim", error: "not_your_claim", taskId, claimedBy: unclaimResult.claimedBy }
    );
  }

  // error === "not_claimed"
  return result(`Error: ${taskId} is not claimed.${warning}`, { mode: "unclaim", error: "not_claimed", taskId });
}

export async function executeComplete(
  state: MessengerState,
  dirs: Dirs,
  taskId: string,
  notes?: string,
  specPath?: string
) {
  const spec = specPath ? resolveSpecPath(specPath, process.cwd()) : state.spec;
  if (!spec) {
    return result("Error: No spec registered.", { mode: "complete", error: "no_spec" });
  }

  const warning = specPath && !existsSync(spec)
    ? `\n\nWarning: Spec file not found at ${displaySpecPath(spec, process.cwd())}.`
    : "";

  const completeResult = await store.completeTask(dirs, spec, taskId, state.agentName, notes);
  const display = displaySpecPath(spec, process.cwd());

  if (store.isCompleteSuccess(completeResult)) {
    return result(`Completed ${taskId} in ${display}${warning}`, {
      mode: "complete",
      spec: display,
      taskId,
      completedAt: completeResult.completedAt
    });
  }

  if (store.isCompleteAlreadyCompleted(completeResult)) {
    return result(
      `Error: ${taskId} was already completed by ${completeResult.completion.completedBy}.${warning}`,
      { mode: "complete", error: "already_completed", taskId, completion: completeResult.completion }
    );
  }

  if (store.isCompleteNotYours(completeResult)) {
    return result(
      `Error: ${taskId} is claimed by ${completeResult.claimedBy}, not you.${warning}`,
      { mode: "complete", error: "not_your_claim", taskId, claimedBy: completeResult.claimedBy }
    );
  }

  // error === "not_claimed"
  return result(`Error: ${taskId} is not claimed.${warning}`, { mode: "complete", error: "not_claimed", taskId });
}

export function executeSwarm(
  state: MessengerState,
  dirs: Dirs,
  specPath?: string
) {
  const claims = store.getClaims(dirs);
  const completions = store.getCompletions(dirs);
  const agents = store.getActiveAgents(state, dirs);
  const cwd = process.cwd();

  const absByDisplay = new Map<string, string>();
  const addAbs = (abs: string) => {
    const display = displaySpecPath(abs, cwd);
    if (!absByDisplay.has(display)) absByDisplay.set(display, abs);
  };

  for (const abs of Object.keys(claims)) addAbs(abs);
  for (const abs of Object.keys(completions)) addAbs(abs);
  if (state.spec) addAbs(state.spec);
  for (const agent of agents) {
    if (agent.spec) addAbs(agent.spec);
  }

  const specAgents: Record<string, string[]> = {};
  if (state.spec) {
    const display = displaySpecPath(state.spec, cwd);
    specAgents[display] = [state.agentName];
  }
  for (const agent of agents) {
    if (!agent.spec) continue;
    const display = displaySpecPath(agent.spec, cwd);
    if (!specAgents[display]) specAgents[display] = [];
    specAgents[display].push(agent.name);
  }

  const myClaim = store.getAgentCurrentClaim(dirs, state.agentName);
  const mySpec = state.spec ? displaySpecPath(state.spec, cwd) : undefined;

  if (specPath) {
    const absSpec = resolveSpecPath(specPath, cwd);
    const display = displaySpecPath(absSpec, cwd);
    const warning = !existsSync(absSpec)
      ? `\n\nWarning: Spec file not found at ${display}.`
      : "";
    const specClaims: SpecClaims = claims[absSpec] || {};
    const specCompletions: SpecCompletions = completions[absSpec] || {};
    const specAgentList = specAgents[display] || [];

    const lines = [`Swarm: ${display}`, ""];
    const completedIds = Object.keys(specCompletions);
    lines.push(`Completed: ${completedIds.length > 0 ? completedIds.join(", ") : "(none)"}`);

    const inProgress = Object.entries(specClaims).map(([tid, c]) =>
      `${tid} (${c.agent === state.agentName ? "you" : c.agent})`
    );
    lines.push(`In progress: ${inProgress.length > 0 ? inProgress.join(", ") : "(none)"}`);

    const teammates = specAgentList.filter(name => name !== state.agentName);
    if (teammates.length > 0) lines.push(`Teammates: ${teammates.join(", ")}`);

    return result(lines.join("\n") + warning, {
      mode: "swarm",
      spec: display,
      agents: specAgentList,
      claims: specClaims,
      completions: specCompletions
    });
  }

  const allSpecs = new Set<string>([
    ...absByDisplay.keys(),
    ...Object.keys(specAgents)
  ]);

  const lines = ["Swarm Status:", ""];
  const specsData: Record<string, { agents: string[]; claims: SpecClaims; completions: SpecCompletions }> = {};

  for (const display of Array.from(allSpecs).sort((a, b) => a.localeCompare(b))) {
    const absSpec = absByDisplay.get(display) ?? resolveSpecPath(display, cwd);
    const specClaims: SpecClaims = claims[absSpec] || {};
    const specCompletions: SpecCompletions = completions[absSpec] || {};
    const specAgentList = specAgents[display] || [];

    specsData[display] = { agents: specAgentList, claims: specClaims, completions: specCompletions };

    const isMySpec = display === mySpec;
    lines.push(`${display}${isMySpec ? " (your spec)" : ""}:`);

    const completedIds = Object.keys(specCompletions);
    lines.push(`  Completed: ${completedIds.length > 0 ? completedIds.join(", ") : "(none)"}`);

    const inProgress = Object.entries(specClaims).map(([tid, c]) =>
      `${tid} (${c.agent === state.agentName ? "you" : c.agent})`
    );
    lines.push(`  In progress: ${inProgress.length > 0 ? inProgress.join(", ") : "(none)"}`);

    const idle = specAgentList.filter(name =>
      !Object.values(specClaims).some(c => c.agent === name)
    );
    if (idle.length > 0) lines.push(`  Idle: ${idle.join(", ")}`);
    lines.push("");
  }

  return result(lines.join("\n").trim(), {
    mode: "swarm",
    yourSpec: mySpec,
    yourClaim: myClaim?.taskId,
    specs: specsData
  });
}

export function executeAutoRegisterPath(
  action: "add" | "remove" | "list"
) {
  const cwd = process.cwd();
  const paths = getAutoRegisterPaths();

  if (action === "list") {
    if (paths.length === 0) {
      return result(
        "No auto-register paths configured.\n\nUse pi_messenger({ autoRegisterPath: \"add\" }) to add the current folder.",
        { mode: "autoRegisterPath", action: "list", paths: [], currentFolder: cwd, isCurrentInList: false }
      );
    }
    
    const isCurrentInList = matchesAutoRegisterPath(cwd, paths);
    const lines = ["Auto-register paths:", ""];
    for (const p of paths) {
      const marker = p === cwd ? " (current)" : "";
      lines.push(`  ${p}${marker}`);
    }
    lines.push("");
    lines.push(`Current folder: ${cwd}`);
    lines.push(`Status: ${isCurrentInList ? "Will auto-register here" : "Will NOT auto-register here"}`);
    
    return result(lines.join("\n"), {
      mode: "autoRegisterPath",
      action: "list",
      paths,
      currentFolder: cwd,
      isCurrentInList
    });
  }

  if (action === "add") {
    if (paths.includes(cwd)) {
      return result(
        `Current folder already in auto-register paths:\n  ${cwd}`,
        { mode: "autoRegisterPath", action: "add", alreadyExists: true, path: cwd }
      );
    }
    
    const newPaths = [...paths, cwd];
    saveAutoRegisterPaths(newPaths);
    
    return result(
      `Added to auto-register paths:\n  ${cwd}\n\nAgents starting in this folder will now auto-join the mesh.`,
      { mode: "autoRegisterPath", action: "add", path: cwd, paths: newPaths }
    );
  }

  if (action === "remove") {
    if (!paths.includes(cwd)) {
      // Check if it matches via glob but isn't exact
      const isMatched = matchesAutoRegisterPath(cwd, paths);
      if (isMatched) {
        return result(
          `Current folder matches a glob pattern but isn't an exact entry.\nManually edit ~/.pi/agent/pi-messenger.json to modify glob patterns.`,
          { mode: "autoRegisterPath", action: "remove", notExact: true, path: cwd }
        );
      }
      return result(
        `Current folder not in auto-register paths:\n  ${cwd}`,
        { mode: "autoRegisterPath", action: "remove", notFound: true, path: cwd }
      );
    }
    
    const newPaths = paths.filter(p => p !== cwd);
    saveAutoRegisterPaths(newPaths);
    
    return result(
      `Removed from auto-register paths:\n  ${cwd}\n\nAgents starting in this folder will no longer auto-join.`,
      { mode: "autoRegisterPath", action: "remove", path: cwd, paths: newPaths }
    );
  }

  return result("Invalid action. Use: add, remove, or list", { mode: "autoRegisterPath", error: "invalid_action" });
}
