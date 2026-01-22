<p>
  <img src="banner.png" alt="pi-messenger" width="1100">
</p>

# Pi Messenger

**Multi-agent coordination for pi. No daemon, no server, just files.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)]()

```typescript
pi_messenger({ join: true, spec: "./auth-spec.md" })
pi_messenger({ claim: "TASK-01", reason: "Implementing login flow" })
pi_messenger({ to: "GoldFalcon", message: "Done with auth, it's yours" })
```

## Why

Running multiple pi instances on the same codebase leads to chaos. One agent rewrites a file while another is mid-edit. Neither knows the other exists.

Pi Messenger fixes this with four primitives:

**Discovery** - Agents register with memorable names (SwiftRaven, IronKnight) when they join the mesh. See who's active, what they're working on, which model they're using, and which git branch they're on.

**Messaging** - Send messages between agents. Recipients wake up immediately (even if idle) and see the message as a steering prompt. Coordinate handoffs, ask questions, broadcast status.

**File Reservations** - Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases when you exit.

**Swarm Coordination** - Multiple agents work on the same spec file. Claim tasks atomically, mark them complete with notes, see who's doing what. No double work, no stepping on toes.

## Comparison

| Feature | Pi Messenger | Shared Context Files | Manual Coordination |
|---------|--------------|---------------------|---------------------|
| Agent discovery | Automatic | Manual | None |
| Real-time messaging | Yes (file watcher) | No | Chat app |
| File conflict prevention | Reservations | Hope | Yelling |
| Task claiming | Atomic locks | First-come conflicts | Spreadsheet |
| Setup required | None | Write conventions | Write conventions |
| Daemon/server | No | No | No |

## Install

Already in your extensions directory. Restart pi to activate:

```
~/.pi/agent/extensions/pi-messenger/
```

After joining the mesh, your agent name appears in the status bar:

```
msg: SwiftRaven (2 peers) ●3
```

## Quick Start

```typescript
// Join the agent mesh with a spec to work on
pi_messenger({ join: true, spec: "./tasks.md" })
// → "Joined as SwiftRaven in backend on main. 2 peers active."

// See swarm status - who's claimed what
pi_messenger({ swarm: true })

// Claim a task (one claim per agent at a time)
pi_messenger({ claim: "TASK-01", reason: "Implementing auth" })

// Complete the task with notes
pi_messenger({ complete: "TASK-01", notes: "Added JWT validation" })

// Send a message
pi_messenger({ to: "GoldFalcon", message: "Auth module ready for review" })

// Broadcast to all
pi_messenger({ broadcast: true, message: "Taking the API routes" })

// Reserve files
pi_messenger({ reserve: ["src/auth/"], reason: "Refactoring" })

// Release when done
pi_messenger({ release: true })
```

**Note:** The `/messenger` command auto-joins when opened.

## Swarm Coordination

When multiple agents work on the same spec, they can coordinate via atomic task claiming:

```typescript
// Join with a spec file
pi_messenger({ join: true, spec: "./feature-spec.md" })

// See what's claimed and completed
pi_messenger({ swarm: true })
// → Swarm: ./feature-spec.md
//   Completed: TASK-01, TASK-02
//   In progress: TASK-03 (you), TASK-04 (GoldFalcon)
//   Teammates: GoldFalcon, IronKnight

// Claim a task (fails if someone else has it)
pi_messenger({ claim: "TASK-05" })

// Release without completing (changed your mind)
pi_messenger({ unclaim: "TASK-05" })

// Mark complete with notes
pi_messenger({ complete: "TASK-05", notes: "Added error handling" })
```

**Rules:**
- One claim per agent at a time (complete or unclaim before claiming another)
- Claims are atomic (lock-protected, no double-claims)
- Stale claims auto-cleanup when agents die (PID check)
- Completions are permanent and include who completed them

The overlay's Agents tab groups agents by spec and shows current claims.

## Features

### Adaptive Agent Display

Output adapts based on where agents are working:

| Context | Display |
|---------|---------|
| Same folder + branch | Compact: name, model, time |
| Same folder, different branches | Adds branch per agent |
| Different folders | Adds folder per agent |
| Working on specs | Groups by spec, shows claims |

### File Reservation Enforcement

When another agent tries to edit reserved files:

```
src/auth/login.ts
Reserved by: SwiftRaven (in backend on main)
Reason: "Refactoring authentication"

Coordinate via pi_messenger({ to: "SwiftRaven", message: "..." })
```

### Immediate Message Delivery

Recipients see messages instantly, even if idle. Messages arrive as steering prompts that wake the agent:

```
**Message from SwiftRaven** — reply: pi_messenger({ to: "SwiftRaven", message: "..." })

Auth module is ready for review
```

### Chat Overlay

`/messenger` opens an interactive chat UI:

```
╭─ Messenger ── SwiftRaven ── 2 peers ────────────────╮
│ ▸ Agents │ ● GoldFalcon │ ● IronKnight (1) │ + All  │
│─────────────────────────────────────────────────────│
│ ./feature-spec.md:                                  │
│   SwiftRaven (you)   TASK-03    Implementing auth   │
│   GoldFalcon         TASK-04    API endpoints       │
│   IronKnight         (idle)                         │
│                                                     │
│ No spec:                                            │
│   QuickOwl           (idle)                         │
│─────────────────────────────────────────────────────│
│ > Agents overview                    [Tab] [Enter]  │
╰─────────────────────────────────────────────────────╯
```

