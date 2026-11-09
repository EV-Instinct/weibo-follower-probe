import test from 'node:test'
import assert from 'node:assert/strict'
import { collectRound } from './browser-round.mjs'

const owner = '1234567890'
const x = '1111111111'
const y = '2222222222'
const href = uid => `https://weibo.com/u/${uid}`

function fixture(windows, identities = [owner, owner]) {
  let index = 0
  return {
    identify: async () => ({ status: 'ok', owner: identities.shift() }),
    openFollowers: async () => 'ok',
    readWindow: async () => windows[index],
    advance: async () => { index++; return 'ok' },
  }
}

test('末页和计数相符只表示观测结果，跨窗口 UID 去重', async () => {
  const round = await collectRound(fixture([
    { status: 'ok', owner, links: [href(x) + '?session=discard'], total: 2, next: 'more' },
    { status: 'ok', owner, links: [href(x), href(y)], total: 2, next: 'end' },
  ]))
  assert.equal(round.owner, owner)
  assert.equal(round.endReason, 'visible-end')
  assert.deepEqual(round.pages, [[x], [x, y]])
  assert.equal(round.coverage.unique, 2)
  assert.equal(round.coverage.duplicates, 1)
  assert.equal(round.coverage.completeness, 'unverified')
  assert.equal(round.coverage.totalRelation, 'equal')
  assert.equal(JSON.stringify(round).includes('session=discard'), false)
})

test('身份中途改变时，丢弃全部 UID，结果不归属到任何账号', async () => {
  const round = await collectRound(fixture([
    { status: 'ok', owner, links: [href(x)], next: 'end' },
  ], [owner, y]))
  assert.equal(round.endReason, 'identity-mismatch')
  assert.equal(round.owner, null)
  assert.deepEqual(round.pages, [])
})

test('粉丝区域所属账号与登录账号不匹配时拒绝归档', async () => {
  const round = await collectRound(fixture([
    { status: 'ok', owner: y, links: [href(x)], next: 'end' },
  ]))
  assert.equal(round.endReason, 'identity-mismatch')
  assert.deepEqual(round.pages, [])
})

test('翻页失败保留已读范围，抓取异常不输出原始错误详情', async () => {
  const browser = fixture([{ status: 'ok', owner, links: [href(x)], total: 5, next: 'more' }])
  browser.advance = async () => { throw new Error('page trace with sensitive query') }
  const round = await collectRound(browser)
  assert.equal(round.status, 'partial')
  assert.equal(round.endReason, 'load-failed')
  assert.deepEqual(round.pages, [[x]])
  assert.equal(round.coverage.totalRelation, 'below')
  assert.equal(JSON.stringify(round).includes('sensitive query'), false)
})

test('上限、未识别控件和不可解析资料链接分别记入覆盖证据', async () => {
  const snapshot = { status: 'ok', owner, links: [href(x), 'https://weibo.com/n/alias'], total: null }
  const capped = await collectRound(fixture([{ ...snapshot, next: 'more' }]), { maxWindows: 1 })
  assert.equal(capped.endReason, 'window-budget')
  assert.equal(capped.coverage.unresolvedLinks, 1)
  assert.equal(capped.coverage.totalRelation, 'unknown')
  const unverified = await collectRound(fixture([{ ...snapshot, next: 'unknown' }]))
  assert.equal(unverified.endReason, 'no-proven-continuation')
})

test('页面报告拦截时停止，观测到的链接也不挂在会话上', async () => {
  const browser = fixture([
    { status: 'ok', owner, links: [href(x)], next: 'more' },
    { status: 'access-blocked' },
  ])
  const round = await collectRound(browser)
  assert.equal(round.endReason, 'access-blocked')
  assert.equal(round.owner, null)
  assert.deepEqual(round.pages, [])
})
