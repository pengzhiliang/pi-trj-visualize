import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRepository } from '../src/session-repository.js'
import { createViewerServer, listen } from '../src/server.js'
import { request as httpRequest, type Server } from 'node:http'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

function tinySession(): string {
  return [
    { type: 'session', version: 3, id: 'tiny', timestamp: '2026-08-20T00:00:00.000Z', cwd: '/srv/project' },
    { type: 'message', id: 'u', parentId: null, timestamp: '2026-08-20T00:00:00.100Z', message: { role: 'user', content: 'Do the thing', timestamp: 1_787_184_000_100 } },
    { type: 'message', id: 'a', parentId: 'u', timestamp: '2026-08-20T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], provider: 'test', model: 'model', stopReason: 'stop', timestamp: 1_787_184_000_200, usage: { input: 10, output: 2, totalTokens: 12 } } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
}

describe('standalone server', () => {
  it('recursively discovers sessions and serves only opaque ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-trj-visualize-'))
    const nested = join(root, '--srv-project--')
    await mkdir(nested)
    await writeFile(join(nested, 'session.jsonl'), tinySession())
    const repository = await SessionRepository.create(root)
    const summaries = await repository.scan()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ cwd: '/srv/project', project: 'project', turns: 1, steps: 1 })
    expect(summaries[0]!.id).not.toContain('/')

    const server = createViewerServer({ repository, webRoot: join(process.cwd(), 'src/web') })
    servers.push(server)
    const address = await listen(server, '127.0.0.1', 0)
    const base = `http://127.0.0.1:${address.port}`
    const list = await fetch(`${base}/api/sessions`).then(response => response.json()) as { total: number; sessionsRoot: string; sessions: { id: string }[] }
    expect(list).toMatchObject({ total: 1, sessionsRoot: root })

    const detailResponse = await fetch(`${base}/api/session?id=${list.sessions[0]!.id}`)
    expect(detailResponse.status).toBe(200)
    const detail = await detailResponse.json() as { data: { lanes: { stats: { steps: number } }[] } }
    expect(detail.data.lanes[0]!.stats.steps).toBe(1)

    expect((await fetch(`${base}/api/session?id=../../etc/passwd`)).status).toBe(404)
    expect((await fetch(`${base}/api/session`)).status).toBe(400)
    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/health', headers: { Host: 'evil.example' } }, response => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      request.on('error', reject)
      request.end()
    })
    expect(rebindingStatus).toBe(421)
  })
})
