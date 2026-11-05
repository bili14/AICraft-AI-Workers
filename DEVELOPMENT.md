# AICraft 开发者文档

面向想读懂代码、改代码、或者拿它做自己实验的人。只想玩请看 [README.md](README.md) 和 [docs/使用说明书.md](docs/使用说明书.md)。

## 先说清楚这个仓库是什么

这是**源码快照**，不是可运行的发行包。仓库里刻意不包含：

- `runtime/`（内置 Node 与 JDK，约 379 MB）
- `app/electron-dist/`（打包好的 `AICraft.exe`，188 MB）
- `bots/node_modules/`（mineflayer 等依赖，858 MB）
- `server/`（服务端 jar、世界存档、快照）
- `config.json`（含真实 Key，仓库里只有 `config.template.json`）
- 各种 `.bak-*` 备份

想跑起来要自己准备 Node 18+、JDK 21、以及 `npm install`。

## 三层结构

```
┌─────────────────────────────────────────┐
│  Electron 壳（app/）                     │
│  main.js 开窗、拉起后端、优雅退出         │
│  renderer/ 全部界面（单页多面板）         │
└───────────────┬─────────────────────────┘
                │ HTTP 127.0.0.1:<内部端口>
┌───────────────▼─────────────────────────┐
│  指挥中心 backend/center.js               │
│  · 唯一的状态持有者（STATE）              │
│  · 管 MC 服务器进程                       │
│  · 管 bot 子进程（起/停/重启）            │
│  · 配置读写、快照、端口分配、LLM 限流      │
└───────────────┬─────────────────────────┘
                │ spawn + RCON
┌───────────────▼─────────────────────────┐
│  Minecraft 服务器 server/ 1.21.4         │
│  ← mineflayer 连接 25565                 │
└───────────────▲─────────────────────────┘
                │
┌───────────────┴─────────────────────────┐
│  Bot 进程 bots/bot-lite.js（每个工人一个）│
│  · 决策循环：看状态 → 调 LLM → 执行动作   │
│  · 起本地 viewer 服务给 3D / 思考页用      │
└─────────────────────────────────────────┘
```

前端不直连 bot，也不直连 MC；它只和 center 说话。center 是唯一知道"世界开没开、谁在跑"的地方。

## 目录职责

| 路径 | 职责 |
|---|---|
| `app/main.js` | Electron 主进程：建窗、`setWindowOpenHandler`（3D 窗）、拉起 center、优雅退出、单实例锁 |
| `app/preload.js` | 渲染层可用 IPC 桥：`api` / `open-path` / `show-item` / `copy-text` / `read-tail` / `force-quit` |
| `app/renderer/index.html` | 全部面板与样式（单文件，无构建步骤） |
| `app/renderer/app.js` | 指挥大厅：工人卡片、启动/停止、3D/思考窗开关 |
| `app/renderer/saves.js` | 存档页：当前世界真值、存一份、删除重生成、存档列表 |
| `app/renderer/chat.js` | 公屏聊天流（秒级去重） |
| `app/renderer/mem.js` | 运行内存估算与红黄绿提示 |
| `app/renderer/wizard.js` | 新手向导 |
| `app/renderer/boot.js` | 冷启动加载屏与轮播提示 |
| `app/renderer/common.js` | API 封装、`APP.toast`、错误码中文文案表、时间/体积格式化 |
| `backend/center.js` | HTTP 服务与全部路由（约 1000 行，单文件） |
| `backend/lib/config-store.js` | 配置默认值、升级迁移、原子写、掩码 |
| `backend/lib/snapshots.js` | 快照创建/恢复/删除/清理、当前世界真值、世界重置 |
| `backend/lib/ports.js` | 端口占用检测与顺延 |
| `backend/lib/rcon.js` | RCON 客户端 |
| `backend/lib/llm-cooldown.js` | 按 provider 的并发租约与冷却（防 429） |
| `bots/bot-lite.js` | 主力工人：采集 + 建造 + 社交（当前在用） |
| `bots/bot.js` | 早期建造工，保留但不再是默认脚本 |
| `bots/personas/*.json` | 人设卡：性格、语气、目标 |
| `bots/specs/*.json` | 功能说明书：能力边界与动作清单 |
| `server/` | MC 服务端（jar、`server.properties`、`world/`、`snapshots/`） |
| `scripts/pack-aicraft.ps1` | 打包脚本 |

