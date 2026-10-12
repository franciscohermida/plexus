---
name: plexus
description: Manage the user's plexus graph of Claude Code sessions. Use when the user mentions plexus or nodes, asks to create, bind, move or retire a session node, to wake a closed session, or whether to split work across sessions or workers.
---

plexus lays a graph over the user's Claude Code sessions. The session stays the unit of work; the graph only says what each session is for and who it talks to. A session bound to a node already reads its place in its system prompt; this skill is for arranging the graph itself.

## Words

- **node**: a role in the graph (`nexus`, `play`, `adventure`). Ids are letters, digits, `-_.`, with `/` allowed. A path id (`play/adventure`) implies its parent; a flat id declares one.
- **binding**: which session holds a node. One session per node; plexus finds the session by id, never by name, so session names are the user's to choose.
- **head**: a node marked `head: true`; the nodes beneath it escalate to it. Its subtree is a cluster.
- **link**: a standing reason to talk across the tree: `from` (a node, `prefix/*` or `*`) reports to `to` about `when`.
- **mailbox**: where a message waits while its node has no open session. The next session bound to the node, or a woken one, gets it as a turn.
- **worker**: a throwaway background session started for one task. It stays out of the graph, reports to the session that started it, and is removed when done.

## The files

Everything is plain JSON under `~/.claude/plexus/`: `graph.json` (the graph, read on every use, so edits apply at each session's next turn with no reload), `sessions/<node>.json` (bindings; `/` in an id becomes `~`), `mail/<node>/` (one file per waiting message). The plugin's README documents the graph format.

## Arranging the graph

- **Create a node's session**: the user opens one in their editor and runs `/node <id>`, or, when the user asks, start one in the background from the project folder: `claude --bg "/node <id>"` (add `--name` only if the user wants one; plexus never names sessions). Background sessions show in the Desktop app and in `claude agents`, not in the VS Code extension. A background session waits silently on any startup dialog (folder trust, a project's new MCP server): start it in a folder the user already works in, and if `claude logs <id>` shows a dialog, ask the user to answer it with `claude attach <id>`.
- **Bind**: `/node <id>` in the session itself. A session holds one node; binding again moves it.
- **Move or describe**: edit `graph.json`: set `parent`, `head`, `brief`, or add a link. Prefer flat ids with a declared `parent`, so a move changes one field and the binding stays.
- **Retire**: remove the node from `graph.json` and delete its `sessions/` file. Its transcript stays resumable.
- **Show**: `mcp__plexus__graph`, or the user's `/graph`.

Read `graph.json` before editing it and keep the user's briefs word for word; they are the user's.

## Waking a closed node

`/wake <id>` resumes the node's last session in the background, where it reads its waiting mail. Each wake spends usage, so it is the user's call: ask them to run it. `mcp__plexus__wake` does the same for you only where the user has added an allow rule for it. A node whose session moved to another node, or that no session has held, can't be woken; offer to open or start a session for it instead.

## Sessions, workers or subagents

When the user asks whether to split work, judge by how long each part needs its own context:

- **Ongoing node**: a stream of work the user returns to over days (an app, a project, a person's admin). Lives in the graph.
- **Worker**: a self-contained task that needs a long context of its own but no future: start it with `claude --bg "<task>. When done, send the result to the plexus node <this session's node> with mcp__plexus__send."` (an unbound worker can still send; its report names it as unbound), keep it out of `graph.json`, and when its report arrives, `claude stop <id>` and `claude rm <id>`.
- **Subagent**: a short task whose result fits in a reply. Use the Agent tool; no session needed.

Start sessions or workers only after the user agrees: each one runs on the user's usage.
