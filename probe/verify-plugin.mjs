/**
 * 插件自检：不依赖 DSH 宿主，用假 `ctx` 验证插件的三层行为。
 *
 *   1. 纯函数层：resolveConfig 默认值/校验 + parseBridgePayload 解析
 *   2. 注册层：apply() 是否真的把 ask_deepseek 注册进 ctx.tools，且定义合法
 *   3. 桥接层：McpStdioClient 能否拉起 Python bridge 并完成 MCP 握手
 *      （**只调 tools/list，只读、不触发真站、不违反 G20**）
 *
 * 用法：node probe/verify-plugin.mjs
 */
import { apply, name, inject, resolveConfig, parseBridgePayload, Config, assertNotBlocked } from '../lib/index.js'
import { McpStdioClient } from '../lib/mcp-client.js'

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures++
    console.log(`  ✗ ${label}\n      ${error.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

/** 异步版 check（G20 闸门是 async）。 */
const checkAsync = async (label, fn) => {
  try {
    await fn()
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures++
    console.log(`  ✗ ${label}\n      ${error.message}`)
  }
}

/** 构造一个只实现 callTool 的假 MCP 客户端。 */
const stubClient = (routeTaskResult) => ({
  callTool: async (toolName) => {
    if (toolName === 'route_task') return routeTaskResult
    throw new Error(`stub 不该被调用于 ${toolName}`)
  },
})

console.log('=== 1. 纯函数层 ===')

check('resolveConfig 空配置 → 全部默认值', () => {
  const c = resolveConfig(undefined)
  assert(c.command === 'uv', `command=${c.command}`)
  // 🌸 默认 args 对齐已验证可用的 `.mcp.json` 形式（`--directory` 让 uv 自己找项目）
  assert(
    c.args.join(' ') === 'run --directory D:/claude-code/dsh-bridge dsh-bridge',
    `args=${c.args.join(' ')}`,
  )
  assert(c.toolCallTimeoutMs === 180000, `timeout=${c.toolCallTimeoutMs}`)
})

check('resolveConfig 用户覆盖生效', () => {
  const c = resolveConfig({ command: 'python', toolCallTimeoutMs: 5000 })
  assert(c.command === 'python', 'command 未覆盖')
  assert(c.toolCallTimeoutMs === 5000, 'timeout 未覆盖')
  assert(
    c.args.join(' ') === 'run --directory D:/claude-code/dsh-bridge dsh-bridge',
    '未覆盖的字段应保留默认值',
  )
})

check('resolveConfig 非法配置要响亮', () => {
  let threw = false
  try {
    resolveConfig({ toolCallTimeoutMs: 10 })
  } catch {
    threw = true
  }
  assert(threw, 'timeout=10 应当抛错（小于 1000）')
})

check('Config.~standard.validate 返回合并后的值', () => {
  const outcome = Config['~standard'].validate({ command: 'python' })
  assert(outcome.value.command === 'python', 'validate 未透传用户值')
  assert(outcome.value.toolCallTimeoutMs === 180000, 'validate 未补默认值')
})

check('Config.~standard.validate 非法配置返回 issues（不抛）', () => {
  const outcome = Config['~standard'].validate({ toolCallTimeoutMs: 'oops' })
  assert(Array.isArray(outcome.issues) && outcome.issues.length > 0, '应返回 issues')
})

check('parseBridgePayload 解析标准 JSON', () => {
  const r = parseBridgePayload('{"reply":"pong","conversation_id":"abc"}')
  assert(r.reply === 'pong', `reply=${r.reply}`)
  assert(r.conversation_id === 'abc', `cid=${r.conversation_id}`)
})

check('parseBridgePayload 解析 markdown 围栏里的 JSON', () => {
  const r = parseBridgePayload('```json\n{"reply":"hi"}\n```')
  assert(r.reply === 'hi', `reply=${r.reply}`)
})

check('parseBridgePayload 纯文本原样透出（不崩）', () => {
  const r = parseBridgePayload('⛔ deepseek 处于频控冻结期')
  assert(r.reply.includes('频控'), `reply=${r.reply}`)
})

check('parseBridgePayload 空结果抛可读错误', () => {
  let threw = false
  try {
    parseBridgePayload('   ')
  } catch (error) {
    threw = true
    assert(error.message.includes('空结果'), `message=${error.message}`)
  }
  assert(threw, '空结果应当抛错')
})

console.log('\n=== 2. 注册层（假 ctx 走 apply）===')

const registered = []
const effects = []
const fakeCtx = {
  tools: { register: (def) => registered.push(def) },
  effect: (fn) => effects.push(fn),
}

await apply(fakeCtx, {})
check('apply 注册了 2 个工具（探针 + ask_deepseek）', () => {
  assert(registered.length === 2, `注册了 ${registered.length} 个：${registered.map((d) => d.name).join(', ')}`)
})
check('第一个是零依赖探针 dsh_bridge_probe（用来证明插件能加载）', () => {
  assert(registered[0].name === 'dsh_bridge_probe', `name=${registered[0].name}`)
})
check('第二个是 ask_deepseek', () => {
  assert(registered[1].name === 'ask_deepseek', `name=${registered[1].name}`)
})
// 🌸 2026-10-06 S3：定义已改为**标准 JSON Schema**（不再依赖 defineTool 转换）
//    ⇒ `required` 是根对象的**字符串数组**，而不是每个属性上的 `required: true`
check('参数是标准 JSON Schema（根为 object + required 数组）', () => {
  const p = registered[1].parameters
  assert(p && p.type === 'object', `parameters.type=${p && p.type}`)
  assert(Array.isArray(p.required), `required 必须是数组，实际 ${JSON.stringify(p.required)}`)
})
check('prompt 必填、conversation_id 可选', () => {
  const p = registered[1].parameters
  assert(p.properties?.prompt?.type === 'string', JSON.stringify(p.properties?.prompt))
  assert(p.required.includes('prompt'), 'prompt 应在 required 里')
  assert(!p.required.includes('conversation_id'), 'conversation_id 不应是必填')
})
check('output.schema 也是标准 JSON Schema（required 数组）', () => {
  const s = registered[1].output.schema
  assert(Array.isArray(s.required) && s.required.includes('reply'), JSON.stringify(s.required))
})
check('output.render 产出 text 段', () => {
  const parts = registered[1].output.render({}, { reply: 'hello' })
  assert(Array.isArray(parts) && parts[0].type === 'text' && parts[0].text === 'hello', JSON.stringify(parts))
})
check('注册了 1 个 effect（用于卸载时杀子进程）', () => {
  assert(effects.length === 1, `effects=${effects.length}`)
  const disposer = effects[0]()
  assert(typeof disposer === 'function', 'effect 应返回 disposer')
})
check('导出元信息正确', () => {
  assert(name === 'dsh-bridge-plugin', `name=${name}`)
  assert(Array.isArray(inject) && inject.includes('tools'), `inject=${inject}`)
})

console.log('\n=== 2b. G20 前置闸门（纯 stub，绝不碰真站）===')

const blockedPayload = JSON.stringify({
  ok: false,
  code: 'ALL_SITES_BLOCKED',
  verify_status: { deepseek: { hours_left: 0.0, blocked: true, source: 'cookie_probe' } },
})
const openPayload = JSON.stringify({
  ok: true,
  verify_status: { deepseek: { hours_left: 11.5, blocked: false, source: 'manual_login' } },
})

await checkAsync('blocked=true → 拒绝发送（抛 G20 错误）', async () => {
  let threw = false
  try {
    await assertNotBlocked(stubClient(blockedPayload), 'deepseek')
  } catch (error) {
    threw = true
    assert(error.message.includes('G20'), `错误信息应含 G20，实际：${error.message}`)
    assert(error.message.includes('dsh-login'), '错误信息应给出 dsh-login 指引')
  }
  assert(threw, 'blocked 时必须抛错（拒绝发送）')
})

await checkAsync('blocked=false → 放行', async () => {
  await assertNotBlocked(stubClient(openPayload), 'deepseek')
})

await checkAsync('预检本身失败 → **保守拒绝**（宁可拒绝也不误发）', async () => {
  let threw = false
  try {
    await assertNotBlocked({ callTool: async () => { throw new Error('桥接挂了') } }, 'deepseek')
  } catch (error) {
    threw = true
    assert(error.message.includes('拒绝发送'), `实际：${error.message}`)
  }
  assert(threw, '预检失败时必须保守拒绝')
})

await checkAsync('读不到该站 verify 状态 → 拒绝', async () => {
  let threw = false
  try {
    await assertNotBlocked(stubClient(JSON.stringify({ verify_status: {} })), 'deepseek')
  } catch {
    threw = true
  }
  assert(threw, '缺条目时必须拒绝')
})

console.log('\n=== 3. 桥接层（只读：仅 tools/list）===')

const client = new McpStdioClient({
  command: 'uv',
  args: ['run', '--no-sync', 'dsh-bridge'],
  cwd: 'D:\\claude-code\\dsh-bridge',
  env: {},
  toolCallTimeoutMs: 60000,
})

try {
  // callTool 走的是 tools/call；这里需要一个只读且无副作用的工具。
  // site_state 是纯读取 G20 状态（不起浏览器、不 send、不碰真站）。
  const text = await client.callTool('site_state', { site: 'deepseek' })
  check('site_state 调用成功（证明整条桥接链可用）', () => {
    assert(typeof text === 'string' && text.length > 0, '返回为空')
  })
  console.log(`      返回前 160 字：${text.slice(0, 160).replace(/\n/g, ' | ')}`)
} catch (error) {
  failures++
  console.log(`  ✗ 桥接调用失败：${error.message}`)
} finally {
  client.dispose()
}

console.log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ===`)
process.exit(failures === 0 ? 0 : 1)
