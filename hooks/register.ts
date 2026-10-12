import type { EngineInterface, Register } from 'claude-code'
import { type Binding, type Graph, isNodeId, parseGraph, emptyGraph, placeText, relation, treeText } from './graph.ts'

// plexus: Claude Code sessions as nodes of a graph the user arranges.
//
// The graph says what nodes exist and who reports to whom; bindings say which
// session holds which node; mail waits for nodes with no open session.
// Delivery to an open session is Claude Code's own cross-session messaging.
//
// Everything lives in files under <claude config dir>/plexus, not `$.store`:
// the store is kept per plugin id, so a development copy and an installed copy
// would each see half the graph. Files are also readable by anything else.
//
//   graph.json                       the graph: the user's; plexus only adds a missing node
//   sessions/<node>.json             which session holds the node
//   mail/<node>/<time>-<rand>.json   one file per message for a node with no open session
//   mail/<node>/delivered.json       the files already delivered, written by the node's session
//
// `$` may only be passed to functions in this file, so the file helpers live
// here; graph.ts holds what needs no `$`.

type Mail = { from: string; relation?: string; text: string; at: number }

/** `play/adventure` → `play~adventure`. Ids are checked by `isNodeId`, so nothing else needs escaping. */
const fileName = (node: string) => node.replace(/\//g, '~')
const nodeName = (file: string) => file.replace(/\.json$/, '').replace(/~/g, '/')

async function root($: EngineInterface): Promise<string> {
  const dir =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ??
    ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')))?.concat('/.claude')
  if (!dir) throw new Error('plexus: neither CLAUDE_CONFIG_DIR, USERPROFILE nor HOME is set')
  return `${dir.replace(/\\/g, '/')}/plexus`
}

async function readJson<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  if (!(await $.fs.exists(path))) return fallback
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch (error) {
    $.ui.log(`plexus: ${path} is not valid JSON (${String(error)})`)
    return fallback
  }
}

const writeJson = ($: EngineInterface, path: string, value: unknown) =>
  $.fs.write(path, JSON.stringify(value, null, 2) + '\n')

async function readGraph($: EngineInterface): Promise<Graph> {
  const path = `${await root($)}/graph.json`
  if (!(await $.fs.exists(path))) return emptyGraph()
  try {
    return parseGraph(await $.fs.read(path))
  } catch (error) {
    $.ui.log(`plexus: ${path} is not valid JSON (${String(error)}); reading it as empty until it's fixed`)
    return emptyGraph()
  }
}

/**
 * Adds a node the graph file doesn't declare, so the user sees it there. Edits
 * the file's own object, keeping every key, and never writes over a file it
 * couldn't parse: a hand edit in progress is the user's.
 */
async function declareNode($: EngineInterface, node: string): Promise<void> {
  const path = `${await root($)}/graph.json`
  let raw: { nodes?: Record<string, unknown>; [key: string]: unknown } = { nodes: {}, links: [] }
  if (await $.fs.exists(path)) {
    try {
      raw = JSON.parse(await $.fs.read(path))
    } catch {
      $.ui.log(`plexus: ${path} doesn't parse, so \`${node}\` wasn't added to it`)
      return
    }
  }
  if (raw.nodes?.[node]) return
  await writeJson($, path, { ...raw, nodes: { ...raw.nodes, [node]: {} } })
}

async function readBindings($: EngineInterface): Promise<Record<string, Binding>> {
  const dir = `${await root($)}/sessions`
  if (!(await $.fs.exists(dir))) return {}
  const found: Record<string, Binding> = {}
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const b = await readJson<Binding | undefined>($, `${dir}/${entry.name}`, undefined)
    if (b?.sessionId) found[nodeName(entry.name)] = b
  }
  return found
}

async function writeBinding($: EngineInterface, node: string, binding: Binding): Promise<void> {
  await writeJson($, `${await root($)}/sessions/${fileName(node)}.json`, binding)
}

/** The node a session holds; when two files name it, the latest bind wins. */
function nodeOf(bindings: Record<string, Binding>, sessionId: string | undefined): string | undefined {
  return Object.entries(bindings)
    .filter(([, b]) => b.sessionId === sessionId && !b.endedAt)
    .sort(([, a], [, b]) => b.boundAt - a.boundAt)[0]?.[0]
}

