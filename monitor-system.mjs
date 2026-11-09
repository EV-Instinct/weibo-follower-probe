import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export const isTestEnv = typeof process !== 'undefined' && Boolean(
  process.env?.NODE_TEST_CONTEXT ||
  process.env?.NODE_ENV === 'test' ||
  process.argv?.some(a => a.includes('.test.')) ||
  process.execArgv?.some(a => a.startsWith('--test'))
)

export function sendWindowsNotification(title, message) {
  if (isTestEnv) return
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $template.GetElementsByTagName('text')
$nodes.Item(0).InnerText = [System.Environment]::GetEnvironmentVariable('TOAST_TITLE')
$nodes.Item(1).InnerText = [System.Environment]::GetEnvironmentVariable('TOAST_MSG')
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
`
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, TOAST_TITLE: String(title), TOAST_MSG: String(message) },
      stdio: 'ignore',
      windowsHide: true,
      detached: true
    })
    child.unref()
  } catch {}
}

export function checkDirectoryWritable(dirPath) {
  try {
    const targetDir = resolve(dirPath)
    mkdirSync(targetDir, { recursive: true })
    const testFile = join(targetDir, `.write-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
    writeFileSync(testFile, 'test', 'utf8')
    unlinkSync(testFile)
    return true
  } catch {
    throw Error('导出目录不可写，请选择有写入权限的文件夹。')
  }
}

export function getDefaultStartupShortcutPath() {
  const startup = process.env.APPDATA ? join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null
  return startup ? join(startup, '微博粉丝助手.lnk') : null
}

export function isAutostartEnabled(customShortcutPath = null) {
  const p = customShortcutPath || getDefaultStartupShortcutPath()
  return Boolean(p && existsSync(p))
}

export function setAutostart(enable, { appDir = process.cwd(), customShortcutPath = null } = {}) {
  const shortcutPath = customShortcutPath || getDefaultStartupShortcutPath()
  if (!shortcutPath) return false

  if (!enable) {
    if (existsSync(shortcutPath)) {
      try { unlinkSync(shortcutPath) } catch {}
    }
    return false
  }

  // Enable autostart
  mkdirSync(dirname(shortcutPath), { recursive: true })

  // Locate the best target (prefer 启动微博粉丝助手.vbs if present)
  let targetPath = '', workingDir = appDir, args = ''
  const candidates = [
    join(appDir, '启动微博粉丝助手.vbs'),
    join(dirname(appDir), '启动微博粉丝助手.vbs'),
    join(appDir, '启动微博粉丝助手.cmd'),
    join(dirname(appDir), '启动微博粉丝助手.cmd')
  ]
  const found = candidates.find(existsSync)
  if (found) {
    targetPath = found
    workingDir = dirname(found)
  } else {
    targetPath = process.execPath
    workingDir = appDir
    args = `"${join(appDir, 'monitor-app.mjs')}" --open`
  }

  const script = `
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($env:SHORTCUT_PATH)
$s.TargetPath = $env:TARGET_PATH
$s.WorkingDirectory = $env:WORKING_DIR
if ($env:SHORTCUT_ARGS) { $s.Arguments = $env:SHORTCUT_ARGS }
$s.Save()
`
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {
      ...process.env,
      SHORTCUT_PATH: shortcutPath,
      TARGET_PATH: targetPath,
      WORKING_DIR: workingDir,
      SHORTCUT_ARGS: args
    },
    windowsHide: true
  })

  return existsSync(shortcutPath)
}
