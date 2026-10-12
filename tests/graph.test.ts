import { expect, test } from 'claude-code/testing'
import { type Graph, childrenOf, headOf, isNodeId, linksFrom, parentOf, placeText, relation, siblingsOf } from '../hooks/graph.ts'

const g: Graph = {
  nodes: {
    nexus: { brief: 'The user, their todos and everything across projects.' },
    play: { parent: 'nexus', head: true, brief: 'The games app.' },
    'play/adventure': { brief: 'The adventure game.' },
    'play/phonics': {},
    'monorepo-maintenance': { parent: 'nexus' },
  },
  links: [{ from: 'play/*', to: 'monorepo-maintenance', when: 'tooling and shared libs' }],
}

test('a path names its parent unless the node declares one', async () => {
  expect(parentOf(g, 'play/adventure')).toBe('play')
  expect(parentOf(g, 'play')).toBe('nexus')
  expect(parentOf(g, 'nexus')).toBe(undefined)
})

test('a child sees its cluster head, siblings and topic links, and not the root as its contact', async () => {
  expect(headOf(g, 'play/adventure')).toBe('play')
  expect(siblingsOf(g, 'play/adventure')).toEqual(['play/phonics'])
  expect(childrenOf(g, 'nexus')).toEqual(['monorepo-maintenance', 'play'])
  expect(linksFrom(g, 'play/adventure').map(l => l.to)).toEqual(['monorepo-maintenance'])
  const text = placeText(g, 'play/adventure')
  expect(text).toContain('Your cluster is headed by `play`')
  expect(text).toContain('Further up: `nexus`. Those are reached through your parent, not by you')
})

test('a cluster link reaches flat ids declared beneath it, as the README recommends', async () => {
  const flat: Graph = {
    nodes: { play: { head: true }, adventure: { parent: 'play' }, maintenance: {} },
    links: [{ from: 'play/*', to: 'maintenance' }],
  }
  expect(linksFrom(flat, 'adventure').map(l => l.to)).toEqual(['maintenance'])
  expect(linksFrom(flat, 'maintenance')).toEqual([])
})

test('a head above the parent is the escalation point, never listed as out of reach', async () => {
  const deep: Graph = { nodes: { nexus: {}, play: { parent: 'nexus', head: true }, adventure: { parent: 'play' }, levels: { parent: 'adventure' } } }
  const text = placeText(deep, 'levels')
  expect(text).toContain('Your cluster is headed by `play`')
  expect(text).toContain('Further up: `nexus`.')
  expect(text).not.toContain('Further up: `play`')
})

test('node ids are levels of letters, digits and -_. with no level made of dots', async () => {
  expect(isNodeId('play/adventure')).toBe(true)
  expect(isNodeId('client-a.v2')).toBe(true)
  expect(isNodeId('..')).toBe(false)
  expect(isNodeId('play/../x')).toBe(false)
  expect(isNodeId('a\\b')).toBe(false)
  expect(isNodeId('')).toBe(false)
})

test('a message names how the sender stands to the receiver', async () => {
  expect(relation(g, 'play', 'play/adventure')).toBe('your parent')
  expect(relation(g, 'play/adventure', 'play')).toBe('your child')
  expect(relation(g, 'play/phonics', 'play/adventure')).toBe('your sibling')
  expect(relation(g, 'play/adventure', 'monorepo-maintenance')).toBe('a node that reports to you by a topic link')
})
