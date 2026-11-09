import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { parseUid, record } from './observations.mjs'
import { writeObservationFile } from './observation-store.mjs'

if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
  throw new Error('请在 Windows 用户会话中运行。')
}
const root = process.env.WEIBO_PROBE_DATA_DIR || join(process.env.LOCALAPPDATA, 'WeiboFollowerProbe')
const file = join(root, 'observations.json')
const port = Number(process.env.WEIBO_PROBE_PORT ?? '8765')
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效的本地端口。')
const loopback = '127.0.0.1'
const edges = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
  .filter(Boolean).map(dir => join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
const csrf = randomUUID()
mkdirSync(root, { recursive: true })

function load() {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { A: [], B: [] }
}

async function openProfile(slot) {
  const edge = edges.find(existsSync)
  if (!edge) throw new Error('未找到 Microsoft Edge。')
  const profile = join(root, 'profiles', slot)
  const child = spawn(edge, [
    '--user-data-dir=' + profile, '--no-first-run', '--new-window', 'https://weibo.com/',
  ], { stdio: 'ignore', detached: true })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', () => reject(new Error('Edge 窗口启动失败。')))
  })
  child.unref()
}

function readObservation(form) {
  const slot = form.get('slot')
  const kind = form.get('kind')
  if (kind !== 'read') return { slot, kind }
  const content = (form.get('links') ?? '').trim()
  const pages = content ? content.split(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/)
    .map(page => page.split(/\r?\n/).map(parseUid)) : []
  const rawTotal = (form.get('total') ?? '').trim()
  if (rawTotal && !/^\d{1,9}$/.test(rawTotal)) throw new Error('只填写页面显示的准确整数。约数请留空。')
  if (!pages.length && rawTotal !== '0') throw new Error('请提供至少一个粉丝 UID。仅页面明确显示 0 时可留空。')
  const end = form.get('end')
  const timeVisible = form.get('timeVisible')
  if (!['unknown', 'more', 'end'].includes(end) || !['unknown', 'yes', 'no'].includes(timeVisible)) {
    throw new Error('请选择页面状态。')
  }
  return {
    slot, kind, pages, end, timeVisible, total: rawTotal ? Number(rawTotal) : null,
    owner: parseUid(form.get('owner') ?? ''),
  }
}

const stateLabels = { 'login-required': '页面要求登录', 'access-blocked': '权限或验证拦截' }
const endLabels = { unknown: '未核对', more: '仍可翻页', end: '官方控件已到末页' }
const timeLabels = { unknown: '未核对', yes: '有时间', no: '无时间' }
const yesNo = value => value == null ? '未核对' : value ? '是' : '否'
const token = '<input type="hidden" name="csrf" value="' + csrf + '">'

function summaries(state) {
  return Object.fromEntries(Object.entries(state).map(([slot, entries]) => [slot, entries.map(entry => {
    const { kind, at, end, total, timeVisible, summary } = entry
    return { kind, at, source: 'manual', end, total, timeVisible, ...summary }
  })]))
}

