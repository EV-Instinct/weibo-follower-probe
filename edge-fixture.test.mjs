import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright-core'
import { collectRound } from './browser-round.mjs'
import { writeObservationFile } from './observation-store.mjs'

const a = '1234567890'
const b = '2345678901'
const x = '1111111111'
const y = '2222222222'
const noise = '9999999999'
const link = uid => `<a href="https://weibo.com/u/${uid}">测试资料</a>`

// These pages and accessible names belong to the loopback fixture only.
function serveFixture(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const signedIn = req.headers.cookie?.match(/(?:^|; )fixture=([ab])(?:;|$)/)?.[1]
  if (['/login/a', '/login/b', '/logout'].includes(url.pathname)) {
    const cookie = url.pathname === '/logout' ? 'fixture=; Max-Age=0' : `fixture=${url.pathname.at(-1)}; Max-Age=600`
    return res.writeHead(303, { 'Set-Cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict`, Location: '/' }).end()
  }
  const owner = signedIn === 'a' ? a : b
  const scenario = url.searchParams.get('scenario')
  const next = page => `?scenario=${scenario}&page=${page}`
  const step = Number(url.searchParams.get('page') ?? '1')
  let body = '<a href="/login/a">登录测试 A</a> <a href="/login/b">登录测试 B</a>'
  if (signedIn) {
    body = `<nav aria-label="账户"><a href="/u/${owner}">我的主页</a> <a href="/logout">退出测试会话</a></nav>`
    if (url.pathname === `/u/${owner}`) {
      body += `<a href="/u/${owner}/fans?scenario=normal">粉丝</a>`
    }
    if (url.pathname === `/u/${owner}/fans`) {
      const rows = scenario === 'reverse' ? [y, x] : step === 1 ? [x] : [x, y]
      const controls = scenario === 'scroll' && step === 1
        ? `<button>加载更多</button><script>
          document.querySelector('button').addEventListener('click', event => {
            document.querySelector('ul').insertAdjacentHTML('beforeend', ${JSON.stringify(`<li>${link(y)}</li>`)});
            event.target.outerHTML = '<p>已到末页</p>';
          });</script>`
        : ['normal', 'broken', 'stalled'].includes(scenario) && step === 1
          ? `<a href="${next(scenario === 'stalled' ? 1 : 2)}">下一页</a>` : '<p>已到末页</p>'
      body += scenario === 'broken' && step === 2 ? '<p role="alert">列表加载失败</p>'
        : `<a href="/u/${owner}">本页所属主页</a><p aria-label="准确总数">2</p>`
          + `<section aria-label="粉丝列表"><ul>${rows.map(uid => `<li>${link(uid)}</li>`).join('')}</ul>${controls}</section>`
          + `<aside aria-label="推荐用户">${link(noise)}</aside><section aria-label="关注列表">${link(noise)}</section>`
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="zh-CN"><body>${body}</body></html>`)
}

function fixtureAdapter(page, origin, scenario) {
  const fromProfile = async locator => {
    const href = await locator.getAttribute('href', { timeout: 1500 })
    const target = new URL(href, origin)
    return target.origin === origin ? target.pathname.match(/^\/u\/(\d+)$/)?.[1] : null
  }
  const myProfile = page.getByRole('navigation', { name: '账户' }).getByRole('link', { name: '我的主页', exact: true })
  const fans = page.getByRole('region', { name: '粉丝列表' })
  const nextPage = fans.getByRole('link', { name: '下一页', exact: true })
  const loadMore = fans.getByRole('button', { name: '加载更多', exact: true })
  const end = fans.getByText('已到末页', { exact: true })
  return {
    async identify() {
      if (await page.getByRole('link', { name: '登录测试 A' }).isVisible()) return { status: 'login-required' }
      return { status: 'ok', owner: await fromProfile(myProfile) }
    },
    async openFollowers() {
      await myProfile.click()
      await page.getByRole('link', { name: '粉丝', exact: true }).click()
      if (scenario !== 'normal') await page.goto(page.url().replace('scenario=normal', `scenario=${scenario}`))
      return 'ok'
    },
    async readWindow() {
      if (await page.getByRole('alert').isVisible()) return { status: 'load-failed' }
      if (!await fans.isVisible()) return { status: 'page-unverified' }
      return {
        status: 'ok',
        owner: await fromProfile(page.getByRole('link', { name: '本页所属主页', exact: true })),
        links: await fans.getByRole('listitem').getByRole('link').evaluateAll(nodes => nodes.map(node => node.href)),
        total: Number(await page.getByLabel('准确总数').textContent()),
        next: await nextPage.isVisible() || await loadMore.isVisible() ? 'more' : await end.isVisible() ? 'end' : 'unknown',
      }
    },
    async advance() {
      if (await loadMore.isVisible()) {
        await loadMore.click()
        await end.waitFor()
        return 'ok'
      }
      const previous = page.url()
      await nextPage.click()
      return page.url() === previous || new URL(page.url()).searchParams.get('page') === '1' ? 'no-progress' : 'ok'
    },
  }
}

test('Edge 独立持久档案通过界面验证身份、读取并保存环回测试证据', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'weibo-edge-fixture-'))
  const server = createServer(serveFixture)
  const contexts = new Set()
  t.after(async () => {
    await Promise.all([...contexts].map(context => context.close()))
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (dirname(temporary) === tmpdir()) await rm(temporary, { recursive: true, force: true })
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  async function open(slot) {
    const context = await chromium.launchPersistentContext(join(temporary, slot), { channel: 'msedge', headless: true })
    contexts.add(context)
    context.on('close', () => contexts.delete(context))
    const page = context.pages()[0]
    page.setDefaultTimeout(4000)
    await page.goto(origin)
    return page
  }
  const scan = (page, expectedOwner, scenario = 'normal') => collectRound(fixtureAdapter(page, origin, scenario), { expectedOwner })
  const pageA = await open('A')
  const pageB = await open('B')
  assert.equal((await scan(pageA, a)).endReason, 'login-required')
  await pageA.getByRole('link', { name: '登录测试 A' }).click()
  await pageB.getByRole('link', { name: '登录测试 B' }).click()

  const round = await scan(pageA, a)
  assert.equal(round.endReason, 'visible-end')
  assert.deepEqual(round.pages, [[x], [x, y]])
  assert.equal(round.coverage.unique, 2)
  assert.equal(round.coverage.completeness, 'unverified')
  const file = join(temporary, 'evidence.json')
  writeObservationFile(file, { source: 'local-fixture', slot: 'A', ...round })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { source: 'local-fixture', slot: 'A', ...round })

  assert.equal((await scan(pageB, b)).owner, b)
  assert.equal((await scan(pageB, a)).endReason, 'identity-mismatch')
  assert.deepEqual((await scan(pageA, a)).pages, round.pages)
  assert.deepEqual((await scan(pageA, a, 'reverse')).pages, [[y, x]])
  assert.deepEqual((await scan(pageA, a, 'scroll')).pages, round.pages)
  assert.equal((await scan(pageA, a, 'broken')).endReason, 'load-failed')
  assert.equal((await scan(pageA, a, 'stalled')).endReason, 'no-progress')

  await pageA.context().close()
  const reopened = await open('A')
  assert.equal((await scan(reopened, a)).owner, a)
  await reopened.getByRole('link', { name: '退出测试会话' }).click()
  assert.equal((await scan(reopened, a)).endReason, 'login-required')
  assert.equal((await scan(pageB, b)).owner, b)
  await reopened.getByRole('link', { name: '登录测试 A' }).click()
  assert.equal((await scan(reopened, a)).owner, a)
})
