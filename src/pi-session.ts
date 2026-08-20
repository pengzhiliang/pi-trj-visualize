import { basename } from 'node:path'
import type {
  BranchInfo,
  MazeData,
  MazeImage,
  MazeLane,
  MazeNode,
  MazeTool,
  PiUsage,
  SessionSummary,
} from './types.js'
import { markRetryClusters, stepVerdict, toolVerdict } from './verdict.js'

export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}

export interface SessionEntry {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  [key: string]: unknown
}

export interface ParsedPiSession {
  header: SessionHeader
  entries: SessionEntry[]
  byId: Map<string, SessionEntry>
  children: Map<string | null, SessionEntry[]>
  activeLeafId: string | null
  leaves: SessionEntry[]
  warnings: string[]
}

export interface SessionFileFacts {
  id: string
  size: number
  modifiedAt: string
  now?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isoMs(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function messageOf(entry: SessionEntry): Record<string, unknown> | null {
  return isRecord(entry.message) ? entry.message : null
}

function messageTime(entry: SessionEntry): number {
  const outer = isoMs(entry.timestamp, 0)
  return isoMs(messageOf(entry)?.timestamp, outer)
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return []
  return content.filter(isRecord)
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of contentBlocks(content)) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push(`[图片${typeof block.mimeType === 'string' ? ` ${block.mimeType}` : ''}]`)
  }
  return parts.join('\n')
}

function imageContent(content: unknown): MazeImage[] {
  const images: MazeImage[] = []
  for (const block of contentBlocks(content)) {
    if (block.type !== 'image' || typeof block.data !== 'string' || block.data === '') continue
    const mimeType = typeof block.mimeType === 'string' && /^image\/[a-z0-9.+-]+$/i.test(block.mimeType)
      ? block.mimeType
      : 'image/png'
    images.push({ mimeType, data: block.data })
  }
  return images
}

function assistantText(message: Record<string, unknown>): string {
  const parts: string[] = []
  for (const block of contentBlocks(message.content)) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function thinkingText(message: Record<string, unknown>): { count: number; text: string } {
  const parts: string[] = []
  for (const block of contentBlocks(message.content)) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push(block.thinking)
  }
  return { count: parts.length, text: parts.join('\n').replace(/\s+/g, ' ').trim() }
}

function usageOf(value: unknown): PiUsage | undefined {
  if (!isRecord(value)) return undefined
  const costValue = isRecord(value.cost) ? finiteNumber(value.cost.total) : 0
  const reasoningValue = typeof value.reasoning === 'number' && Number.isFinite(value.reasoning) ? value.reasoning : null
  const input = finiteNumber(value.input)
  const output = finiteNumber(value.output)
  const cacheRead = finiteNumber(value.cacheRead)
  const cacheWrite = finiteNumber(value.cacheWrite)
  const totalTokens = finiteNumber(value.totalTokens, input + output + cacheRead + cacheWrite)
  return { input, output, reasoning: reasoningValue, cacheRead, cacheWrite, totalTokens, cost: costValue }
}

function entryRole(entry: SessionEntry): string | null {
  const role = messageOf(entry)?.role
  return typeof role === 'string' ? role : null
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`
}

function roundT(value: number): number {
  return Math.round(value * 10) / 10
}

export function parsePiSessionText(text: string): ParsedPiSession {
  const warnings: string[] = []
  const parsed: Record<string, unknown>[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) parsed.push(value)
      else warnings.push(`第 ${index + 1} 行不是 JSON 对象`)
    } catch (error) {
      const isPossiblyPartial = index === lines.length - 1 && !text.endsWith('\n')
      warnings.push(isPossiblyPartial
        ? `忽略正在写入的末行（第 ${index + 1} 行）`
        : `第 ${index + 1} 行 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const rawHeader = parsed.find(value => value.type === 'session')
  if (rawHeader === undefined) {
    const v4 = parsed.find(value => value.kind === 'header')
    if (v4 !== undefined) throw new Error(`暂不支持 Pi harness session v${finiteNumber(v4.version, 4)}（当前支持 coding-agent JSONL v3）`)
    throw new Error('缺少 Pi session header')
  }
  const version = finiteNumber(rawHeader.version, 1)
  if (version !== 3) throw new Error(`暂不支持 Pi session v${version}（当前支持 JSONL v3）`)
  const header: SessionHeader = {
    type: 'session',
    version,
    id: asString(rawHeader.id, 'unknown'),
    timestamp: asString(rawHeader.timestamp, new Date(0).toISOString()),
    cwd: asString(rawHeader.cwd, '(unknown cwd)'),
    ...(typeof rawHeader.parentSession === 'string' ? { parentSession: rawHeader.parentSession } : {}),
  }

  const entries: SessionEntry[] = []
  const byId = new Map<string, SessionEntry>()
  for (const value of parsed) {
    if (value.type === 'session') continue
    if (typeof value.type !== 'string' || typeof value.id !== 'string') {
      warnings.push('忽略缺少 type/id 的 entry')
      continue
    }
    const entry = value as SessionEntry
    if (byId.has(entry.id)) {
      warnings.push(`发现重复 entry id：${entry.id}`)
      continue
    }
    if (entry.parentId !== null && typeof entry.parentId !== 'string') {
      warnings.push(`entry ${entry.id} 的 parentId 非法，按根节点处理`)
      entry.parentId = null
    }
    entries.push(entry)
    byId.set(entry.id, entry)
  }

  const children = new Map<string | null, SessionEntry[]>()
  for (const entry of entries) {
    const key = entry.parentId
    const bucket = children.get(key) ?? []
    bucket.push(entry)
    children.set(key, bucket)
    if (key !== null && !byId.has(key)) warnings.push(`entry ${entry.id} 引用了不存在的父节点 ${key}`)
  }
  const leaves = entries.filter(entry => !children.has(entry.id))
  return {
    header,
    entries,
    byId,
    children,
    activeLeafId: entries.at(-1)?.id ?? null,
    leaves,
    warnings,
  }
}

