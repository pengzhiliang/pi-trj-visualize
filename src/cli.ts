#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createViewerServer, listen } from './server.js'
import { SessionRepository } from './session-repository.js'

interface CliOptions {
  host: string
  port: number
  sessionsDir?: string
  open: boolean
  help: boolean
}

function usage(): string {
  return `Pi Trj Visualize — visualize Pi coding-agent and Subagent trajectories

Usage:
  pi-trj-visualize [options]

Options:
  --host <address>       Listen address (default: 127.0.0.1)
  --port <number>        Listen port (default: 4310; use 0 for any free port)
  --sessions-dir <path>  Override Pi session directory
  --open                  Open the viewer in the default browser
  -h, --help              Show this help

Remote usage (recommended):
  remote$ pi-trj-visualize
  local$  ssh -L 4310:127.0.0.1:4310 <remote-host>
  Then open http://127.0.0.1:4310

Environment:
  PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR are respected.
`
}

export function parseCliArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { host: '127.0.0.1', port: 4310, open: false, help: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--open') options.open = true
    else if (arg === '--host') {
      const value = args[++index]
      if (!value) throw new Error('--host requires an address')
      options.host = value
    } else if (arg === '--port') {
      const value = args[++index]
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${value ?? ''}`)
      options.port = port
    } else if (arg === '--sessions-dir') {
      const value = args[++index]
      if (!value) throw new Error('--sessions-dir requires a path')
      options.sessionsDir = value
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

async function main(): Promise<void> {
  let options: CliOptions
  try { options = parseCliArgs(process.argv.slice(2)) }
  catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    console.error(usage())
    process.exitCode = 1
    return
  }
  if (options.help) {
    console.log(usage())
    return
  }
  const repository = await SessionRepository.create(options.sessionsDir)
  const loopback = options.host === '127.0.0.1' || options.host === '::1' || options.host === 'localhost'
  const server = createViewerServer({ repository, allowRemoteHost: !loopback })
  const address = await listen(server, options.host, options.port)
  const browserHost = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host
  const url = `http://${browserHost}:${address.port}`
  console.log('\n  π  Pi Trj Visualize')
  console.log(`  Viewer:  ${url}`)
  console.log(`  Sessions: ${repository.root}`)
  if (!loopback) {
    console.warn('  Warning: non-loopback binding exposes prompts, reasoning and tool output to the network.')
  } else {
    console.log(`  Remote:  ssh -L ${address.port}:127.0.0.1:${address.port} <host>`)
  }
  console.log('  Press Ctrl-C to stop.\n')
  if (options.open) openBrowser(url)
}

void main().catch(error => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
