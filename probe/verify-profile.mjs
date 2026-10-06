/**
 * DSH profile 健康检查 —— 逐 bundle 复现 `loadProfileDirectory` 的每一步。
 *
 * 对 `dsh.profile.bundles` 里每个 bundle 复现：
 *   1. 从 profile 锚点解析包目录（官方 bundle 在 app.asar 内，外部解析不到 —— 见下）
 *   2. 读 package.json（并模拟宿主的 JSON.parse —— 含 BOM 检测）
 *   3. 校验声明了 `dsh.bundle`
 *   4. 解析 bundle patch YAML 并检查 insert 行
 *
 * ⚠️ 已知局限（不谎报）：宿主 `resolveBundleDir` 用**两个锚点** ——
 *    安装锚点（`app.asar/dsh/package.json`，官方 bundle 在里面）与 profile 锚点。
 *    纯 Node 无法穿透 asar，所以**官方/asar 内置 bundle 本脚本解析不到**，
 *    这类会明确标为「无法从外部验证」而**不算作问题**。
 *    `dsh peer` 只是**信息**：宿主用 `readProfileVersionExemptions` 做精确豁免，
 *    声明 peer 本身完全正常。
 *
 * 用法：node probe/verify-profile.mjs [profileName]
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const profileName = process.argv[2] ?? 'desktop'
const profilesRoot = path.join(process.env.USERPROFILE, '.dsh', 'profiles')
const profileDir = path.join(profilesRoot, profileName)

const requireFromProfile = createRequire(path.join(profileDir, 'noop.js'))
const YAML = requireFromProfile('yaml')

let problems = 0
let unverifiable = 0
const note = (msg) => console.log(msg)
const bad = (msg) => {
  problems++
  console.log(`  ✗ ${msg}`)
}

console.log(`profile: ${profileDir}\n`)

// ── 0. 先做宿主最容易崩的那一步：读 profile 清单 ──
const manifestPath = path.join(profileDir, 'package.json')
const bytes = readFileSync(manifestPath)
if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
  bad('profile package.json 带 UTF-8 BOM —— DSH 宿主会在 startup 阶段 JSON.parse 崩溃')
}
let manifest
try {
  manifest = JSON.parse(bytes.toString('utf8'))
  note(`✓ profile 清单可解析（${bytes.length}B）`)
} catch (error) {
  bad(`profile 清单 JSON.parse 失败：${error.message}`)
  process.exit(1)
}
if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
  bad('profile 清单必须是 JSON 对象')
  process.exit(1)
}

const bundles = manifest.dsh?.profile?.bundles ?? []
note(`✓ bundles 共 ${bundles.length} 个\n`)

/**
 * 官方/随安装包发布的 bundle 前缀 —— 它们从 app.asar 内部解析，外部无法验证。
 * 判据：包名以 @deepseek-ai/ 开头，或以 @deepseek-harness-tui/ 开头（同为官方）。
 */
function isOfficialBundle(packageName) {
  return packageName.startsWith('@deepseek-ai/') || packageName.startsWith('@deepseek-harness-tui/')
}

// ── 逐个 bundle 复现宿主加载 ──
for (const packageName of bundles) {
  const issues = []
  let packageDir = null
  let resolveError = null

  try {
    packageDir = path.dirname(requireFromProfile.resolve(`${packageName}/package.json`))
  } catch (error) {
    resolveError = error
  }

  if (!packageDir) {
    if (isOfficialBundle(packageName)) {
      // 官方 bundle 在 app.asar 内，外部解析不到是**预期**的，不是问题。
      unverifiable++
      console.log(`· ${packageName}  — 官方 bundle（asar 内置），无法从外部验证`)
    } else {
      // profile 安装的 bundle 解析不到 ⇒ 真实 DSH 会报 cannot resolve profile bundle
      bad(`${packageName} 解析失败（真实 DSH 会 skip 它）：${String(resolveError).split('\n')[0]}`)
    }
    continue
  }

  // 读该 bundle 的 package.json（重点：BOM —— 这是真会让宿主崩的东西）
  let bundleManifest = null
  try {
    const b = readFileSync(path.join(packageDir, 'package.json'))
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) issues.push('package.json 带 BOM')
    bundleManifest = JSON.parse(b.toString('utf8'))
  } catch (error) {
    issues.push(`读 package.json 失败：${error.message}`)
  }

  // 必须声明 dsh.bundle
  const bundle = bundleManifest?.dsh?.bundle
  if (bundleManifest && !bundle) issues.push('未声明 dsh.bundle（宿主会 skip）')

  // patch 文件可读 + 有 insert 行
  if (bundle) {
    const declared = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
    if (!Array.isArray(declared) || declared.length === 0) {
      issues.push('dsh.bundle.patch 不是路径或路径数组')
    } else {
      for (const rel of declared) {
        const patchPath = path.join(packageDir, rel)
        if (!existsSync(patchPath)) {
          issues.push(`patch 文件不存在：${rel}`)
          continue
        }
        try {
          const rows = YAML.parse(readFileSync(patchPath, 'utf8'))
          const inserts = (rows ?? []).flatMap((r) => r?.insert ?? [])
          if (inserts.length === 0) issues.push(`patch ${rel} 里没有 insert 行`)
        } catch (error) {
          issues.push(`patch ${rel} 解析失败：${error.message}`)
        }
      }
    }
  }

  if (issues.length === 0) {
    console.log(`✓ ${packageName}`)
  } else {
    console.log(`✗ ${packageName}`)
    for (const issue of issues) console.log(`    · ${issue}`)
    problems++
  }
}

console.log(
  `\n═══ ${problems === 0 ? 'profile 健康 ✅' : `${problems} 处问题 ❌`}`
  + `（另有 ${unverifiable} 个官方 bundle 无法从外部验证，属预期） ═══`,
)
process.exit(problems === 0 ? 0 : 1)

