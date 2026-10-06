/**
 * 校验 profile 的 cordis.patch.yml 里那条 mcp-dshbridge 配置。
 *
 * 用文件而非 `node -e` 内联 —— 避免 shell 对正则 `$` 的转义破坏
 * （上次就是这么误报的）。
 *
 * 用法：node probe/verify-mcp-entry.mjs [profileName]
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const profileName = process.argv[2] ?? 'desktop'
const profileDir = path.join(process.env.USERPROFILE, '.dsh', 'profiles', profileName)
const requireFromProfile = createRequire(path.join(profileDir, 'noop.js'))
const YAML = requireFromProfile('yaml')

const patchFile = path.join(profileDir, 'cordis.patch.yml')
const bytes = readFileSync(patchFile)

// ① BOM
const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
console.log(`① cordis.patch.yml BOM = ${hasBom}${hasBom ? '  ❌ 会让宿主启动崩溃' : '  ✅'}`)
if (hasBom) process.exit(1)

// ② YAML
let rows
try {
  rows = YAML.parse(bytes.toString('utf8'))
  console.log(`② YAML 解析成功 ✅  顶层条目 ${rows.length} 个`)
} catch (error) {
  console.log(`② YAML 解析失败 ❌ ${error.message}`)
  process.exit(1)
}
if (!Array.isArray(rows)) {
  console.log('② ❌ 顶层必须是数组（profile patch 层约定）')
  process.exit(1)
}

// ③ 找到目标条目
const inserts = rows.flatMap((row) => row?.insert ?? [])
console.log(`③ insert 条目: ${inserts.map((row) => row.id).join(', ') || '(无)'}`)
const entry = inserts.find((row) => row.id === 'mcp-dshbridge')
if (!entry) {
  console.log('③ ❌ 没找到 mcp-dshbridge')
  process.exit(1)
}
console.log('③ ✓ 找到 mcp-dshbridge')

// ④ 复现 mcp-client 的 Config schema（z.union 的 stdio 分支）
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const config = entry.config ?? {}
const problems = []
if (entry.name !== '@deepseek-ai/dsh-mcp-client') problems.push(`name 应为 @deepseek-ai/dsh-mcp-client，实际 ${entry.name}`)
if (config.transport !== 'stdio') problems.push("transport 必须是 'stdio'")
if (typeof config.serverName !== 'string' || !SERVER_NAME_PATTERN.test(config.serverName)) {
  problems.push(`serverName 必须匹配 /^[A-Za-z0-9_-]{1,32}$/，实际 ${JSON.stringify(config.serverName)}`)
}
if (typeof config.command !== 'string' || config.command.trim() === '') problems.push('command 必须是非空字符串')
if (!Array.isArray(config.args) || config.args.some((a) => typeof a !== 'string')) problems.push('args 必须是字符串数组')
if (config.env === null || typeof config.env !== 'object' || Array.isArray(config.env)) {
  problems.push('env 必须是字符串字典')
} else {
  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value !== 'string') problems.push(`env.${key} 必须是字符串（YAML 里要加引号）`)
  }
}
if ('toolCallTimeoutMs' in config && (typeof config.toolCallTimeoutMs !== 'number' || config.toolCallTimeoutMs <= 0)) {
  problems.push('toolCallTimeoutMs 必须是正数')
}
if ('failOnStartupError' in config && typeof config.failOnStartupError !== 'boolean') {
  problems.push('failOnStartupError 必须是布尔')
}

console.log(`④ config = ${JSON.stringify(config)}`)
if (problems.length > 0) {
  console.log('④ ❌ 与 mcp-client Config 契约不符：')
  for (const problem of problems) console.log(`   · ${problem}`)
  process.exit(1)
}
console.log('④ ✓ 与 mcp-client Config(stdio 分支) 契约一致')

// ⑤ mcp-client 插件可解析
try {
  const resolved = requireFromProfile.resolve('@deepseek-ai/dsh-mcp-client/package.json')
  console.log(`⑤ dsh-mcp-client 可解析 ✅  ${resolved.replace(profileDir, '<profile>')}`)
} catch (error) {
  console.log(`⑤ ⚠️ dsh-mcp-client 解析失败：${String(error).split('\n')[0]}`)
}

// ⑥ 确认命令能真的跑起来（只做 --help 之外的轻量确认：文件是否存在）
const cwdFromArgs = config.args?.includes('--directory') ? config.args[config.args.indexOf('--directory') + 1] : null
console.log(`⑥ bridge 项目目录（来自 --directory）= ${cwdFromArgs}`)
if (cwdFromArgs) {
  const fs = await import('node:fs')
  const ok = fs.existsSync(path.join(cwdFromArgs, 'pyproject.toml'))
  console.log(`⑥ pyproject.toml 存在 = ${ok}${ok ? '  ✅' : '  ❌'}`)
  if (!ok) process.exit(1)
}

console.log('\n═══ mcp-dshbridge 配置校验通过 ✅ ═══')
