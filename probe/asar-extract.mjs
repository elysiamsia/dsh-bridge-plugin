/**
 * 从 app.asar 里抽取指定文件（asar 是简单的归档格式）。
 *
 * 目的：读**真实运行版本**（0.2.0-rc.2）的 app-boot / loader 代码，
 * 而不是 master 源码 —— 两者在 loader 行为上可能有差异。
 *
 * 用法：
 *   node probe/asar-extract.mjs list <前缀>          # 列出匹配的条目
 *   node probe/asar-extract.mjs cat <内部路径>        # 打印文件内容
 */
import { readFileSync } from 'node:fs'

// 🌸 机器专属路径由环境变量传入：DSH_ASAR=<DSH 安装目录>/resources/app.asar
const ASAR = process.env.DSH_ASAR ?? ''
if (!ASAR) {
  console.error('请先设置 DSH_ASAR 指向 DSH 的 app.asar，例如：')
  console.error('  $env:DSH_ASAR = "C:\\<DSH 安装目录>\\resources\\app.asar"')
  process.exit(1)
}

const fd = readFileSync(ASAR)
// asar 布局：u32(=4) | u32(headerPickleSize) | u32(headerJsonSize) | headerJson | files...
const headerPickleSize = fd.readUInt32LE(4)
const headerJsonSize = fd.readUInt32LE(8)
const header = JSON.parse(fd.subarray(12, 12 + headerJsonSize).toString('utf8'))
const baseOffset = 8 + headerPickleSize

const mode = process.argv[2] ?? 'list'
const arg = process.argv[3] ?? ''

/** 把 asar 的嵌套 header 展平成 [路径, 条目] 列表。 */
function walk(node, prefix, out) {
  for (const [key, value] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${key}` : key
    if (value.files) walk(value, p, out)
    else out.push([p, value])
  }
  return out
}

const files = walk(header, '', [])

if (mode === 'list') {
  const hits = files.filter(([p]) => p.includes(arg))
  console.log(`匹配 "${arg}" 的条目共 ${hits.length} 个：`)
  for (const [p, v] of hits.slice(0, 60)) console.log(`  ${p}  (${v.size}B)`)
} else if (mode === 'cat') {
  const hit = files.find(([p]) => p === arg) ?? files.find(([p]) => p.endsWith(arg))
  if (!hit) {
    console.error(`未找到条目：${arg}`)
    process.exit(1)
  }
  const [p, v] = hit
  const content = fd.subarray(baseOffset + Number(v.offset), baseOffset + Number(v.offset) + v.size)
  console.log(`===== ${p} (${v.size}B) =====`)
  process.stdout.write(content)
} else {
  console.error('用法：node probe/asar-extract.mjs list <前缀> | cat <路径>')
  process.exit(1)
}
