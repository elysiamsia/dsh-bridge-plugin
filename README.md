# dsh-bridge-plugin

把 [dsh-bridge](file:///D:/claude-code/dsh-bridge)（Python/Playwright 驱动的 4 站网页版 AI 桥接）
以 **DSH 原生插件**形式接入 DeepSeek Harness。

## 这是什么 / 为什么这么做

dsh-bridge 已经是一个 MCP server。DSH **原生支持 MCP**，所以严格来说不改代码也能用
（`mcp-client` 插件 + 三行 YAML）。做成原生插件的**增量**在于：

| 能力 | 直接挂 MCP | 本插件 |
|---|---|---|
| 工具名 | `mcp__dshbridge__ask_deepseek` | `ask_deepseek` |
| UI 卡片 | 通用 MCP 呈现 | 原生 `presentCall` 卡片 |
| 配置 | MCP 的 env/args | 插件 `Config`（Schemastery 风格 / Standard Schema） |
| 开关 | 改 YAML | DSH「插件」页可见可开关 |

**关键设计取舍：业务逻辑一行不重写。** 执行层通过 MCP stdio 子进程复用已经过
**469 条测试**验证的 Python 实现（Playwright、stealth 反检测、fallback 降级链、
4 站登录、G20 频控状态机、状态老化）。把这些重写成 TypeScript 既昂贵，又会丢掉既有测试保护。

```
DSH 宿主
  └── dsh-bridge-plugin (本插件, ESM)
        ├── ctx.tools.register(ask_deepseek …)   ← 原生工具定义
        └── McpStdioClient (零依赖手写)
              └── spawn: uv run --no-sync dsh-bridge   ← 复用 Python
                    └── MCP stdio (逐行 JSON-RPC)
```

## 当前状态：**PoC 未跑通，已从环境卸载（2026-10-06）**

诚实记录，避免下次重复踩坑：

| 项 | 状态 |
|---|---|
| 工具实现（`ask_deepseek`） | ✅ 已实现 |
| 离线自检 `node probe/verify-plugin.mjs` | ✅ **17/17 通过**（含真实 MCP 往返 `site_state`，拿到 `{ok:true, site:deepseek}`） |
| loader 链路复现 `node probe/verify-loader.mjs` | ✅ 6 步全过（解析包 → patch → 入口 → 导出 → 真调 `apply()` 注册成功） |
| 兼容性闸门（真实 semver 复现） | ✅ 3 种 runtime 版本下不兼容 peer 数 = 0（不会被 skip） |
| **在真实 DSH 里加载** | ❌ **失败**：插件页显示该组件异常（源码判定＝Cordis fiber `phase === 'failed'`，即 `apply`/import/config 阶段抛错），工具 `ask_deepseek` 未出现在模型工具表 |
| 失败原因 | **未确定** —— 需要宿主报错文本，但该异常在 UI 里点不开 |

### ⚠️ 这次踩到并已修的两个坑（重要）

1. **我引入过一次严重事故：profile 清单被写入 UTF-8 BOM**，导致 DSH 启动阶段直接崩溃
   （`SyntaxError: Unexpected token ''` at `readProfileManifest`；见
   `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`）。
   根因：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` **会写 BOM**。
   现已改用 `Write-NoBomJson`（`[System.IO.File]::WriteAllText` + `UTF8Encoding($false)`），
   并在安装后**断言无 BOM**（`install.ps1:121-125`）。
2. **`@deepseek-ai/dsh-tools` 在本机解析不到**（`profiles/node_modules` 下是指向 npx 缓存、
   目标已消失的 junction）。而 `defineTool` **不是可选包装** —— 它做真正的转换：
   `parameterSchemaSpecToJsonSchema()` / `valueSchemaSpecToJsonSchema()`。
   本插件现有的「恒等降级」会**跳过这些转换**，是很可能的失败原因。
   **下次应改为**：自己把参数 schema 转成标准 JSON Schema（`required` 必须是**字符串数组**），
   `output.schema` 也写成标准 JSON Schema，从而完全不依赖 `defineTool`。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 插件入口：`apply()` + 工具注册 + 配置校验 + 结果解析 |
| `lib/mcp-client.js` | 极简 MCP stdio 客户端（零外部依赖，串行化，超时，子进程清理） |
| `cordis.patch.yml` | 插件自带的 bundle patch（由 `package.json` 的 `dsh.bundle.patch` 声明） |
| `probe/mcp-probe.mjs` | 架构探针：只验证 Node→Python→MCP 握手 + tools/list |
| `probe/verify-plugin.mjs` | 插件自检：纯函数 / 注册 / 桥接三层（17 项） |
| `probe/verify-loader.mjs` | **复现宿主 loader 的 6 步**：解析包→patch→入口→导出→真调 `apply()` |
| `probe/verify-profile.mjs` | **profile 健康检查**：逐 bundle 复现 `loadProfileDirectory`（含 BOM 检测） |
| `probe/asar-extract.mjs` | 从 `app.asar` 抽单个文件（读真实运行版本代码用） |
| `install.ps1` | 安装/卸载脚本（离线，等效 `dsh plugin add`；**无 BOM 写入 + 写后断言**） |

## 安装

```powershell
# 若受执行策略限制，用：powershell -ExecutionPolicy Bypass -File install.ps1
& .\install.ps1
# 然后**完全退出**并重启 DeepSeek Harness Desktop
```

手动等价步骤（`install.ps1` 做的就是这些）：

1. profile 的 `package.json` → `dependencies` 加 `"dsh-bridge-plugin": "link:D:/claude-code/dsh-bridge-plugin"`
2. 同文件 → `dsh.profile.bundles` 追加 `"dsh-bridge-plugin"`
3. 把 `lib/` + `package.json` + `cordis.patch.yml` 复制到
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-bridge-plugin\`

> ⚠️ **不要**手改 profile 的 `cordis.patch.yml` —— 插件自带 bundle patch，
> loader 会自动插入配置行（与 `dsh-free-search` / `dsh-mnemon` 同机制）。

> ⚠️ **绝不能让 profile 的 `package.json` 带 UTF-8 BOM** —— DSH 宿主启动时直接
> `JSON.parse`（`readProfileManifest`），BOM 会让它 **startup 阶段崩溃**。
> Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` / `Out-File -Encoding UTF8`
> **会写 BOM**；`install.ps1` 已改用 .NET `UTF8Encoding($false)` 并在写后断言。
> 如果你手动改这个文件，改完请用 `probe/verify-profile.mjs` 验一下（它会检查 BOM）。

## 配置

改 `cordis.patch.yml` 里那一行 `config`（或重启后在 DSH 插件页改）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` | `uv` | 启动 bridge 的可执行文件 |
| `args` | `["run","--no-sync","dsh-bridge"]` | 传参 |
| `cwd` | `D:\claude-code\dsh-bridge` | bridge 仓库位置（uv 需在此找到 `.venv`） |
| `env` | `{}` | 追加环境变量（插件已强制 `PYTHONIOENCODING=utf-8`） |
| `toolCallTimeoutMs` | `180000` | 单次调用超时（真站 ask 要驱动浏览器，别调太小） |

## 卸载 / 回滚

```powershell
& .\install.ps1 -Uninstall
# 或直接恢复备份：Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak-dsh-bridge-plugin" "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Force
```

## ⚠️ G20 频控铁律（使用前必读）

本插件**继承** dsh-bridge 的全部频控约束，不绕过：

- 真站访问只允许 **deepseek** 一站，且仅限冒烟
- `verify < 6.0h` **禁止 send** —— 先跑 `uv run --no-sync dsh-verify readiness`
- 每跑一次真站冒烟 = **4 站账号同时吊销**
- 状态陈旧（窗口按墙钟耗尽）时 G20 **保守判定为冻结**；此时跑 `dsh-login deepseek` 即可解锁
  （P21-02 起陈旧不再被门禁拦住）

## 开发

```powershell
node probe/mcp-probe.mjs      # 探针：只读，验证桥接链路（不碰真站）
node probe/verify-plugin.mjs  # 自检：17 项（不碰真站）
```

改完 `lib/` 后：因为安装是**复制**而非链接，需重跑 `install.ps1` 再重启 DSH。
（若想让源码改动即时生效，可把 `node_modules/dsh-bridge-plugin` 改为指向本目录的
junction：`New-Item -ItemType Junction -Path <node_modules路径> -Target D:\claude-code\dsh-bridge-plugin`）

## 扩展到其余 8 个工具

桥接层无需改动，在 `lib/index.js` 的 `apply()` 里继续 `ctx.tools.register(...)` 即可。
各工具的 inputSchema 可从 bridge 侧拉：

```powershell
uv run --no-sync python -c "from dsh_bridge.server import mcp; import asyncio; [print(t.name, t.inputSchema) for t in asyncio.run(mcp.list_tools())]"
```
