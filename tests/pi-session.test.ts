import { describe, expect, it } from 'vitest'
import {
  buildSessionSummary,
  listBranches,
  parsePiSessionText,
  resolveBranch,
  sessionToMaze,
  sessionToolResultText,
} from '../src/pi-session.js'
import { toolVerdict } from '../src/verdict.js'

const t0 = Date.parse('2026-08-20T00:00:00.000Z')
const iso = (offset: number): string => new Date(t0 + offset).toISOString()

function entry(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function fixture(): string {
  const lines = [
    { type: 'session', version: 3, id: 'session-1', timestamp: iso(0), cwd: '/work/demo', parentSession: '/tmp/parent.jsonl' },
    { type: 'model_change', id: 'model', parentId: null, timestamp: iso(10), provider: 'anthropic', modelId: 'claude-sonnet' },
    { type: 'message', id: 'user', parentId: 'model', timestamp: iso(100), message: { role: 'user', content: [{ type: 'text', text: 'Fix the failing test' }], timestamp: t0 + 100 } },
    // An abandoned branch remains in the append-only file.
    { type: 'message', id: 'old-assistant', parentId: 'user', timestamp: iso(900), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'old-call', name: 'ls', arguments: { path: '.' } }], provider: 'anthropic', model: 'old-model', stopReason: 'toolUse', timestamp: t0 + 500 } },
    { type: 'message', id: 'old-result', parentId: 'old-assistant', timestamp: iso(1000), message: { role: 'toolResult', toolCallId: 'old-call', toolName: 'ls', content: [{ type: 'text', text: 'old branch' }], isError: false, timestamp: t0 + 1000 } },
    // Active branch: two parallel calls whose results arrive in reverse order.
    { type: 'message', id: 'assistant-1', parentId: 'user', timestamp: iso(2000), message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Inspect both files first.' },
      { type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'src/a.ts' } },
      { type: 'toolCall', id: 'bash-call', name: 'bash', arguments: { command: 'pnpm test' } },
    ], provider: 'anthropic', model: 'claude-sonnet', stopReason: 'toolUse', timestamp: t0 + 1000, usage: { input: 100, output: 30, reasoning: 12, cacheRead: 40, cacheWrite: 0, totalTokens: 170, cost: { total: 0.0123 } } } },
    { type: 'message', id: 'bash-result', parentId: 'assistant-1', timestamp: iso(3000), message: { role: 'toolResult', toolCallId: 'bash-call', toolName: 'bash', content: [{ type: 'text', text: 'Error: one test failed' }], isError: true, timestamp: t0 + 3000 } },
    {
      type: 'message', id: 'read-result', parentId: 'bash-result', timestamp: iso(4000),
      message: {
        role: 'toolResult', toolCallId: 'read-call', toolName: 'read',
        content: [{ type: 'text', text: 'export const answer = 42' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], isError: false, timestamp: t0 + 4000,
        usage: { input: 5, output: 1, totalTokens: 6, cost: { total: 0.001 } },
      },
    },
    { type: 'compaction', id: 'compact', parentId: 'read-result', timestamp: iso(4200), summary: 'Earlier work', firstKeptEntryId: 'assistant-1', tokensBefore: 9000 },
    {
      type: 'message', id: 'assistant-2', parentId: 'compact', timestamp: iso(5000),
      message: {
        role: 'assistant', content: [{ type: 'text', text: 'Fixed and verified.' }],
        provider: 'anthropic', model: 'claude-sonnet', stopReason: 'stop', timestamp: t0 + 4500,
        usage: { input: 200, output: 20, cacheRead: 100, cacheWrite: 0, totalTokens: 320, cost: { total: 0.02 } },
      },
    },
    { type: 'session_info', id: 'info', parentId: 'assistant-2', timestamp: iso(5100), name: 'Repair demo tests' },
  ]
  return lines.map(entry).join('\n') + '\n'
}

