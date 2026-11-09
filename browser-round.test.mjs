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

test('增量读取遇到连续 2 屏已知就停止，候选 UID 不算已知', async () => {
  const k1 = '3000000001', k2 = '3000000002', k3 = '3000000003'
  const new1 = '4000000001', candidate1 = '5000000001'
  const knownSet = new Set([k1, k2, k3])
  const isKnown = uid => knownSet.has(uid)

  // 1. 连续 2 屏全已知：第0屏有新UID和已知，第1屏全已知，第2屏全已知 -> 停止在第2屏
  const round = await collectRound(fixture([
    { status: 'ok', owner, links: [href(new1), href(k1)], total: 10, next: 'more' },
    { status: 'ok', owner, links: [href(k1), href(k2)], total: 10, next: 'more' },
    { status: 'ok', owner, links: [href(k2), href(k3)], total: 10, next: 'more' },
    { status: 'ok', owner, links: [href(k3)], total: 10, next: 'more' },
  ]), { maxWindows: 40, isKnown, mode: 'incremental' })

  assert.equal(round.endReason, 'incremental-hit')
  assert.equal(round.coverage.windows, 3) // Stopped after 3rd window (streak of 2: window 1 and 2)
  assert.equal(round.status, 'observed')

  // 2. 候选 UID 出现时，knownStreak 重置为 0，不停止
  const roundWithCand = await collectRound(fixture([
    { status: 'ok', owner, links: [href(k1), href(k2)], total: 10, next: 'more' },
    { status: 'ok', owner, links: [href(candidate1)], total: 10, next: 'more' }, // not known!
    { status: 'ok', owner, links: [href(k2)], total: 10, next: 'more' }, // streak = 1
    { status: 'ok', owner, links: [href(candidate1)], total: 10, next: 'end' }, // streak reset to 0, reaches end
  ]), { maxWindows: 40, isKnown, mode: 'incremental' })

  assert.equal(roundWithCand.endReason, 'visible-end')
  assert.equal(roundWithCand.coverage.windows, 4)
})

test('增量读取读满 40 屏还没遇到已知粉丝，停止并标记 window-budget', async () => {
  const isKnown = () => false
  const windows = Array.from({ length: 45 }, (_, i) => ({
    status: 'ok', owner, links: [href(`90000000${String(i).padStart(2, '0')}`)], total: 100, next: 'more'
  }))
  const round = await collectRound(fixture(windows), { maxWindows: 40, isKnown, mode: 'incremental' })
  assert.equal(round.endReason, 'window-budget')
  assert.equal(round.coverage.windows, 40)
  assert.equal(round.status, 'partial')
})
