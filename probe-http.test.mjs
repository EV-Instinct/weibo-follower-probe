import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { chromium } from 'playwright-core'

test('单个 A 档案通过本地页面提交、保存和复读模拟观测', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'weibo-http-fixture-'))
  t.after(async () => {
    if (dirname(dataDir) === tmpdir()) await rm(dataDir, { recursive: true, force: true })
  })
  const child = spawn(process.execPath, ['probe.mjs'], {
    env: { ...process.env, WEIBO_PROBE_PORT: '0', WEIBO_PROBE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  })
  const stopped = once(child, 'close')
  const lines = createInterface({ input: child.stdout })
  let browser
  // Finish using the server before shutting down the child and removing its data.
  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(10_000) }),
      stopped.then(() => { throw new Error('隔离的验证服务未启动') }),
    ])
    const address = line.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]
    assert.ok(address)
    assert.notEqual(new URL(address).port, '8765')
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    await page.goto(address)
    const owner = '1234567890'
    const x = '1111111111'
    const y = '2222222222'
    async function submit(ownerUid) {
      await page.getByLabel('我的主页链接或 UID').fill(`https://weibo.com/u/${ownerUid}`)
      await page.getByLabel('页面准确粉丝总数').fill('2')
      await page.getByLabel('列表项是否明确显示该粉丝关注你的时间').selectOption('no')
      await page.locator('textarea[name="links"]').fill(`https://weibo.com/u/${x}\nhttps://weibo.com/u/${y}`)
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/record')
      await page.getByRole('button', { name: '保存观测' }).click()
      return (await response).status()
    }
    assert.equal(await submit(owner), 303)
    await page.getByText(/初始样本.*2 个不同 UID.*全量未验证/).waitFor()
    assert.equal(await submit(owner), 303)
    await page.getByText(/复读.*初次出现待确认 0/).waitFor()
    assert.equal(await submit(y), 400)

    const saved = JSON.parse(await readFile(join(dataDir, 'observations.json'), 'utf8'))
    assert.equal(saved.A.length, 2)
    assert.deepEqual(saved.A.map(entry => entry.ordered), [[x, y], [x, y]])
    assert.deepEqual(saved.A.map(entry => entry.summary.baseline), [true, false])
    assert.deepEqual(saved.B, [])
    const summary = await (await fetch(new URL('summary', address))).text()
    assert.equal(JSON.parse(summary).A.length, 2)
    for (const uid of [owner, x, y]) assert.equal(summary.includes(uid), false)
  } finally {
    try {
      await browser?.close()
    } finally {
      lines.close()
      child.kill()
      await stopped
    }
  }
})
