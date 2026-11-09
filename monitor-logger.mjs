import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chinaTime } from './monitor-store.mjs'

function sanitize(value) {
  if (value == null) return ''
  const str = typeof value === 'string' ? value : JSON.stringify(value)
  return str
    .replace(/(cookie|token|auth|authorization|password|passwd|pwd)\s*[:=]\s*["']?[^,"';\s]+/gi, '$1=***')
    .replace(/SUB=[A-Za-z0-9_-]+/gi, 'SUB=***')
    .replace(/SUBP=[A-Za-z0-9_-]+/gi, 'SUBP=***')
}

export class MonitorLogger {
  constructor(root) {
    this.root = root
    this.logsDir = join(root, 'logs')
    mkdirSync(this.logsDir, { recursive: true })
    this.pruneOldLogs()
  }

  pruneOldLogs(retentionDays = 14) {
    try {
      if (!existsSync(this.logsDir)) return
      const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
      for (const file of readdirSync(this.logsDir)) {
        if (!file.startsWith('weibo-monitor-') || !file.endsWith('.log')) continue
        const fullPath = join(this.logsDir, file)
        try {
          const stat = statSync(fullPath)
          if (stat.mtimeMs < cutoff) {
            unlinkSync(fullPath)
          }
        } catch {}
      }
    } catch {}
  }

  write(level, message, meta = null) {
    try {
      mkdirSync(this.logsDir, { recursive: true })
      const now = new Date()
      const timePart = now.toISOString().replace('T', ' ').slice(0, 23)
      const datePart = chinaTime(now).date
      const logFile = join(this.logsDir, `weibo-monitor-${datePart}.log`)

      let line = `[${timePart}] [${level.toUpperCase()}] ${sanitize(message)}`
      if (meta != null) {
        line += ` | ${sanitize(meta)}`
      }
      line += '\r\n'
      appendFileSync(logFile, line, 'utf8')
    } catch {}
  }

  info(msg, meta) { this.write('INFO', msg, meta) }
  warn(msg, meta) { this.write('WARN', msg, meta) }
  error(msg, meta) { this.write('ERROR', msg, meta) }
}
