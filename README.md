<a id="top"></a>

**语言 / Language**：[`中文`](#zh-cn) | [`English`](#en)

---

<a id="zh-cn"></a>

# LAN-SHELL

一个基于 Node.js 的局域网 Web Shell：通过浏览器访问一个网页，即可在服务端开启交互式 Bash 终端（WebSocket），并提供“文件浏览”“一键运行命令（SSE 流式输出）”“自定义指令集持久化”等能力。

> ⚠️ 重要安全提示：本项目当前为 **NO-AUTH** 版本（无登录/无鉴权）。在不可信网络或公网暴露会带来严重安全风险（相当于远程执行命令）。请仅在可信局域网使用，或自行加上认证与访问控制。

## 功能特性

- 交互式终端：浏览器通过 WebSocket 连接服务端 `node-pty`，获得完整交互体验
- 终端会话管理：支持重连、查看会话列表、查看历史输出、终止会话/清空所有会话
- 文件浏览：在限定根目录内浏览文件/目录（只读列目录信息）
- 一次性命令运行：`/api/run` 以 SSE 方式实时返回输出（并受允许命令白名单限制）
- 指令集（预设命令）持久化：存储到 `data/command-sets.json`，便于多设备共享
- 移动端手势：单指滑动发送方向键移动光标；二指点按复制“最后一次输出”；二指长按触发粘贴（无剪贴板权限时自动打开粘贴输入框）
- 工具栏增强：新增 `UNDO`（发送 `Ctrl+U` 清空当前输入行，便于误粘贴后快速回退）
- Git 管理页：长按右侧“指令集”按钮进入 Git 页面查看提交历史（支持用背景色区分是否已 push；点击条目可复制提交哈希）；若目录未初始化可提示执行 `git init`（为安全起见，根目录 `.` 与隐藏目录禁止打开）
- 前端资源：静态页面 + PWA 资源（`public/`），并强制禁用缓存避免旧版本前端残留

## 快速开始

### 依赖

- Node.js（建议 18+）
- Linux/macOS（服务端默认启动 `/bin/bash`；Windows 需要自行适配）

### 启动

```bash
npm install
npm start
```

默认监听端口为 `6273`，启动后访问：

```text
http://localhost:6273
```

### 停止

```bash
npm run stop
```

也可以直接运行脚本：

```bash
bash ./关闭服务.sh
```

## 配置（环境变量）

项目主要通过环境变量控制运行行为（见 `server.js`）：

- `PORT`：HTTP 服务监听端口（默认 `6273`）
- `ALLOW_ROOT`：允许访问/执行的根目录（默认：`$HOME`，若不存在则 `/`）
- `ALLOWED_CMDS`：一次性命令运行白名单（默认：`npm,node,yarn,pnpm,ls,bash`）
- `HISTORY_MAX_CHARS`：终端“刷新后恢复”回放缓冲上限（字符数，默认 `500000`；值越大可上滑越多，但会占用更多内存）

示例：

```bash
PORT=8080 ALLOW_ROOT=/home/you/work ALLOWED_CMDS="npm,node,ls,bash" npm start
```

## 主要接口/协议（概要）

- `GET /`：前端页面（SPA）
- `GET /api/fs?path=.`：列目录（会限制在 `ALLOW_ROOT` 内）
- `GET /api/command-sets`：读取指令集
- `PUT /api/command-sets`：保存指令集（服务端会做结构与大小校验）
- `POST /api/run`：一次性命令运行（SSE 流式输出，且 `cmd` 必须在 `ALLOWED_CMDS` 内）
- `GET /api/sessions`：列出终端会话
- `DELETE /api/sessions`：终止全部会话
- `GET /api/sessions/:id/history`：获取某会话历史输出
- `DELETE /api/sessions/:id`：终止指定会话
- `GET /api/git/info?cwd=...`：Git 状态信息（是否可用/是否为仓库/仓库根/分支）
- `GET /api/git/commits?cwd=...&limit=...`：提交历史（含是否已推送的标记；依赖上游分支配置）
- `POST /api/git/init`：在指定目录执行 `git init`（仅允许在 `ALLOW_ROOT` 内，且禁止 `.` 与隐藏目录）
- `WS /ws/pty`：交互式终端 WebSocket（关键 query：`cwd`、`cols`、`rows`、`sessionId`、`clientId`）

## 目录结构

- `server.js`：服务端入口（Express + ws + node-pty）
- `public/`：前端静态资源与页面
- `data/`：数据持久化目录（如 `command-sets.json`）
- `启动服务.sh`：启动脚本（实际等同于 `npm start`）
- `关闭服务.sh`：停止脚本（按端口/PID 等尝试停止）

## 安全建议（强烈推荐）

如果你打算在多人环境使用，建议至少做到：

- 在反向代理层加认证（Basic Auth / OAuth / SSO）与 IP 白名单
- 只监听内网地址或通过 VPN 访问
- 将 `ALLOW_ROOT` 限制到最小目录
- 收紧 `ALLOWED_CMDS`（或直接关闭 `/api/run`）
- 增加审计日志（记录谁在何时执行了什么）

## 常见问题

### 端口被占用怎么办？

换端口启动即可：

```bash
PORT=6174 npm start
```

停止脚本也支持指定端口：

```bash
bash ./关闭服务.sh 6174
```

---

## License

MIT License，详见 `LICENSE`。

[`↑ 返回顶部`](#top) | [`English`](#en)

---

<a id="en"></a>

# LAN-SHELL (English)

A LAN-friendly Web Shell built with Node.js. Open a web page in your browser to get an interactive Bash terminal on the server (via WebSocket), plus file browsing, one-shot command execution (SSE streaming output), and persistent “command sets”.

> ⚠️ Security warning: This project is a **NO-AUTH** build (no login / no authentication). Exposing it to the public Internet or untrusted networks is extremely dangerous (effectively remote command execution). Use only on trusted LANs, or add proper auth and access controls.

## Features

- Interactive terminal: Browser connects to `node-pty` over WebSocket for a full interactive experience
- Session management: Reconnect, list sessions, fetch output history, terminate a session / terminate all sessions
- File browsing: List files/directories within a configured root (read-only listing)
- One-shot command runner: `/api/run` streams output via SSE (restricted by an allowlist)
- Persistent command sets: Stored in `data/command-sets.json` for sharing across devices
- Frontend assets: Static page + PWA assets in `public/`, with caching disabled to avoid stale UI logic

## Quick Start

### Requirements

- Node.js (recommended 18+)
- Linux/macOS (server spawns `/bin/bash` by default; Windows requires adaptation)

### Start

```bash
npm install
npm start
```

Default port is `6273`. After starting, open:

```text
http://localhost:6273
```

### Stop

```bash
npm run stop
```

Or run the script directly:

```bash
bash ./关闭服务.sh
```

## Configuration (Environment Variables)

The server behavior is controlled mainly via environment variables (see `server.js`):

- `PORT`: HTTP listening port (default `6273`)
- `ALLOW_ROOT`: Allowed root for file browsing and working directories (default: `$HOME`, or `/` if not set)
- `ALLOWED_CMDS`: Allowlist for one-shot command execution (default: `npm,node,yarn,pnpm,ls,bash`)

Example:

```bash
PORT=8080 ALLOW_ROOT=/home/you/work ALLOWED_CMDS="npm,node,ls,bash" npm start
```

## APIs / Protocols (Overview)

- `GET /`: Frontend page (SPA)
- `GET /api/fs?path=.`: List directory (restricted within `ALLOW_ROOT`)
- `GET /api/command-sets`: Read command sets
- `PUT /api/command-sets`: Save command sets (server validates structure/size)
- `POST /api/run`: One-shot command runner (SSE streaming output; `cmd` must be in `ALLOWED_CMDS`)
- `GET /api/sessions`: List terminal sessions
- `DELETE /api/sessions`: Terminate all sessions
- `GET /api/sessions/:id/history`: Fetch output history of a session
- `DELETE /api/sessions/:id`: Terminate a session
- `WS /ws/pty`: Interactive terminal WebSocket (key query params: `cwd`, `cols`, `rows`, `sessionId`, `clientId`)

## Project Layout

- `server.js`: Server entry (Express + ws + node-pty)
- `public/`: Frontend static assets/pages
- `data/`: Persistent data directory (e.g. `command-sets.json`)
- `启动服务.sh`: Start script (effectively `npm start`)
- `关闭服务.sh`: Stop script (tries to stop by port/PID)

## Security Recommendations (Strongly Suggested)

If you plan to use this with multiple users, at minimum:

- Add auth (Basic Auth / OAuth / SSO) and IP allowlists at a reverse proxy layer
- Bind only to LAN interfaces or access via VPN
- Restrict `ALLOW_ROOT` to the smallest possible directory
- Tighten `ALLOWED_CMDS` (or disable `/api/run`)
- Add audit logs (who ran what and when)

## FAQ

### Port is already in use. What now?

Start on a different port:

```bash
PORT=6174 npm start
```

The stop script also supports specifying the port:

```bash
bash ./关闭服务.sh 6174
```

---

## License

MIT License. See `LICENSE`.

[`↑ Back to top`](#top) | [`中文`](#zh-cn)