function renderHistory(entries) {
  return entries.slice(-20).reverse().map(entry => {
    const at = new Date(entry.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    if (entry.kind !== 'read') return '<li>' + at + '　' + stateLabels[entry.kind] + '</li>'
    const s = entry.summary
    return '<li>' + at + '　' + (s.baseline ? '初始样本' : '复读')
      + ' · ' + s.pages + ' 页 · ' + s.unique + ' 个不同 UID / ' + (entry.total ?? '未知') + ' 显示总数'
      + ' · ' + endLabels[entry.end] + ' · 关注时间：' + timeLabels[entry.timeVisible]
      + ' · 重复项 ' + s.duplicates + ' · 完全重复页 ' + s.repeatedPages
      + ' · 相对顺序变化：' + yesNo(s.relativeOrderChanged)
      + ' · 初次出现待确认 ' + s.firstSeenPending + ' · 样本消失 ' + s.missingFromSample + ' · 回到样本 ' + s.returned
      + ' · 含另一账号：' + yesNo(s.otherAccountPresent)
      + (s.otherPosition ? '（样本第 ' + s.otherPosition + ' 位）' : '') + ' · 全量未验证 · 缺少新增确认依据</li>'
  }).join('')
}

function page(state) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>微博粉丝可行性验证</title>'
    + '<style>body{max-width:960px;margin:32px auto;padding:0 16px;font:16px/1.55 system-ui}label{display:block;margin:8px 0}textarea{width:100%;box-sizing:border-box}input[type=text]{width:min(90%,500px)}button{margin-right:10px}li{margin:6px 0}</style>'
    + '<h1>微博粉丝可行性验证</h1><p>本页记录手动核对的网页样本。请在各自独立的 Edge 档案中登录 A、B。请勿粘贴凭据、验证码或会话数据。</p>'
    + '<form method="post" action="/open">' + token + '<button name="slot" value="A">打开账号 A</button><button name="slot" value="B">打开账号 B</button></form>'
    + '<h2>记录官方页面观测</h2><form method="post" action="/record">' + token
    + '<label>档案 <select name="slot"><option>A</option><option>B</option></select></label>'
    + '<label>页面状态 <select name="kind"><option value="read">正常显示</option><option value="login-required">要求重新登录</option><option value="access-blocked">权限或验证拦截</option></select></label>'
    + '<label>我的主页链接或 UID <input type="text" name="owner" autocomplete="off"></label>'
    + '<label>页面准确粉丝总数（约数留空） <input name="total" inputmode="numeric"></label>'
    + '<label>分页状态 <select name="end"><option value="unknown">未核对</option><option value="more">仍可翻页</option><option value="end">官方控件已到末页</option></select></label>'
    + '<label>列表项是否明确显示该粉丝关注你的时间 <select name="timeVisible"><option value="unknown">未核对</option><option value="yes">有</option><option value="no">无</option></select></label>'
    + '<label>按显示顺序手动粘贴粉丝主页链接或 UID，每行一个。多页样本用空行隔开。<textarea name="links" rows="6" autocomplete="off" spellcheck="false"></textarea></label>'
    + '<button>保存观测</button></form><p>本地比对只记录可见样本，首次出现永远待确认。记录保存在当前 Windows 用户目录。</p>'
    + '<h2>A 的观测</h2><ul>' + renderHistory(state.A) + '</ul><h2>B 的观测</h2><ul>' + renderHistory(state.B) + '</ul></html>'
}

const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
  const host = `${loopback}:${server.address().port}`
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
  // Same-origin form posts need an Origin header for the CSRF check below.
  res.setHeader('Referrer-Policy', 'same-origin')
  if (req.headers.host !== host) return res.writeHead(403).end()
  try {
    if (req.method === 'GET' && req.url === '/') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(load()))
    }
    if (req.method === 'GET' && req.url === '/summary') {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(summaries(load())))
    }
    if (req.method !== 'POST' || !['/open', '/record'].includes(req.url)) return res.writeHead(404).end()
    if (req.headers.origin !== `http://${host}` || !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      return res.writeHead(403).end()
    }
    let body = ''
    for await (const chunk of req.setEncoding('utf8')) {
      body += chunk
      if (body.length > 128 * 1024) return res.writeHead(413).end('记录过长。')
    }
    const form = new URLSearchParams(body)
    if (form.get('csrf') !== csrf || !['A', 'B'].includes(form.get('slot'))) return res.writeHead(403).end()
    if (req.url === '/open') {
      await openProfile(form.get('slot'))
    } else {
      const state = load()
      record(state, readObservation(form))
      writeObservationFile(file, state)
    }
    res.writeHead(303, { Location: '/' }).end()
  } catch (error) {
    const invalid = error instanceof Error && /^[\u4e00-\u9fff]/.test(error.message)
    const message = invalid ? error.message : '本地记录读取或保存失败。'
    res.writeHead(invalid ? 400 : 500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message)
  }
})

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '端口已在使用。请检查是否已经启动验证工具。' : '本地验证工具启动失败。')
  process.exitCode = 1
})
server.listen(port, loopback, () => console.log(`本地验证页 http://${loopback}:${server.address().port}/`))