export function resolveBranch(session: ParsedPiSession, leafId = session.activeLeafId): SessionEntry[] {
  if (leafId === null) return []
  const branch: SessionEntry[] = []
  const seen = new Set<string>()
  let current = session.byId.get(leafId)
  if (current === undefined) throw new Error(`找不到分支 leaf：${leafId}`)
  while (current !== undefined) {
    if (seen.has(current.id)) throw new Error(`session 树存在环：${current.id}`)
    seen.add(current.id)
    branch.push(current)
    current = current.parentId === null ? undefined : session.byId.get(current.parentId)
  }
  branch.reverse()
  return branch
}

function branchPreview(branch: readonly SessionEntry[]): string {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const message = messageOf(branch[index]!)
    if (message?.role === 'user') return clip(textContent(message.content).replace(/\s+/g, ' ').trim(), 80)
  }
  return '无用户消息'
}

export function listBranches(session: ParsedPiSession): BranchInfo[] {
  const labels = new Map<string, string>()
  for (const entry of session.entries) {
    if (entry.type !== 'label' || typeof entry.targetId !== 'string') continue
    if (typeof entry.label === 'string' && entry.label !== '') labels.set(entry.targetId, entry.label)
    else labels.delete(entry.targetId)
  }
  return session.leaves
    .map(leaf => {
      const branch = resolveBranch(session, leaf.id)
      const label = labels.get(leaf.id)
      return {
        id: leaf.id,
        active: leaf.id === session.activeLeafId,
        depth: branch.length,
        timestamp: leaf.timestamp,
        preview: branchPreview(branch),
        ...(label === undefined ? {} : { label }),
      }
    })
    .sort((left, right) => Number(right.active) - Number(left.active) || Date.parse(right.timestamp) - Date.parse(left.timestamp))
}

function toolArguments(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? {}, null, 2) }
  catch { return String(value) }
}

function toolResultText(message: Record<string, unknown>): string {
  const text = textContent(message.content)
  if (text !== '') return text
  return isRecord(message.details) ? toolArguments(message.details) : ''
}

function modelErrorTool(entry: SessionEntry, message: Record<string, unknown>, s: number, e: number): MazeTool {
  const stopReason = asString(message.stopReason, 'error')
  const result = asString(message.errorMessage, `模型请求以 ${stopReason} 结束`)
  const verdict = toolVerdict({ name: 'model', res: result, err: true })
  return {
    k: 't', name: 'model', s, e, args: `${asString(message.provider, 'unknown')}/${asString(message.model, 'unknown')}`,
    res: result.slice(0, 380), resFull: result.slice(0, 5000), err: true, dur: roundT(Math.max(0, e - s)),
    v: verdict.v, why: `模型响应 ${stopReason}；${verdict.why}`, callId: `model:${entry.id}`,
  }
}

