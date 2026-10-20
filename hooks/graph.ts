// The session graph: what a node is, who it reports to, and what a session
// bound to it should know about its neighbours. Pure functions, no `$`, so
// tests and every hook read the graph the same way.

export type GraphNode = {
  /** The node above this one. Left out, the parent is the path's prefix: `play/adventure` → `play`. `""` makes a root. */
  parent?: string
  /** True when this node heads a cluster: its descendants escalate to it. */
  head?: boolean
  /** What the node is for, in a sentence or two. Every neighbour reads it. */
  brief?: string
}

/** A standing reason to talk across the tree: `from` (a node id, `prefix/*`, or `*`) reports to `to` about `when`. */
export type GraphLink = { from: string; to: string; when?: string }

export type Graph = { nodes: Record<string, GraphNode>; links?: GraphLink[] }

export const emptyGraph = (): Graph => ({ nodes: {}, links: [] })

export function parseGraph(text: string | undefined): Graph {
  if (!text?.trim()) return emptyGraph()
  const raw = JSON.parse(text) as Partial<Graph>
  return { nodes: raw.nodes ?? {}, links: raw.links ?? [] }
}

/** Every node the graph mentions: declared ones, path prefixes, parents and link ends. */
export function nodeIds(g: Graph): string[] {
  const ids = new Set(Object.keys(g.nodes))
  for (const id of [...ids]) {
    for (const a of ancestors(g, id)) ids.add(a)
  }
  for (const l of g.links ?? []) {
    if (!l.from.includes('*')) ids.add(l.from)
    ids.add(l.to)
  }
  return [...ids].sort()
}

export function parentOf(g: Graph, id: string): string | undefined {
  const declared = g.nodes[id]?.parent
  if (declared !== undefined) return declared || undefined
  const cut = id.lastIndexOf('/')
  return cut > 0 ? id.slice(0, cut) : undefined
}

export function ancestors(g: Graph, id: string): string[] {
  const found: string[] = []
  for (let p = parentOf(g, id); p !== undefined && !found.includes(p) && p !== id; p = parentOf(g, p)) {
    found.push(p)
  }
  return found
}

export function childrenOf(g: Graph, id: string): string[] {
  return nodeIds(g).filter(n => n !== id && parentOf(g, n) === id)
}

export function siblingsOf(g: Graph, id: string): string[] {
  const p = parentOf(g, id)
  return p === undefined ? [] : childrenOf(g, p).filter(n => n !== id)
}

/** The nearest head at or above `id`. */
export function headOf(g: Graph, id: string): string | undefined {
  return [id, ...ancestors(g, id)].find(n => g.nodes[n]?.head)
}

/** `x/*` matches everything beneath `x` in the graph, whether ids are paths or flat. */
function matches(g: Graph, pattern: string, id: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('/*')) {
    const top = pattern.slice(0, -2)
    return id.startsWith(`${top}/`) || ancestors(g, id).includes(top)
  }
  return pattern === id
}

/** Links this node should report along. */
export function linksFrom(g: Graph, id: string): GraphLink[] {
  return (g.links ?? []).filter(l => l.to !== id && matches(g, l.from, id))
}

/** Letters, digits, `-_.`, with `/` between levels; no level may be only dots. */
export function isNodeId(id: string): boolean {
  return id.split('/').every(level => /^[\w-][\w.-]*$/.test(level))
}

/** How `from` stands to `to`, as the receiver should read it ("your parent"). */
export function relation(g: Graph, from: string, to: string): string {
  if (parentOf(g, to) === from) return 'your parent'
  if (parentOf(g, from) === to) return 'your child'
  if (parentOf(g, from) !== undefined && parentOf(g, from) === parentOf(g, to)) return 'your sibling'
  if (ancestors(g, to).includes(from)) return 'above you in the graph'
  if (ancestors(g, from).includes(to)) return 'below you in the graph'
  if (linksFrom(g, from).some(l => l.to === to)) return 'a node that reports to you by a topic link'
  return 'another node'
}

const describe = (g: Graph, id: string) => {
  const brief = g.nodes[id]?.brief
  return brief ? `\`${id}\`: ${brief}` : `\`${id}\``
}

/**
 * What a session bound to `id` reads in its system prompt. Stable on purpose:
 * it changes only when the graph file does, so the prompt cache holds.
 */
