/**
 * PoC 架构探针：用纯 Node 拉起 Python dsh-bridge，走 MCP stdio 完成握手 + tools/list。
 *
 * 目的：在写插件之前，独立验证「Node → spawn Python → MCP 握手 → 工具发现」这条链。
 * 只调 tools/list（**只读**，不触发任何真站访问，不违反 G20 频控铁律）。
 *
 * 用法：node probe/mcp-probe.mjs
 */
import { spawn } from 'node:child_process'

const CWD = 'D:\\claude-code\\dsh-bridge'
const COMMAND = 'uv'
const ARGS = ['run', '--no-sync', 'dsh-bridge']

const child = spawn(COMMAND, ARGS, {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
})

let buf = ''
const pending = new Map()
let nextId = 1

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n')
}

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }
    }, 30000)
  })
}

child.stdout.setEncoding('utf-8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      console.log('[non-json stdout]', line.slice(0, 200))
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }
})

child.stderr.setEncoding('utf-8')
child.stderr.on('data', (d) => {
  const t = String(d).trim()
  if (t) console.log('[stderr]', t.split('\n').slice(0, 3).join(' | '))
})

child.on('error', (e) => {
  console.error('SPAWN ERROR:', e.message)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  console.log(`[child exited] code=${code} signal=${signal}`)
})

const main = async () => {
  console.log('=== 1. initialize ===')
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-bridge-plugin-probe', version: '0.0.1' },
  })
  console.log('serverInfo:', JSON.stringify(init.serverInfo))
  console.log('protocolVersion:', init.protocolVersion)
  console.log('capabilities:', JSON.stringify(init.capabilities))

  console.log('=== 2. notifications/initialized ===')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  console.log('=== 3. tools/list ===')
  const list = await request('tools/list', {})
  const tools = list.tools ?? []
  console.log(`发现 ${tools.length} 个工具：`)
  for (const t of tools) {
    console.log(`  - ${t.name}`)
  }

  const target = tools.find((t) => t.name === 'ask_deepseek')
  if (target) {
    console.log('\n=== ask_deepseek 的 inputSchema ===')
    console.log(JSON.stringify(target.inputSchema, null, 2))
    console.log('\n=== description ===')
    console.log(target.description)
  } else {
    console.log('⚠️  未找到 ask_deepseek')
  }

  child.kill()
  process.exit(0)
}

main().catch((e) => {
  console.error('PROBE FAILED:', e.message)
  child.kill()
  process.exit(1)
})
