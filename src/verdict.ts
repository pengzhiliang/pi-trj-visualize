import type { MazeTool, Verdict } from './types.js'

export const VERDICT_RULES = {
  ERROR_PATTERNS_STRONG: /\[stderr\].*(Error|Traceback|File ")|\[status=Failed\]|__EXIT__=[1-9]/i,
  ERROR_PATTERNS_WEAK: /Traceback \(most recent|command not found|Permission denied|No such file|HTTP 40\d|HTTP 50\d|^Error:/i,
  ERROR_HEAD_SCAN: 300,
  ERROR_TAIL_SCAN: 1000,
  WRITE_TOOLS: ['write', 'edit', 'todo_write'],
  SEARCH_TOOLS: ['grep', 'read', 'find', 'ls', 'web_search', 'read_image'],
  NO_RESULT_PATTERNS: /^(---)?$|no matches|no results|not found in/i,
  RETRY_SIMILARITY: 0.6,
  RETRY_MIN_CLUSTER: 2,
} as const

export const SEV: Record<string, number> = { error: 4, retry: 3, deadend: 2, ok: 0, answer: 0 }

export interface VerdictInput {
  name: string
  res?: string
  err?: boolean
}

export interface VerdictResult {
  v: Verdict
  why: string
}

export function toolVerdict(ev: VerdictInput): VerdictResult {
  if (ev.err) return { v: 'error', why: '工具返回错误标志（isError）' }
  const txt = (ev.res ?? '').trim()
  const head = txt.slice(0, VERDICT_RULES.ERROR_HEAD_SCAN)
  const tail = txt.slice(-VERDICT_RULES.ERROR_TAIL_SCAN)
  const strong = VERDICT_RULES.ERROR_PATTERNS_STRONG.exec(head) ?? VERDICT_RULES.ERROR_PATTERNS_STRONG.exec(tail)
  if (strong !== null) return { v: 'error', why: `输出命中失败特征「${strong[0].slice(0, 48)}」` }
  const weak = VERDICT_RULES.ERROR_PATTERNS_WEAK.exec(head)
  if (weak !== null) return { v: 'error', why: `输出开头命中失败特征「${weak[0].slice(0, 48)}」` }
  if ((VERDICT_RULES.WRITE_TOOLS as readonly string[]).includes(ev.name)) return { v: 'ok', why: '写入类工具，无错误即成功' }
  if ((VERDICT_RULES.SEARCH_TOOLS as readonly string[]).includes(ev.name)) {
    if (VERDICT_RULES.NO_RESULT_PATTERNS.test(head)) {
      return { v: 'deadend', why: txt === '' ? '检索返回为空，判为扑空' : '检索开头命中无结果特征，判为扑空' }
    }
    return { v: 'ok', why: '检索有返回' }
  }
  if (VERDICT_RULES.NO_RESULT_PATTERNS.test(head)) return { v: 'deadend', why: '退出正常但无输出，判为扑空' }
  return { v: 'ok', why: '退出正常且有输出' }
}

export function stepVerdict<T extends { v: string }>(tools: readonly T[]): T | null {
  let worst: T | null = null
  for (const tool of tools) {
    if (worst === null || (SEV[tool.v] ?? 0) > (SEV[worst.v] ?? 0)) worst = tool
  }
  return worst
}

function argTokens(value: string): Set<string> {
  const tokens = new Set<string>()
  for (const word of String(value).split(/[^\w一-鿿./-]+/)) if (word.length > 2) tokens.add(word)
  return tokens
}

export function argSimilarity(a: string, b: string): number {
  const left = argTokens(a)
  const right = argTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const word of left) if (right.has(word)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

export function markRetryClusters<T extends Pick<MazeTool, 'name' | 'args' | 'v' | 'why'>>(calls: T[]): number {
  let clusters = 0
  let start = 0
  for (let i = 1; i <= calls.length; i += 1) {
    const shouldBreak = i === calls.length
      || calls[i]!.name !== calls[i - 1]!.name
      || argSimilarity(calls[i]!.args, calls[i - 1]!.args) < VERDICT_RULES.RETRY_SIMILARITY
    if (!shouldBreak) continue
    const length = i - start
    if (length >= VERDICT_RULES.RETRY_MIN_CLUSTER) {
      const cluster = calls.slice(start, i)
      const failures = cluster.filter(call => call.v === 'error').length
      if (failures > 0) {
        clusters += 1
        for (const call of cluster) {
          if (call.v === 'error') call.why = `${call.why ?? ''}；处于连续重试簇（同一操作共 ${length} 次）`
          else {
            call.v = 'retry'
            call.why = `同一操作连续重试 ${length} 次（其中 ${failures} 次失败），判为盲目重试`
          }
        }
      }
    }
    start = i
  }
  return clusters
}
