import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUid, record } from './observations.mjs'

const snapshot = (slot, owner, pages) => ({ slot, owner, pages, kind: 'read', end: 'unknown', total: null })

test('接受官方数字资料链接，保留 UID 精度，拒绝非资料链接', () => {
  assert.equal(parseUid('https://weibo.com/u/987654321098765432?source=example'), '987654321098765432')
  assert.equal(parseUid('https://m.weibo.cn/profile/1234567890'), '1234567890')
  assert.equal(parseUid('https://weibo.com/1234567890/JhPnDoE7y'), '1234567890')
  assert.throws(() => parseUid('https://weibo.com/675415355'))
  assert.throws(() => parseUid('https://weibo.com.example/u/1234567890'))
  assert.throws(() => parseUid('https://weibo.com/u/1234567890/follow'))
})

test('基线只记录旧样本，跨页重复与首次出现分别记录，始终零确认', () => {
  const state = { A: [], B: [] }
  const a = '1234567890'
  const x = '1111111111'
  const y = '2222222222'
  const z = '3333333333'
  const baseline = record(state, snapshot('A', a, [[x, y], [y]]))
  assert.equal(state.A[0].source, 'manual')
  assert.equal(baseline.duplicates, 1)
  assert.equal(baseline.repeatedPages, 0)
  assert.equal(baseline.firstSeenPending, 0)
  const repeat = record(state, snapshot('A', a, [[x, y], [x, y]]))
  assert.equal(repeat.repeatedPages, 1)
  assert.equal(repeat.firstSeenPending, 0)
  const changed = record(state, snapshot('A', a, [[y, x, z]]))
  assert.equal(changed.firstSeenPending, 1)
  assert.equal(changed.relativeOrderChanged, true)
  assert.equal(changed.confirmed, 0)
  record(state, snapshot('A', a, [[x, y]]))
  assert.equal(record(state, snapshot('A', a, [[z, y, x]])).returned, 1)
  assert.equal(state.A.at(-1).summary.firstSeenPending, 0)
  assert.equal(record(state, snapshot('B', '2345678901', [[z]])).firstSeenPending, 0)
})

test('拒绝两个档案绑定同一账号或换号，登录失效保留历史', () => {
  const state = { A: [], B: [] }
  const a = '1234567890'
  const initial = snapshot('A', a, [['1111111111']])
  record(state, initial)
  assert.throws(() => record(state, snapshot('B', a, [])))
  assert.throws(() => record(state, snapshot('A', '2345678901', [])))
  record(state, { slot: 'A', kind: 'login-required' })
  assert.equal(record(state, initial).firstSeenPending, 0)
  assert.equal(state.B.length, 0)
})
