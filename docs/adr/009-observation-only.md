# 009 — Agent Office is observation-only

- Status: Accepted (2026-10-03)
- Supersedes: 003 (control plane ↔ runtime dispatch channel), 007 (agent-owned
  files and the Claude Code discovery bridge), 008 (run sandbox). Retires the
  Project/Task/AgentDefinition model of 001, 002, 004, 005 from the running
  product; 006 (SQLite) stays, for the call log only.

## Context

Agent Office set out to own Projects, Agents, Tasks, Skills and Knowledge and
to dispatch work to Claude Code. In practice the person creates and runs their
agents in Claude Code, each agent keeps its own instructions, memory and
outputs, and the useful part of Office was the pixel office plus the Agent
list, detail and call history built on top of observation
(`claude/cc-task-dashboard` @ `e2100f2`). The management and dispatch code
stayed reachable behind the UI, its boot path migrated agent files and wrote
discovery links into `~/.claude/agents`, and tests leaked junctions there.

## Decision

Office only observes:

- No dispatch, cancel, resume, review/accept, or editing of agent
  instructions/skills/knowledge. The `office*` protocol messages, the
  `runtime/` package, `domain/`, and the management storage are removed.
- Opening storage backs the database up before any schema migration, adds
  the observation columns (migration 5), and never deletes old tables or the
  old `agents/`, `blobs/`, `runtime/` directories.
- Agents and shown skills are discovered automatically from Claude Code's own
  definition files (user scope + configured project roots). Discovery
  settings are Office's own file; skills are opt-in by name.
- Activity is derived only from hooks, transcripts and an agent's existing run
  records, read-only. Every status change records its evidence; without a
  reliable signal the status is `unknown`.
- New call rows store a one-line summary, never the full prompt.
- The VS Code surface no longer launches, auto-spawns or disposes terminals.

## Consequences

- Adding an agent never needs an Office change; adding a new invocation
  _shape_ (not a new agent) still needs a parser/adapter change, or the
  optional shared status report.
- The VS Code e2e suite starts `claude` in a terminal itself instead of via
  "+ Agent".
- Old data stays on disk and in the backup; reading it again needs an older
  build.
