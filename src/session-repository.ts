import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import {
  buildSessionSummary,
  listBranches,
  parsePiSessionText,
  sessionToolResultText,
  sessionToMaze,
  type ParsedPiSession,
} from './pi-session.js'
import type { MazeLane, SessionDetail, SessionSummary } from './types.js'

interface CacheEntry {
  stamp: string
  summary: SessionSummary
}

interface DetailCacheEntry {
  stamp: string
  parsed: ParsedPiSession
}

interface IndexedFile {
  id: string
  path: string
  relativePath: string
  stamp: string
  summary: SessionSummary
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

async function configuredSessionRoot(): Promise<string> {
  const environmentRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  if (environmentRoot) return resolve(expandHome(environmentRoot))
  const agentRoot = resolve(expandHome(process.env.PI_CODING_AGENT_DIR ?? '~/.pi/agent'))
  try {
    const settings: unknown = JSON.parse(await readFile(join(agentRoot, 'settings.json'), 'utf8'))
    if (settings !== null && typeof settings === 'object' && 'sessionDir' in settings) {
      const candidate = (settings as { sessionDir?: unknown }).sessionDir
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        const expanded = expandHome(candidate)
        return resolve(isAbsolute(expanded) ? expanded : join(agentRoot, expanded))
      }
    }
  } catch {
    // A missing or malformed settings file must not hide the default session directory.
  }
  return join(agentRoot, 'sessions')
}

export async function resolveSessionRoot(override?: string): Promise<string> {
  return override === undefined ? configuredSessionRoot() : resolve(expandHome(override))
}

async function findJsonlFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (current: string): Promise<void> => {
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) }
    catch (error) {
      if (current === directory) throw error
      return
    }
    await Promise.all(entries.map(async entry => {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }))
  }
  await walk(directory)
  return files.sort()
}

function opaqueId(root: string, relativePath: string): string {
  return createHash('sha256').update(root).update('\0').update(relativePath).digest('base64url').slice(0, 18)
}

const SUBAGENT_COLORS = ['#0891b2', '#d97706', '#db2777', '#4f46e5', '#65a30d', '#ea580c', '#0d9488']

function shiftLane(lane: MazeLane, offset: number): void {
  for (const node of [...lane.main, ...lane.detours]) {
    node.s += offset
    node.e += offset
    for (const tool of node.tools) {
      tool.s += offset
      if (tool.e !== null) tool.e += offset
    }
  }
}

function laneEnd(lane: MazeLane): number {
  return Math.max(0, ...[...lane.main, ...lane.detours].map(node => node.e))
}

function attachLazyResults(lane: MazeLane, sessionId: string, leafId?: string): void {
  for (const node of [...lane.main, ...lane.detours]) {
    for (const tool of node.tools) {
      if (!tool.callId || tool.callId.startsWith('model:') || (tool.resultLength ?? 0) === 0) continue
      const params = new URLSearchParams({ id: sessionId, callId: tool.callId })
      if (leafId) params.set('leaf', leafId)
      tool.resultRef = `/api/tool-result?${params.toString()}`
      delete tool.resFull
    }
  }
}

export class SessionRepository {
  readonly root: string
  // The list cache contains summaries only. Full parsed trees can be many times
  // larger than their JSONL and therefore live in a deliberately tiny LRU used
  // only by detail views.
  #cache = new Map<string, CacheEntry>()
  #detailCache = new Map<string, DetailCacheEntry>()
  #index = new Map<string, IndexedFile>()
  #scanPromise: Promise<SessionSummary[]> | null = null

  private constructor(root: string) {
    this.root = root
  }

  static async create(rootOverride?: string): Promise<SessionRepository> {
    const requestedRoot = await resolveSessionRoot(rootOverride)
    let canonicalRoot: string
    try { canonicalRoot = await realpath(requestedRoot) }
    catch { canonicalRoot = requestedRoot }
    return new SessionRepository(canonicalRoot)
  }

