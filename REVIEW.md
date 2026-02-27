# Pi-Messenger Technical Review

## Overview

Pi-messenger is a **daemonless, file-based agent mesh** that enables autonomous AI agents to discover each other, exchange messages, coordinate file ownership, and execute multi-agent work plans — all without a server, database, or network layer. Every operation is implemented as atomic filesystem I/O under a shared directory (`~/.pi/agent/messenger/`), using JSON files for state and `fs.watch()` for event-driven delivery.

---

## 1. Filesystem Layout

All coordination state lives under two roots:

| Root | Path | Scope |
|------|------|-------|
| **Global** | `~/.pi/agent/messenger/` | Cross-project agent registry and inboxes |
| **Project** | `{cwd}/.pi/messenger/` | Activity feed, crew plans, and task files |

Global directory structure:

```
~/.pi/agent/messenger/
├── registry/
│   └── {AgentName}.json        # Agent presence records
├── inbox/
│   └── {AgentName}/
│       └── {timestamp}-{rand}.json  # Pending messages
├── claims.json                 # Task ownership map
├── completions.json            # Completed task records
└── swarm.lock                  # Distributed lock file
```

Project directory structure:

```
{cwd}/.pi/messenger/
├── feed.jsonl                  # Append-only activity timeline
└── crew/
    ├── plan.json               # Plan metadata
    ├── plan.md                 # Full plan spec
    ├── tasks/
    │   ├── task-{N}.json       # Task metadata
    │   ├── task-{N}.md         # Task specification
    │   └── task-{N}.progress.md
    ├── blocks/
    │   └── task-{N}.md         # Block context notes
    └── artifacts/              # Worker execution logs (optional)
```

---

## 2. Agent Registration & Discovery

### Registration (`store.ts:285-416`)

On startup an agent:

1. Generates a memorable name from themed word lists (e.g. "SwiftRaven", "LunarDust") via `generateMemorableName()` (`lib.ts:265-297`).
2. Writes a JSON registration file to `registry/{name}.json`.
3. Verifies ownership by reading back the file and checking PID.
4. Creates a personal inbox directory at `inbox/{name}/`.

The registration record (`AgentRegistration`, `lib.ts:30-44`) captures:

| Field | Purpose |
|-------|---------|
| `name` | Agent identity |
| `pid` | OS process ID for liveness checks |
| `sessionId` | Session identifier for identity change detection |
| `cwd` | Working directory |
| `model` | LLM model in use |
| `gitBranch` | Current branch |
| `isHuman` | Whether this is a human-driven session |
| `reservations[]` | File/directory claims |
| `session` | Cumulative stats: tool calls, tokens, files modified |
| `activity` | Last activity timestamp, current task description |
| `statusMessage` | Custom or auto-generated status string |

### Discovery (`store.ts:167-253`)

`getActiveAgents()` reads all JSON files in `registry/`, validates each PID with `kill(pid, 0)`, prunes dead entries, and returns the live agent list. Results are cached with a **1-second TTL** to limit disk I/O. An optional `scopeToFolder` filter restricts visibility to agents sharing the same working directory.

### Liveness

`isProcessAlive()` (`lib.ts:299-306`) sends signal 0 to the PID. Dead registrations are cleaned up automatically during discovery and claim operations.

---

## 3. Messaging

### Message Format (`AgentMailMessage`, `lib.ts:46-53`)

```typescript
{
  id: string;          // UUID
  from: string;        // Sender agent name
  to: string;          // Recipient agent name
  text: string;        // Message body
  timestamp: string;   // ISO-8601
  replyTo: string | null;  // Threading via parent message ID
}
```

### Send Path

1. **Handler** — `executeSend()` (`handlers.ts:258-381`) validates the target, enforces a per-coordination-level message budget, and calls `sendMessageToAgent()`.
2. **Write** — `sendMessageToAgent()` (`store.ts:996-1020`) creates a JSON file at `inbox/{recipient}/{timestamp}-{random}.json` using an atomic temp-file-then-rename pattern.
3. **Broadcast** — When `broadcast: true`, the sender iterates all active agents and drops a file into each inbox.

### Receive Path

1. **Watch** — `startWatcher()` (`store.ts:1026-1090`) attaches `fs.watch()` to the agent's inbox directory with a **50 ms debounce** to coalesce rapid filesystem events.
2. **Process** — `processAllPendingMessages()` (`store.ts:942-994`) reads all `.json` files sorted by filename (timestamp order), parses each, invokes the delivery callback, and deletes the file. A re-entrant guard with pending flag prevents concurrent processing.
3. **Deliver** — `deliverMessage()` (`index.ts:122-177`) stores the message in a circular chat history buffer (max 50 per sender), increments the sender's unread count, optionally injects sender context on first contact (location, branch, model), and calls `pi.sendMessage()` with `triggerTurn: true` and `deliverAs: "steer"` to nudge the receiving agent into a new turn.

