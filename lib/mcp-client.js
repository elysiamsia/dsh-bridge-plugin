/**
 * 极简 MCP stdio 客户端 —— 零外部依赖，只覆盖本插件需要的四个动作。
 *
 * 为什么手写而不用 `@modelcontextprotocol/sdk`：
 *   1. 本机 DSH 的 `@deepseek-ai/*` 与 `@modelcontextprotocol/sdk` 都是指向
 *      npx 缓存的 junction，路径脆弱；手写即自包含，不会被宿主依赖树变动打断。
 *   2. 只需 initialize / notifications-initialized / tools/list / tools/call，
 *      协议面极小，手写比引 SDK 更可控。
 *
 * 关键实现约束（都是踩过的坑，勿改）：
 *   - **逐行 JSON（NDJSON）**：MCP stdio framing 是「一行一条 JSON-RPC 消息」，
 *     用 `\n` 分隔。不能假设一个 data 事件等于一条完整消息 —— 必须缓冲后按
 *     `\n` 切分（Python 侧可能把多条消息合并写出，或一条消息跨多个 chunk）。
 *   - **stdout 是协议信道，stderr 才是日志**：bridge 启动横幅打在 stderr，
 *     绝不能把 stderr 混进 JSON 解析。
 *   - **串行化**：Python 侧是 Playwright 驱动真实浏览器，并发调用会互相踩。
 *     所有请求经同一条 promise 链排队。
 *   - **child 退出要拒绝所有在途请求**，否则调用方会一直挂到超时。
 */

/** JSON-RPC 协议版本。bridge 用 Python `mcp` SDK，会回选它支持的版本。 */
const PROTOCOL_VERSION = '2024-11-05'

/** @typedef {{ command: string, args: string[], cwd: string, env: Record<string, string>, toolCallTimeoutMs: number }} BridgeOptions */

/**
 * 一个 MCP stdio 连接。延迟启动：首次调用时才 spawn，避免插件加载期就拽起
 * 一个 Python 进程（那是 ~1s 的冷启动，会拖慢 DSH 启动）。
 */
export class McpStdioClient {
  /** @type {import('node:child_process').ChildProcess | null} */
  #child = null
  /** @type {BridgeOptions} */
  #options
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  #pending = new Map()
  /** stdout 行缓冲。 */
  #buffer = ''
  #nextId = 1
  /** 串行化队列尾。 */
  #queue = Promise.resolve()
  /** 握手只做一次。 */
  #ready = null
  /** 最近若干条 stderr，出错时附带，便于定位。 */
  #stderrTail = []

  /** @param {BridgeOptions} options */
  constructor(options) {
    this.#options = options
  }

  /** 已收集的 stderr 摘要（最近 40 行）。 */
  get stderrTail() {
    return this.#stderrTail.slice(-40).join('\n')
  }

  /** 进程是否活着。 */
  get alive() {
    return this.#child !== null && this.#child.exitCode === null
  }

  /** 主动关闭（插件卸载时调）。 */
  dispose() {
    const child = this.#child
    this.#child = null
    if (!child) return
    this.#rejectAll(new Error('mcp client disposed'))
    try {
      child.kill()
    } catch {
      // 进程可能已退出；忽略。
    }
  }

  #rejectAll(error) {
    for (const { reject } of this.#pending.values()) reject(error)
    this.#pending.clear()
  }

  /**
   * 调用一个 MCP 工具并返回其文本结果。
   * @param {string} name 工具名
   * @param {Record<string, unknown>} args 工具参数
   * @returns {Promise<string>} 工具返回的文本（多段 text 内容拼接）
   */
  async callTool(name, args) {
    // 串行化：同一个浏览器不能被并发驱动。
    const run = this.#queue.then(() => this.#callTool(name, args))
    // 队列不能因为一次失败而断掉：吞掉错误再续上。
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #callTool(name, args) {
    await this.#ensureReady()
    const result = await this.#request('tools/call', { name, arguments: args })
    const text = extractText(result)
    if (result && result.isError) {
      throw new Error(text || `MCP tool ${name} returned isError`)
    }
    return text
  }

