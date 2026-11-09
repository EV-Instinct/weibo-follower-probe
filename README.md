# 微博粉丝助手 0.2.1 (Weibo Follower Assistant)

直接双击项目根目录的 **启动新版微博粉丝助手.exe**，或便携包内的 **微博粉丝助手.exe**。保留程序旁的 `dist` 或 `app`、`runtime` 文件夹，不需要安装 Node.js。

面向多微博账号的新增粉丝增量监测、去重统计与批量导出工具。

## 项目架构与核心模块

- **应用入口与 HTTP 服务**：[`monitor-app.mjs`](monitor-app.mjs)
  - 提供本地轻量 Web 管理接口（默认端口 `8766`，支持同源与 CSRF 双重校验）。
  - 支持后台静默运行、再次启动复用已有进程与页面唤醒。
  - 启动参数支持 `--open`，默认打开 Edge App 窗口 (`--window-size=1280,820`)。
- **任务调度与风控保护**：[`monitor-service.mjs`](monitor-service.mjs)
  - 增量扫描状态机与并发队列调度（支持 1～3 账号并发）。
  - 间隔随机浮动（±20%）与账号切换冷却（5～20 秒）。
  - 访问受限与验证码分级保护（60 分钟冷却、连续 3 次停止并通知）。
- **数据持久化与导出管理**：[`monitor-store.mjs`](monitor-store.mjs)
  - 基于 Node.js 24 原生 `node:sqlite`（WAL 模式 + 强事务隔离）。
  - 数据库自动升级与自动备份（备份至 `backups/`）。
  - 粉丝 UID 永久去重，每满 60 个自动生成文件，支持尾数手动导出。
  - 动态导出路径与目录可写性检查。
- **浏览器适配与增量采集**：[`monitor-browser.mjs`](monitor-browser.mjs)、[`browser-round.mjs`](browser-round.mjs)、[`weibo-a.mjs`](weibo-a.mjs)
  - 基于 `playwright-core` 驱动系统内置 Microsoft Edge 独立持久化档案。
  - 增量扫描策略：倒序连续命中 2 屏已知粉丝即停，上限 40 屏；超限转候选并触发下一轮完整读取。
  - 账号昵称与身份自动识别提取。
- **系统通知与开机自启**：[`monitor-system.mjs`](monitor-system.mjs)
  - 通过 PowerShell WinRT API 调用原生 Windows Toast 桌面通知，无需重量级三方依赖。
  - Windows 当前用户启动项快捷方式读写。
- **运行日志与敏感脱敏**：[`monitor-logger.mjs`](monitor-logger.mjs)
  - 按天分割日志至 `logs/weibo-monitor-YYYY-MM-DD.log`，自动滚动清理 14 天前日志。
  - 敏感字段（Cookie、Token、Password 等）自动过滤脱敏。
- **Web 前端管理界面**：[`ui/`](ui/)
  - 原生 HTML5 / CSS3 / ES Module，无外部构建依赖，符合 CSP 策略。
  - 统计卡片、实时搜索筛选、批量操作、右侧滑出详情抽屉、响应式卡片视图（<1000px）。

## 开发与常用命令

```powershell
# 安装依赖 (仅 playwright-core)
npm.cmd install

# 启动本地服务与管理界面
npm.cmd start

# 运行全套自动化测试
npm.cmd test

# 打包便携绿色分发包 (输出至 dist/微博粉丝助手_0.2.1/)
npm.cmd run build

# 便携包独立运行时冒烟测试
node portable-smoke.mjs

# 原生 EXE、重复点击与重启持久化验证（隔离临时数据）
node launcher-smoke.mjs
```

## 数据目录说明

用户实际运行数据存放于当前用户本地目录：
`%LOCALAPPDATA%\WeiboFollowerProbe`

- `monitor.sqlite`：核心数据库文件。
- `backups/`：结构迁移与自动备份副本。
- `profiles/`：各账号独立 Edge 用户浏览器档案。
- `exports/`：生成的粉丝 UID 导出文本文件（默认位置，可在设置中修改）。
- `logs/`：按天分卷保存的运行日志文件。

## 运行说明与托盘说明

本程序在 Windows 系统下作为后台静默进程运行，通过原生 EXE 启动，无需 VBS 或额外安装 Node.js。启动器核对版本和数据目录，重复点击复用同一后台；遇到旧版后台会提示先从旧界面退出。
程序不常驻系统托盘（避免引入高风险原生编译依赖）；如需再次打开管理界面，直接双击运行启动程序即可瞬间唤起网页管理界面；如需彻底停止程序，在界面右上角点击「退出程序」即可。
面向普通用户的使用指南请参阅 [使用说明.md](使用说明.md)。