## 启动链路

1. `AICraft.exe` 启动 → `app.whenReady()` → `createWindow()` 先开窗显示加载屏
2. 同时 `startCenter()` 拉起 `backend/center.js`（若已有实例则复用）
3. center 读 `config.json`，绑定内部 HTTP 端口，开始接受请求
4. 渲染层通过 IPC → center 拿 `/api/hall`，把状态铺到界面
5. 用户点「启动服务器」→ center `spawn` `java -jar minecraft_server_1.21.4.jar`，端口冲突则顺延
6. 用户点工人「启动」→ center `spawn node bots/bot-lite.js`，通过环境变量注入 provider/model/端口
7. 关窗走 `beginGracefulShutdown()`：停 bot → 停服（`/stop` + 等落盘）→ 真正退出

## 决策循环（bot-lite.js）

每一步大致是这样：

```
读世界状态（位置/血量/饥饿/背包/周围方块/队友消息）
        ↓
拼提示词（人设 + 功能说明书 + 最近记忆 + 当前局势）
        ↓
POST 到 OpenAI 兼容的 /chat/completions
        ↓
解析返回里的动作（JSON）
        ↓
用 mineflayer 执行（移动/挖/放/丢/说话/吃）
        ↓
写入 decisions-lite-<日期>-<bot>-<pid>.jsonl
        ↓
等下一个决策间隔（默认 10 秒，config.llm.decisionIntervalMs）
```

几个不那么显然的实现点：

- **思考参数**：同时发 `chat_template_kwargs.enable_thinking`、`enable_thinking`、`thinking`、`reasoning_effort` 四套；某家服务端回 400 就整体去掉重试一次，保证不漏单。
- **并发控制**：bot 不直接狂调 LLM，先向 center 的 `/api/llm/lease` 申请租约，由 `llm-cooldown.js` 统一限流，避免 429。
- **卡死自救**：`busy` 锁硬上限 200 秒，到点强制解锁并 `tp` 脱困；位置 60 秒不动也触发脱困。
- **3D 观战**：每个 bot 起一个本地 HTTP 服务，渲染层 `window.open` 打开它；主进程拦截 `window.open` 只放行 `127.0.0.1:<port>`，且**不设 parent**（Windows 上同父多子窗会互相抢层级）。

## HTTP 接口

