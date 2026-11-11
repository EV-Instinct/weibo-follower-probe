import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createMonitorApp } from './monitor-app.mjs'

test('管理界面重做：账号生命周期、详情抽屉、批量操作、文件定位、删除与双分辨率截图', { timeout: 45000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'weibo-ui-'))
  let loginAccount = null
  let loginReady = false

  const reader = {
    login: null,
    async openLogin(account) {
      loginAccount = account
      loginReady = true
    },
    async loginState() {
      if (loginReady && loginAccount) {
        return { id: loginAccount.id, ready: true, nickname: '测试大V' }
      }
      return null
    },
    async scan() {
      return {
        owner: '9999000001',
        nickname: '测试大V',
        uids: ['1000000001', '1000000002'],
        total: 2,
        complete: true,
        reason: 'visible-end'
      }
    },
    async close() {}
  }

  const app = await createMonitorApp({ root, port: 0, reader, importProfiles: false, autoTick: false })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })

  t.after(async () => {
    await browser.close()
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })

  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))

  await page.goto(app.address)

  // 1. 添加账号
  await page.getByRole('button', { name: '+ 添加账号', exact: true }).click()
  await page.getByLabel('账号备注').fill('主工作号')
  await page.getByRole('button', { name: '保存账号', exact: true }).click()

  // 验证添加后表格行显示，且未登录账号显示「登录绑定」，不显示「立即检查」
  await page.getByRole('row').filter({ hasText: '主工作号' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '立即检查' }).count(), 0)
  const loginBtn = page.getByRole('button', { name: '登录绑定', exact: true })
  assert.equal(await loginBtn.count(), 1)

  const a = app.store.accounts()[0]
  assert.equal(a.label, '主工作号')

  // 2. 点击「登录绑定」
  await loginBtn.click()
  await page.waitForTimeout(100)
  // 运行调度周期：识别登录成功、获取昵称、建立初始基线
  await app.service.tick()
  assert.ok(app.store.account(a.id).baseline_at)

  await page.reload()
  // 登录并完成初始化后，显示微博昵称与「立即检查」按钮
  await page.getByText('测试大V').waitFor()
  const checkBtn = page.getByRole('button', { name: '立即检查', exact: true })
  assert.equal(await checkBtn.count(), 1)

  // 3. 再次点击「立即检查」触发增量检查
  await checkBtn.click()
  await page.waitForTimeout(100)
  await app.service.tick()

  // 4. 模拟新增 60 个 UID 并生成批次
  app.store.ingest(a.id, {
    owner: '9999000001',
    nickname: '测试大V',
    uids: Array.from({ length: 60 }, (_, i) => String(2000000000 + i)),
    total: 62,
    complete: true,
    reason: 'visible-end'
  }, { mode: 'incremental' })
  app.store.flush()

  await page.reload()
  await page.getByText('测试大V').waitFor()

  // 5. 点击行打开详情抽屉
  await page.getByRole('row').filter({ hasText: '测试大V' }).click()
  await page.locator('#detail-drawer').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#detail-drawer').isVisible(), true)

  // 切换抽屉标签：导出文件
  await page.getByRole('button', { name: '导出文件', exact: true }).click()
  await page.locator('#batches-list .drawer-item').first().waitFor()

  // 验证下载链接可用
  const downloadPromise = page.waitForEvent('download')
  await page.locator('#batches-list a').filter({ hasText: '下载' }).first().click()
  const download = await downloadPromise
  assert.match(download.suggestedFilename(), /60条/)

  // 切换抽屉标签：检查记录
  await page.getByRole('button', { name: '检查记录', exact: true }).click()
  await page.locator('#scans-list .drawer-item').first().waitFor()

  // 关闭抽屉
  await page.locator('#drawer-close').click()
  await page.locator('#detail-drawer').waitFor({ state: 'hidden' })

  // 6. 验证新 API：详情接口 GET /api/accounts/:id/detail
  const detailRes = await fetch(`${app.address}api/accounts/${a.id}/detail`)
  assert.equal(detailRes.status, 200)
  const detailData = await detailRes.json()
  assert.equal(detailData.account.id, a.id)
  assert.equal(detailData.batches.length, 1)
  assert.equal(detailData.recent_scans.length >= 2, true)
  assert.equal(detailData.recent_followers.length, 60)

  // 7. 验证新 API：批次文件内容与定位
  const batchId = detailData.batches[0].id
  const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content')

  const contentRes = await fetch(`${app.address}api/batches/${batchId}/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: '{}'
  })
  assert.equal(contentRes.status, 200)
  const contentData = await contentRes.json()
  assert.equal(contentData.ok, true)
  assert.equal(contentData.content.trim().split(/\r?\n/).length, 60)

  const openRes = await fetch(`${app.address}api/batches/${batchId}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: '{}'
  })
  assert.equal(openRes.status, 200)

  // 8. 验证新 API：账号文件夹定位
  const folderRes = await fetch(`${app.address}api/accounts/${a.id}/folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: '{}'
  })
  assert.equal(folderRes.status, 200)

  // 9. 验证新 API：批量操作 POST /api/batch-actions
  // 批量暂停
  const pauseRes = await fetch(`${app.address}api/batch-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ action: 'pause' })
  })
  assert.equal(pauseRes.status, 200)
  assert.equal(app.store.account(a.id).enabled, 0)

  // 批量开始
  const startRes = await fetch(`${app.address}api/batch-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ action: 'start' })
  })
  assert.equal(startRes.status, 200)
  assert.equal((await startRes.json()).count, 1)
  assert.equal(app.store.account(a.id).enabled, 1)

  // 批量导出尾数
  const tailRes = await fetch(`${app.address}api/batch-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ action: 'tail' })
  })
  assert.equal(tailRes.status, 200)

  // 10. 验证 CSRF 防护（新接口必须全部拦截跨站伪造请求）
  const badDelete = await fetch(`${app.address}api/accounts/${a.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
    body: '{}'
  })
  assert.equal(badDelete.status, 403)

  const badBatchAction = await fetch(`${app.address}api/batch-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
    body: JSON.stringify({ action: 'pause' })
  })
  assert.equal(badBatchAction.status, 403)

  const badBatchOpen = await fetch(`${app.address}api/batches/${batchId}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
    body: '{}'
  })
  assert.equal(badBatchOpen.status, 403)

  // 11. 验证账号删除 API POST /api/accounts/:id/delete
  // 读取中禁止删除
  app.service.activeIds.add(a.id)
  const busyDelete = await fetch(`${app.address}api/accounts/${a.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: '{}'
  })
  assert.equal(busyDelete.status, 400)
  assert.match((await busyDelete.json()).error, /正在读取中/)
  app.service.activeIds.delete(a.id)

  // 正常删除并验证档案文件夹与数据库记录删除
  const profileDir = join(root, 'profiles', a.profile)
  mkdirSync(profileDir, { recursive: true })
  assert.equal(existsSync(profileDir), true)

  const okDelete = await fetch(`${app.address}api/accounts/${a.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: '{}'
  })
  assert.equal(okDelete.status, 200)
  assert.equal(existsSync(profileDir), false)
  assert.equal(app.store.accounts().length, 0)

  // 12. 验证设置 API：默认间隔、同时读取数、导出目录检查与日志接口
  const getSettingsRes = await fetch(`${app.address}api/settings`)
  assert.equal(getSettingsRes.status, 200)
  const settingsData = await getSettingsRes.json()
  assert.equal(settingsData.concurrency, 1)
  assert.equal(settingsData.default_interval, 10)

  // 修改设置
  const customExportDir = join(root, 'custom-exports')
  const saveSettingsRes = await fetch(`${app.address}api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: JSON.stringify({
      concurrency: 2,
      default_interval: 15,
      export_dir: customExportDir,
      notifications: true,
      autostart: false
    })
  })
  assert.equal(saveSettingsRes.status, 200)
  assert.equal(app.store.exportRoot, customExportDir)
  assert.equal(app.store.getSetting('concurrency'), '2')
  assert.equal(app.store.getSetting('default_interval'), '15')

  // 验证不合法的设置值会被拦截
  const badInterval = await fetch(`${app.address}api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ default_interval: 1 })
  })
  assert.equal(badInterval.status, 400)

  // 验证日志文件夹接口与日志写入
  const logFolderRes = await fetch(`${app.address}api/logs/folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
    body: '{}'
  })
  assert.equal(logFolderRes.status, 200)
  app.logger.info('这是一条测试日志包含敏感信息: cookie=SECRET_COOKIE; token=MY_TOKEN')
  const logDir = join(root, 'logs')
  assert.equal(existsSync(logDir), true)

  // 13. 截图测试：分别在 1280 宽度和 900 宽度下捕获截图保存到 .build/
  const buildDir = join(process.cwd(), '.build')
  mkdirSync(buildDir, { recursive: true })

  // 先添加一个展示账号以便截图中有真实内容
  app.store.addAccount('微博主号')
  const newAcc = app.store.accounts()[0]
  app.store.ingest(newAcc.id, {
    owner: '9876543210',
    nickname: '数码探索者',
    uids: ['1000000001'],
    total: 12580,
    complete: true,
    reason: 'visible-end'
  })
  app.store.update(newAcc.id, {
    enabled: 1,
    next_due: Date.now() + 8 * 60000
  })

  // 桌面 1280 宽度截图
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.reload()
  await page.getByText('数码探索者').waitFor()
  await page.screenshot({ path: join(buildDir, 'monitor-1280.png'), fullPage: true })

  // 窄屏 900 宽度截图（卡片式自适应，按钮不挤成一列）
  await page.setViewportSize({ width: 900, height: 820 })
  await page.reload()
  await page.getByText('数码探索者').waitFor()
  await page.screenshot({ path: join(buildDir, 'monitor-900.png'), fullPage: true })

  assert.deepEqual(errors, [])
})