  /** 握手保证只执行一次；失败则不缓存，允许下次重试。 */
  #ensureReady() {
    if (!this.#ready) {
      this.#ready = this.#handshake().catch((error) => {
        this.#ready = null
        throw error
      })
    }
    return this.#ready
  }

  async #handshake() {
    this.#spawn()
    const init = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-bridge-plugin', version: '0.1.0' },
    })
    // 按协议：initialize 的响应之后必须发 initialized 通知，服务端才认为会话就绪。
    this.#notify('notifications/initialized')
    return init
  }

  #spawn() {
    if (this.alive) return
    const { command, args, cwd, env } = this.#options
    let child
    try {
      child = spawnChild(command, args, cwd, env)
    } catch (error) {
      throw new Error(
        `无法启动 dsh-bridge（command=${command}）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.#child = child
    this.#buffer = ''

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk) => this.#onStdout(String(chunk)))
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk) => this.#onStderr(String(chunk)))

    child.on('error', (error) => {
      this.#rejectAll(new Error(`dsh-bridge 进程错误：${error.message}`))
    })
    child.on('exit', (code, signal) => {
      this.#rejectAll(
        new Error(
          `dsh-bridge 进程退出（code=${code} signal=${signal}）。` +
            (this.#stderrTail.length ? `\n最近 stderr：\n${this.stderrTail}` : ''),
        ),
      )
    })
  }

  #onStdout(chunk) {
    this.#buffer += chunk
    let index
    // 按行切分：一条完整的 JSON-RPC 消息就是一行。
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // 不是 JSON —— stdout 本该只有协议消息。忽略但留痕，便于排查 bridge 改动。
        continue
      }
      this.#onMessage(message)
    }
  }

  #onStderr(chunk) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) this.#stderrTail.push(trimmed)
    }
    if (this.#stderrTail.length > 200) {
      this.#stderrTail.splice(0, this.#stderrTail.length - 200)
    }
  }

  #onMessage(message) {
    if (message?.id === undefined || !this.#pending.has(message.id)) return
    const { resolve, reject } = this.#pending.get(message.id)
    this.#pending.delete(message.id)
    if (message.error) {
      reject(new Error(`MCP error: ${JSON.stringify(message.error)}`))
      return
    }
    resolve(message.result)
  }

  #notify(method, params) {
    const payload = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    this.#child?.stdin?.write(JSON.stringify(payload) + '\n')
  }

  #request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++
      this.#pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(
            new Error(
              `MCP 请求超时（${method}, ${this.#options.toolCallTimeoutMs}ms）` +
                (this.#stderrTail.length ? `\n最近 stderr：\n${this.stderrTail}` : ''),
            ),
          )
        }
      }, this.#options.toolCallTimeoutMs)
      const settle = (fn) => (value) => {
        clearTimeout(timer)
        fn(value)
      }
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
      const payload = { jsonrpc: '2.0', id, method }
      if (params !== undefined) payload.params = params
      const stdin = this.#child?.stdin
      if (!stdin) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error('dsh-bridge stdin 不可用（进程未启动？）'))
        return
      }
      stdin.write(JSON.stringify(payload) + '\n')
    })
  }
}

/**
 * 从 tools/call 的 result 里抽出文本。MCP 返回 `content: [{type:'text', text}]`，
 * 但不同服务端可能夹杂 image/resource 段；只拼接 text 段。
 * @param {any} result
 * @returns {string}
 */
export function extractText(result) {
  const content = result?.content
  if (!Array.isArray(content)) {
    return result === undefined ? '' : JSON.stringify(result)
  }
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

// spawn 单独抽出，便于测试替换。
import { spawn } from 'node:child_process'

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string>} env
 */
function spawnChild(command, args, cwd, env) {
  return spawn(command, args, {
    cwd: cwd || undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 🌸 强制 UTF-8：bridge 会打 🌸 emoji，Windows 默认 GBK 会 UnicodeEncodeError。
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...env },
  })
}
