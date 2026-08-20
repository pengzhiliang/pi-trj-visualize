import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'lib/web')
await mkdir(out, { recursive: true })
await cp(resolve(root, 'src/web/maze.html'), resolve(out, 'maze.html'))
await cp(resolve(root, 'src/web/index.html'), resolve(out, 'index.html'))