test('如果数据库中存在测试 UID（1234567890 / 2345678901），createMonitorApp 拒绝启动', async t => {
  const root = mkdtempSync(join(tmpdir(), 'weibo-polluted-check-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // 1. 账号 owner 为 1234567890 时拒绝启动
  const { MonitorStore } = await import('./monitor-store.mjs')
  const store = new MonitorStore(root)
  const a = store.addAccount('测试账号', 'A')
  store.ingest(a.id, {
    owner: '1234567890',
    uids: ['1000000001'],
    complete: true,
    total: 1,
    reason: 'visible-end'
  }, { mode: 'baseline' })
  store.close()

  await assert.rejects(
    () => createMonitorApp({ root, port: 0, importProfiles: false, autoTick: false }),
    /检测到数据库中包含测试数据（UID 1234567890 \/ 2345678901），已拒绝启动/
  )

  // 2. 粉丝 UID 中包含 2345678901 时也拒绝启动
  const root2 = mkdtempSync(join(tmpdir(), 'weibo-polluted-check2-'))
  t.after(() => rmSync(root2, { recursive: true, force: true }))

  const store2 = new MonitorStore(root2)
  const b = store2.addAccount('测试账号B', 'B')
  store2.ingest(b.id, {
    owner: '9999000002',
    uids: ['2345678901'],
    complete: true,
    total: 1,
    reason: 'visible-end'
  }, { mode: 'baseline' })
  store2.close()

  await assert.rejects(
    () => createMonitorApp({ root: root2, port: 0, importProfiles: false, autoTick: false }),
    /检测到数据库中包含测试数据（UID 1234567890 \/ 2345678901），已拒绝启动/
  )
})