### Watcher Resilience

If the filesystem watcher fails, it retries with exponential backoff: `min(1000 * 2^(retries-1), 30000)` ms, up to `MAX_WATCHER_RETRIES` (5) attempts.

---

## 4. File Reservations

Agents can claim ownership of files or directories to prevent edit conflicts.

### Reserve / Release (`handlers.ts:383-450`)

`executeReserve()` appends `FileReservation` entries (pattern + reason + timestamp) to the agent's registration. `executeRelease()` removes them. Both update the registry on disk immediately.

### Enforcement (`index.ts:1039-1061`)

A `tool_call` hook intercepts every `edit` and `write` operation. `getConflictsWithOtherAgents()` checks the target path against all other agents' reservations using `pathMatchesReservation()` (`lib.ts:324-329`). On conflict the hook returns `{ block: true }` with a message identifying the conflicting agent, their location, and branch.

---

## 5. Activity Feed (`feed.ts`)

An append-only JSONL file at `{cwd}/.pi/messenger/feed.jsonl` logs agent activity.

### Event Types (26 total, `feed.ts:10-36`)

| Category | Types |
|----------|-------|
| **Mesh** | `join`, `leave`, `message`, `reserve`, `release` |
| **Development** | `commit`, `test`, `edit` |
| **Tasks** | `task.start`, `task.done`, `task.block`, `task.unblock`, `task.reset`, `task.delete`, `task.split`, `task.revise`, `task.revise-tree` |
| **Planning** | `plan.start`, `plan.pass.start`, `plan.pass.done`, `plan.review.start`, `plan.review.done`, `plan.done`, `plan.cancel`, `plan.failed` |
| **Status** | `stuck` |

Each event carries: `ts`, `agent`, `type`, and optional `target` / `preview` fields. Feed retention defaults to 50 events, pruned by `pruneFeed()`.

---

## 6. Status & Heartbeat

### Heartbeat (`index.ts:295`)

Every **15 seconds** `updateStatus()` flushes the agent's current state to its registry file — session stats (tokens, tool calls, files modified), activity timestamps, computed status, and auto-generated status message.

### Computed Status (`lib.ts:120-146`)

| Status | Condition |
|--------|-----------|
| **active** | Last activity < 30 s ago |
| **idle** | Last activity 30 s – 5 min ago |
| **away** | Last activity > 5 min ago, no active task |
| **stuck** | Last activity > `stuckThreshold` (default 900 s) |

### Auto-Status (`lib.ts:172-200`)

Contextual messages generated from recent activity:

- "just arrived" (session < 30 s old)
- "just shipped" (recent commit)
- "debugging..." (3+ recent test runs)
- "on fire" (8+ recent edits)
- "exploring the codebase" (reading files, no edits)

---

## 7. Distributed Locking (`store.ts:103-157`)

Swarm-level operations (task claims, unclaims, completions) are serialized through a filesystem lock.

| Parameter | Value |
|-----------|-------|
| Lock file | `~/.pi/agent/messenger/swarm.lock` |
| Creation | `O_CREAT \| O_EXCL \| O_RDWR` (atomic) |
| Content | Holder's PID |
| Stale timeout | 10 s (verified via PID liveness) |
| Retry | 50 attempts, 100 ms apart (~5 s total) |

`withSwarmLock(baseDir, fn)` acquires the lock, executes the callback, and releases it in a `finally` block. Stale locks from dead processes are cleaned up before retry.

---

## 8. Task Claims & Completions

### Data Model

Claims are stored in `claims.json` keyed by spec path and task ID. Each `ClaimEntry` (`lib.ts:94-100`) records the agent name, session ID, PID, timestamp, and optional reason.

### Operations (all wrapped in `withSwarmLock`)

| Operation | Location | Behavior |
|-----------|----------|----------|
| `claimTask()` | `store.ts:789-826` | Validates no existing claim; prevents double-claim by same agent; writes entry |
| `unclaimTask()` | `store.ts:840-867` | Verifies ownership; removes entry |
| `completeTask()` | `store.ts:885-932` | Verifies ownership; moves entry from claims to completions |

Stale claims from dead processes are pruned on every read (`store.ts:700-730`).

---

## 9. Crew: Multi-Agent Work Plans

### Plan Lifecycle (`crew/store.ts`)