/** Session ids running on this machine, from `claude agents --json`; undefined when it can't be read. */
async function liveSessions($: EngineInterface): Promise<Set<string> | undefined> {
  try {
    const ran = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 15_000 })
    if (ran.exitCode !== 0) return undefined
    return new Set((JSON.parse(ran.stdout) as { sessionId?: string }[]).flatMap(s => (s.sessionId ? [s.sessionId] : [])))
  } catch {
    return undefined
  }
}

async function leaveMail($: EngineInterface, node: string, mail: Mail): Promise<void> {
  const id = `${mail.at}-${Math.random().toString(36).slice(2, 8)}`
  await writeJson($, `${await root($)}/mail/${fileName(node)}/${id}.json`, mail)
}

/** The node's undelivered mail, oldest first; `done()` records it as delivered. */
async function peekMail($: EngineInterface, node: string): Promise<{ mail: Mail[]; done: () => Promise<void> }> {
  const dir = `${await root($)}/mail/${fileName(node)}`
  if (!(await $.fs.exists(dir))) return { mail: [], done: async () => {} }
  const deliveredPath = `${dir}/delivered.json`
  const delivered = new Set(await readJson<string[]>($, deliveredPath, []))
  const fresh = (await $.fs.list(dir))
    .filter(e => e.kind === 'file' && e.name !== 'delivered.json' && e.name.endsWith('.json') && !delivered.has(e.name))
    .map(e => e.name)
    .sort()
  const mail: Mail[] = []
  for (const name of fresh) {
    const m = await readJson<Partial<Mail> | undefined>($, `${dir}/${name}`, undefined)
    if (m && typeof m.text === 'string') mail.push({ from: String(m.from ?? 'unknown'), relation: m.relation, text: m.text, at: Number(m.at) })
  }
  return { mail, done: () => (fresh.length ? writeJson($, deliveredPath, [...delivered, ...fresh]) : Promise.resolve()) }
}

function mailPrompt(node: string, mail: Mail[]): string {
  const when = (at: number) => (Number.isFinite(at) ? ` at ${new Date(at).toISOString()}` : '')
  const body = mail
    .map(m => `[plexus] from \`${m.from}\`${m.relation ? ` (${m.relation})` : ''}${when(m.at)}\n${m.text}`)
    .join('\n\n---\n\n')
  return `${mail.length} plexus message(s) for \`${node}\` arrived while no session held it. Read them and act as you would on a live message from that node.\n\n${body}`
}

// --- the session's own state ---------------------------------------------------

let known: string | undefined // the session id this module last saw
let carried: string | undefined // a node to keep across a /clear, which ends the session and starts another

const sessionId = ($: EngineInterface) => $.session.id()
const myNode = async ($: EngineInterface) => nodeOf(await readBindings($), await sessionId($))

/**
 * Brings the files in line with the session this process is running now. Runs
 * at start and before every request: a /clear or an in-process /resume
 * changes the session id without a `session.start`.
 */
async function reconcile($: EngineInterface): Promise<void> {
  const id = await sessionId($)
  if (id === known) return
  known = id
  if (carried) {
    const node = carried
    carried = undefined
    await bind($, node)
  } else {
    // A resumed session takes back the node it held when it ended, unless it
    // had moved off it or another session has bound it since (then the file names that session).
    const all = await readBindings($)
    const mine = Object.entries(all)
      .filter(([, b]) => b.sessionId === id && b.endedAt && !b.released)
      .sort(([, a], [, b]) => b.boundAt - a.boundAt)[0]
    if (mine) await writeBinding($, mine[0], { ...mine[1], endedAt: undefined })
  }
  await deliverMail($)
}

async function bind($: EngineInterface, node: string): Promise<void> {
  const id = await sessionId($)
  const all = await readBindings($)
  // Release the node this session held before.
  for (const [held, b] of Object.entries(all)) {
    if (held !== node && b.sessionId === id && !b.endedAt) await writeBinding($, held, { ...b, endedAt: Date.now(), released: true })
  }
  // Tell a session that held this node it no longer does.
  const previous = all[node]
  if (previous && previous.sessionId !== id && !previous.endedAt) {
    await $.session
      .send({ to: { sessionId: previous.sessionId }, text: `[plexus] Another session took over the node \`${node}\`; this session no longer holds it.` })
      .catch(() => undefined)
  }
  await writeBinding($, node, { sessionId: id, boundAt: Date.now(), cwd: await $.session.cwd() })
  await declareNode($, node)
}

