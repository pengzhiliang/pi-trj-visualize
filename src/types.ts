export type Verdict = 'error' | 'deadend' | 'retry' | 'ok'
export type NodeVerdict = Verdict | 'answer'

export interface PiUsage {
  input: number
  output: number
  reasoning: number | null
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

export interface MazeImage {
  mimeType: string
  /** Inline base64 for synthetic data; persisted session images use ref instead. */
  data?: string
  /** Lazy same-origin endpoint for the persisted image bytes. */
  ref?: string
}

export interface MazeTool {
  k: 't'
  name: string
  s: number
  e: number | null
  args: string
  res: string
  /** Inline full result for synthetic/non-addressable tools only. */
  resFull?: string
  /** Lazy same-origin endpoint for the untruncated persisted result. */
  resultRef?: string
  resultLength?: number
  images?: MazeImage[]
  err: boolean
  dur: number
  v: Verdict
  why?: string
  callId?: string
  /** Child Pi session launched by this Agent tool call. */
  linkedSessionId?: string
  linkedSessionName?: string
}

export interface MazeNode {
  step: number
  entryId: string
  turn: number
  s: number
  e: number
  /** End of model generation / start of tool execution. */
  modelEnd?: number
  /** Timestamp of the user input that started this turn. */
  promptAt?: number
  /** Entry id used to address user images lazily. */
  promptEntryId?: string
  tools: MazeTool[]
  rz: number
  rzTxt: string
  rzTxtFull?: string
  rzTok: number | null
  outTok: number | null
  prompt?: string
  promptImages?: MazeImage[]
  answer?: string
  answerImages?: MazeImage[]
  model?: string
  provider?: string
  stopReason?: string
  usage?: PiUsage
  v: NodeVerdict
  why?: string
  /** Number of failed/dead-end/retry tool calls in an otherwise successful mixed step. */
  partialFailures?: number
  attach?: number
}

export interface MazeStats {
  steps: number
  tools: number
  rz: number
  rzTok: number | null
  outTok: number | null
  inputTok: number
  cacheReadTok: number
  totalTok: number
  cost: number
  T: number
  main: number
  detours: number
}

export interface MazeLane {
  key: string
  title?: string
  role?: 'main' | 'subagent'
  color?: string
  /** Absolute timestamp used to align child trajectories with their parent. */
  anchorMs?: number
  parentId?: string
  parentCallId?: string
  /** Parent tool call or step that consumed this Subagent's completed result. */
  returnCallId?: string
  returnStep?: number
  model: string | null
  provider?: string | null
  preWindow: number
  main: MazeNode[]
  detours: MazeNode[]
  stats: MazeStats
}

export interface MazeData {
  Tmax: number
  lanes: MazeLane[]
}

export interface BranchInfo {
  id: string
  active: boolean
  depth: number
  timestamp: string
  preview: string
  label?: string
}

export interface SessionSummary {
  id: string
  sessionId: string
  version: number
  name: string | null
  cwd: string
  project: string
  firstPrompt: string
  createdAt: string
  modifiedAt: string
  size: number
  turns: number
  steps: number
  tools: number
  branches: number
  compactions: number
  model: string | null
  provider: string | null
  totalTokens: number
  cost: number
  durationMs: number
  active: boolean
  parentSession: string | null
  /** Opaque parent session id when parentSession resolves inside the scan root. */
  parentId: string | null
  /** Direct child/subagent session count. */
  subagents: number
  warningCount: number
  error?: string
}

export interface SessionDetail {
  session: SessionSummary
  selectedLeafId: string | null
  branches: BranchInfo[]
  subagents: SessionSummary[]
  warnings: string[]
  data: MazeData
}