export function sessionToMaze(session: ParsedPiSession, leafId = session.activeLeafId, laneKey = 'l1', includeImages = true): MazeData {
  const branch = resolveBranch(session, leafId)
  const firstUser = branch.find(entry => entryRole(entry) === 'user')
  const anchorMs = firstUser === undefined ? isoMs(session.header.timestamp, Date.now()) : messageTime(firstUser)
  const rel = (ms: number): number => roundT(Math.max(0, (ms - anchorMs) / 1000))

  const resultByCall = new Map<string, { entry: SessionEntry; message: Record<string, unknown> }>()
  for (const entry of branch) {
    const message = messageOf(entry)
    if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
      resultByCall.set(message.toolCallId, { entry, message })
    }
  }

  const rows: MazeNode[] = []
  let turn = 0
  let step = 0
  let pendingPrompt = ''
  let pendingPromptImages: MazeImage[] = []
  let latestModel: string | null = null
  let latestProvider: string | null = null

  for (const entry of branch) {
    if (entry.type === 'model_change') {
      if (typeof entry.modelId === 'string') latestModel = entry.modelId
      if (typeof entry.provider === 'string') latestProvider = entry.provider
      continue
    }
    const message = messageOf(entry)
    if (message === null) continue
    const role = asString(message.role)
    if (role === 'user') {
      turn += 1
      pendingPrompt = textContent(message.content).trim()
      pendingPromptImages = includeImages ? imageContent(message.content) : []
      continue
    }
    if (role === 'assistant') {
      step += 1
      if (typeof message.model === 'string') latestModel = message.model
      if (typeof message.provider === 'string') latestProvider = message.provider
      const requestStart = rel(messageTime(entry))
      const responseEnd = Math.max(requestStart, rel(isoMs(entry.timestamp, messageTime(entry))))
      const tools: MazeTool[] = []
      for (const block of contentBlocks(message.content)) {
        if (block.type !== 'toolCall') continue
        const callId = asString(block.id, `${entry.id}:${tools.length}`)
        const result = resultByCall.get(callId)
        const end = result === undefined ? null : Math.max(responseEnd, rel(isoMs(result.entry.timestamp, responseEnd * 1000 + anchorMs)))
        const fullResult = result === undefined ? '' : toolResultText(result.message)
        const resultImages = includeImages && result !== undefined ? imageContent(result.message.content) : []
        const error = result?.message.isError === true
        const verdict = result === undefined
          ? { v: 'ok' as const, why: '工具结果尚未写入 session，暂留主干' }
          : toolVerdict({ name: asString(block.name, '?'), res: fullResult, err: error })
        tools.push({
          k: 't', name: asString(block.name, '?'), s: responseEnd, e: end,
          args: toolArguments(block.arguments), res: fullResult.slice(0, 380), resFull: fullResult.slice(0, 5000),
          ...(resultImages.length === 0 ? {} : { images: resultImages }),
          err: error, dur: end === null ? 0 : roundT(Math.max(0, end - responseEnd)), v: verdict.v, why: verdict.why, callId,
        })
      }
      const stopReason = asString(message.stopReason)
      if (stopReason === 'error' || stopReason === 'aborted') tools.push(modelErrorTool(entry, message, requestStart, responseEnd))
      const thinking = thinkingText(message)
      const answer = assistantText(message)
      const answerImages = includeImages ? imageContent(message.content) : []
      const usage = usageOf(message.usage)
      const end = Math.max(responseEnd, ...tools.map(tool => tool.e ?? responseEnd))
      const prompt = pendingPrompt
      const promptImages = pendingPromptImages
      pendingPrompt = ''
      pendingPromptImages = []
      rows.push({
        step, entryId: entry.id, turn: Math.max(turn, 1), s: requestStart, e: end, tools,
        rz: thinking.count, rzTxt: thinking.text.slice(0, 240), rzTxtFull: thinking.text.slice(0, 2000),
        rzTok: usage?.reasoning ?? null, outTok: usage?.output ?? null,
        ...(prompt === '' ? {} : { prompt: clip(prompt, 5000) }),
        ...(promptImages.length === 0 ? {} : { promptImages }),
        ...(answer === '' ? {} : { answer: clip(answer, 5000) }),
        ...(answerImages.length === 0 ? {} : { answerImages }),
        ...(latestModel === null ? {} : { model: latestModel }),
        ...(latestProvider === null ? {} : { provider: latestProvider }),
        ...(stopReason === '' ? {} : { stopReason }),
        ...(usage === undefined ? {} : { usage }),
        v: 'ok',
      })
      continue
    }
    if (role === 'bashExecution') {
      // Pi treats each explicit !/!! shell execution as its own user turn.
      turn += 1
      step += 1
      const start = rel(messageTime(entry))
      const end = Math.max(start, rel(isoMs(entry.timestamp, messageTime(entry))))
      const output = asString(message.output)
      const error = finiteNumber(message.exitCode) !== 0 || message.cancelled === true
      const verdict = toolVerdict({ name: 'bash', res: output, err: error })
      const tool: MazeTool = {
        k: 't', name: 'bash', s: start, e: end, args: asString(message.command), res: output.slice(0, 380), resFull: output.slice(0, 5000),
        err: error, dur: roundT(end - start), v: verdict.v, why: verdict.why, callId: `bash:${entry.id}`,
      }
      rows.push({
        step, entryId: entry.id, turn: Math.max(turn, 1), s: start, e: end, tools: [tool], rz: 0, rzTxt: '',
        rzTok: null, outTok: null, v: tool.v, ...(tool.why === undefined ? {} : { why: tool.why }),
      })
    }
  }

  const settledTools = rows.flatMap(row => row.tools.filter(tool => tool.e !== null))
  markRetryClusters(settledTools)
  for (const row of rows) {
    if (row.tools.length === 0) {
      row.v = 'answer'
      row.why = row.answer ? '无工具调用，输出回答' : '无工具调用，模型完成本步'
      continue
    }
    const settled = row.tools.filter(tool => tool.e !== null)
    const worst = stepVerdict(settled)
    if (worst === null) {
      row.v = 'ok'
      row.why = '工具结果尚未写入 session，暂留主干'
    } else {
      row.v = worst.v
      if (worst.why !== undefined) row.why = worst.why
    }
  }

  const main: MazeNode[] = []
  const detours: MazeNode[] = []
  let lastMain: MazeNode | null = null
  for (const row of rows) {
    if (row.v === 'ok' || row.v === 'answer') {
      main.push(row)
      lastMain = row
    } else {
      detours.push({ ...row, attach: lastMain?.step ?? 0 })
    }
  }
  // Compaction and branch-summary model calls are billed too even though they
  // are metadata markers rather than visible assistant steps.
  const usages = [
    ...rows.flatMap(row => row.usage === undefined ? [] : [row.usage]),
    ...branch.flatMap(entry => {
      if (entry.type === 'compaction' || entry.type === 'branch_summary') {
        const usage = usageOf(entry.usage)
        return usage === undefined ? [] : [usage]
      }
      const message = messageOf(entry)
      if (message?.role === 'toolResult') {
        const usage = usageOf(message.usage)
        return usage === undefined ? [] : [usage]
      }
      return []
    }),
  ]
  const sum = (pick: (usage: PiUsage) => number): number => usages.reduce((total, usage) => total + pick(usage), 0)
  const T = Math.max(0.1, ...rows.map(row => row.e))
  const lane: MazeLane = {
    key: laneKey,
    role: 'main',
    anchorMs,
    model: latestModel,
    provider: latestProvider,
    preWindow: 0,
    main,
    detours,
    stats: {
      steps: rows.length,
      tools: rows.reduce((total, row) => total + row.tools.length, 0),
      rz: rows.reduce((total, row) => total + row.rz, 0),
      rzTok: usages.some(usage => usage.reasoning !== null) ? sum(usage => usage.reasoning ?? 0) : null,
      outTok: usages.length === 0 ? null : sum(usage => usage.output),
      inputTok: sum(usage => usage.input),
      cacheReadTok: sum(usage => usage.cacheRead),
      totalTok: sum(usage => usage.totalTokens),
      cost: sum(usage => usage.cost),
      T,
      main: main.length,
      detours: detours.length,
    },
  }
  return { Tmax: Math.max(T, 60), lanes: [lane] }
}

