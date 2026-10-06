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

## 当前状态：**✅ 已跑通并安装在用（2026-10-06）**

| 项 | 状态 |
|---|---|
| 工具实现 | ✅ `ask_deepseek`（真站对话）+ `dsh_bridge_probe`（零依赖诊断探针） |
| **在真实 DSH 里加载** | ✅ **成功** —— 面包屑日志走到 `APPLY-DONE`，无异常 |
| **原生工具真调用** | ✅ `dsh_bridge_probe(echo=…)` → `probe ok=true plugin=dsh-bridge-plugin@0.2.0 echo=…`（**无 `mcp__` 前缀 = 真·原生工具**） |
| **G20 前置闸门** | ✅ 实测生效：4 站冻结时调 `ask_deepseek` 被拒绝、**未触碰真站** |
| 离线自检 `node probe/verify-plugin.mjs` | ✅ 全部通过（纯函数 / 注册 / 桥接 / G20 闸门） |
| loader 链路复现 `node probe/verify-loader.mjs` | ✅ 6 步全过（解析包 → patch → 入口 → 导出 → 真调 `apply()`） |
| 生命周期 | ✅ 重启时上一实例正确卸载（日志留 `[EFFECT-DISPOSE]`） |

### 🔑 上次失败的根因（已修复）

上次（同日早些时候）插件页显示「异常」＝ Cordis fiber `phase === 'failed'`，且**拿不到报错文本**。

**根因**：工具定义用了 **DSH 参数方言**（`prompt: { type:'string', required:true }`），
却在不依赖 `defineTool` 的情况下把该方言直接交给 `ctx.tools.register()`。

**修复**：把 `parameters` 与 `output.schema` 全写成**标准 JSON Schema**
（`required` 为**字符串数组**），彻底不依赖 `@deepseek-ai/dsh-tools`（本机解析不到）。
改完一次通过。

### 🔧 诊断技法（这次解开死结的关键，值得沿用）

插件在**导入期 / apply 入口 / 每一步 / 每个异常**都 `appendFileSync` 到固定日志文件，
并记录 `ctx` 的真实形状（`ctxKeys`/`hasTools`/`hasRegister`/`hasEffect`）到
`diag/boot.log`。⇒ **即使 fiber 失败、UI 不给原因，也能从文件读到确切失败点与完整错误栈。**

### ⚠️ G20 安全闸门（本插件的重要安全网）

实测发现 **内核的 `dsh_bridge/tools/ask.py` 完全不检查 G20**（`blocked` 只在
`routing/decide.py` 的 `route_task` 决策链与 `scripts/login.py` 里生效）
⇒ **直接调 `ask_*` 会真的发出去**，冻结期等于 **4 站账号同时吊销**。

对策：本插件调 `ask_*` 前先用 `route_task`（纯逻辑、不起浏览器、不 send）读 `verify_status`，
目标站 `blocked` 就**拒绝发送**并给出 `dsh-login` 指引；**预检本身失败也保守拒绝**。
闸门有 4 条单元测试（stub 客户端，**绝不碰真站**）。

### 已修的两个环境坑（供后来者避开）

1. **profile 的 `package.json` 绝不能带 UTF-8 BOM** —— 宿主启动时直接 `JSON.parse`，
   BOM 会 `DesktopHostFatalError` 崩溃。Windows PowerShell 5.1 的
   `Set-Content -Encoding UTF8` **会写 BOM**；改用
   `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`，并在写后断言无 BOM。
2. **含中文的 `.ps1` 必须有 BOM**（与上一条**方向相反**）—— PS 5.1 无 BOM 时会按 GBK
   解码中文 → 语法错。`install.ps1` 已带 BOM，用解析器验证过无语法错误。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 插件入口：`apply()` + 工具注册 + 配置校验 + G20 闸门 + 结果解析 |
| `lib/mcp-client.js` | 极简 MCP stdio 客户端（零外部依赖，串行化，超时，子进程清理） |
| `cordis.patch.yml` | 插件自带的 bundle patch（由 `package.json` 的 `dsh.bundle.patch` 声明） |
| `install.ps1` | 安装/卸载（**无 BOM 写入 + 写后断言 + 安装后真实 import 验证**） |
| `probe/mcp-probe.mjs` | 架构探针：只验证 Node→Python→MCP 握手 + tools/list |
| `probe/verify-plugin.mjs` | 插件自检：纯函数 / 注册 / 桥接 / G20 闸门 |
| `probe/verify-loader.mjs` | **复现宿主 loader 的 6 步**：解析包→patch→入口→导出→真调 `apply()` |
| `probe/verify-profile.mjs` | **profile 健康检查**：逐 bundle 复现 `loadProfileDirectory`（含 BOM 检测） |
| `probe/asar-extract.mjs` | 从 `app.asar` 抽单个文件（读真实运行版本代码用） |
| `probe/verify-mcp-entry.mjs` | 校验 profile 里 `mcp-dshbridge` 那条配置（BOM / YAML / 契约 / 路径） |
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