1. **Create** — `createPlan()` writes `plan.json` metadata and `plan.md` spec.
2. **Tasks** — `createTask()` generates `task-{N}.json` + `task-{N}.md` with dependency graph.
3. **Execute** — `getReadyTasks()` returns todos whose dependencies are all done. Workers claim and start tasks.
4. **Review** — Completed tasks receive a `ReviewVerdict`: `SHIP`, `NEEDS_WORK`, or `MAJOR_RETHINK`.
5. **Complete** — `completeTask()` records summary and evidence (commits, tests, PRs). Milestones auto-complete when all dependencies resolve.

### Dependency Graph

- Tasks declare `depends_on: string[]` linking to other task IDs.
- `getReadyTasks()` (`crew/store.ts:449-464`) filters for todos with all deps in `done` status.
- `autoCompleteMilestones()` (`crew/store.ts:466-490`) iteratively completes milestone tasks when their children finish.
- Validation checks for circular dependencies (recursive DFS) and orphan references.

### Worker Spawning (`crew/agents.ts`)

Workers are spawned as subprocess `pi` instances:

```
pi --mode json --no-session -p [task prompt] [--provider X --model Y]
```

| Aspect | Detail |
|--------|--------|
| **Concurrency** | Configurable; queue-based with dynamic limit adjustment |
| **Environment** | `PI_CREW_WORKER=1`, `PI_AGENT_NAME={name}` |
| **Progress** | Streamed as JSONL events on stdout |
| **System prompt** | Passed via `--append-system-prompt` temp file |
| **Artifacts** | Input prompt, full output, JSONL stream, execution metadata |

### Graceful Shutdown (`crew/agents.ts:365-415`)

1. Steer message delivered to worker inbox with wrap-up instructions.
2. Wait `shutdownGracePeriodMs` (default 30 s) for voluntary exit.
3. `SIGTERM` with 5 s grace.
4. `SIGKILL` as last resort.

---

## 10. Configuration (`config.ts`)

Configuration is loaded with cascading priority:

1. **Project** — `.pi/pi-messenger.json`
2. **Extension** — `~/.pi/agent/pi-messenger.json`
3. **Settings** — `~/.pi/agent/settings.json` → `"messenger"` key
4. **Defaults**

Key options:

| Option | Default | Purpose |
|--------|---------|---------|
| `autoRegister` | `false` | Join mesh on session start |
| `autoRegisterPaths` | `[]` | Folder glob patterns for auto-join |
| `scopeToFolder` | `false` | Restrict peer visibility to same cwd |
| `nameTheme` | `"default"` | Name generation theme (nature, space, minimal, custom) |
| `feedRetention` | `50` | Max feed events |
| `stuckThreshold` | `900` | Seconds before stuck status |
| `autoStatus` | `true` | Generate contextual status messages |
| `autoOverlay` | `true` | Open overlay during crew work |
| `crewEventsInFeed` | `true` | Include planning/task events in feed |

---

## 11. Concurrency & Safety Summary

| Concern | Mechanism |
|---------|-----------|
| **Atomic writes** | Temp file + `rename()` (POSIX atomic) |
| **Distributed lock** | `O_CREAT \| O_EXCL` on `swarm.lock` with PID-based stale detection |
| **Message ordering** | Timestamp-prefixed filenames, sorted before processing |
| **Concurrent delivery** | Re-entrant guard flag with pending re-entry queue |
| **Watcher reliability** | Exponential backoff retry (50 ms debounce, 5 retries, 30 s cap) |
| **Dead agent cleanup** | PID liveness check on every registry read and claim operation |
| **File conflict prevention** | Reservation enforcement via `tool_call` hook |

---

## 12. Key Source Files

| File | Lines | Responsibility |
|------|-------|---------------|
| `index.ts` | ~1060 | Extension entry, registration, message delivery, hooks, overlay lifecycle |
| `store.ts` | ~1125 | Registry, inbox, watcher, locking, claims, messaging I/O |
| `lib.ts` | ~415 | Type definitions, status computation, name generation, utilities |
| `handlers.ts` | ~990 | Tool action handlers (send, reserve, claim, status, feed, rename) |
| `feed.ts` | ~195 | Activity feed types, append/read/prune, formatting |
| `config.ts` | ~95 | Configuration loading and merging |
| `crew/types.ts` | ~166 | Plan, task, review, and spawning type definitions |
| `crew/store.ts` | ~605 | Plan and task CRUD, dependency resolution, validation |
| `crew/agents.ts` | ~415 | Worker spawning, concurrency, graceful shutdown |
| `crew/registry.ts` | — | In-memory worker lifecycle tracking |
| `crew/lobby.ts` | — | Pre-spawned idle worker management |