describe('Pi v3 session parser', () => {
  it('resolves the physical last entry as active leaf without mixing abandoned branches', () => {
    const parsed = parsePiSessionText(fixture())
    expect(parsed.activeLeafId).toBe('info')
    expect(parsed.leaves.map(leaf => leaf.id).sort()).toEqual(['info', 'old-result'])
    expect(resolveBranch(parsed).map(item => item.id)).not.toContain('old-assistant')
    expect(listBranches(parsed)).toHaveLength(2)
    expect(listBranches(parsed)[0]).toMatchObject({ id: 'info', active: true })
  })

  it('pairs parallel tool results by call id and uses Pi request/response timestamps', () => {
    const data = sessionToMaze(parsePiSessionText(fixture()))
    const lane = data.lanes[0]!
    expect(lane.stats.steps).toBe(2)
    expect(lane.stats.tools).toBe(2)
    expect(lane.detours).toHaveLength(0)
    const first = lane.main.find(node => node.entryId === 'assistant-1')!
    expect(first).toMatchObject({ v: 'ok', partialFailures: 1 })
    expect(first.s).toBe(0.9)
    expect(first.e).toBe(3.9)
    expect(first.tools.map(tool => [tool.callId, tool.e])).toEqual([
      ['read-call', 3.9],
      ['bash-call', 2.9],
    ])
    expect(first.tools.find(tool => tool.callId === 'read-call')).toMatchObject({ v: 'ok', err: false, images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }] })
    expect(first.tools.find(tool => tool.callId === 'bash-call')).toMatchObject({ v: 'error', err: true })
    expect(sessionToolResultText(parsePiSessionText(fixture()), 'read-call')).toContain('export const answer = 42')
  })

  it('preserves prompt, answer, thinking and native Pi usage', () => {
    const lane = sessionToMaze(parsePiSessionText(fixture())).lanes[0]!
    const all = [...lane.main, ...lane.detours]
    expect(all.find(node => node.entryId === 'assistant-1')).toMatchObject({
      prompt: 'Fix the failing test',
      rz: 1,
      rzTok: 12,
      outTok: 30,
      model: 'claude-sonnet',
    })
    expect(all.find(node => node.entryId === 'assistant-2')).toMatchObject({ answer: 'Fixed and verified.', v: 'answer' })
    expect(lane.stats).toMatchObject({ inputTok: 305, outTok: 51, cacheReadTok: 140, totalTok: 496, cost: 0.0333 })
  })

  it('builds useful list metadata from the active branch', () => {
    const parsed = parsePiSessionText(fixture())
    const summary = buildSessionSummary(parsed, { id: 'opaque', size: 1234, modifiedAt: iso(5100), now: t0 + 6000 })
    expect(summary).toMatchObject({
      id: 'opaque',
      name: 'Repair demo tests',
      cwd: '/work/demo',
      project: 'demo',
      firstPrompt: 'Fix the failing test',
      branches: 2,
      compactions: 1,
      active: true,
      parentSession: '/tmp/parent.jsonl',
    })
  })

  it('ignores a partial final line while reporting a warning', () => {
    const parsed = parsePiSessionText(fixture() + '{"type":"message"')
    expect(parsed.warnings.at(-1)).toContain('正在写入的末行')
    expect(parsed.activeLeafId).toBe('info')
  })

  it('counts explicit bash executions as Pi turns', () => {
    const text = [
      { type: 'session', version: 3, id: 'bash-session', timestamp: iso(0), cwd: '/work/bash' },
      { type: 'message', id: 'b1', parentId: null, timestamp: iso(100), message: { role: 'bashExecution', command: 'pwd', output: '/work/bash', exitCode: 0, timestamp: t0 + 50 } },
      { type: 'message', id: 'b2', parentId: 'b1', timestamp: iso(200), message: { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0, timestamp: t0 + 150 } },
    ].map(entry).join('\n')
    const parsed = parsePiSessionText(text)
    const nodes = sessionToMaze(parsed).lanes[0]!.main
    expect(nodes.map(node => node.turn)).toEqual([1, 2])
    expect(buildSessionSummary(parsed, { id: 'bash', size: 1, modifiedAt: iso(200) }).turns).toBe(2)
  })

  it('keeps a narrative assistant step on the main path when its only tool fails', () => {
    const text = [
      { type: 'session', version: 3, id: 'partial-session', timestamp: iso(0), cwd: '/work/partial' },
      { type: 'message', id: 'u', parentId: null, timestamp: iso(10), message: { role: 'user', content: 'run it', timestamp: t0 + 10 } },
      { type: 'message', id: 'a', parentId: 'u', timestamp: iso(1000), message: { role: 'assistant', content: [{ type: 'text', text: 'I will run a focused check.' }, { type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'slow-check' } }], provider: 'x', model: 'y', stopReason: 'toolUse', timestamp: t0 + 100 } },
      { type: 'message', id: 'r', parentId: 'a', timestamp: iso(2000), message: { role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: 'Command timed out' }], isError: true, timestamp: t0 + 2000 } },
    ].map(entry).join('\n')
    const lane = sessionToMaze(parsePiSessionText(text)).lanes[0]!
    expect(lane.detours).toHaveLength(0)
    expect(lane.main[0]).toMatchObject({ v: 'ok', partialFailures: 1, answer: 'I will run a focused check.' })
    expect(lane.main[0]!.tools[0]).toMatchObject({ v: 'error', err: true })
  })

  it('treats a failed Agent model dispatch as an error', () => {
    expect(toolVerdict({ name: 'Agent', res: 'Model not found: "sonnet"', err: false })).toMatchObject({ v: 'error' })
  })

  it('turns model errors into visible failed steps', () => {
    const text = [
      { type: 'session', version: 3, id: 'error-session', timestamp: iso(0), cwd: '/work/error' },
      { type: 'message', id: 'u', parentId: null, timestamp: iso(10), message: { role: 'user', content: 'hello', timestamp: t0 + 10 } },
      { type: 'message', id: 'a', parentId: 'u', timestamp: iso(1000), message: { role: 'assistant', content: [], provider: 'x', model: 'y', stopReason: 'error', errorMessage: 'rate limited', timestamp: t0 + 100 } },
    ].map(entry).join('\n')
    const lane = sessionToMaze(parsePiSessionText(text)).lanes[0]!
    expect(lane.detours).toHaveLength(1)
    expect(lane.detours[0]!.tools[0]).toMatchObject({ name: 'model', v: 'error', err: true })
  })
})