/** Hands this node's waiting mail to Claude as a turn of its own; recorded as delivered once the turn starts. */
async function deliverMail($: EngineInterface): Promise<void> {
  const node = await myNode($)
  if (!node) return
  const { mail, done } = await peekMail($, node)
  if (!mail.length) return
  void $.prompt
    .submit({ text: mailPrompt(node, mail) })
    .then(done)
    .catch(error => $.ui.log(`plexus: mail for \`${node}\` stays waiting: ${String(error)}`))
}

async function send($: EngineInterface, to: string, text: string): Promise<string> {
  if (!isNodeId(to)) return `"${to}" is not a node id.`
  const g = await readGraph($)
  const bindings = await readBindings($)
  if (!g.nodes[to] && !bindings[to]) {
    return `There is no node \`${to}\` in the graph. Known nodes: ${Object.keys(g.nodes).sort().join(', ') || 'none'}.`
  }
  const id = await sessionId($)
  const node = nodeOf(bindings, id)
  // An unbound session (a worker) can report in; it just can't be answered through plexus.
  const from = node ?? `unbound session ${id.slice(0, 8)}`
  const rel = node ? relation(g, node, to) : 'a session outside the graph'
  const target = bindings[to]

  if (target && !target.endedAt) {
    const sent = await $.session.send({ to: { sessionId: target.sessionId }, text: `[plexus] from \`${from}\` (${rel}) to \`${to}\`\n${text}` })
    if (sent.isDelivered) return `Delivered to \`${to}\`'s open session.`
  }
  await leaveMail($, to, { from, relation: rel, text, at: Date.now() })
  $.ui.toast(`plexus: \`${to}\` has no open session; the message waits in its mailbox`)
  const next = target
    ? ` If it can't wait, the user can wake it with \`/wake ${to}\` (its last session resumes in the background and reads the mail).`
    : ` No session has held \`${to}\` yet; the user can open one and run \`/node ${to}\` there.`
  return `\`${to}\` has no open session, so the message is waiting in its mailbox; the next session bound to \`${to}\` reads it.${next}`
}

/**
 * Resumes a closed node's last session in the background with a note; the
 * session then delivers its own mail. Refuses when that session is still
 * running (a resume would start a copy) or has moved to another node.
 */
