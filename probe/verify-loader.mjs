/**
 * 精确复现 DSH loader 处理本插件的每一步，定位「装好了但工具没出现」的断点。
 *
 * 复现的步骤（与宿主 loader 同构）：
 *   1. 从 profile 目录按包名解析 bundle 目录（node 解析语义）
 *   2. 读 package.json → dsh.bundle.patch → 解析 patch YAML → 取 insert 行
 *   3. 按行里的 name 解析模块（用 package.json 的 exports）
 *   4. import 模块，校验 name/inject/apply/Config 导出
 *   5. 用 stub ctx 真的调一次 apply()，确认工具注册成功
 *
 * 用法：node probe/verify-loader.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PROFILE_DIR = 'C:\\Users\\dong\\.dsh\\profiles\\desktop'
const PLUGIN = 'dsh-bridge-plugin'

// loader 用 profile 目录做解析基准。
const require = createRequire(path.join(PROFILE_DIR, 'noop.js'))
// 复用宿主自带的 yaml 解析器，避免引入新依赖。
const YAML = require('yaml')

let failed = 0
const step = (label) => console.log(`\n── ${label}`)
const ok = (m) => console.log(`   ✓ ${m}`)
const bad = (m) => {
  failed++
  console.log(`   ✗ ${m}`)
}

step('1. 按包名解析 bundle 目录')
let pkgJsonPath
try {
  pkgJsonPath = require.resolve(`${PLUGIN}/package.json`)
  ok(`解析到 ${pkgJsonPath}`)
} catch (error) {
  bad(`无法解析 ${PLUGIN}/package.json：${error.message}`)
  process.exit(1)
}

step('2. 读 package.json → dsh.bundle.patch')
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
console.log(`   name=${pkg.name} version=${pkg.version} type=${pkg.type}`)
const patchRef = pkg.dsh?.bundle?.patch
if (!patchRef) bad('package.json 未声明 dsh.bundle.patch')
else ok(`dsh.bundle.patch = ${patchRef}`)
if (pkg.dsh?.engines?.dsh) console.log(`   dsh.engines.dsh = ${pkg.dsh.engines.dsh}`)

step('3. 解析 patch YAML → insert 行')
const pkgDir = path.dirname(pkgJsonPath)
const patchPath = path.resolve(pkgDir, patchRef ?? '')
let rows
try {
  rows = YAML.parse(readFileSync(patchPath, 'utf8'))
  ok(`patch 解析成功：${patchPath}`)
} catch (error) {
  bad(`patch 解析失败：${error.message}`)
  process.exit(1)
}
const inserts = (rows ?? []).flatMap((r) => r?.insert ?? [])
console.log(`   insert 行数 = ${inserts.length}`)
for (const row of inserts) console.log(`   id=${row.id} name=${row.name}`)
if (inserts.length === 0) bad('patch 里没有 insert 行')

step('4. 按行里的 name 解析并 import 模块')
const rowName = inserts[0]?.name
let mod
try {
  // 与宿主同构：用包名的 exports 解析到入口文件。
  const entry = require.resolve(rowName)
  ok(`入口解析到 ${entry}`)
  mod = await import(pathToFileURL(entry).href)
  ok('import 成功')
} catch (error) {
  bad(`模块解析/import 失败：${error.message}`)
  process.exit(1)
}

step('5. 校验导出契约')
for (const key of ['name', 'inject', 'apply', 'Config']) {
  if (mod[key] === undefined) bad(`缺导出 ${key}`)
  else ok(`${key} = ${typeof mod[key]}`)
}
if (typeof mod.apply !== 'function') bad('apply 不是函数 —— 宿主无法加载')
if (mod.name !== PLUGIN) bad(`导出的 name (${mod.name}) 与包名 (${PLUGIN}) 不一致`)

step('6. 用 stub ctx 真调 apply()')
const registered = []
const effects = []
const stubCtx = {
  tools: { register: (def) => registered.push(def) },
  effect: (fn) => effects.push(fn),
}
try {
  await mod.apply(stubCtx, inserts[0]?.config)
  ok(`apply() 执行成功；注册 ${registered.length} 个工具`)
  for (const def of registered) console.log(`   工具: ${def.name}`)
  ok(`注册 ${effects.length} 个 effect`)
} catch (error) {
  bad(`apply() 抛错：${error.stack ?? error.message}`)
}

console.log(`\n═══ 结论：${failed === 0 ? 'loader 全链路可加载 ✅' : `${failed} 处失败 ❌`} ═══`)
process.exit(failed === 0 ? 0 : 1)
