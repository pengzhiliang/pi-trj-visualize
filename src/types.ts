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
  data: string
}

export interface MazeTool {
  k: 't'
  name: string
  s: number
  e: number | null
  args: string
  res: string
  resFull?: string
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
