import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { sendWindowsNotification } from './monitor-system.mjs'

const validUid = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)

export function chinaTime(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]))
  return { year: p.year, date: `${p.year}-${p.month}-${p.day}`, file: `${p.month}.${p.day} ${p.hour}.${p.minute}.${p.second}` }
}

export function formatExportRelativePath({ account, count, at = new Date(), store = null, exportRoot = '' }) {
  const rawName = (account.label?.trim() || account.nickname?.trim() || '未命名')
  const safeName = rawName.replace(/[\x00-\x1f\\/:*?"<>|]/g, '').slice(0, 30).trim() || '未命名'
  const safeOwner = String(account.owner || account.uid || account.profile || 'unknown').replace(/[\x00-\x1f\\/:*?"<>|]/g, '')
  const dirName = `${safeName}_${safeOwner}`

  const dateObj = (typeof at === 'string' ? new Date(at) : at) || new Date()
  const validDate = Number.isFinite(dateObj.getTime()) ? dateObj : new Date()
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(validDate).map(p => [p.type, p.value])
  )
  const timeStr = `${parts.month}.${parts.day}_${parts.hour}.${parts.minute}`
  const uidPart = safeOwner.startsWith('UID') ? safeOwner : `UID${safeOwner}`
  const baseFile = `${timeStr}_${safeName}_${uidPart}_${count}条`

  let candidateFile = `${baseFile}.txt`
  let index = 1
  while (true) {
    const candidateRelative = join(dirName, candidateFile)
    const fullDest = exportRoot ? join(exportRoot, candidateRelative) : candidateRelative
    let inDb = false
    if (store?.db) {
      if (store.batches && typeof store.target === 'function') {
        try {
          inDb = Boolean(store.db.prepare('SELECT 1 FROM batches WHERE path = ?').get(fullDest))
        } catch {}
      } else {
        try {
          inDb = Boolean(store.db.prepare('SELECT 1 FROM batches WHERE relative_path = ?').get(candidateRelative))
        } catch {}
      }
    }
    if (!existsSync(fullDest) && !inDb) {
      return candidateRelative
    }
    index++
    candidateFile = `${baseFile}_${index}.txt`
  }
}

function backupBeforeMigration(root, db) {
  const dbPath = join(root, 'monitor.sqlite')
  if (!existsSync(dbPath)) return
  const backupDir = join(root, 'backups')
  mkdirSync(backupDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = join(backupDir, `monitor.before-migration-${timestamp}.sqlite`)
  db.prepare('VACUUM INTO ?').run(backupFile)
  return backupFile
}

export class MonitorStore {
  constructor(root) {
    this.root = root
    mkdirSync(root, { recursive: true })

    const dbPath = join(root, 'monitor.sqlite')
    const isExistingDb = existsSync(dbPath)

    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')

    if (isExistingDb) {
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name))
      const hasAccounts = tables.has('accounts')
      const hasScans = tables.has('scans')
      const hasSettings = tables.has('settings')

      let accCols = new Set()
      let interval5 = false
      let accountsNeedMigration = false
      if (hasAccounts) {
        accCols = new Set(this.db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name))
        accountsNeedMigration = !accCols.has('nickname') || !accCols.has('full_scan_needed') || !accCols.has('blocked_count') || !hasSettings
        interval5 = accountsNeedMigration && Boolean(this.db.prepare('SELECT 1 FROM accounts WHERE interval_minutes=5').get())
      }

      let scanCols = new Set()
      let scansNeedMigration = false
      if (hasScans) {
        scanCols = new Set(this.db.prepare('PRAGMA table_info(scans)').all().map(c => c.name))
        scansNeedMigration = !scanCols.has('mode') || !scanCols.has('added')
      }

      const batchesNeedMigration = tables.has('batches') && !this.db.prepare('PRAGMA table_info(batches)').all().some(c=>c.name==='export_root')
      const needsMigration = accountsNeedMigration || scansNeedMigration || batchesNeedMigration

      if (needsMigration) {
        backupBeforeMigration(root, this.db)
        if(batchesNeedMigration)this.db.exec('ALTER TABLE batches ADD COLUMN export_root TEXT')

        if (hasAccounts) {
          if (!accCols.has('nickname')) {
            this.db.exec('ALTER TABLE accounts ADD COLUMN nickname TEXT;')
          }
          if (!accCols.has('full_scan_needed')) {
            this.db.exec('ALTER TABLE accounts ADD COLUMN full_scan_needed INTEGER NOT NULL DEFAULT 0;')
          }
          if (!accCols.has('blocked_count')) {
            this.db.exec('ALTER TABLE accounts ADD COLUMN blocked_count INTEGER NOT NULL DEFAULT 0;')
          }
          if (interval5) {
            this.db.exec('UPDATE accounts SET interval_minutes=10 WHERE interval_minutes=5;')
          }
        }

        if (hasScans) {
          if (!scanCols.has('mode')) {
            this.db.exec('ALTER TABLE scans ADD COLUMN mode TEXT;')
          }
          if (!scanCols.has('added')) {
            this.db.exec('ALTER TABLE scans ADD COLUMN added INTEGER;')
          }
        }
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts(
        id TEXT PRIMARY KEY, label TEXT NOT NULL, profile TEXT UNIQUE NOT NULL, owner TEXT UNIQUE,
        nickname TEXT, baseline_at TEXT, enabled INTEGER NOT NULL DEFAULT 0, interval_minutes INTEGER NOT NULL DEFAULT 10,
        status TEXT NOT NULL DEFAULT 'needs-login', message TEXT NOT NULL DEFAULT '',
        last_attempt TEXT, last_success TEXT, next_due INTEGER NOT NULL DEFAULT 0,
        displayed_total INTEGER, read_count INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        full_scan_needed INTEGER NOT NULL DEFAULT 0, blocked_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id),
        created_at TEXT NOT NULL, count INTEGER NOT NULL, relative_path TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'reserved', export_root TEXT);
      CREATE TABLE IF NOT EXISTS followers(account_id TEXT NOT NULL REFERENCES accounts(id), uid TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('historical','candidate','new')), first_seen TEXT NOT NULL,
        confirmed_at TEXT, batch_id INTEGER REFERENCES batches(id), PRIMARY KEY(account_id,uid));
      CREATE INDEX IF NOT EXISTS pending ON followers(account_id,kind,batch_id);
      CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), at TEXT NOT NULL,
        complete INTEGER NOT NULL, total INTEGER, read_count INTEGER NOT NULL, reason TEXT NOT NULL, mode TEXT, added INTEGER);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings(key, value) VALUES('concurrency', '1');
    `)
    for(const batch of this.db.prepare('SELECT id,relative_path FROM batches WHERE export_root IS NULL').all()){
      const current=this.exportRoot, original=this.defaultExportRoot
      const directory=existsSync(join(current,batch.relative_path))?current:existsSync(join(original,batch.relative_path))?original:current
      this.db.prepare('UPDATE batches SET export_root=? WHERE id=?').run(directory,batch.id)
    }
    this.databaseId=this.getSetting('database_id')??randomUUID()
    this.setSetting('database_id',this.databaseId)
  }

  close() { this.db.close() }

  assertStorageCurrent() {
    let disk
    try {
      disk=new DatabaseSync(join(this.root,'monitor.sqlite'),{readOnly:true})
      const id=disk.prepare("SELECT value FROM settings WHERE key='database_id'").get()?.value
      if(id!==this.databaseId)throw Error('changed')
    }catch{throw Error('数据库位置或身份发生变化，已停止操作。请退出程序后重新启动，不要在运行中替换数据目录。')}
    finally{disk?.close()}
  }

  get exportRoot() {
    const custom = this.getSetting('export_dir')
    if (custom && typeof custom === 'string' && custom.trim()) {
      return resolve(custom.trim())
    }
    return join(this.root, 'exports')
  }

  get defaultExportRoot() {
    return join(this.root, 'exports')
  }

  getBatchFilePath(batch) {
    if(batch.export_root)return join(batch.export_root,batch.relative_path)
    const current = join(this.exportRoot, batch.relative_path)
    if (existsSync(current)) return current
    const def = join(this.defaultExportRoot, batch.relative_path)
    if (existsSync(def)) return def
    return current
  }

  getSettings() {
    return {
      concurrency: Math.min(3, Math.max(1, Number(this.getSetting('concurrency', '1')) || 1)),
      default_interval: Math.min(1440, Math.max(2, Number(this.getSetting('default_interval', '10')) || 10)),
      export_dir: this.getSetting('export_dir', '') || join(this.root, 'exports'),
      default_export_dir: join(this.root, 'exports'),
      autostart: this.getSetting('autostart', '0') === '1',
      notifications: this.getSetting('notifications', '1') !== '0',
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  getSetting(key, defaultValue = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return row ? row.value : defaultValue
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, String(value), String(value))
  }

  isKnown(accountId, uid) {
    return Boolean(this.db.prepare("SELECT 1 FROM followers WHERE account_id=? AND uid=? AND kind IN ('historical','new')").get(accountId, uid))
  }

  getKnownUids(accountId) {
    return new Set(this.db.prepare("SELECT uid FROM followers WHERE account_id=? AND kind IN ('historical','new')").all(accountId).map(r => r.uid))
  }

  addAccount(label, profile = randomUUID(), interval = null) {
    if (typeof label !== 'string' || !label.trim() || label.length > 80 || !/^[A-Za-z0-9_-]{1,80}$/.test(profile)) {
      throw Error('账号名称或档案无效。')
    }
    const defaultInterval = Math.min(1440, Math.max(2, Number(this.getSetting('default_interval', '10')) || 10))
    const intervalMinutes = interval != null ? Number(interval) : defaultInterval
    const id = randomUUID()
    this.db.prepare('INSERT INTO accounts(id,label,profile,interval_minutes) VALUES(?,?,?,?)').run(id, label.trim(), profile, intervalMinutes)
    return this.account(id)
  }

  account(id) {
    const a = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id)
    if (!a) throw Error('找不到该账号。')
    const counts = this.db.prepare(`SELECT SUM(kind='new' AND batch_id IS NULL) pending,SUM(kind='candidate') candidates,
      SUM(kind='new') total_new, SUM(kind='historical') historical FROM followers WHERE account_id=?`).get(id)
    const rows = this.db.prepare("SELECT confirmed_at FROM followers WHERE account_id=? AND kind='new' AND confirmed_at>=?").all(id, new Date(Date.now() - 48 * 3600000).toISOString())
    const today = chinaTime().date
    return {
      ...a,
      ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v ?? 0])),
      today_new: rows.filter(r => chinaTime(new Date(r.confirmed_at)).date === today).length,
      exported_batches: this.db.prepare("SELECT COUNT(*) n FROM batches WHERE account_id=? AND status='ready'").get(id).n,
      waiting_files: this.db.prepare("SELECT COUNT(*) n FROM batches WHERE account_id=? AND status='reserved'").get(id).n,
    }
  }

  accounts() {
    return this.db.prepare('SELECT id FROM accounts ORDER BY rowid').all().map(r => this.account(r.id))
  }

  deleteAccount(id) {
    return this.transaction(() => {
      const a = this.account(id)
      this.db.prepare('DELETE FROM scans WHERE account_id=?').run(id)
      this.db.prepare('DELETE FROM followers WHERE account_id=?').run(id)
      this.db.prepare('DELETE FROM batches WHERE account_id=?').run(id)
      this.db.prepare('DELETE FROM accounts WHERE id=?').run(id)
      return a
    })
  }

  accountDetail(id) {
    const account = this.account(id)
    const recent_followers = this.db.prepare(`
      SELECT uid, kind, first_seen, confirmed_at, (batch_id IS NOT NULL) AS is_exported
      FROM followers
      WHERE account_id=? AND kind IN ('new', 'candidate')
      ORDER BY rowid DESC
      LIMIT 100
    `).all(id)
    const batches = this.batches(id)
    const recent_scans = this.db.prepare(`
      SELECT at, complete, total, read_count, reason, mode, added
      FROM scans
      WHERE account_id=?
      ORDER BY id DESC
      LIMIT 20
    `).all(id)
    const unexported_uids = this.db.prepare(`
      SELECT uid FROM followers
      WHERE account_id=? AND kind='new' AND batch_id IS NULL
      ORDER BY confirmed_at, first_seen, uid
    `).all(id).map(r => r.uid)
    return { account, recent_followers, batches, recent_scans, unexported_uids }
  }

  update(id, values) {
    const cur = this.account(id)
    const allowed = new Set(['label', 'owner', 'enabled', 'interval_minutes', 'status', 'message', 'last_attempt', 'last_success', 'next_due', 'failures', 'nickname', 'full_scan_needed', 'blocked_count'])
    const entries = Object.entries(values)
    if (!entries.length || entries.some(([k]) => !allowed.has(k))) throw Error('无效更新。')
    if (values.owner !== undefined && values.owner !== null) {
      if (!validUid(values.owner)) throw Error('账号身份数据无效。')
      if (cur.owner && cur.owner !== values.owner) {
        throw Error('登录的不是原来绑定的微博账号，请登录原账号。')
      }
      const other = this.db.prepare('SELECT id FROM accounts WHERE owner=? AND id<>?').get(values.owner, id)
      if (other) throw Error('这个微博账号已经绑定，请使用原来的账号记录。')
    }
    this.db.prepare(`UPDATE accounts SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).run(...entries.map(([, v]) => v), id)
  }

  ingest(id, scan, options = {}) {
    if (!validUid(scan.owner) || !Array.isArray(scan.uids) || scan.uids.some(u => !validUid(u))) {
      throw Error('账号身份或UID数据无效。')
    }
    const uids = [...new Set(scan.uids)], at = scan.at ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(at))) throw Error('观测时间无效。')

    return this.transaction(() => {
      const a = this.account(id)
      if (a.owner && a.owner !== scan.owner) throw Error('登录账号与已绑定账号不一致，请登录原账号。')
      const other = this.db.prepare('SELECT id FROM accounts WHERE owner=? AND id<>?').get(scan.owner, id)
      if (other) throw Error('这个微博账号已经绑定，请使用原来的账号记录。')
      this.db.prepare('UPDATE accounts SET owner=? WHERE id=?').run(scan.owner, id)
      if (scan.nickname) {
        this.db.prepare('UPDATE accounts SET nickname=? WHERE id=?').run(scan.nickname, id)
      } else if (/^(profile|avatar|profile picture)$/i.test(a.nickname??'')) {
        this.db.prepare('UPDATE accounts SET nickname=NULL WHERE id=?').run(id)
      }

      if (scan.reason === 'legacy-history-import') {
        const ins = this.db.prepare("INSERT OR IGNORE INTO followers(account_id, uid, kind, first_seen, confirmed_at) VALUES(?, ?, 'historical', ?, NULL)")
        for (const uid of uids) ins.run(id, uid, at)
        this.db.prepare('INSERT INTO scans(account_id, at, complete, total, read_count, reason, mode, added) VALUES(?, ?, 0, ?, ?, ?, ?, 0)').run(
          id, at, scan.total ?? null, uids.length, scan.reason, 'legacy')
        return { baseline: false, added: 0, complete: false, mode: 'legacy' }
      }

      const mode = options.mode ?? scan.mode ?? (!a.baseline_at ? 'baseline' : a.full_scan_needed ? 'full' : 'incremental')
      const noUnresolved = (scan.unresolvedLinks ?? 0) === 0

      let complete = false
      if (mode === 'baseline') {
        complete = (scan.complete === true || scan.reason === 'visible-end') && noUnresolved
      } else if (mode === 'incremental') {
        complete = (scan.complete === true || scan.reason === 'incremental-hit' || scan.reason === 'visible-end') && noUnresolved && scan.reason !== 'window-budget'
      } else if (mode === 'full') {
        complete = (scan.complete === true || scan.reason === 'visible-end') && noUnresolved
      }

      let added = 0
      if (mode === 'baseline') {
        if (complete) {
          const upHist = this.db.prepare("UPDATE followers SET kind='historical', confirmed_at=NULL WHERE account_id=? AND uid=?")
          const insHist = this.db.prepare("INSERT OR IGNORE INTO followers(account_id, uid, kind, first_seen, confirmed_at) VALUES(?, ?, 'historical', ?, NULL)")
          for (const uid of uids) {
            const r = upHist.run(id, uid)
            if (r.changes === 0) insHist.run(id, uid, at)
          }
          this.db.prepare("UPDATE followers SET kind='historical', confirmed_at=NULL WHERE account_id=? AND kind='candidate'").run(id)
          this.db.prepare(`UPDATE accounts SET baseline_at=?, full_scan_needed=0, displayed_total=?, read_count=?,
            last_attempt=?, last_success=?, status='ready', message='已建立初始粉丝记录，本轮已有粉丝不导出。', failures=0 WHERE id=?`).run(
            at, scan.total ?? null, uids.length, at, at, id)
        } else {
          const ins = this.db.prepare("INSERT OR IGNORE INTO followers(account_id, uid, kind, first_seen, confirmed_at) VALUES(?, ?, 'candidate', ?, NULL)")
          for (const uid of uids) ins.run(id, uid, at)
          this.db.prepare(`UPDATE accounts SET displayed_total=?, read_count=?, last_attempt=?, status='incomplete',
            message='初始读取未完整到达页面末尾，未建立基线。', failures=failures+1 WHERE id=?`).run(
            scan.total ?? null, uids.length, at, id)
        }
      } else if (mode === 'incremental') {
        if (complete) {
          const upCandidate = this.db.prepare("UPDATE followers SET kind='new', confirmed_at=? WHERE account_id=? AND uid=? AND kind='candidate'")
          const insNew = this.db.prepare("INSERT OR IGNORE INTO followers(account_id, uid, kind, first_seen, confirmed_at) VALUES(?, ?, 'new', ?, ?)")
          for (const uid of uids) {
            const upRes = upCandidate.run(at, id, uid)
            if (upRes.changes > 0) {
              added++
            } else {
              const insRes = insNew.run(id, uid, at, at)
              if (insRes.changes > 0) added++
            }
          }
          this.db.prepare(`UPDATE accounts SET full_scan_needed=0, displayed_total=?, read_count=?,
            last_attempt=?, last_success=?, status='ready', message=?, failures=0 WHERE id=?`).run(
            scan.total ?? null, uids.length, at, at,
            added > 0 ? `完成增量检查，确认新增 ${added} 个粉丝。` : '完成增量检查，无新增粉丝。', id)
        } else {
          const insCand = this.db.prepare("INSERT OR IGNORE INTO followers(account_id, uid, kind, first_seen, confirmed_at) VALUES(?, ?, 'candidate', ?, NULL)")
          for (const uid of uids) insCand.run(id, uid, at)
          const msg = scan.reason === 'window-budget'
            ? '已读取40屏未遇已知粉丝，新发现UID暂存候选，下一轮改为完整读取。'
            : '增量检查中断，新发现UID暂存候选，下一轮改为完整读取。'
          this.db.prepare(`UPDATE accounts SET full_scan_needed=1, displayed_total=?, read_count=?,
            last_attempt=?, status='incomplete', message=?, failures=failures+1 WHERE id=?`).run(
            scan.total ?? null, uids.length, at, msg, id)
        }
      } else if (mode === 'full') {
        if (complete) {
          const upCandidate = this.db.prepare("UPDATE followers SET kind='new', confirmed_at=? WHERE account_id=? AND uid=? AND kind='candidate'")
          const insNew = this.db.prepare("INSERT OR IGNORE INTO followers(account_id, uid, kind, first_seen, confirmed_at) VALUES(?, ?, 'new', ?, ?)")
          for (const uid of uids) {
            const upRes = upCandidate.run(at, id, uid)
            if (upRes.changes > 0) {
              added++
            } else {
              const insRes = insNew.run(id, uid, at, at)
              if (insRes.changes > 0) added++
            }
          }
          this.db.prepare(`UPDATE accounts SET full_scan_needed=0, displayed_total=?, read_count=?,
            last_attempt=?, last_success=?, status='ready', message=?, failures=0 WHERE id=?`).run(
            scan.total ?? null, uids.length, at, at,
            added > 0 ? `完成完整读取，确认新增 ${added} 个粉丝。` : '完成完整读取，无新增粉丝。', id)
        } else {
          const insCand = this.db.prepare("INSERT OR IGNORE INTO followers(account_id, uid, kind, first_seen, confirmed_at) VALUES(?, ?, 'candidate', ?, NULL)")
          for (const uid of uids) insCand.run(id, uid, at)
          this.db.prepare(`UPDATE accounts SET full_scan_needed=1, displayed_total=?, read_count=?,
            last_attempt=?, status='incomplete', message='完整读取未成功到达末尾，新发现UID保留为候选。', failures=failures+1 WHERE id=?`).run(
            scan.total ?? null, uids.length, at, id)
        }
      }

      this.db.prepare('INSERT INTO scans(account_id, at, complete, total, read_count, reason, mode, added) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, at, complete ? 1 : 0, scan.total ?? null, uids.length, scan.reason ?? 'unknown', mode, added)
      this.db.prepare('DELETE FROM scans WHERE account_id=? AND id NOT IN (SELECT id FROM scans WHERE account_id=? ORDER BY id DESC LIMIT 100)').run(id, id)

      return { baseline: mode === 'baseline' && complete, added, complete, mode }
    })
  }

  batches(accountId) {
    return accountId
      ? this.db.prepare('SELECT * FROM batches WHERE account_id=? ORDER BY id DESC').all(accountId)
      : this.db.prepare('SELECT * FROM batches ORDER BY id DESC').all()
  }

  flush({ accountId = null, tail = false, fault = () => {} } = {}) {
    const created = this.transaction(() => {
      const made = []
      for (const a of this.accounts().filter(a => !accountId || a.id === accountId)) {
        const rows = this.db.prepare("SELECT uid FROM followers WHERE account_id=? AND kind='new' AND batch_id IS NULL ORDER BY confirmed_at,first_seen,uid").all(a.id)
        for (let start = 0; start < rows.length; start += 60) {
          const group = rows.slice(start, start + 60)
          if (group.length < 60 && !tail) break
          const at = new Date().toISOString()
          const id = Number(this.db.prepare('INSERT INTO batches(account_id,created_at,count,export_root) VALUES(?,?,?,?)').run(a.id, at, group.length,this.exportRoot).lastInsertRowid)
          const relative = formatExportRelativePath({ account: a, count: group.length, at, store: this, exportRoot: this.exportRoot })
          this.db.prepare('UPDATE batches SET relative_path=? WHERE id=?').run(relative, id)
          for (const { uid } of group) {
            this.db.prepare('UPDATE followers SET batch_id=? WHERE account_id=? AND uid=? AND batch_id IS NULL').run(id, a.id, uid)
          }
          made.push(id)
        }
      }
      return made
    })

    if (created.length) fault('reserved')

    for (const batch of this.batches(accountId)) {
      const destination = this.getBatchFilePath(batch)
      if (batch.status === 'ready' && existsSync(destination)) continue
      const rows = this.db.prepare('SELECT uid FROM followers WHERE batch_id=? ORDER BY confirmed_at,first_seen,uid').all(batch.id)
      if (rows.length !== batch.count) throw Error('批次记录数量不一致，请保留数据并检查。')
      const content = rows.map(r => r.uid).join('\r\n') + '\r\n'
      mkdirSync(dirname(destination), { recursive: true })
      if (existsSync(destination)) {
        if (readFileSync(destination, 'utf8') !== content) throw Error('导出文件已被修改，未覆盖，请移走冲突文件后重试。')
      } else {
        const temp = destination + '.tmp'
        writeFileSync(temp, content, { encoding: 'utf8', flush: true })
        linkSync(temp, destination)
        unlinkSync(temp)
      }
      fault('written')
      this.db.prepare("UPDATE batches SET status='ready' WHERE id=?").run(batch.id)
      if (this.getSetting('notifications', '1') !== '0') {
        try {
          const a = this.account(batch.account_id)
          const name = a.nickname || a.label
          sendWindowsNotification('微博粉丝助手', `${name} 导出 ${batch.count} 个`)
        } catch {}
      }
    }
    return created
  }
}