全部走 center，返回 JSON，失败约定 `{ ok:false, code, msg }`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/hall` `/api/state` | 全量状态（服务器、工人、配置摘要） |
| GET | `/api/health` | 存活探测 |
| POST | `/api/server/start` `/api/server/stop` | 开/停服务器 |
| POST | `/api/all/start` `/api/all/stop` | 全部工人开/停 |
| POST | `/api/shutdown` | 整体优雅退出 |
| POST | `/api/bot/start` `/api/bot/stop` `/api/bot/restart` | 单个工人控制 |
| POST | `/api/bot/add` `/api/bot/update` `/api/bot/remove` | 增改删工人 |
| POST | `/api/bot/preset/two` | 一键铺两个预设工人 |
| GET / PUT | `/api/config` | 读（掩码后）/ 写配置 |
| POST | `/api/provider/test` | 测 Key 与连通性 |
| POST | `/api/provider/fetch-models` | 拉该家的模型清单 |
| GET | `/api/llm/lease` | bot 申请 LLM 配额 |
| POST | `/api/llm/report` | bot 回报调用结果（供限流统计） |
| POST | `/api/world/snapshot` | 打一份快照 |
| GET | `/api/world/snapshots` | 快照列表 + 当前世界真值 `current` |
| POST | `/api/world/snapshot/restore` | 用某份快照 |
| DELETE | `/api/world/snapshot` | 删某份快照 |
| POST | `/api/world/reset` | 删除当前世界并按设置重生成（内部先自动备份） |
| GET | `/api/logs` | 读日志尾部 |

## 配置结构（config.json）

```json
{
  "setupWizardDone": true,
  "server": {
    "host": "127.0.0.1",
    "portPref": 25565,
    "rconPortPref": 25575,
    "xmx": "4G",
    "rconPassword": "<随机>",
    "world": { "seed": "", "difficulty": "easy", "gamemode": "survival", "keepInventory": true, "levelType": "minecraft:normal" },
    "snapshots": { "autoEveryMin": 10, "autoKeep": 5, "manualKeep": 20, "totalCapMB": 2048 }
  },
  "memory": { "rounds": 5 },
  "llm": { "decisionIntervalMs": 10000, "staggerStartMs": 3000 },
  "providers": [
    { "id": "cloud", "name": "Agnes", "endpoint": "…", "key": "", "defaultModel": "agnes-2.5-flash", "models": [], "thinkingStyle": "all" }
  ],
  "presets": { },
  "bots": [
    { "name": "AI-Bot-L1", "nick": "…", "script": "bot-lite.js", "persona": "…", "providerId": "cloud", "model": "…", "keyMode": "shared", "color": "…", "viewer": true, "viewerPortPref": 0, "streamPortPref": 0, "spawnSlot": 0, "memoryRounds": 5 }
  ],
  "model": { "decisionIntervalMs": 10000 }
}
```

约定：

- `providers` 是数组；bot 脚本里有一层兼容旧对象格式的 `providersMap()`
- `key` 为空且 endpoint 是内网/本机地址时，视为本地模型，不强制要 Key
- 端口用 `portPref`，真正端口由 `ports.js` 探测顺延
- 升级时 `upgradeCfg()` 只清下线供应商（`RETIRED_IDS`），用户自己加的原样保留

## 想改点什么

| 目标 | 改哪里 | 注意 |
|---|---|---|
| 加一个动作 | `bot-lite.js` 的动作分派 + `specs/*.json` 的能力说明 | 提示词里的动作名必须和代码里的分支一致，否则模型会"说得到做不到" |
| 调性格 | `personas/*.json` | 只写性格与语气，别把能力写进去（能力和人设是分开的两套文件） |
| 换模型 | 「AI 大脑供应商」页，或直接改 `providers[].defaultModel` | 模型名写错会触发 `E_BAD_RESPONSE` |
| 加供应商 | 「＋ 添加供应商」，填 OpenAI 兼容的完整 URL | 需要完整 endpoint，不是 base url |
| 改决策频率 | `llm.decisionIntervalMs` | 调太短会被限流，调太长像发呆 |
| 改界面 | `app/renderer/index.html` + 对应 js | 无构建步骤，改完重启 AICraft 就能看到 |

## 打包

```powershell
# 在项目根目录
powershell -ExecutionPolicy Bypass -File scripts\pack-aicraft.ps1
```

打包前会按 `scripts/pack-exclude-list.txt` 剔除日志、备份、测试产物。

## 已知限制

- 只有 Windows 绿色包，没有 mac/Linux 封装
- 3D 观战窗每个约占 0.3 GB 内存，开多了会卡
- 世界类型固定 `minecraft:normal`（flat / large_biomes 实测会让 3D 画面看不到东西）
- 模型返回格式不稳时会出现"说了没做"，靠重试兜底，不是 100% 可靠
- 快照列表每次刷新都会递归算目录大小，快照多了会变慢（未优化）

## 二次开发前的提醒

- 不要提交 `config.json`——里面有明文 Key。仓库的 `.gitignore` 已经排除它
- `app/node_modules` 与 `bots/node_modules` 都是依赖，不要入库
- 改已有文件请先备份（`.bak-日期`），这个项目的历史包袱就是靠备份找回的