## Keys

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch agent tabs |
| `↑` `↓` | Scroll message history |
| `Home` / `End` | Jump to oldest / newest |
| `Enter` | Send message |
| `Esc` | Close overlay |

## Tool Reference

```typescript
pi_messenger({
  // Registration
  join?: boolean,              // Join the agent mesh (required first)
  spec?: string,               // Spec file to work on (with join or standalone)

  // Swarm coordination
  swarm?: boolean,             // Get swarm status (all specs or one with spec param)
  claim?: string,              // Claim a task in your spec
  unclaim?: string,            // Release a claim without completing
  complete?: string,           // Mark task complete
  notes?: string,              // Completion notes (with complete)

  // Messaging
  to?: string | string[],      // Recipient(s)
  broadcast?: boolean,         // Send to all
  message?: string,            // Message text
  replyTo?: string,            // Message ID for threading

  // Reservations
  reserve?: string[],          // Paths (trailing / for directories)
  reason?: string,             // Why reserving (or claiming)
  release?: string[] | true,   // Release specific or all

  // Other
  rename?: string,             // Change your name
  list?: boolean,              // List active agents
})
```

**Mode priority:** `join` → `swarm` → `claim` → `unclaim` → `complete` → `spec` → `to/broadcast` → `reserve` → `release` → `rename` → `list` → status

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_AGENT_NAME` | Explicit name (fails if taken) | Auto-generated |
| `PI_MESSENGER_DIR` | Custom data directory | `~/.pi/agent/messenger` |

```bash
PI_AGENT_NAME=AuthWorker pi
PI_AGENT_NAME=APIWorker pi
```

### Config Files

Priority (highest to lowest):
1. `.pi/pi-messenger.json` (project)
2. `~/.pi/agent/pi-messenger.json` (global)
3. `~/.pi/agent/settings.json` → `"messenger"` key

```json
{
  "autoRegister": false,
  "autoRegisterPaths": [
    "~/projects/team-collab",
    "~/.pi/agent/extensions/web-search"
  ],
  "scopeToFolder": true,
  "contextMode": "full",
  "registrationContext": true,
  "replyHint": true,
  "senderDetailsOnFirstContact": true
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `autoRegister` | Join mesh on startup (global) | `false` |
| `autoRegisterPaths` | Paths where auto-register is enabled | `[]` |
| `scopeToFolder` | Only see agents in same directory | `false` |
| `contextMode` | `"full"` / `"minimal"` / `"none"` | `"full"` |
| `registrationContext` | Orientation message on join | `true` |
| `replyHint` | Include reply syntax in messages | `true` |
| `senderDetailsOnFirstContact` | Show sender's cwd/model first time | `true` |

**Path-based auto-register**: Instead of global auto-register, specify folders where agents should auto-join. Supports `~` expansion and glob patterns (`~/work/*` matches any subfolder).

**Folder scoping**: When `scopeToFolder: true`, agents only see other agents in the same working directory. Broadcasts are scoped, but direct messaging by name still works across folders. Useful when running multiple projects simultaneously.

### Managing Auto-Register Paths

**Via tool (for agents):**
```typescript
pi_messenger({ autoRegisterPath: "add" })     // Add current folder
pi_messenger({ autoRegisterPath: "remove" })  // Remove current folder
pi_messenger({ autoRegisterPath: "list" })    // Show all paths
```

**Via TUI (for users):**
```
/messenger config
```
Opens an overlay to add/remove paths with keyboard navigation (`a` to add, `d` to delete, arrows to navigate).

## How It Works

```
~/.pi/agent/messenger/
├── registry/
│   ├── SwiftRaven.json     # name, PID, cwd, model, branch, spec, reservations
│   └── GoldFalcon.json
├── inbox/
│   ├── SwiftRaven/         # incoming messages
│   └── GoldFalcon/
├── claims.json             # active task claims by spec
├── completions.json        # completed tasks by spec
└── swarm.lock              # atomic lock for claim/complete operations
```

**Registration** - Agents write JSON with PID, sessionId, cwd, model, git branch, spec. Write-then-verify prevents race conditions. Dead PIDs detected and cleaned up.

**Messaging** - Sender writes to recipient's inbox. File watcher triggers immediate delivery as steering message.

**Reservations** - Stored in registration. Checked on `tool_call` events before file operations.

**Swarm** - Claims and completions stored in shared JSON files. All mutations go through `swarm.lock` using atomic `O_CREAT | O_EXCL`. Stale claims cleaned up when owning PID is dead.

**Cleanup** - Clean exit deletes registration. Crash detection via PID check.

## Limitations

- **Same-machine only** - File-based, no network
- **Literal path matching** - `src/auth/` won't match `/absolute/path/src/auth/`
- **Brief rename window** - Messages during rename (ms) may be lost
- **No persistence** - Messages deleted after delivery
- **Spec not parsed** - Task IDs are user-defined strings, not extracted from spec files

## License

MIT