function latestSessionName(branch: readonly SessionEntry[]): string | null {
  let name: string | null = null
  for (const entry of branch) {
    if (entry.type === 'session_info') name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : null
  }
  return name
}

export function buildSessionSummary(session: ParsedPiSession, facts: SessionFileFacts): SessionSummary {
  const branch = resolveBranch(session)
  const maze = sessionToMaze(session, session.activeLeafId, 'l1', false)
  const lane = maze.lanes[0]!
  const userEntries = branch.filter(entry => entryRole(entry) === 'user')
  const turnEntries = branch.filter(entry => {
    const role = entryRole(entry)
    return role === 'user' || role === 'bashExecution'
  })
  const firstPrompt = userEntries.length === 0 ? '' : textContent(messageOf(userEntries[0]!)?.content).replace(/\s+/g, ' ').trim()
  const createdMs = isoMs(session.header.timestamp, 0)
  const modifiedMs = isoMs(facts.modifiedAt, createdMs)
  const name = latestSessionName(branch)
  return {
    id: facts.id,
    sessionId: session.header.id,
    version: session.header.version,
    name,
    cwd: session.header.cwd,
    project: basename(session.header.cwd) || session.header.cwd,
    firstPrompt: clip(firstPrompt, 180),
    createdAt: new Date(createdMs).toISOString(),
    modifiedAt: new Date(modifiedMs).toISOString(),
    size: facts.size,
    turns: turnEntries.length,
    steps: lane.stats.steps,
    tools: lane.stats.tools,
    branches: session.leaves.length,
    compactions: branch.filter(entry => entry.type === 'compaction').length,
    model: lane.model,
    provider: lane.provider ?? null,
    totalTokens: lane.stats.totalTok,
    cost: lane.stats.cost,
    durationMs: Math.max(0, lane.stats.T * 1000),
    active: (facts.now ?? Date.now()) - modifiedMs < 120_000,
    parentSession: session.header.parentSession ?? null,
    parentId: null,
    subagents: 0,
    warningCount: session.warnings.length,
  }
}
