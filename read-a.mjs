import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { readWeiboA } from './weibo-a.mjs'

const run = promisify(execFile)
const processCheck = String.raw`
$path = [regex]::Escape($env:WEIBO_PROBE_PROFILE_CHECK_PATH)
$active = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction Stop |
  Where-Object { $_.CommandLine -match ('(?i)--user-data-dir="?' + $path + '(?="|\s|$)') -and $_.CommandLine -notmatch '(?:^| )--type=' }
if ($active) { 'in-use' } else { 'available' }
`

async function main() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('windows-required')
  const root = join(process.env.LOCALAPPDATA, 'WeiboFollowerProbe')
  const profile = join(root, 'profiles', 'A')
  if (!existsSync(profile)) throw new Error('missing-profile')
  let state
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', processCheck], {
      env: { ...process.env, WEIBO_PROBE_PROFILE_CHECK_PATH: profile }, windowsHide: true, timeout: 10_000,
    })
    state = stdout.trim()
  } catch {
    throw new Error('profile-check-failed')
  }
  if (state === 'in-use') throw new Error('profile-in-use')
  if (state !== 'available') throw new Error('profile-check-failed')

  let context
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: false, timeout: 15_000, args: ['--disable-background-mode'],
    })
  } catch {
    throw new Error('edge-launch-failed')
  }
  try {
    const page = context.pages()[0] ?? await context.newPage()
    page.setDefaultTimeout(8000)
    const goHome = async () => {
      const response = await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 })
      if ([401, 403, 429].includes(response?.status())) throw new Error('access-blocked')
    }
    await goHome()
    let result = await readWeiboA(page, root)
    if (result.endReason === 'login-required' && process.stdin.isTTY) {
      const consoleInput = createInterface({ input: process.stdin, output: process.stdout })
      try {
        await consoleInput.question('请在这个 A 的 Edge 窗口手动登录微博，完成后在此按 Enter。')
      } finally {
        consoleInput.close()
      }
      await goHome()
      result = await readWeiboA(page, root)
    }
    console.log(JSON.stringify(result))
    if (!result.coverage.windows) process.exitCode = 1
  } finally {
    await context.close()
  }
}

main().catch(error => {
  const messages = {
    'windows-required': '请在 Windows 用户会话中运行。',
    'missing-profile': '找不到既有 A 档案。',
    'profile-in-use': 'A 档案正在使用。请只关闭 A 的独立 Edge 窗口后重试。',
    'profile-check-failed': '无法确认 A 档案是否空闲。',
    'edge-launch-failed': '无法用 A 的档案启动 Edge。请检查 A 专用窗口是否已退出。',
    'access-blocked': '微博页面拒绝访问，本轮停止。',
  }
  console.error(messages[error.message] ?? '读取或保存失败。')
  process.exitCode = 1
})
