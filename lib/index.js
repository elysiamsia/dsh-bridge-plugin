/**
 * dsh-bridge-plugin —— 把 dsh-bridge（Python/Playwright 驱动的 4 站网页版 AI 桥接）
 * 以 **DSH 原生插件**形式接入 DeepSeek Harness。
 *
 * ⚠️ 本文件必须是**可直接执行的 ESM 纯 JS**（宿主直接 import `lib/index.js`，
 *    不经任何转译）—— 不要写 TypeScript 类型语法，那会 SyntaxError。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 本轮（2026-10-06 S3）的**首要目标不是功能，而是把「失败原因未知」变成「已知」**。
 * 上次尝试的失败表现：插件页显示该组件「异常」（= Cordis fiber `phase === 'failed'`），
 * 但**拿不到报错文本**（UI 点不开；我读不了图；DSH API 全 401）。
 *
 * 对策：**面包屑日志**。在模块导入期、apply 入口、每一步、异常处全部
 * append 到固定路径的日志文件（DIAG_LOG）。这样即使 fiber 失败、UI 不显示原因，
 * 也能从文件里读出**确切的失败点与错误栈**。
 *
 * 设计要点（都是上次踩坑后的修正，改动前请先读 HANDOVER §12.4）：
 *   1. **零外部依赖**：绝不 import `@deepseek-ai/dsh-tools`（本机 profile 里解析不到，
 *      坑 2）。工具定义**自己写成标准 JSON Schema** —— `required` 必须是**字符串数组**，
 *      不是 DSH 参数方言的 `required: true`（那个靠 defineTool 转换）。
 *   2. **工具注册分区容错**：先注册一个「不可能失败」的探针工具；桥接类工具放 try/catch
 *      —— 桥接出问题**只写日志，不让整个 fiber 失败**。
 *   3. **日志不能反过来搞崩插件**：所有写日志都 try/catch 吞掉。
 * ──────────────────────────────────────────────────────────────────────
 *
 * @module dsh-bridge-plugin
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { McpStdioClient } from './mcp-client.js'

export const name = 'dsh-bridge-plugin'

/** 需要工具注册表就绪（Cordis 会等 `ctx.tools` 可用后再调 `apply`）。 */
export const inject = ['tools']

/**
 * 诊断日志路径 —— **默认关闭**，仅在设置了环境变量 `DSH_BRIDGE_PLUGIN_DIAG`
 * （值为日志文件的绝对路径）时才写盘。
 *
 * 🌸 为什么改成可选：早期版本把开发机的绝对路径写死在这里，随包发布后
 *    对别人的机器毫无意义、还会在奇怪的目录里建文件。诊断是开发期手段，
 *    不该成为发布包的副作用 —— 需要时用环境变量显式开启即可。
 */
const DIAG_LOG = typeof process.env.DSH_BRIDGE_PLUGIN_DIAG === 'string'
  ? process.env.DSH_BRIDGE_PLUGIN_DIAG
  : ''

/** 默认超时：真站 ask 需要驱动浏览器。 */
const DEFAULT_TIMEOUT_MS = 180_000

/**
 * 面包屑日志。**永远不会抛** —— 诊断代码不能成为新的失败源。
 * 未开启 `DSH_BRIDGE_PLUGIN_DIAG` 时是**空操作**。
 * @param {string} stage 阶段名
 * @param {unknown} [detail] 附加信息
 */
function diag(stage, detail) {
  if (!DIAG_LOG) return
  try {
    mkdirSync(dirname(DIAG_LOG), { recursive: true })
    const stamp = new Date().toISOString()
    let extra = ''
    if (detail !== undefined) {
      try {
        extra = ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
      } catch {
        extra = ' ' + String(detail)
      }
    }
    appendFileSync(DIAG_LOG, `${stamp} [${stage}]${extra}\n`, 'utf8')
  } catch {
    // 吞掉：诊断失败绝不能影响插件加载
  }
}

// ── 导入期面包屑：能读到这一行 = 模块被成功 import 且顶层代码执行了 ──
diag('MODULE-IMPORTED', { pid: process.pid, node: process.version })

/**
 * 配置默认值。
 *
 * 🌸 **刻意不含任何机器专属路径**（发布包必须对任何机器都成立）。
 *    默认假定 `dsh-bridge` 可执行文件已在 PATH 上（例如 `uv tool install .`
 *    或 pipx 安装后的效果）；若你是在源码目录里用 `uv run` 启动，
 *    请在**你自己机器**的 profile `cordis.patch.yml` 里覆盖：
 *
 *    - id: dsh-bridge-plugin
 *      config:
 *        command: uv
 *        args: [run, --directory, /abs/path/to/dsh-bridge, dsh-bridge]
 */
const CONFIG_DEFAULTS = {
  command: 'dsh-bridge',
  args: [],
  cwd: '',
  env: {},
  toolCallTimeoutMs: DEFAULT_TIMEOUT_MS,
}

/**
 * 合并默认值并做最小校验（自包含，不依赖 Schemastery）。
 * @param {Record<string, unknown> | undefined} raw
 */