  async scan(): Promise<SessionSummary[]> {
    if (this.#scanPromise !== null) return this.#scanPromise
    this.#scanPromise = this.#performScan().finally(() => { this.#scanPromise = null })
    return this.#scanPromise
  }

  async #performScan(): Promise<SessionSummary[]> {
    const files = await findJsonlFiles(this.root)
    const now = Date.now()
    const nextIndex = new Map<string, IndexedFile>()
    const summaries: SessionSummary[] = []
    let cursor = 0

    // Bound file reads/parses so a large ~/.pi cannot turn one refresh into an
    // unbounded file-descriptor and heap spike.
    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const path = files[cursor++]!
        let fileStat
        try { fileStat = await stat(path) }
        catch { continue } // The file may disappear between readdir and stat.
        const relativePath = relative(this.root, path)
        const id = opaqueId(this.root, relativePath)
        const stamp = `${fileStat.mtimeMs}:${fileStat.size}`
        let cached = this.#cache.get(path)
        if (cached?.stamp !== stamp) {
          this.#detailCache.delete(path)
          let summary: SessionSummary
          try {
            const parsed = parsePiSessionText(await readFile(path, 'utf8'))
            summary = buildSessionSummary(parsed, {
              id,
              size: fileStat.size,
              modifiedAt: fileStat.mtime.toISOString(),
              now,
            })
          } catch (error) {
            const timestamp = fileStat.mtime.toISOString()
            summary = {
              id,
              sessionId: relativePath,
              version: 0,
              name: null,
              cwd: '(无法解析)',
              project: relativePath.split('/')[0] ?? relativePath,
              firstPrompt: '',
              createdAt: timestamp,
              modifiedAt: timestamp,
              size: fileStat.size,
              turns: 0,
              steps: 0,
              tools: 0,
              branches: 0,
              compactions: 0,
              model: null,
              provider: null,
              totalTokens: 0,
              cost: 0,
              durationMs: 0,
              active: now - fileStat.mtimeMs < 120_000,
              parentSession: null,
              parentId: null,
              subagents: 0,
              warningCount: 1,
              error: error instanceof Error ? error.message : String(error),
            }
          }
          cached = { stamp, summary }
          this.#cache.set(path, cached)
        }
        // active is time-sensitive even while the summary remains cached.
        cached.summary.active = now - fileStat.mtimeMs < 120_000
        cached.summary.modifiedAt = fileStat.mtime.toISOString()
        nextIndex.set(id, { id, path, relativePath, stamp, summary: cached.summary })
        summaries.push(cached.summary)
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, () => worker()))

    // Resolve Pi's header.parentSession path into the opaque id namespace and
    // keep child sessions out of the root-level UI. The relationship remains
    // valid for nested subagents as well.
    const byPath = new Map<string, IndexedFile>()
    const byBasename = new Map<string, IndexedFile[]>()
    for (const indexed of nextIndex.values()) {
      indexed.summary.parentId = null
      indexed.summary.subagents = 0
      byPath.set(resolve(indexed.path), indexed)
      const sameName = byBasename.get(basename(indexed.path)) ?? []
      sameName.push(indexed)
      byBasename.set(basename(indexed.path), sameName)
    }
    for (const indexed of nextIndex.values()) {
      if (indexed.summary.parentSession === null) continue
      const exact = byPath.get(resolve(indexed.summary.parentSession))
      const sameName = byBasename.get(basename(indexed.summary.parentSession)) ?? []
      const parent = exact ?? (sameName.length === 1 ? sameName[0] : undefined)
      if (parent === undefined) continue
      indexed.summary.parentId = parent.id
      parent.summary.subagents += 1
    }

    const livePaths = new Set(files)
    for (const path of this.#cache.keys()) if (!livePaths.has(path)) this.#cache.delete(path)
    for (const path of this.#detailCache.keys()) if (!livePaths.has(path)) this.#detailCache.delete(path)
    this.#index = nextIndex
    return summaries.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
  }

  async #parsedDetail(indexed: IndexedFile): Promise<ParsedPiSession> {
    const cached = this.#detailCache.get(indexed.path)
    if (cached?.stamp === indexed.stamp) {
      // Map insertion order is the LRU order.
      this.#detailCache.delete(indexed.path)
      this.#detailCache.set(indexed.path, cached)
      return cached.parsed
    }
    const parsed = parsePiSessionText(await readFile(indexed.path, 'utf8'))
    this.#detailCache.set(indexed.path, { stamp: indexed.stamp, parsed })
    while (this.#detailCache.size > 4) {
      const oldest = this.#detailCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#detailCache.delete(oldest)
    }
    return parsed
  }

  async toolResult(id: string, callId: string, leafId?: string): Promise<string> {
    await this.scan()
    const indexed = this.#index.get(id)
    if (indexed === undefined) throw new Error('SESSION_NOT_FOUND')
    if (indexed.summary.error !== undefined) throw new Error(`SESSION_INVALID:${indexed.summary.error}`)
    const parsed = await this.#parsedDetail(indexed)
    const result = sessionToolResultText(parsed, callId, leafId ?? parsed.activeLeafId)
    if (result === null) throw new Error('TOOL_RESULT_NOT_FOUND')
    return result
  }

  async detail(id: string, leafId?: string): Promise<SessionDetail> {
    await this.scan()
    const indexed = this.#index.get(id)
    if (indexed === undefined) throw new Error('SESSION_NOT_FOUND')
    if (indexed.summary.error !== undefined) throw new Error(`SESSION_INVALID:${indexed.summary.error}`)
    const parsed = await this.#parsedDetail(indexed)
    const selectedLeafId = leafId ?? parsed.activeLeafId ?? undefined
    const data = sessionToMaze(parsed, selectedLeafId)
    data.lanes[0]!.title = indexed.summary.name ?? indexed.summary.project
    const subagents = [...this.#index.values()]
      .filter(candidate => candidate.summary.parentId === id && candidate.summary.error === undefined)
      .map(candidate => candidate.summary)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))

    // Child session_info names use "Type#<agent-id-prefix>". Agent tool results
    // carry the same id, so wire the parent step directly to the full child
    // trajectory without loading every child JSONL eagerly.
    const tools = data.lanes.flatMap(lane => [...lane.main, ...lane.detours].flatMap(node => node.tools))
    const records = parsed.entries.flatMap(entry => {
      if (entry.type !== 'custom' || entry.customType !== 'subagents:record' || entry.data === null || typeof entry.data !== 'object') return []
      const record = entry.data as { id?: unknown; description?: unknown }
      return typeof record.id === 'string'
        ? [{ id: record.id, description: typeof record.description === 'string' ? record.description : '' }]
        : []
    })
    const parentAnchor = data.lanes[0]!.anchorMs ?? Date.parse(indexed.summary.createdAt)
    const parentNodes = [...data.lanes[0]!.main, ...data.lanes[0]!.detours].sort((left, right) => left.s - right.s)
    const linkedCalls = new Map<string, string>()
    for (const child of subagents) {
      const prefix = child.name?.split('#').at(-1)
      if (!prefix) continue
      const record = records.find(candidate => candidate.id.startsWith(prefix))
      const availableAgentTools = tools.filter(candidate => candidate.name.toLowerCase().endsWith('agent') && candidate.linkedSessionId === undefined)
      // Prefer the successful launch result carrying the real Agent ID. A
      // description-only fallback may point at an earlier failed dispatch
      // attempt (for example, "Model not found" followed by a retry).
      const tool = availableAgentTools.find(candidate => String(candidate.resFull ?? candidate.res).includes(prefix))
        ?? (record?.description ? availableAgentTools.find(candidate => candidate.args.includes(record.description)) : undefined)
      if (tool === undefined) continue
      tool.linkedSessionId = child.id
      tool.linkedSessionName = child.name ?? child.project
      if (tool.callId) linkedCalls.set(child.id, tool.callId)
    }

    const returnCalls = new Map<string, string>()
    const returnSteps = new Map<string, number>()
    for (const child of subagents) {
      const prefix = child.name?.split('#').at(-1)
      if (!prefix) continue
      const record = records.find(candidate => candidate.id.startsWith(prefix))
      const identity = record?.id ?? prefix
      const retrieval = tools.find(candidate => {
        if (!candidate.name.toLowerCase().endsWith('get_subagent_result')) return false
        const haystack = `${candidate.args}\n${candidate.resFull ?? candidate.res}`
        return haystack.includes(identity) || haystack.includes(prefix)
      })
      if (retrieval?.callId) {
        returnCalls.set(child.id, retrieval.callId)
        continue
      }
      // A background notification enters the parent context before its next
      // assistant step even when no explicit get_subagent_result call exists.
      const notification = parsed.entries.find(entry =>
        entry.type === 'custom_message'
        && String(entry.content ?? '').includes(identity))
      if (notification === undefined) continue
      const at = Math.max(0, (Date.parse(notification.timestamp) - parentAnchor) / 1000)
      const target = parentNodes.find(node => node.s >= at)
      if (target) returnSteps.set(child.id, target.step)
    }

    // Render direct Subagent sessions as colored lanes on the parent's real
    // wall-clock axis. They remain independently openable for a focused view.
    data.lanes[0]!.role = 'main'
    data.lanes[0]!.color = '#2563eb'
    for (let index = 0; index < subagents.length; index += 1) {
      const child = subagents[index]!
      const childIndexed = this.#index.get(child.id)
      if (childIndexed === undefined) continue
      try {
        const childParsed = await this.#parsedDetail(childIndexed)
        const childData = sessionToMaze(childParsed, childParsed.activeLeafId, `sa${index + 1}`)
        const lane = childData.lanes[0]!
        const offset = Math.max(0, ((lane.anchorMs ?? Date.parse(child.createdAt)) - parentAnchor) / 1000)
        shiftLane(lane, offset)
        lane.role = 'subagent'
        lane.color = SUBAGENT_COLORS[index % SUBAGENT_COLORS.length]!
        lane.title = child.name ?? `Subagent ${index + 1}`
        lane.parentId = id
        const parentCallId = linkedCalls.get(child.id)
        if (parentCallId) lane.parentCallId = parentCallId
        const returnCallId = returnCalls.get(child.id)
        const returnStep = returnSteps.get(child.id)
        if (returnCallId) lane.returnCallId = returnCallId
        else if (returnStep !== undefined) lane.returnStep = returnStep
        attachLazyResults(lane, child.id, childParsed.activeLeafId ?? undefined)
        data.lanes.push(lane)
      } catch {
        // The summary remains available in the picker if a concurrently-written
        // child cannot be parsed for inline rendering yet.
      }
    }
    attachLazyResults(data.lanes[0]!, id, selectedLeafId)
    data.Tmax = Math.max(60, ...data.lanes.map(laneEnd))
    return {
      session: indexed.summary,
      selectedLeafId: selectedLeafId ?? null,
      branches: listBranches(parsed),
      subagents,
      warnings: parsed.warnings,
      data,
    }
  }
}
