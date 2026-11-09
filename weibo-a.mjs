import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectRound } from './browser-round.mjs'
import { profileUid } from './observations.mjs'
import { writeObservationFile } from './observation-store.mjs'

const weiboOrigin = /^https:\/\/(?:www\.)?weibo\.com$/
const fansHeading = /^全部粉丝\s*[（(]\s*([0-9,]+)\s*[）)]$/
const timeOrder = '关注时间倒序'
const otherOrder = '粉丝数倒序'
const ownAvatar = 'div[role=navigation] a[href]:has(img)'
const scroller = '.vue-recycle-scroller.ready'
const rowSelector = '.wbpro-scroller-item'

function ownFansUrl(url, owner) {
  return weiboOrigin.test(url.origin) && url.pathname === `/u/page/follow/${owner}` && url.searchParams.get('relate') === 'fans'
}

async function siteState(page) {
  const url = new URL(page.url())
  if (/^(?:passport\.weibo\.com|login\.sina\.com\.cn)$/.test(url.hostname)) return 'login-required'
  if (url.pathname === '/newlogin' || url.pathname.startsWith('/newlogin')) return 'login-required'
  if (!weiboOrigin.test(url.origin)) return 'page-unverified'
  const challenge = page.getByText(/^(安全验证|访问异常|访问受限|操作频繁|请输入验证码)$/).filter({ visible: true })
  if (await challenge.count()) return 'access-blocked'
  if (await page.getByText(/^(登录|扫码登录|登录微博)$/).filter({ visible: true }).count()) return 'login-required'
  return 'ok'
}