export function resolveConfig(raw) {
  const merged = { ...CONFIG_DEFAULTS, ...(raw ?? {}) }
  if (typeof merged.command !== 'string' || merged.command.trim() === '') {
    throw new Error('dsh-bridge-plugin: config.command 必须是非空字符串')
  }
  if (!Array.isArray(merged.args) || merged.args.some((a) => typeof a !== 'string')) {
    throw new Error('dsh-bridge-plugin: config.args 必须是字符串数组')
  }
  if (typeof merged.cwd !== 'string') {
    throw new Error('dsh-bridge-plugin: config.cwd 必须是字符串')
  }
  if (merged.env === null || typeof merged.env !== 'object' || Array.isArray(merged.env)) {
    throw new Error('dsh-bridge-plugin: config.env 必须是字符串字典')
  }
  if (
    typeof merged.toolCallTimeoutMs !== 'number'
    || !Number.isFinite(merged.toolCallTimeoutMs)
    || merged.toolCallTimeoutMs < 1000
  ) {
    throw new Error('dsh-bridge-plugin: config.toolCallTimeoutMs 必须是不小于 1000 的数字')
  }
  return {
    command: merged.command,
    args: [...merged.args],
    cwd: merged.cwd,
    env: { ...merged.env },
    toolCallTimeoutMs: merged.toolCallTimeoutMs,
  }
}

/**
 * Standard Schema v1 接口。宿主（`vendor/cordis/src/fiber.ts:53`）调
 * `Config['~standard'].validate(raw)`；返回 `{issues}` → 抛 ValidationError → fiber FAILED。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-bridge-plugin',
    validate(value) {
      try {
        return { value: resolveConfig(value) }
      } catch (error) {
        return {
          issues: [{ message: error instanceof Error ? error.message : String(error), path: [] }],
        }
      }
    },
  },
}

/**
 * 插件入口。
 *
 * 结构刻意做成「**探针工具先注册 + 桥接工具容错**」：
 *   · `dsh_bridge_probe` 零依赖、不可能失败 → 只要插件能加载，它就会出现
 *   · `ask_deepseek` 放 try/catch → 桥接问题只写日志，不让 fiber 失败
 *
 * @param {any} ctx Cordis 上下文
 * @param {Record<string, unknown>} [config]
 */
export async function apply(ctx, config) {
  diag('APPLY-ENTER', {
    configKeys: config === undefined ? null : Object.keys(config),
    ctxKeys: (() => {
      try {
        return Object.keys(ctx)
      } catch {
        return 'keys() threw'
      }
    })(),
    hasTools: typeof ctx?.tools === 'object' && ctx?.tools !== null,
    hasRegister: typeof ctx?.tools?.register === 'function',
    hasEffect: typeof ctx?.effect === 'function',
  })

  // ── 步骤 1：解析配置（失败会让 fiber FAILED，但日志会记下原因）──
  let resolved
  try {
    resolved = resolveConfig(config)
    diag('CONFIG-OK', resolved)
  } catch (error) {
    diag('CONFIG-FAILED', error?.stack ?? String(error))
    throw error
  }

  // ── 步骤 2：注册探针工具（零依赖，纯为证明「插件能加载」）──
  try {
    ctx.tools.register({
      name: 'dsh_bridge_probe',
      description:
        'Diagnostic probe for the dsh-bridge native plugin. Returns a fixed string plus the '
        + 'plugin version, proving the plugin loaded and its tool registry entry works.',
      // 🌸 标准 JSON Schema（required 是**字符串数组**）—— 不经过 defineTool 转换
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          echo: { type: 'string', description: 'Optional text to echo back.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            plugin: { type: 'string' },
            echo: { type: 'string' },
          },
          required: ['ok', 'plugin'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: `dsh-bridge-plugin probe ok=${value.ok} plugin=${value.plugin}`
            + (value.echo ? ` echo=${value.echo}` : ''),
        }],
      },
      async execute(args) {
        return {
          ok: true,
          plugin: 'dsh-bridge-plugin@0.2.0',
          ...(typeof args?.echo === 'string' ? { echo: args.echo } : {}),
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'dsh-bridge probe', kind: 'other', rawInput: args }),
    })
    diag('PROBE-TOOL-REGISTERED')
  } catch (error) {
    diag('PROBE-TOOL-REGISTER-FAILED', error?.stack ?? String(error))
    throw error
  }

  // ── 步骤 3：桥接工具（容错：失败只记日志，不让 fiber 挂）──
  try {
    const client = new McpStdioClient({
      command: resolved.command,
      args: resolved.args,
      cwd: resolved.cwd,
      env: resolved.env,
      toolCallTimeoutMs: resolved.toolCallTimeoutMs,
    })
    ctx.effect(() => () => {
      diag('EFFECT-DISPOSE')
      client.dispose()
    })
    diag('EFFECT-REGISTERED')

    ctx.tools.register({
      name: 'ask_deepseek',
      description:
        'Ask the DeepSeek web chat (deepseek.com) through the local dsh-bridge browser bridge '
        + 'and return its reply. Drives a real logged-in browser session, so a call takes seconds. '
        + 'G20 SAFETY: this tool REFUSES to send while DeepSeek is inside its rate-limit freeze '
        + 'window — it pre-checks the bridge verify state and returns an error telling the user to '
        + 'run `dsh-login deepseek`. Do not retry on that error.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'The question to send to DeepSeek.' },
          conversation_id: { type: 'string', description: 'Continue an existing conversation by id.' },
        },
        required: ['prompt'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reply: { type: 'string' },
            conversation_id: { type: 'string' },
            site: { type: 'string' },
          },
          required: ['reply'],
        },
        render: (_args, value) => [{ type: 'text', text: value.reply }],
      },
      async execute(args) {
        // 🌸 G20 前置闸门（2026-10-06 实测发现：bridge 的 ask 路径**不检查** verify 状态，
        //    直接 send 会真的发出去 → 触发 4 站账号同时吊销）。
        //    先用 bridge 的 route_task 读 verify_status，blocked 就拒绝。
        //    route_task 是纯逻辑（不起浏览器、不 send），所以预检本身零风险。
        await assertNotBlocked(client, 'deepseek')

        const payload = { prompt: args.prompt }
        if (typeof args.conversation_id === 'string' && args.conversation_id !== '') {
          payload.conversation_id = args.conversation_id
        }
        const text = await client.callTool('ask_deepseek', payload)
        const parsed = parseBridgePayload(text)
        return {
          reply: parsed.reply,
          ...(parsed.conversation_id ? { conversation_id: parsed.conversation_id } : {}),
          site: 'deepseek',
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'Ask DeepSeek', kind: 'other', rawInput: args }),
    })
    diag('ASK-TOOL-REGISTERED')
  } catch (error) {
    // 🌸 刻意不 rethrow：桥接层的问题不该让整个插件行变「异常」
    diag('BRIDGE-TOOL-SECTION-FAILED', error?.stack ?? String(error))
  }

  diag('APPLY-DONE')
}

