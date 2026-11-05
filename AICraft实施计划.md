# AICraft 绿色版游戏化改造 · 实施计划

> 版本：v1.0（2026-10-25）· 状态：待主人批准后开工
> 目标：把现有 MC-AI 实验（Minecraft 1.21.4 + Mineflayer bot + 云端大模型）做成"学习版游戏"式绿色产品
> 边界：**全新项目文件夹 `E:\Doubao\DB work\MC-AI游戏\`，现有 `MC-AI实验\` 一字不改，只作只读参考**

---

## 〇、已拍板的决定（主人确认清单）

| # | 决定 | 结论 |
|---|---|---|
| 1 | 入口名 | **AICraft**（exe = AICraft.exe，桌面快捷方式同名） |
| 2 | 系统兼容 | **Win10/11 64位全覆盖，放弃 Win7**（Java 21 + MC 官方均不支持，已查证） |
| 3 | 形态 | 绿色版：解压即玩，自带完整 JDK + 便携 Node + 全部依赖，约 1GB |
| 4 | 初始 bot | **2 个**（可在界面增删，动态数量） |
| 5 | key 模型 | 每 bot 可独立 key（免费多账号分摊限流），也可共享默认 key（按量计费） |
| 6 | 显示对应 | 界面显示真实 bot 名 + 真实模型全名，不显示"大姐/二姐/三妹"花名 |
| 7 | 界面 | 游戏风格 + **黑底/白底手动切换**，颜色柔和低饱和 |
| 8 | 世界 | 种子/世界类型/难度/游戏模式/死亡掉落/出生点 全部界面可设，支持重置 |
| 9 | 角色卡 | 内置编辑器 + 可导入外部 JSON，每 bot 绑定一份 |
| 10 | 快捷方式 | 文件夹内放"创建桌面快捷方式.bat"，点一下自动建 |
| 11 | 新项目 | `E:\Doubao\DB work\MC-AI游戏\`，不动现有实验目录 |

---

## 一、目标目录结构

```
E:\Doubao\DB work\MC-AI游戏\
├── AICraft.exe                  ← 绿色版入口（Electron 壳，双击即玩）
├── app\                         ← Electron 壳代码
│   ├── main.js                  ← 主进程：开窗口、托盘、关停联动
│   ├── preload.js               ← 安全桥
│   └── renderer\                ← 前端页面（大厅/详情/设置，纯静态 HTML+JS）
│       ├── index.html           ← 大厅页
│       ├── detail.html          ← bot 详情页（3D+对话+思考）
│       ├── settings.html        ← 设置页（连接/角色/世界/帮助 四页签）
│       ├── style.css            ← 双主题样式（黑/白 CSS 变量）
│       └── app.js               ← 前端逻辑
├── backend\
│   └── center.js                ← 指挥中心后端（原 hall.js 升级：进程管理+配置API+状态聚合）
├── runtime\
│   ├── jdk25\                   ← 完整便携 JDK（复制自 E:\Tools\jdk-25.0.4.1+1）
│   └── node\                    ← 便携 Node（node.exe + bot 依赖 node_modules）
├── server\
│   ├── minecraft_server_1.21.4.jar
│   ├── server.properties        ← 世界设置（seed/难度/模式…由界面写入）
│   └── world\                   ← 世界存档（重置=备份+删+重建）
├── bots\
│   ├── bot-lite.js              ← 拆建全能工脚本（复制自实验目录，加一行 viewer 开关判断）
│   ├── bot.js                   ← 纯建造工脚本（复制，自由搭建，加一行 viewer 开关判断）
│   ├── presets.json             ← bot 预设模板库（新手一键配置）
│   └── personas\                ← 角色卡 JSON（界面可编辑/导入）
│       ├── persona-worker.json  ← 预设①拆建全能工角色卡模板
│       ├── persona-builder.json ← 预设②纯建造工角色卡模板
│       ├── persona-1.json       ← 实际 bot 绑定的角色卡（从预设复制生成）
│       ├── persona-2.json
│       └── …
├── config.json                  ← 唯一配置事实源（无 BOM！）
├── logs\                        ← 服务器/bot 日志
├── 创建桌面快捷方式.bat         ← 一键建桌面快捷方式
└── 使用说明.txt                 ← 小白也能看懂的说明书
```

---

## 二、关键技术设计

### 1. 指挥中心后端 center.js（核心新增）
- 原生 Node http（不引框架），端口 **3100**
- **进程管理**：
  - 启动服务器：spawn java → 轮询日志等 "Done" + RCON 就绪 → 报告状态
  - 启动 bot：从 config.bots 派生参数（name/model/端口），spawn node
  - 停止：级联 kill（记录 PID，防孤儿进程）
  - 一键全启动 / 一键全停止
- **配置 API**：
  - GET /api/config（脱敏返回：key 打码）
  - POST /api/config（校验 + 无 BOM 写入 + 自动重启受影响 bot）
  - POST /api/provider/test（用 endpoint+key+model 实测一发，返回耗时/错误）
- **状态聚合**：轮询各 bot /state → /api/hall（沿用现 hall 逻辑）

### 2. 配置结构 config.json（新 schema）
> ⚠️ **端口规则：config 里存的只是"偏好起始端口"，不是写死值。** 每次启动时 center.js 动态探测，被占用就自动顺延，Electron 壳始终用返回的**实际端口**访问。换任何电脑都不会因为端口撞车而玩不了。
```json
{
  "server": { "xmx": "2G", "rconPassword": "***", "world": { "seed": 1892274125, "difficulty": "peaceful", "gamemode": "survival", "keepInventory": true, "levelType": "default" },
    "portPref": 25565, "rconPortPref": 25575 },
  "memory": { "rounds": 5 },
  "providers": [
    { "id": "agnes", "endpoint": "https://api.agnes-ai.cn/v1/chat/completions", "key": "***", "models": ["agnes-2.5-flash","agnes-3.0-flash"] },
    { "id": "qwen",  "endpoint": "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions", "key": "***", "models": ["qwen3.8-27b"] }
  ],
  "presets": [
    { "id": "worker",  "name": "拆建全能工", "script": "bot-lite.js", "persona": "personas/persona-worker.json" },
    { "id": "builder", "name": "纯建造工",   "script": "bot.js",     "persona": "personas/persona-builder.json" }
  ],
  "bots": [
    { "name": "AI-Bot-L",  "script": "bot-lite.js", "persona": "personas/persona-1.json",
      "provider": "agnes", "model": "agnes-2.5-flash", "keyMode": "shared" | "own", "ownKey": "***",
      "viewer": true, "viewerPortPref": 3001, "streamPortPref": 3002 },
    { "name": "AI-Bot-L2", "script": "bot-lite.js", "persona": "personas/persona-2.json", "…" }
  ]
}
```

### 3. Electron 壳（AICraft.exe）
- 用 **Electron 最新稳定版**（Win7 已放弃，不必锁 22）
- 主进程：打开大厅窗口 → 所有功能走 center.js 的 HTTP API
- 详情页：3D viewer 用 iframe 嵌入（点进才渲染，避免三路 WebGL 同开卡顿）
- 关窗 = 问"是否同时关闭服务器和 bot"（防孤儿进程）

### 4. 前端（游戏风格 + 双主题）
- 深色：低饱和深蓝黑（沿用 #0b1220 系）
- 浅色：米白低饱和（非纯白，护眼）
- 右上角主题切换按钮（存 localStorage）
- 每块区域带灰色小字说明"这是啥、点了会怎样"
- 状态灯：🔴 未启动 / 🟡 启动中 / 🟢 运行中
- 首次打开引导三步（没配 key 时显示）
- 内联说明规范见 §11：悬停提示（核心操作）+ 操作反馈 + 状态引导 + 危险确认 + 较全面帮助页

### 5. 世界设置
- 界面表单 → 备份 server.properties → 写入（seed/难度/模式/level-type）
- keepInventory 用 RCON gamerule 或 server.properties
- 重置世界：停服 → world 改名备份 → 删 → 启动重建（保留 seed）
- 全部危险操作（重置/删除）在界面二次确认

### 6. 绿色打包
- runtime/jdk25：复制 `E:\Tools\jdk-25.0.4.1+1`（完整版，~300MB，稳）
- runtime/node：便携 Node + bot 的 node_modules 复制
- Electron：npm install electron（ELECTRON_MIRROR=npmmirror，缓存指 E:\Tools）→ electron-builder 打 **portable 免安装包**（或直接目录版）
- 产物：MC-AI游戏 文件夹整体 ≈ 1GB，拷到任何 Win10/11 解压即玩

### 7. bot 预设模板（新手一键配置）
- `bots/presets.json` 内置两套预设：
  | 预设 id | 名字 | 对应脚本 | 角色卡模板 | 适合 |
  |---|---|---|---|---|
  | `worker` | 拆建全能工 | bot-lite.js | persona-worker.json | 会拆会建：TNT 爆破 + 蓝图秒建 + 兑换机制 |
  | `builder` | 纯建造工 | bot.js | persona-builder.json | 自由搭建：一格格亲手盖房，不靠脚本 |
- 设置页"角色"页签：点「从预设添加 bot」→ 选预设 → 自动生成：新 bot 名（AI-Bot-N）、脚本、角色卡副本、空闲端口 → 界面只改模型/key 即可启动
- 新手路径：选预设 → 填 key → 启动，三步完成，不用碰 JSON

### 8. 每 bot 独立启停 + 画面开关
- **独立启停**：大厅每张 bot 卡片自带 启动/停止 按钮，开 5 个也能只关某个；另有"全部启动/全部停止"总控
- **画面开关**：config.bots 每项加 `viewer: true/false`——开 = 3D 画面 + 文字决策流都起；关 = 只起文字决策流（对话/思考/状态照常看），适合不想看画面的人
  - 实现：bot 脚本加一行 `if (RUN.viewerPort)` 判断（复制版上改，实验目录原件不动），不传 --viewer-port 就不起 3D
- 切换画面开关后自动重启该 bot 生效

### 9. 端口动态分配（跨机不撞车，关键）
- **config 里只有"偏好起始端口"（portPref / viewerPortPref / streamPortPref），没有写死值**
- center.js 内置**端口分配器**：每次启动前扫描本机占用，从偏好值开始探测，被占用就 +1 顺延，直到找到空闲端口
  - 服务器：`portPref 25565` / `rconPortPref 25575` 被占 → 自动顺延
  - bot 3D/文字：`viewerPortPref 3001` / `streamPortPref 3002` 被占 → 自动顺延
- **Electron 壳从不写死端口**：每次通过 `/api/hall` 拿到的就是各 bot **实际运行端口**，前端用它拼 URL（iframe 嵌 3D、轮询 /state），端口变了界面照常工作
- bot 连接服务器的端口/RCON 端口也由 center 启动时通过命令行参数注入（复制版 bot 加读参逻辑），服务器顺延后 bot 自动连对
- 换电脑 / 端口被别的程序占用 → 自动换端口，不报错、不崩、界面自适配

### 10. 人设自写 + 记忆条数可设置- **人设（角色卡）全部可自己写**：界面"角色"页签里，每个 bot 的角色卡提供**编辑器**，可改的核心字段（从现有角色卡结构提取）：
  | 字段 | 含义 | 例子 |
  |---|---|---|
  | role_name | 角色名 | 全能工·大姐 |
  | character.name / first_person | 名字 / 自称 | 大姐 / 姐 |
  | character.identity | 身份设定 | 三姐妹老大，拆建全能工 |
  | character.appearance | 外貌 | 168cm，工装风 |
  | character.mannerisms | 举止习惯 | 干活利落 |
  | character.catchphrase | 口头禅 | （可空） |
  | positioning | 定位 | 自主规划工 |
  | system_prompt_ready | 最终系统提示（模型实际看到的） | 你就是大姐…… |
  - 编辑器 = 文本框直接改 + 语法校验 + 保存无 BOM 写回；也支持导入外部 JSON 整卡替换
- **记忆条数可设置**：现在两个 bot 脚本里记忆上限**硬编码 `> 5`**（bot-lite.js L233/L1580/L1643、bot.js L148/L1189/L1243，共 6 处）→ 改为读 config
  - config.json 新增 `memory`: `{ "rounds": 5 }`（决策轮历史条数，默认 5，可设 3/5/8/10/自定义）
  - 复制版 bot 脚本把 6 处 `> 5` 改成读 `RUN.memoryRounds`（启动时由 center 通过参数注入），实验目录原件不动
  - 队友聊天、自己说话、决策轮历史三条记忆窗口共用同一可调值
- 界面：设置页 → bot 编辑 → "记忆条数"下拉（3/5/8/10）+ 人设编辑按钮

### 11. 界面内联说明规范（不单独写说明书，说明化进界面）
- **① 悬停提示（tooltip）——覆盖核心操作**：
  - 只给核心操作加：启动/停止、画面开关、记忆条数、API key、测试连接、重置世界、预设添加、人设编辑等
  - 文案一句话原则："这是啥 + 点了会怎样"，大白话 + 生活比喻（如记忆条数=记性），不放专业术语
  - 次要控件用简短灰色小字（不悬停也看得到），不铺满气泡
- **② 操作反馈提示——改完必提示**：
  - 保存配置 → 右上角浮提示"已保存，bot1 正在重启，约 3 秒"
  - 启动服务器 → 卡片变 🟡 启动中…，下方滚动日志；就绪变绿
  - 出错 → 明确说"哪里错 + 怎么解决"（如"API key 无效 HTTP 401，去设置页检查"）
- **③ 状态引导**：首次未配 key → 顶部黄条"第 1 步：填 API 密钥 → 第 2 步：添加 bot → 第 3 步：启动"；按钮依赖不满足 → 变灰 + 悬停说明原因
- **④ 危险操作确认**：重置世界等 → 弹窗"会删除当前世界重新生成（保留种子），确定？"
- **⑤ 帮助页（较全面，承担说明书角色）**：
  - 因为悬停提示只覆盖核心操作，帮助页必须补全**所有功能**说明：每个 bot 卡片、每个设置项、每个按钮是干嘛的
  - 结构：① 快速上手（3 步操作顺序）② 所有功能逐个说明（分区：大厅/详情/设置-连接/设置-角色/设置-世界/帮助）③ 常见问题（key 无效/连不上服务器/bot 卡住/端口被占用怎么办）④ 版本号
  - 语言同款大白话；内嵌在应用"帮助"页签里，不是外部文档

---

## 三、分阶段执行 + 每步验证

### 阶段 1：后端 center.js + 新配置结构（先动骨头）
1. 新建 `backend/center.js`（进程管理 + 配置 API + 状态聚合）
2. 新 config.json schema 落地（无 BOM 校验）
3. 验证：
   - [ ] center 启动、/api/hall 返回
   - [ ] 通过 API 启动服务器 → 日志出现 Done → 状态 🟢
   - [ ] 通过 API 启动 2 bot → /state 可读
   - [ ] 一键停止 → 进程清空（无孤儿）
   - [ ] POST /api/provider/test 对 qwen/agnes 各实测一发

### 阶段 2：Electron 壳 + 前端页面
1. app/main.js + renderer（大厅/详情/设置/双主题/引导）
2. 验证：
   - [ ] AICraft.exe 启动 → 大厅显示服务器+2 bot 卡片
   - [ ] 点 bot 卡片 → 详情页 3D 画面 + 对话 + 思考
   - [ ] 黑/白主题切换生效且不刺眼
   - [ ] 设置页：加第 3 个 bot → 保存 → 自动重启 → 卡片出现
   - [ ] 设置页：改 key → 测试连接 → 保存 → bot 重启用新 key
   - [ ] 世界页：改种子 → 重置世界 → 新世界生成
   - [ ] 关窗 → 提示关停服务器+bot
   - [ ] **预设添加**：点「从预设添加」选 拆建全能工 → 自动生成新 bot（名字/脚本/角色卡/端口）→ 只填 key 即可启动
   - [ ] **独立启停**：开 2 个 bot，只停其中 1 个 → 另一个照常跑；再只开回那 1 个
   - [ ] **画面开关**：某 bot 关掉 3D（viewer:false）→ 重启后只显示文字决策流（对话/思考正常），另开一个照常有 3D
   - [ ] **人设编辑**：在编辑器里改 bot 的人设（自称/性格/口头禅）→ 保存 → 重启 bot → 对话风格按新设定走（读日志确认 system prompt 生效）
   - [ ] **记忆条数**：把某 bot 记忆条数改成 3 → 重启 → 决策页历史只保留最近 3 轮（/state 或日志确认）；改成 8 同理
   - [ ] **悬停提示**：核心操作（启动/画面开关/记忆条数/API key/重置世界）悬停有气泡说明，次要控件有灰字
   - [ ] **操作反馈**：保存配置后出现"已保存，正在重启"提示；启动中卡片变黄+日志滚动；错误有明确原因+解决办法
   - [ ] **帮助页**：帮助页签能查到所有功能说明（含悬停未覆盖的次要项）、3 步上手、常见问题、版本号

### 阶段 3：绿色打包 + 便携运行时
1. 复制 runtime（JDK + Node + node_modules）
2. electron-builder 打包 portable
3. 验证（关键！模拟"干净机器"）：
   - [ ] 从 E:\Doubao\DB work\MC-AI游戏 直接双击 AICraft.exe（不依赖系统 node/java）
   - [ ] 全链路：启动服务器 → bot → 3D → 对话 → 停止
   - [ ] 使用说明.txt 按步骤走一遍能通
   - [ ] **端口防撞验证**：手动占用 3001（起个临时监听）→ 启动 bot → 自动顺延到 3002+ → 界面仍正常显示画面/对话
   - [ ] **端口防撞验证2**：占用 25565 → 启动服务器 → 自动顺延 → bot 自动连对端口，全链路通

### 阶段 4：交付 + 文档 + 记账
1. 使用说明.txt（小白向）
2. 创建桌面快捷方式.bat 实测
3. 交接报告 + 台账登记（MC-AI实验 明细补登记自由搭建阶段；新项目建"MC-AI游戏"明细）

---

## 四、风险与坑（防呆清单）

| 风险 | 应对 |
|---|---|
| config.json 写入带 BOM → Node 崩 | 所有写入用 Node fs 无 BOM；写完立刻 JSON.parse 自检 |
| 孤儿进程残留 | center 记录 PID，停止时级联 kill；启动前端口占用检查 |
| Electron 下载慢/写 C 盘 | ELECTRON_MIRROR=npmmirror + 缓存指 E:\Tools\ |
| 三路 WebGL 同开卡顿 | 详情页点进才渲染，大厅只显状态 |
| 新代码破坏现有 bot 逻辑 | bot-lite.js/bot.js 原样复制不改一行；所有修改前备份 .bak-日期 |
| 1GB 拷贝耗时 | 大文件用 robocopy 带进度 |
| 端口被占用（任意机器） | center 端口分配器自动 +1 顺延，Electron 用实际端口访问，界面自适配不报错 |

---

## 五、本计划不含（边界）

- 不做运行时热切换 key（改配置 = 重启 bot，2 秒完成）
- **不改 bot-lite.js / bot.js 的玩法逻辑**（拆/建/兑换/自由搭建全部保持原样）；唯一允许的改动 = 复制版加：① viewer 开关判断 `if (RUN.viewerPort)` ② 记忆条数读参（6 处 `> 5` 改读 RUN.memoryRounds）③ 服务器/RCON 端口读参；实验目录原件全部不动
- 不做安装器（NSIS），只做便携文件夹 + 快捷方式 bat
- 不兼容 Win7 / macOS / Linux（本轮仅 Win10/11）
- 预设仅内置两套（拆建全能工 / 纯建造工），不做预设市场

---

## 六、工作量预估

| 阶段 | 内容 | 预估 |
|---|---|---|
| 1 | 后端 center.js + 配置 | 1 次会话 |
| 2 | Electron 壳 + 前端 | 1-2 次会话 |
| 3 | 绿色打包 + 干净机验证 | 1 次会话 |
| 4 | 文档 + 记账 + 交付 | 0.5 次会话 |

---

**批准开工请回复"批准"或"开工"。有异议先改计划再动。**