export function weiboAdapter(page, { full = false } = {}) {
  const heading = page.getByRole('heading', { name: fansHeading }).filter({ visible: true })
  const panel = page.locator('.woo-panel-main').filter({ has: heading }).filter({ visible: true })
  const avatars = page.locator(ownAvatar).filter({ visible: true })
  const evidence = { sort: 'unverified', visibilityLimited: null, rowFollowTime: 'unverified', stage: 'identify', nickname: null }
  let verifiedOwner
  let sorted = false
  let lastScroll = null
  let detectedNickname = null

  async function tryExtractNickname(owner) {
    if (detectedNickname) return detectedNickname
    try {
      const name = await page.evaluate((uid) => {
        const navImg = document.querySelector(`div[role=navigation] a[href*="${uid}"] img`)
        if (navImg?.alt && navImg.alt !== '我' && navImg.alt !== '头像') return navImg.alt.trim()
        if (navImg?.title) return navImg.title.trim()
        const navAnchor = document.querySelector(`div[role=navigation] a[href*="${uid}"]`)
        const navText = navAnchor?.innerText?.trim()
        if (navText && navText !== '我' && navText.length <= 30) return navText
        const titleMatch = document.title.match(/^(.+?)\s*(?:的个人主页|的微博|的关注和粉丝|全部粉丝)/)
        if (titleMatch && titleMatch[1] && !titleMatch[1].includes('微博')) return titleMatch[1].trim()
        const headerName = document.querySelector('[class*="ProfileHeader_name"], .username, .name')
        if (headerName?.innerText?.trim()) return headerName.innerText.trim()
        return null
      }, owner)
      if (name) {
        detectedNickname = name
        evidence.nickname = name
      }
    } catch {}
    return detectedNickname
  }

  return {
    evidence,
    get nickname() { return detectedNickname },
    async identify() {
      const state = await siteState(page)
      if (state !== 'ok') return { status: state }
      await avatars.and(page.locator('a[href*="/u/"]')).first().waitFor({ timeout: 5000 }).catch(() => {})
      const links = await avatars.evaluateAll(nodes => nodes.map(node => node.href))
      const candidates = links.filter(href => weiboOrigin.test(new URL(href).origin) && profileUid(href))
      if (candidates.length !== 1) return { status: 'identity-unverified' }
      const owner = profileUid(candidates[0])
      await tryExtractNickname(owner)
      return { status: 'ok', owner, nickname: detectedNickname }
    },
    async openFollowers(owner) {
      evidence.stage = 'open-own-profile'
      await tryExtractNickname(owner)
      const avatar = avatars.and(page.locator(`a[href$="/u/${owner}"]`))
      if (await avatar.count() !== 1) return 'page-unverified'
      await avatar.click()
      await page.waitForURL(url => weiboOrigin.test(url.origin) && profileUid(url.href) === owner)
      await tryExtractNickname(owner)
      evidence.stage = 'open-fans-menu'
      const menu = page.getByText('我的粉丝', { exact: true }).filter({ visible: true })
      await menu.waitFor()
      const destination = await menu.evaluate(node => node.closest('a[href]')?.href ?? null)
      if (!destination || !ownFansUrl(new URL(destination), owner)) return 'page-unverified'
      await menu.click()
      await page.waitForURL(url => ownFansUrl(url, owner))
      verifiedOwner = owner
      await tryExtractNickname(owner)
      return siteState(page)
    },
    async readWindow() {
      if (!verifiedOwner || !ownFansUrl(new URL(page.url()), verifiedOwner)) return { status: 'page-unverified' }
      await tryExtractNickname(verifiedOwner)
      const orderControl = heading.locator('..').locator('.woo-pop-wrap > :first-child')
      const time = orderControl.getByText(timeOrder, { exact: true }).filter({ visible: true })
      const other = orderControl.getByText(otherOrder, { exact: true }).filter({ visible: true })
      let total
      try {
        evidence.stage = 'read-sort-menu'
        await time.or(other).waitFor()
        if (!sorted && await other.count() === 1) {
          await other.click()
          const option = page.getByText(timeOrder, { exact: true }).filter({ visible: true })
          await option.click()
        }
        evidence.stage = 'wait-active-sort'
        await time.waitFor()
        evidence.stage = 'wait-scroller'
        await panel.locator(scroller).waitFor()
        evidence.stage = 'read-total'
        const text = await heading.innerText()
        total = Number(text.match(fansHeading)?.[1].replaceAll(',', ''))
        evidence.stage = 'wait-rows'
        if (total > 0) await panel.locator(scroller).locator(rowSelector).first().waitFor()
        // The visibility notice can render after the first row on the real page.
        if (!sorted) await page.waitForTimeout(350)
        sorted = true
      } catch (error) {
        evidence.issue = error.name === 'TimeoutError' ? 'timeout' : error.message.includes('strict mode violation') ? 'ambiguous-element' : 'dom-error'
        const state = await siteState(page)
        return { status: state === 'ok' ? 'load-failed' : state }
      }
      evidence.stage = 'read-fan-rows'
      const snapshot = await panel.evaluate((element, selectors) => {
        const list = element.querySelector(selectors.scroller)
        const box = list.getBoundingClientRect()
        const rows = [...list.querySelectorAll(selectors.rowSelector)].filter(row => {
          const rect = row.getBoundingClientRect()
          return rect.height > 0 && rect.bottom > Math.max(0, box.top) && rect.top < Math.min(innerHeight, box.bottom)
        }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        const links = rows.map(row => {
          const anchors = row.querySelectorAll('a[href]:has(img)')
          if (anchors.length !== 1) return ''
          const url = new URL(anchors[0].href)
          return url.origin + url.pathname
        })
        return {
          links, rowCount: rows.length,
          visibilityLimited: element.innerText.includes('部分账号暂不展示'),
          timeElementPresent: rows.some(row => row.querySelector('time')),
          bottom: box.bottom <= innerHeight + 2,
        }
      }, { scroller, rowSelector })
      if (!Number.isSafeInteger(total) || total < 0 || (!snapshot.rowCount && total !== 0)) return { status: 'load-failed' }
      if (!ownFansUrl(new URL(page.url()), verifiedOwner)) return { status: 'page-unverified' }
      evidence.sort = 'follow-time-desc'
      evidence.visibilityLimited = snapshot.visibilityLimited
      evidence.rowFollowTime = snapshot.timeElementPresent ? 'unverified-time-element' : 'not-observed'
      evidence.stage = 'rows-read'
      // A viewport at the current DOM bottom can precede an asynchronously appended page.
      if (full && snapshot.bottom) {
        await page.waitForTimeout(700)
        const stillBottom = await panel.locator(scroller).evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 2)
        if (!stillBottom) snapshot.bottom = false
      }
      return { status: 'ok', owner: verifiedOwner, links: snapshot.links, total, next: full ? (snapshot.bottom ? 'end' : 'more') : 'unknown' }
    },
    async advance() {
      const state = await siteState(page)
      if (state !== 'ok') return state
      const position = await panel.locator(scroller).evaluate(el => ({ top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height }))
      if (lastScroll && position.top === lastScroll.top && position.height === lastScroll.height) return 'no-progress'
      lastScroll = position
      const box = await panel.boundingBox()
      const viewport = page.viewportSize() ?? { width:1280, height:720 }
      await page.mouse.move(Math.min(viewport.width-20,Math.max(20,box.x+box.width/2)),Math.min(viewport.height-30,Math.max(80,box.y+100)))
      await page.mouse.wheel(0, Math.max(200, Math.floor(viewport.height * 0.65)))
      await page.waitForTimeout(220)
      return 'ok'
    },
  }
}

export async function readWeiboA(page, root) {
  const file = join(root, 'weibo-a-observations.json')
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { owner: null, rounds: [] }
  const adapter = weiboAdapter(page, { full: true })
  const round = await collectRound(adapter, { expectedOwner: state.owner, maxWindows: 600 })
  const previous = state.rounds.findLast(item => item.owner && item.pages.length)
  const attributed = round.owner && round.pages.length > 0
  const sameSample = attributed && previous ? JSON.stringify(round.pages) === JSON.stringify(previous.pages) : null
  const entry = {
    source: 'weibo-visible-dom', slot: 'A', ...round, evidence: adapter.evidence,
    baseline: Boolean(attributed && !previous), sameSample,
  }
  if (attributed) state.owner ??= round.owner
  state.rounds.push(entry)
  mkdirSync(root, { recursive: true })
  writeObservationFile(file, state)
  return {
    status: entry.status, endReason: entry.endReason, ownerVerified: Boolean(entry.owner),
    baseline: entry.baseline, sameSample, coverage: entry.coverage, evidence: entry.evidence,
  }
}