/**
 * G20 前置闸门：site 处于冻结/陈旧（blocked）时**拒绝发送**。
 *
 * 为什么必须由插件来做：实测 `dsh_bridge/tools/ask.py` **不检查** verify 状态
 * （grep 全仓库确认：G20 只在 `routing/decide.py` 的 `route_task` 决策链与
 * `scripts/login.py` 里生效）。所以「冻结时不能 send」这条铁律在 ask 路径上是
 * **靠调用方自觉**的 —— 插件必须自己兜住，否则一次误调 = 4 站账号同时吊销。
 *
 * 实现：调 bridge 的 `route_task`（纯逻辑、不起浏览器、不 send）读 `verify_status`，
 * 取目标站的 `blocked`（P21-02 起为 `blocked_effective` = blocked OR 陈旧）。
 *
 * @param {McpStdioClient} client 已连接的 bridge 客户端
 * @param {string} site 目标站点
 */
export async function assertNotBlocked(client, site) {
  let status
  try {
    const raw = await client.callTool('route_task', { prompt: '__g20_preflight__' })
    status = JSON.parse(raw)
  } catch (error) {
    // 预检本身失败 → **保守拒绝**（宁可拒绝，也不冒真发一次的风险）
    diag('G20-PREFLIGHT-ERROR', error?.stack ?? String(error))
    throw new Error(
      'G20 前置检查失败，为安全起见拒绝发送（避免误触发真站 send）。原因：'
      + (error instanceof Error ? error.message : String(error)),
    )
  }

  const entry = status?.verify_status?.[site]
  if (!entry) {
    diag('G20-PREFLIGHT-NO-ENTRY', status)
    throw new Error(`G20 前置检查读不到 ${site} 的 verify 状态，为安全起见拒绝发送。`)
  }
  const hours = typeof entry.hours_left === 'number' ? entry.hours_left : null
  if (entry.blocked === true) {
    diag('G20-PREFLIGHT-BLOCKED', { site, hours_left: hours, source: entry.source })
    throw new Error(
      `⛔ G20 频控铁律：${site} 处于冻结/陈旧状态（老化后剩余 ${hours ?? '?'}h < 6h 阈值），`
      + `已拒绝发送以免吊销账号。请先跑 \`uv run --no-sync dsh-login ${site}\` 重过 verify。`,
    )
  }
  diag('G20-PREFLIGHT-PASS', { site, hours_left: hours })
}

/**
 * 解析 bridge 的 `ask_*` 返回（JSON 字符串或纯文本都要能处理）。
 * @param {string} text
 * @returns {{reply: string, conversation_id?: string}}
 */
export function parseBridgePayload(text) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) throw new Error('dsh-bridge 返回了空结果（可能是频控拦截或站点异常）')
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (unfenced.startsWith('{')) {
    try {
      const parsed = JSON.parse(unfenced)
      if (parsed && typeof parsed.reply === 'string') {
        return {
          reply: parsed.reply,
          ...(typeof parsed.conversation_id === 'string' ? { conversation_id: parsed.conversation_id } : {}),
        }
      }
      return { reply: unfenced }
    } catch {
      // 落到纯文本分支
    }
  }
  return { reply: trimmed }
}
