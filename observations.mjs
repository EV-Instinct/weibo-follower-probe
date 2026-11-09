const digits = /^[1-9]\d{0,19}$/
const profileHosts = new Set(['weibo.com', 'www.weibo.com', 'm.weibo.cn', 'weibo.cn'])

export function profileUid(value) {
  const link = URL.parse(value)
  if (link?.protocol !== 'https:' || !profileHosts.has(link.host) || link.username || link.password) return null
  return link.pathname.match(/^\/(?:u|profile)\/([1-9]\d{0,19})\/?$/)?.[1] ?? null
}

export function parseUid(value) {
  const text = value.trim()
  if (digits.test(text)) return text
  const uid = profileUid(text)
  if (uid) return uid
  const link = URL.parse(text)
  const post = link?.host === 'weibo.com' || link?.host === 'www.weibo.com'
    ? link.pathname.match(/^\/([1-9]\d{9,19})\/[a-zA-Z0-9]+\/?$/) : null
  if (link?.protocol === 'https:' && !link.username && !link.password && post) {
    return post[1]
  }
  throw new Error('只接受已核对的数字 UID，或含数字 UID 的微博官方个人资料或微博正文链接。')
}

export function describeSample(pages) {
  const all = pages.flat()
  const ordered = [...new Set(all)]
  return {
    ordered,
    counts: {
      rows: all.length,
      unique: ordered.length,
      duplicates: all.length - ordered.length,
      repeatedPages: pages.length - new Set(pages.map(page => JSON.stringify(page))).size,
    },
  }
}

export function record(state, observation) {
  const { slot, kind } = observation
  if (!['A', 'B'].includes(slot)) throw new Error('请选择 A 或 B。')
  const history = state[slot]
  const prior = history.filter(entry => entry.kind === 'read')
  const at = new Date().toISOString()
  if (['login-required', 'access-blocked'].includes(kind)) {
    const entry = { kind, at, source: 'manual' }
    history.push(entry)
    return entry
  }
  if (kind !== 'read') throw new Error('请选择页面状态。')

  const { owner, pages, end, total, timeVisible } = observation
  if (prior.length && prior[0].owner !== owner) throw new Error('资料 UID 与该档案已绑定的账号不同。')
  const other = state[slot === 'A' ? 'B' : 'A'].find(entry => entry.kind === 'read')
  if (other?.owner === owner) throw new Error('另一档案已经绑定此 UID。请核对登录账号。')

  const { ordered, counts } = describeSample(pages)
  const current = new Set(ordered)
  const previous = prior.at(-1)?.ordered ?? []
  const previousSet = new Set(previous)
  const seen = new Set(prior.flatMap(entry => entry.ordered))
  const previousCommon = previous.filter(uid => current.has(uid))
  const currentCommon = ordered.filter(uid => previousSet.has(uid))
  const pending = prior.length ? ordered.filter(uid => !seen.has(uid)) : []
  const otherPosition = other ? ordered.indexOf(other.owner) + 1 : null
  const summary = {
    baseline: prior.length === 0,
    pages: pages.length,
    ...counts,
    relativeOrderChanged: currentCommon.some((uid, index) => uid !== previousCommon[index]),
    firstSeenPending: pending.length,
    returned: ordered.filter(uid => seen.has(uid) && !previousSet.has(uid)).length,
    missingFromSample: previous.filter(uid => !current.has(uid)).length,
    otherAccountPresent: otherPosition == null ? null : otherPosition > 0,
    otherPosition,
    confirmed: 0,
  }
  history.push({ kind, at, source: 'manual', owner, ordered, pending, end, total, timeVisible, summary })
  return summary
}