async function wake($: EngineInterface, node: string, reason: string): Promise<string> {
  const b = (await readBindings($))[node]
  if (!b) {
    return `No session has held \`${node}\`, so there is nothing to resume. A new one can be started in the background from the project folder: claude --bg "/node ${node}"`
  }
  if (b.released) return `\`${node}\`'s last session moved to another node, so resuming it wouldn't bring \`${node}\` back. Open a session for \`${node}\` and run \`/node ${node}\` there.`
  const live = await liveSessions($)
  if (live?.has(b.sessionId)) {
    return b.endedAt
      ? `\`${node}\`'s last session is running but no longer holds it. Open a session for \`${node}\` and run \`/node ${node}\` there.`
      : `\`${node}\`'s session is open; message it with mcp__plexus__send instead.`
  }
  const from = (await myNode($)) ?? 'a session'
  try {
    const ran = await $.process.run(['claude', '--resume', b.sessionId, '--bg', `[plexus] \`${from}\` woke this session (node \`${node}\`): ${reason}`], {
      cwd: b.cwd,
      timeoutMs: 60_000,
    })
    if (ran.exitCode !== 0) return `Could not resume \`${node}\`'s session (exit ${ran.exitCode}): ${(ran.stderr || ran.stdout).trim().slice(0, 500)}`
    return `Woke \`${node}\`: its last session resumed in the background and reads its waiting mail. It shows in the Desktop app and in \`claude agents\`.\n${ran.stdout.trim()}`
  } catch (error) {
    return `Could not resume \`${node}\`'s session: ${String(error)}. Is \`claude\` on PATH, and does ${b.cwd ?? 'its folder'} still exist?`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'send',
      description:
        "Send a message to a node of the user's session graph (plexus). Delivered to the session bound to that node, or left in its mailbox until one binds. Use for reporting to your parent, asking a child or sibling, or a topic link.",
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The node id, such as `play` or `adventure`.' },
          text: { type: 'string', description: 'The message. Make the first line say what it is about.' },
        },
        required: ['to', 'text'],
      },
    })
    await $.tool.register({
      name: 'graph',
      description: "Show the user's whole session graph (plexus): every node, its parent, whether a session holds it, and the topic links.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'wake',
      description:
        "Resume a closed plexus node's last session in the background so it reads its waiting mail. Spends the user's usage, so it runs only where the user allows it (an allow rule for mcp__plexus__wake); otherwise it tells you to ask the user to run /wake.",
      inputSchema: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'The node id to wake.' },
          reason: { type: 'string', description: 'Why it is being woken, for the woken session to read.' },
        },
        required: ['node', 'reason'],
      },
    })
    await $.command.register({ name: 'node', description: 'Bind this session to a plexus node, or show its place', argumentHint: '[node id]' })
    await $.command.register({ name: 'graph', description: 'Show the plexus session graph' })
    await $.command.register({ name: 'wake', description: "Resume a closed plexus node's last session in the background", argumentHint: '<node id> [reason]' })

    known = undefined
    await reconcile($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const node = nodeOf(await readBindings($), e.sessionId)
    if (node) {
      if (e.reason === 'clear') carried = node
      const b = (await readBindings($))[node]
      if (b) await writeBinding($, node, { ...b, endedAt: Date.now() })
    }
    return next(e)
  })

  // The node's place goes in the system prompt, so it survives compaction.
  on('prompt.compose', async ($, e, next) => {
    await reconcile($)
    const composed = await next(e)
    const node = await myNode($)
    if (!node) return composed
    const text = placeText(await readGraph($), node)
    return { sections: [...composed.sections, { id: 'plexus:place', text, scope: 'session' }] }
  })

  on('tool.call', { tool: 'mcp__plexus__send' }, async ($, e) => {
    const { to, text } = e as unknown as { to: string; text: string }
    return { result: await send($, to, text) }
  }).catch(($, e, next) => ({ result: `plexus failed: ${next.error?.message ?? "unknown error"}` }))

  // A plugin's tool answered here skips the permission prompt, so the hook asks
  // the user's rules itself: a wake runs only under an explicit allow rule.
  on('tool.call', { tool: 'mcp__plexus__wake' }, async ($, e) => {
    const { node, reason } = e as unknown as { node: string; reason: string }
    const check = await $.tool.check({ tool: 'mcp__plexus__wake', input: { node, reason } })
    if (check.decision === 'deny') return { result: `Waking is denied by the user's settings${check.rule ? ` (${check.rule})` : ''}.` }
    if (check.decision !== 'allow' || !check.rule) {
      return { result: `Waking spends the user's usage, so it needs the user: ask them to run \`/wake ${node}\`. (An allow rule for mcp__plexus__wake lets you wake nodes yourself.)` }
    }
    return { result: await wake($, node, reason) }
  }).catch(($, e, next) => ({ result: `plexus failed: ${next.error?.message ?? "unknown error"}` }))

  on('tool.call', { tool: 'mcp__plexus__graph' }, async $ => {
    return { result: treeText(await readGraph($), await readBindings($), await myNode($), await liveSessions($)) }
  }).catch(($, e, next) => ({ result: `plexus failed: ${next.error?.message ?? "unknown error"}` }))

  on('command.run', { command: 'node' }, async ($, e) => {
    const id = e.args.trim()
    if (!id) {
      const node = await myNode($)
      return { text: node ? placeText(await readGraph($), node) : 'This session is not bound to a node. Run /node <id>, such as /node adventure.' }
    }
    if (!isNodeId(id)) return { text: `"${id}" is not a node id: use letters, digits, - _ . and / between levels.` }
    await bind($, id)
    void deliverMail($)
    return { text: `Bound this session to \`${id}\`.\n\n${placeText(await readGraph($), id)}` }
  })

  on('command.run', { command: 'graph' }, async $ => {
    return { text: `${treeText(await readGraph($), await readBindings($), await myNode($), await liveSessions($))}\n\nFiles: ${await root($)}` }
  })

  on('command.run', { command: 'wake' }, async ($, e) => {
    const [node = '', ...rest] = e.args.trim().split(/\s+/)
    if (!isNodeId(node)) return { text: 'Usage: /wake <node id> [reason]' }
    return { text: await wake($, node, rest.join(' ') || 'the user asked for it') }
  })
}
