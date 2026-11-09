# 微博粉丝助手

当前已提供本地中文管理界面、多账号独立档案、可见粉丝列表连续滚动读取、初始 UID 记录、永久去重、定时检查及每 60 个 UID 自动导出。

**直接使用：**打开 `dist/微博粉丝助手_0.1.0`，双击 `启动微博粉丝助手.cmd`。便携包自带 Node.js，只需本机已安装 Microsoft Edge。详见 [使用说明](使用说明.md)。

**源码运行：** `npm.cmd start`；**测试：** `npm.cmd test`；**打包：** `npm.cmd run build`；**便携包验证：** `node portable-smoke.mjs`。

正式管理界面使用 `http://127.0.0.1:8766/`，原验证工具保留在 8765，使用 `npm.cmd run probe` 启动。真实数据保存在 `%LOCALAPPDATA%\WeiboFollowerProbe`，不在源码或便携包中。

统计采用用户确认的“可见列表 UID 差异”口径。初始化已有粉丝不导出，读不全的轮次不直接确认新增。未覆盖隐藏账号或两轮间短暂关注，详情及验证范围见使用说明。

以下保留早期验证工具说明，历史阶段记录不代表正式应用当前功能状态。

## A 账号真实读取

在装有 Microsoft Edge 和 Node.js 24 的 Windows 上，在本目录运行：

```powershell
npm.cmd ci
npm.cmd run read:a
```

如果 A 的独立 Edge 窗口仍开着，先关闭该窗口。命令使用 `%LOCALAPPDATA%\WeiboFollowerProbe\profiles\A` 中的既有档案。若命令提示登录，在打开的微博窗口里自行登录，完成后回到命令行按 Enter。

命令通过顶部头像和自己的主页交叉核对 UID，从「我的粉丝」进入同一账号的粉丝区，选用「关注时间倒序」，连续滚动读取已渲染的粉丝卡片。观测保存在 `%LOCALAPPDATA%\WeiboFollowerProbe\weibo-a-observations.json`。此命令仅用于采集诊断，新增比较、定时调度和导出使用上方的正式管理界面。

## 本机 Edge 自动化验证

在装有 Microsoft Edge 和 Node.js 24 的 Windows 上，在本目录运行：

```powershell
npm.cmd ci
npm.cmd test
```

仅运行浏览器测试可用 `node --test edge-fixture.test.mjs`。测试启动本机 Edge，无需安装其他浏览器。测试页与测试 UID 均为环回模拟数据，档案和证据文件放在临时目录，测试完成后清理。

[browser-round.mjs](browser-round.mjs) 提供识别登录者、进入粉丝区域、核对归属及遍历窗口的流程。[weibo-a.mjs](weibo-a.mjs) 提供真实页面适配及连续滚动能力，正式应用通过 [monitor-browser.mjs](monitor-browser.mjs) 复用到多个独立账号。身份冲突或访问拦截时丢弃该轮 UID，不挂到错误账号。

## 手动取样工具

Windows 上使用 Microsoft Edge 和 Node.js 24。双击 [启动验证.cmd](启动验证.cmd) 或在工作区运行 `node probe.mjs`，然后访问 [本地验证页](http://127.0.0.1:8765/)。

请在 Windows 上的 Edge 地址栏直接输入本地验证地址。如果本地页的 A 按钮打不开浏览器，可以在文件资源管理器里双击 [打开账号A.cmd](打开账号A.cmd)。它使用相同的 A 档案。

1. 在验证页点「打开账号 A」。在官方页面自行登录。点自己的头像进入主页，复制主页链接，随后从自己的主页进入「粉丝」。将主页链接和按可见顺序手动复制的粉丝资料链接填到本地页。没有准确粉丝数时留空。手动翻到下一页时，使用空行分隔两个页面的链接。仅选取部分内容时，在对比中一直使用相同范围。
2. B 同理。首次记录 B 的独立基线，再对 A 原样复读一次。检查两账号的历史分开且账号身份不能串用。关闭后从本地页重新打开 A 和 B，核对登录仍是各自账号。
3. 先在 B 查看是否已经关注 A。由 B（或另一个受控账号）在平台正常操作一次关注 A。在 A 中记录同一范围并查看是否有带 UID 与时间的新粉丝提醒。之后分别验证取关和重新关注，每次刷新 A 并单独保存观测。A/B 都已录入时，工具会显示另一档案的账号是否出现在样本中。
4. 最后仅在 A 官方页面主动退出。重新打开确认是否要求登录，并在验证工具登记「要求重新登录」。核对 B 仍可用。A 重新登录原账号后沿用历史。自然过期和手动退出单独记录。

如果主页是个性域名，点该用户一条微博的发布时间，从正文链接确认 UID。微博微号与 UID 是不同标识。不要提交整页文本、密码、验证码、二维码或 Cookie。 [微博官方说明](https://kefu.weibo.com/faqdetail?id=12701)

浏览器自行维护登录状态，两个 Edge 用户数据目录分别位于当前 Windows 用户的 `%LOCALAPPDATA%\WeiboFollowerProbe\profiles\A` 和 `profiles\B`。尽量不在验证档案启用 Edge 同步或保存密码。工具读取和保存的是手动提供的数字 UID、顺序和页面观测，写入同一应用目录下的 `observations.json`。本机验证服务器只监听环回地址。无 UID 的摘要位于 [本地摘要](http://127.0.0.1:8765/summary)。

手动取样逻辑的单元测试可用 `node --test probe.test.mjs`。原始项目记录见 [第一阶段验证记录](第一阶段验证记录.md)。
