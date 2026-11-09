import { describeSample, profileUid } from './observations.mjs'

const validUid = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
const browserStops = new Set(['login-required', 'access-blocked', 'load-failed', 'page-unverified', 'no-progress'])
const stop = (reason, fallback) => browserStops.has(reason) ? reason : fallback

// A site adapter must independently verify the signed-in user and the owner of
// each visible fans region. It may return links only from rows in that region.
export async function collectRound(browser, { expectedOwner = null, maxWindows = 5 } = {}) {
  if (!Number.isSafeInteger(maxWindows) || maxWindows < 1 || (expectedOwner !== null && !validUid(expectedOwner))) {
    throw new Error('无效的观测范围或绑定 UID。')
  }
  const startedAt = new Date().toISOString()
  const pages = []
  const totals = new Set()
  let unresolvedLinks = 0
  let owner = null

  function result(endReason, attributed) {
    const savedPages = attributed ? pages : []
    const exactTotals = attributed ? [...totals] : []
    const total = exactTotals.length === 1 ? exactTotals[0] : null
    const { counts } = describeSample(savedPages)
    let totalRelation = 'unknown'
    if (total !== null) {
      totalRelation = counts.unique === total ? 'equal' : counts.unique < total ? 'below' : 'above'
    }
    return {
      startedAt, endedAt: new Date().toISOString(), owner: attributed ? owner : null,
      status: !attributed ? 'unattributed' : endReason === 'visible-end' && unresolvedLinks === 0 ? 'observed' : 'partial',
      endReason, pages: savedPages,
      coverage: {
        windows: savedPages.length, maxWindows, ...counts,
        unresolvedLinks: attributed ? unresolvedLinks : 0, exactTotals,
        totalRelation,
        completeness: 'unverified',
      },
    }
  }

  async function verify(expected) {
    try {
      const identity = await browser.identify()
      if (identity.status !== 'ok' || !validUid(identity.owner)) {
        return stop(identity.status, 'identity-unverified')
      }
      if (expected !== null && identity.owner !== expected) return 'identity-mismatch'
      owner = identity.owner
      return 'ok'
    } catch {
      return 'identity-unverified'
    }
  }

  const initial = await verify(expectedOwner)
  if (initial !== 'ok') return result(initial, false)

  let endReason
  try {
    endReason = await browser.openFollowers(owner)
    if (endReason === 'ok') {
      for (let index = 0; index < maxWindows; index++) {
        const window = await browser.readWindow()
        if (window.status !== 'ok') {
          endReason = stop(window.status, 'page-unverified')
          break
        }
        if (!validUid(window.owner)) return result('page-unverified', false)
        if (window.owner !== owner) return result('identity-mismatch', false)
        const uids = window.links.map(profileUid).filter(Boolean)
        unresolvedLinks += window.links.length - uids.length
        if (Number.isSafeInteger(window.total) && window.total >= 0) totals.add(window.total)
        pages.push(uids)
        if (window.next !== 'more') {
          endReason = window.next === 'end' ? 'visible-end' : 'no-proven-continuation'
          break
        }
        if (index + 1 === maxWindows) {
          endReason = 'window-budget'
          break
        }
        const advanced = await browser.advance()
        if (advanced !== 'ok') {
          endReason = stop(advanced, 'no-progress')
          break
        }
      }
    } else {
      endReason = stop(endReason, 'page-unverified')
    }
  } catch {
    endReason = 'load-failed'
  }

  if (endReason === 'login-required' || endReason === 'access-blocked') return result(endReason, false)
  const final = await verify(owner)
  return final === 'ok' ? result(endReason, true) : result(final, false)
}
