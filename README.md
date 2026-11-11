<div align="center">

# 微博粉丝助手 (Weibo Follower Probe)

**基于 Microsoft Edge 与顺位哨兵链机制的微博公开粉丝列表高频监控与批量导出助手**

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-lightgrey.svg)](https://microsoft.com/windows)
[![Release](https://img.shields.io/badge/Release-v0.3.0-orange.svg)](https://github.com/EV-Instinct/weibo-follower-probe/releases)

</div>

---

## 📖 项目简介

**微博粉丝助手** 是一款专为大规模微博公开博主粉丝动态追踪设计的桌面工具。通过多查看账号池（Viewer Pool）分流调度、长连接常驻 Edge 浏览器直连首屏 API、顺位哨兵链（Anchor Queue）推断机制，实现 50~100+ 个目标博主粉丝列表顶部的秒级极速巡检与增量变动捕获。

- **无需配置复杂爬虫环境**：直接复用本地自带的 Microsoft Edge 浏览器。
- **开箱即用免安装**：提供原生绿色便携包（内嵌 Node.js 运行时与 C# 原生启动器），普通用户电脑无需安装 Node.js。
- **全链路本地隐私安全**：账号登录状态与数据库完全保存在本地电脑（`%LOCALAPPDATA%`），绝不上传任何云端。

---

## ✨ 核心特性

### 1. 顺位哨兵链机制（Anchor Queue）
- 自动保存上次顶部前 N 名粉丝作为有序候补哨兵链。
- **取关容错**：排头哨兵取关时自动顺延使用后继哨兵作为截点，彻底解决微调断层与误报 gap。
- **回粉识别**：旧粉取关后重新关注跳到顶部时，仍以正常哨兵为截点，精准识别重新关注并不漏算新增粉丝。

### 2. 极速检测与常驻复用（Persistent Browser & Early Stop）
- 常驻复用 Edge 浏览器上下文（Keep-Alive 长连接），彻底消除重复启动关闭浏览器的进程冷启动耗时。
- 同源直连微博粉丝 API 首屏（`/ajax/friendships/friends`），第 1 页命中有效哨兵立即停止翻页，单次检测耗时压减至毫秒级。

### 3. 多查看账号池（Viewer Pool）与智能分流
- 支持添加、管理多个“巡检查看小号”，支持从单 viewer 平滑自动升级。
- 多账号并行分流巡检不同目标（单个查看号内部串行 + 随机微抖动防风控）。
- **故障自动转移（Failover）**：单个查看号受限或失效时仅单独隔离冷却该号，其分担的目标自动由其他健康账号无缝接管，整体监控不停摆。

### 4. 智能自适应分级轮询（Adaptive Polling）
- **活跃快巡（30~60秒）**：持续有新增的目标自动升入高频档，防止大号爆发涨粉冲出哨兵窗口。
- **常规巡检（默认 2分钟）**：平稳状态保持基准巡检频率。
- **静默省流（4~10分钟）**：长期 0 新增的目标阶梯式放缓，节省系统资源与网络请求；一旦出现新关注立即秒级唤醒回切高频档。

### 5. 高密度批量管理 UI
- 顶部卡片化展示查看账号池状态（正常 / 登录中 / 冷却受限）与分担速率。
- 支持多行文本批量粘贴导入 UID 与备注，自动去重清洗。
- 提供一键全部开始、全部暂停、批量修改检查间隔 / 切换智能调频、一键导出所有尾数。
- 支持按状态筛选（全部 / 监控中 / 有待导出 / 异常需核对 / 已暂停）与 UID / 备注实时毫秒级搜索。
- 每博主满 60 条自动导出为清晰的 TXT 档案（格式：`时间_博主备注_UID_60条.txt`）。

---

## 🚀 快速上手

### 方式 A：便携绿色版运行（推荐最终用户）

1. 在 [Releases](https://github.com/EV-Instinct/weibo-follower-probe/releases) 页面下载最新的 `微博粉丝助手_0.3.0.zip` 并解压。
2. 双击运行 `微博粉丝助手.exe`。
3. 系统将自动调起内置 Edge 打开本地管理界面。
4. 详细操作步骤请参考 [使用说明.md](./使用说明.md)。

> **系统要求**：Windows 10 / Windows 11，系统自带 Microsoft Edge 即可，**无需** 安装 Node.js。

### 方式 B：从源码运行与二次开发

确保本地已安装 [Node.js](https://nodejs.org/) (版本 `>= 22.5.0`，因使用了原生 `node:sqlite`)：

```bash
# 1. 克隆仓库
git clone https://github.com/EV-Instinct/weibo-follower-probe.git
cd weibo-follower-probe

# 2. 安装依赖
npm install

# 3. 启动开发模式（自动打开网页管理端）
npm start

# 4. 运行完整自动化测试套件
npm test

# 5. 打包构建 Windows 绿色便携版
npm run build
```

---

## 🏗️ 系统架构

```text
weibo-follower-probe/
├── watch-app.mjs         # 本地环回 HTTP API 服务，校验 Host/Origin/CSRF，提供管理端接口
├── watch-store.mjs       # 基于 node:sqlite 的本地数据库层，管理哨兵底册、关注事件与批次
├── watch-service.mjs     # 账号池调度引擎，负责多号分流、随机抖动、动态调频与故障转移
├── watch-browser.mjs     # 常驻 Edge 浏览器生命周期与同源 API 直连提取引擎
├── launcher/
│   └── Launcher.cs       # C# 原生单实例启动器，防多开、进程托管与托盘/唤醒支持
├── ui/                   # 纯原生无框架高响应管理端 UI
│   ├── watch.html        # 主界面结构
│   ├── watch.css         # 现代化高密度响应式样式
│   └── watch.js          # 交互状态机、实时轮询与批量操作逻辑
└── 使用说明.md            # 面向终端用户的详细图文操作指南
```

---

## ⚙️ 环境变量配置

系统支持通过环境变量自定义存储路径与端口（适合高级用户或批处理集成）：

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `WEIBO_MONITOR_DATA_DIR` | `%LOCALAPPDATA%\WeiboFollowerProbe` | 数据库 `watch.sqlite` 与登录凭证存储目录 |
| `WEIBO_MONITOR_PORT` | `8766` | 本地回环 HTTP 服务端口（绑定 `127.0.0.1`） |
| `WEIBO_MONITOR_EXPORT_DIR` | 程序同级目录下的 `粉丝UID导出` | TXT 结果文件导出目录 |

---

## 🔒 隐私与安全性

1. **零外部数据外泄**：本项目为纯本地单机应用，仅与微博官方服务器及本地 `127.0.0.1` 通信，不包含任何第三方统计、埋点或遥测上报代码。
2. **凭据安全隔离**：登录会话保留在系统用户独占的 LocalAppData 目录中，项目打包与 Git 提交均已深度过滤，绝不包含个人身份凭据或监控数据。
3. **安全防护机制**：本地 HTTP API 强制校验 Host 和 Origin 来源，拦截非本机与跨域非法调用。

---

## ⚖️ 开源协议与免责声明

- 本项目基于 [MIT License](./LICENSE) 开源。
- **免责声明**：本项目仅供个人学习、技术研究及公开数据统计分析使用。请严格遵守相关法律法规以及目标平台的使用条款和机器人协议，请勿将其用于任何侵犯他人权益、高频恶意请求或商业化营利行为。使用者须自行承担由于使用本软件所产生的全部风险与责任。
