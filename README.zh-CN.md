# pi-trj-visualize

[English](README.md) | 简体中文

一个独立的 **Pi coding-agent session 只读可视化工具**。它直接扫描 `~/.pi/agent/sessions`，把 agent 的真实探索过程画成可缩放的迷宫时间线：主干、失败支路、折返、并行工具瀑布、token 与成本都在一张图里。

> 不依赖 DSH，不需要上传日志，也不会修改任何 Pi session 文件。

## 功能

- **直接浏览 `~/.pi`**：按更新时间列出所有项目和 session，支持项目、提示词、模型全文搜索。
- **Pi v3 树感知解析**：按 `parentId` 重建 append-only session 树，默认展示物理末行指向的 active branch；多分支 session 可切换 leaf，不会把废弃分支混进当前路径。
- **Subagent 轨迹联动**：按 header 的 `parentSession` 把子 session 归回父会话，不再作为左侧独立顶层 session；点击父时间线中的 `Agent` 步即可打开完整 Subagent 轨迹，并可一键返回父会话。未匹配到具体调用的子轨迹也可从顶部下拉菜单进入。
- **探索迷宫**：成功步骤留在主干；连续失败、检索扑空和无效重试按真实时间串成一条失败链，最后一次失败只画一条恢复线回到下一个成功节点。
- **真实时间语义**：assistant 内层时间作为模型请求开始、entry 时间作为响应/工具开始、tool result 时间作为工具结束；长空闲区间自动折叠。
- **并行工具瀑布**：同一次 assistant response 里的多个 tool call 按 `toolCallId` 精确配对，即使结果乱序也不会串线。
- **主会话 + Subagent 同轴视图**：父会话与所有直接 Subagent 按真实启动时间放在同一墙钟轴，每条子轨迹使用独立颜色，并从对应的 `Agent` 调用画连接线。
- **双语界面**：默认英文，顶部 `EN / 中文` 可持久切换，Session shell 与轨迹 iframe 同步更新。
- **完整交互**：多轨迹时滚轮纵向浏览、`Ctrl/⌘+滚轮` 横向缩放、拖拽平移、失败过滤、工具过滤、命令/结果/思考搜索、详情面板、SVG/PNG 导出、明暗主题。
- **图片结果**：Pi session 中 user/tool result 的 base64 `image` block 会在详情面板直接显示，支持点击展开原图；列表摘要只保留占位文本，不复制图片数据。
- **Pi 原生统计**：input/output/reasoning/cache token、成本、模型、provider、compaction、parent session。
- **自动跟随**：每 10 秒静默检查；当前 session 写入新 entry 后后台刷新并保留缩放窗口，不再遮挡当前视图。
- **安全路径模型**：浏览器只使用服务端生成的 opaque id，API 不接受任意文件路径。

## 快速开始

要求 Node.js `>=22.19.0`。

```bash
corepack enable
pnpm install
pnpm build
pnpm start
```

默认监听：

```text
http://127.0.0.1:4310
```

也可以安装后直接使用 CLI：

```bash
pnpm link --global
pi-trj-visualize
```

## CLI

```text
pi-trj-visualize [options]

--host <address>       监听地址，默认 127.0.0.1
--port <number>        端口，默认 4310；0 表示随机空闲端口
--sessions-dir <path>  覆盖 Pi session 目录
--open                 启动后打开默认浏览器
-h, --help             显示帮助
```

Session 目录解析顺序：

1. `--sessions-dir`
2. `PI_CODING_AGENT_SESSION_DIR`
3. `PI_CODING_AGENT_DIR` 下 `settings.json` 的 `sessionDir`
4. `~/.pi/agent/sessions`

自定义目录可以是 Pi 默认的项目子目录布局，也可以是平铺目录；服务端会递归查找 `.jsonl`。

## 如何读图

- **蓝色实线**：主 session 的成功路径；青、橙、粉等色带是同轴 Subagent 轨迹。
- **圆角胶囊**：一步 assistant response，从模型请求开始到相关工具完成；宽度即墙钟耗时。
- **胶囊下方细条**：同一步里的并行 tool call，每条使用自己的起止时间和结果判定色。
- **红/灰虚线链**：按真实先后顺序连接的失败、扑空或无效重试。
- **灰色恢复线**：连续失败链的最后一步连接到下一个成功节点；不会让每次失败都返回旧节点。
- **橙色 `▧` 标记**：该步骤含图片；数字表示图片张数，直接点击标记可打开正确步骤。
- **⏸ 缝隙**：超过 60 秒没有活动的空闲区间被压缩；详情、步骤耗时和总耗时仍是真实墙钟值。

点击节点可查看用户提示、模型回答、思考摘要、模型/stop reason、token、工具参数、最多 5000 字结果和判定依据。

## Pi session 支持范围

当前产品针对 Pi coding-agent 的 JSONL **v3** 格式：

- `session` header
- `message`：`user` / `assistant` / `toolResult` / `bashExecution`
- `model_change`、`thinking_level_change`
- `compaction`、`branch_summary`
- `custom`、`custom_message`、`label`、`session_info`
- session tree、active leaf、parent session

解析完全只读。正在追加但尚未形成完整 JSON 的最后一行会暂时忽略，并在下一次刷新后重新读取。

## 开发与验证

```bash
pnpm check       # TypeScript + Vitest + production build
pnpm e2e         # Playwright（需要先 build；会自动启动隔离测试服务）
```

主要目录：

```text
src/cli.ts                  CLI
src/server.ts               只读 HTTP/API 服务
src/session-repository.ts   递归发现、缓存、opaque id
src/pi-session.ts           Pi 树解析与 MazeData 转换
src/verdict.ts              工具判定和盲目重试检测
src/web/index.html          Session 浏览器
src/web/maze.html           SVG 迷宫渲染器
```

## 隐私与安全

- 服务端只执行读取和 `stat`，不会调用会迁移旧 session 的 `SessionManager.open()`。
- `/api/session` 只接受扫描索引中的 opaque id，不接受绝对路径或相对路径。
- 默认只监听 `127.0.0.1`，并校验 loopback `Host`，阻断浏览器 DNS rebinding 读取本地 API。
- 首次扫描最多并发解析 6 个文件；列表缓存只保留摘要，完整 session 树使用 4 项 LRU，避免大型 `~/.pi` 常驻占满内存。
- 浏览器只收到可视化所需的 active branch；工具结果最多 5000 字、思考最多 2000 字。

## 致谢

本项目最初的 SVG 迷宫渲染思路和部分前端实现源自 [lamost423/dsh-trace-compare](https://github.com/lamost423/dsh-trace-compare)。感谢原作者对 agent 主干、失败支路、时间折叠和工具瀑布可视化的探索。本仓库在此基础上重构为独立的 Pi session 服务，新增 Pi v3 树解析、Subagent 同轴轨迹、图片、本地只读浏览及安全边界。

## License

MIT。详细归属说明见 [NOTICE](NOTICE)。
