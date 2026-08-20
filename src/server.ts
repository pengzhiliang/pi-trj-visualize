import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionRepository } from './session-repository.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

export interface ViewerServerOptions {
  repository: SessionRepository
  webRoot?: string
  /** Explicit non-loopback CLI bindings opt into accepting non-loopback Host headers. */
  allowRemoteHost?: boolean
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'SAMEORIGIN')
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'")
}

function json(response: ServerResponse, status: number, value: unknown): void {
  setSecurityHeaders(response)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function serveFile(response: ServerResponse, path: string): Promise<void> {
  try {
    const fileStat = await stat(path)
    if (!fileStat.isFile()) throw new Error('not a file')
    setSecurityHeaders(response)
    response.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Cache-Control': 'no-cache',
    })
    createReadStream(path).pipe(response)
  } catch {
    json(response, 404, { error: 'Not found' })
  }
}

function isLoopbackHost(header: string | undefined): boolean {
  if (header === undefined) return false
  try {
    const hostname = new URL(`http://${header}`).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '[::ffff:127.0.0.1]'
  } catch {
    return false
  }
}

export function createViewerServer(options: ViewerServerOptions): Server {
  const webRoot = options.webRoot ?? fileURLToPath(new URL('./web', import.meta.url))
  return createServer((request, response) => {
    void handleRequest(request, response, options.repository, webRoot, options.allowRemoteHost === true)
  })
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, repository: SessionRepository, webRoot: string, allowRemoteHost: boolean): Promise<void> {
  try {
    if (!allowRemoteHost && !isLoopbackHost(request.headers.host)) {
      json(response, 421, { error: 'Rejected Host header' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'GET') {
      json(response, 405, { error: 'Only GET is supported' })
      return
    }
    if (url.pathname === '/api/health') {
      json(response, 200, { ok: true, sessionsRoot: repository.root })
      return
    }
    if (url.pathname === '/api/sessions') {
      const sessions = await repository.scan()
      json(response, 200, {
        sessionsRoot: repository.root,
        scannedAt: new Date().toISOString(),
        total: sessions.length,
        active: sessions.filter(session => session.active).length,
        projects: new Set(sessions.map(session => session.cwd)).size,
        sessions,
      })
      return
    }
    if (url.pathname === '/api/session') {
      const id = url.searchParams.get('id')
      if (!id) {
        json(response, 400, { error: 'Missing session id' })
        return
      }
      try {
        const detail = await repository.detail(id, url.searchParams.get('leaf') ?? undefined)
        json(response, 200, detail)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'SESSION_NOT_FOUND') json(response, 404, { error: 'Session not found' })
        else if (message.startsWith('SESSION_INVALID:')) json(response, 422, { error: message.slice('SESSION_INVALID:'.length) })
        else if (message.startsWith('找不到分支 leaf')) json(response, 400, { error: message })
        else throw error
      }
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await serveFile(response, join(webRoot, 'index.html'))
      return
    }
    if (url.pathname === '/maze.html') {
      await serveFile(response, join(webRoot, 'maze.html'))
      return
    }
    json(response, 404, { error: 'Not found' })
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

export async function listen(server: Server, host: string, port: number): Promise<{ host: string; port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  return { host, port: typeof address === 'object' && address !== null ? address.port : port }
}