export function placeText(g: Graph, id: string): string {
  const lines = [
    '# plexus: your place in the session graph',
    '',
    `This session is bound to the node \`${id}\` of the user's session graph (plexus).${g.nodes[id]?.brief ? ` ${g.nodes[id]?.brief}` : ''}`,
  ]
  const head = headOf(g, id)
  const parent = parentOf(g, id)
  const up = ancestors(g, id)
  if (head && head !== id) lines.push(`Your cluster is headed by ${describe(g, head)}.`)
  if (head === id) lines.push('You head this cluster: the nodes below you escalate to you.')
  if (parent) lines.push(`Parent, the node you report to: ${describe(g, parent)}`)
  const kids = childrenOf(g, id)
  if (kids.length) lines.push(`Children: ${kids.map(k => describe(g, k)).join('; ')}`)
  const sibs = siblingsOf(g, id)
  if (sibs.length) lines.push(`Siblings: ${sibs.map(s => `\`${s}\``).join(', ')}`)
  for (const l of linksFrom(g, id)) {
    lines.push(`Topic link: report to \`${l.to}\`${l.when ? ` about ${l.when}` : ''}.`)
  }
  const further = up.slice(1).filter(a => a !== head)
  if (further.length) {
    lines.push(`Further up: ${further.map(a => `\`${a}\``).join(', ')}. Those are reached through your parent${head && head !== id && head !== parent ? ' and your cluster head' : ''}, not by you; reach them only when the user asks.`)
  }
  lines.push(
    '',
    "Message a node with the `mcp__plexus__send` tool, by node id. It reaches the session bound to that node, or leaves the message in the node's mailbox when none is open. Every message starts a turn in the receiving session and costs usage, so send one only when the user asks, or when you learn something that changes your parent's, a child's, a sibling's or a topic link's work (a breaking change, a decision it is waiting on), or need an answer only that node has. Reach nodes outside those only when the user asks. `mcp__plexus__graph` shows the whole graph.",
    'A message from another node arrives as a cross-session message whose first line starts with `[plexus]` and names the sender\'s node and how it stands to you.',
  )
  return lines.join('\n')
}

/** What a fork reads, while it holds no node, about where it came from. Stable, like `placeText`. */
export function forkText(g: Graph, origin: string): string {
  const parent = parentOf(g, origin)
  return [
    '# plexus: this session is a fork',
    '',
    `This conversation was forked from the session holding the node \`${origin}\` of the user's session graph (plexus). The \`[plexus]\` lines earlier in it describe that session, not this one: this fork holds no node, and what it sends goes out as an unbound session.`,
    `The original is reachable as \`${origin}\` with \`mcp__plexus__send\`. Tell it what it would want to know from this fork's work, as a sibling would.`,
    `If this fork becomes its own line of work, give it a node with \`mcp__plexus__node\` (action \`bind\`) once the user agrees on a name, usually as a sibling of \`${origin}\`${parent ? ` under \`${parent}\`` : ''}.`,
  ].join('\n')
}

/**
 * Which session holds a node. `endedAt` is set when that session ended;
 * `released` when it moved to another node, so a resume doesn't take this one back.
 */
export type Binding = { sessionId: string; boundAt: number; cwd?: string; endedAt?: number; released?: true; movedTo?: string }

/** `id` renamed `from` → `to`, and every path id beneath `from/` with it. */
function renamed(id: string, from: string, to: string): string {
  return id === from ? to : id.startsWith(`${from}/`) ? `${to}${id.slice(from.length)}` : id
}

/**
 * The graph with node `from` renamed `to`: its entry, path ids beneath it,
 * declared parents and links that name it. Returns the old → new id pairs.
 */
export function renameNode(g: Graph, from: string, to: string): { graph: Graph; moved: [string, string][] } {
  const moved: [string, string][] = []
  const nodes: Record<string, GraphNode> = {}
  const implied = (id: string) => (id.lastIndexOf('/') > 0 ? id.slice(0, id.lastIndexOf('/')) : undefined)
  for (const [id, node] of Object.entries(g.nodes)) {
    const next = renamed(id, from, to)
    if (next !== id) moved.push([id, next])
    if (node.parent !== undefined) {
      nodes[next] = { ...node, parent: node.parent && renamed(node.parent, from, to) }
    } else {
      // A parent the old path implied is kept, declared, when the new id implies another.
      const before = implied(id)
      const kept = before && renamed(before, from, to)
      nodes[next] = kept && implied(next) !== kept ? { ...node, parent: kept } : node
    }
  }
  if (!g.nodes[from]) moved.push([from, to])
  const links = (g.links ?? []).map(l => ({
    ...l,
    from: l.from.endsWith('/*') ? `${renamed(l.from.slice(0, -2), from, to)}/*` : renamed(l.from, from, to),
    to: renamed(l.to, from, to),
  }))
  return { graph: { ...g, nodes, links }, moved }
}

/**
 * The whole graph as an indented tree, with each node's session state.
 * `live`, when known, is the set of session ids running on this machine.
 */
export function treeText(g: Graph, bindings: Record<string, Binding>, self?: string, live?: Set<string>): string {
  const ids = nodeIds(g)
  for (const [b, binding] of Object.entries(bindings)) if (!binding.movedTo && !ids.includes(b)) ids.push(b)
  const roots = ids.filter(n => parentOf(g, n) === undefined || !ids.includes(parentOf(g, n)!))
  const out: string[] = []
  const walk = (id: string, depth: number) => {
    const b = bindings[id]
    const isOpen = b && !b.endedAt && (live ? live.has(b.sessionId) : true)
    const state = !b ? 'no session' : isOpen ? 'session open' : 'session closed'
    const isLoose = depth === 0 && !ids.some(n => n !== id && parentOf(g, n) === id)
    const marks = [isLoose ? 'loose' : '', g.nodes[id]?.head ? 'head' : '', state, id === self ? 'this session' : ''].filter(Boolean).join(', ')
    out.push(`${'  '.repeat(depth)}- ${id} (${marks})${g.nodes[id]?.brief ? `: ${g.nodes[id]?.brief}` : ''}`)
    for (const c of ids.filter(n => n !== id && parentOf(g, n) === id).sort()) walk(c, depth + 1)
  }
  for (const r of roots.sort()) walk(r, 0)
  for (const l of g.links ?? []) out.push(`link: ${l.from} → ${l.to}${l.when ? ` (${l.when})` : ''}`)
  return out.length ? out.join('\n') : 'The graph is empty. Bind a session with /node <id>, or edit the graph file.'
}
