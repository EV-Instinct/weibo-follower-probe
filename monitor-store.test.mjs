import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MonitorStore } from './monitor-store.mjs'

const ids = (n, start = 1000000000) => Array.from({ length:n }, (_, i) => String(start + i))
const scan = (uids, complete=true, owner='1234567890') => ({ owner, uids, complete, total:uids.length, reason:complete?'visible-complete':'incomplete', at:'2026-11-09T01:00:00.000Z' })
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'weibo-store-'))
  let store=new MonitorStore(root)
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
  const a=store.addAccount('测试账号','A')
  return {root,a,get store(){return store},reopen(){store.close();store=new MonitorStore(root)}}
}
test('初始与不完整观测不导出；重启、取关重现永久去重', t=>{
  const env=setup(t), {a}=env
  env.store.ingest(a.id,scan(ids(2),false))
  assert.equal(env.store.account(a.id).baseline_at,null)
  env.store.ingest(a.id,scan(ids(3)))
  assert.equal(env.store.account(a.id).pending,0)
  env.store.ingest(a.id,scan(ids(4),false))
  assert.equal(env.store.account(a.id).pending,0)
  assert.equal(env.store.account(a.id).candidates,1)
  env.store.ingest(a.id,scan(ids(4)))
  assert.equal(env.store.account(a.id).pending,1)
  env.reopen()
  env.store.ingest(a.id,scan([]))
  env.store.ingest(a.id,scan(ids(4)))
  assert.equal(env.store.account(a.id).pending,1)
  assert.throws(()=>env.store.ingest(a.id,scan(ids(4),true,'2345678901')))
})
test('59/60/61/120/121 边界、批次恢复与精度',t=>{
  const {store,a,root}=setup(t)
  store.ingest(a.id,scan(['987654321098765432']))
  for(const n of [59,60,61,120,121]) {
    store.ingest(a.id,scan(['987654321098765432',...ids(n)]))
    store.flush()
    assert.equal(store.batches(a.id).length,Math.floor(n/60))
    assert.equal(store.account(a.id).pending,n%60)
  }
  const batches=store.batches(a.id)
  const all=batches.flatMap(b=>readFileSync(join(root,'exports',b.relative_path),'utf8').trim().split(/\r?\n/))
  assert.equal(all.length,120);assert.equal(new Set(all).size,120)
  assert.equal(all.includes('987654321098765432'),false)
  store.flush({accountId:a.id,tail:true})
  assert.equal(store.account(a.id).pending,0)
  assert.equal(store.batches(a.id).length,3)
})
test('预留批次后崩溃，重启沿用原批次；文件写好后失败同样幂等',t=>{
  const env=setup(t),{a}=env
  env.store.ingest(a.id,scan([]));env.store.ingest(a.id,scan(ids(60)))
  assert.throws(()=>env.store.flush({fault:stage=>{if(stage==='reserved')throw Error('模拟中断')}}))
  env.reopen()
  assert.throws(()=>env.store.flush({fault:stage=>{if(stage==='written')throw Error('模拟中断')}}))
  env.reopen();env.store.flush();env.store.flush()
  assert.equal(env.store.batches(a.id).length,1)
  assert.equal(env.store.batches(a.id)[0].status,'ready')
  assert.equal(env.store.account(a.id).pending,0)
})
test('文件冲突保留批次并报错；账号隔离和重复绑定检查',t=>{
  const {store,a,root}=setup(t),b=store.addAccount('B','B')
  store.ingest(a.id,scan([]));store.ingest(a.id,scan(ids(60)))
  assert.throws(()=>store.flush({fault:stage=>{if(stage==='written')throw Error('模拟中断')}}))
  const batch=store.batches(a.id)[0]
  writeFileSync(join(root,'exports',batch.relative_path),'user content')
  assert.throws(()=>store.flush())
  assert.equal(store.batches(a.id)[0].status,'reserved')
  assert.throws(()=>store.ingest(b.id,scan([])))
  store.ingest(b.id,scan([],true,'2345678901'))
  store.ingest(b.id,scan(ids(1),true,'2345678901'))
  assert.equal(store.account(b.id).pending,1)
})
test('导出目录不可用时不丢批次，恢复后生成唯一文件',t=>{
  const env=setup(t),{a,root}=env
  env.store.ingest(a.id,scan([]));env.store.ingest(a.id,scan(ids(60)))
  writeFileSync(join(root,'exports'),'模拟路径被文件占用')
  assert.throws(()=>env.store.flush())
  assert.equal(env.store.account(a.id).waiting_files,1)
  rmSync(join(root,'exports'))
  env.reopen();env.store.flush()
  assert.equal(env.store.account(a.id).waiting_files,0)
  assert.equal(env.store.batches(a.id).length,1)
  assert.equal(env.store.batches(a.id)[0].status,'ready')
})

test('大账号基线不要求数量相等', t => {
  const env = setup(t), { a } = env
  // 页面标题粉丝数 100000，但可见滚动到末尾读到 50 个
  const bigScan = {
    owner: '1234567890',
    uids: ids(50),
    total: 100000,
    complete: true,
    reason: 'visible-end',
    unresolvedLinks: 0,
    at: '2026-11-09T02:00:00.000Z',
  }
  const result = env.store.ingest(a.id, bigScan, { mode: 'baseline' })
  assert.equal(result.baseline, true)
  assert.equal(result.complete, true)
  assert.equal(result.added, 0)
  const acc = env.store.account(a.id)
  assert.ok(acc.baseline_at)
  assert.equal(acc.displayed_total, 100000)
  assert.equal(acc.read_count, 50)
  assert.equal(acc.historical, 50)
  assert.equal(acc.pending, 0)
  assert.equal(acc.candidates, 0)
})

test('读满 40 屏转为候选并在下一轮完整读取，候选后来转为新增', t => {
  const env = setup(t), { a } = env
  // 1. 建立基线
  env.store.ingest(a.id, scan(ids(10)), { mode: 'baseline' })
  assert.ok(env.store.account(a.id).baseline_at)

  // 2. 增量读满 40 屏未遇已知，原因 window-budget
  const budgetScan = {
    owner: '1234567890',
    uids: ['2000000001', '2000000002'],
    total: 12,
    complete: false,
    reason: 'window-budget',
    unresolvedLinks: 0,
    at: '2026-11-09T03:00:00.000Z',
  }
  const resBudget = env.store.ingest(a.id, budgetScan, { mode: 'incremental' })
  assert.equal(resBudget.complete, false)
  assert.equal(resBudget.added, 0)
  const accBudget = env.store.account(a.id)
  assert.equal(accBudget.full_scan_needed, 1)
  assert.equal(accBudget.candidates, 2)
  assert.equal(accBudget.pending, 0)
  // 候选 UID 不算已知
  assert.equal(env.store.isKnown(a.id, '2000000001'), false)
  assert.equal(env.store.isKnown(a.id, '2000000002'), false)

  // 3. 下一轮改为完整读取 (mode: 'full')，成功到达末尾
  const fullScan = {
    owner: '1234567890',
    uids: [...ids(10), '2000000001', '2000000002', '2000000003'],
    total: 13,
    complete: true,
    reason: 'visible-end',
    unresolvedLinks: 0,
    at: '2026-11-09T03:10:00.000Z',
  }
  const resFull = env.store.ingest(a.id, fullScan, { mode: 'full' })
  assert.equal(resFull.complete, true)
  assert.equal(resFull.added, 3) // 2 候选转为新增 + 1 全新
  const accFull = env.store.account(a.id)
  assert.equal(accFull.full_scan_needed, 0)
  assert.equal(accFull.candidates, 0)
  assert.equal(accFull.pending, 3)
  // 转为新增后算作已知
  assert.equal(env.store.isKnown(a.id, '2000000001'), true)
  assert.equal(env.store.isKnown(a.id, '2000000003'), true)
})

test('文件名格式、非法字符处理、同名加 _2', t => {
  const { store, a, root } = setup(t)
  // 设置含有非法 Windows 字符和超长字符的备注
  store.update(a.id, { label: '主账号/工作:测试*<>?|"非常长非常长非常长非常长非常长超过三十个字会被截断' })
  // 建立基线并添加 60 个新粉丝
  store.ingest(a.id, scan([]), { mode: 'baseline' })
  store.ingest(a.id, scan(ids(60)), { mode: 'incremental' })

  // 第一次导出
  const made1 = store.flush()
  assert.equal(made1.length, 1)
  const batch1 = store.batches(a.id)[0]
  // 目录为 <账号名>_<UID>，不再有年份子目录
  assert.match(batch1.relative_path, /^[^\\/]+_[^\\/]+\\[^\\/]+$/)
  assert.equal(batch1.relative_path.includes(':'), false)
  assert.equal(batch1.relative_path.includes('*'), false)
  assert.equal(batch1.relative_path.includes('?'), false)
  assert.equal(batch1.relative_path.includes('"'), false)
  assert.equal(batch1.relative_path.includes('<'), false)
  assert.equal(batch1.relative_path.includes('>'), false)
  assert.equal(batch1.relative_path.includes('|'), false)
  // 文件名符合：月.日 时.分 60个 账号名.txt
  assert.match(batch1.relative_path, /\d+\.\d+ \d+\.\d{2} 60个 .+\.txt$/)

  // 第二次添加 60 个，同时间生成批次 -> 同名冲突依次加 _2
  store.ingest(a.id, scan(ids(60, 2000000000)), { mode: 'incremental' })
  const made2 = store.flush()
  assert.equal(made2.length, 1)
  const batch2 = store.batches(a.id)[0]
  assert.match(batch2.relative_path, /_2\.txt$/)

  // 第三次添加 60 个 -> 同名冲突加 _3
  store.ingest(a.id, scan(ids(60, 3000000000)), { mode: 'incremental' })
  const made3 = store.flush()
  assert.equal(made3.length, 1)
  const batch3 = store.batches(a.id)[0]
  assert.match(batch3.relative_path, /_3\.txt$/)
})

test('对旧数据库的兼容迁移：备份到 backups/，字段补全，间隔5改10，旧数据不丢且不重复导出', t => {
  const root = mkdtempSync(join(tmpdir(), 'weibo-legacy-'))

  // 1. 手动构建旧版本 SQLite 数据库结构（无 nickname, full_scan_needed, blocked_count；interval_minutes 默认为 5）
  const legacyDb = new DatabaseSync(join(root, 'monitor.sqlite'))
  legacyDb.exec(`
    CREATE TABLE accounts(
      id TEXT PRIMARY KEY, label TEXT NOT NULL, profile TEXT UNIQUE NOT NULL, owner TEXT UNIQUE,
      baseline_at TEXT, enabled INTEGER NOT NULL DEFAULT 0, interval_minutes INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'ready', message TEXT NOT NULL DEFAULT '',
      last_attempt TEXT, last_success TEXT, next_due INTEGER NOT NULL DEFAULT 0,
      displayed_total INTEGER, read_count INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE batches(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id),
      created_at TEXT NOT NULL, count INTEGER NOT NULL, relative_path TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'reserved');
    CREATE TABLE followers(account_id TEXT NOT NULL REFERENCES accounts(id), uid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('historical','candidate','new')), first_seen TEXT NOT NULL,
      confirmed_at TEXT, batch_id INTEGER REFERENCES batches(id), PRIMARY KEY(account_id,uid));
    CREATE INDEX pending ON followers(account_id,kind,batch_id);
    CREATE TABLE scans(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), at TEXT NOT NULL,
      complete INTEGER NOT NULL, total INTEGER, read_count INTEGER NOT NULL, reason TEXT NOT NULL);
  `)
  const accId = 'legacy-acc-1'
  legacyDb.prepare(`INSERT INTO accounts(id, label, profile, owner, baseline_at, enabled, interval_minutes, status)
    VALUES(?, '旧账号A', 'A', '1234567890', '2026-11-08T10:00:00.000Z', 1, 5, 'ready')`).run(accId)
  // 插入历史粉丝
  legacyDb.prepare("INSERT INTO followers(account_id, uid, kind, first_seen) VALUES(?, '1000000001', 'historical', '2026-11-08T10:00:00.000Z')").run(accId)
  // 插入已经导出过的批次和粉丝
  legacyDb.prepare("INSERT INTO batches(id, account_id, created_at, count, relative_path, status) VALUES(1, ?, '2026-11-08T11:00:00.000Z', 1, 'A_1234567890/2026/11.08 11.00.00 1个_0001.txt', 'ready')").run(accId)
  legacyDb.prepare("INSERT INTO followers(account_id, uid, kind, first_seen, confirmed_at, batch_id) VALUES(?, '1000000002', 'new', '2026-11-08T11:00:00.000Z', '2026-11-08T11:00:00.000Z', 1)").run(accId)
  // 插入待导出新粉丝
  legacyDb.prepare("INSERT INTO followers(account_id, uid, kind, first_seen, confirmed_at, batch_id) VALUES(?, '1000000003', 'new', '2026-11-08T12:00:00.000Z', '2026-11-08T12:00:00.000Z', NULL)").run(accId)
  legacyDb.close()

  // 2. 用 MonitorStore 打开旧数据库，触发自动备份与兼容迁移
  const store = new MonitorStore(root)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })

  // 验证备份文件已创建在 backups/
  const backupDir = join(root, 'backups')
  assert.ok(existsSync(backupDir))
  const backupFiles = readdirSync(backupDir).filter(f => f.startsWith('monitor.before-migration-'))
  assert.equal(backupFiles.length >= 1, true)

  // 验证账号字段已迁移：interval_minutes 5 改为 10
  const acc = store.account(accId)
  assert.equal(acc.interval_minutes, 10)
  assert.equal(acc.nickname, null)
  assert.equal(acc.full_scan_needed, 0)
  assert.equal(acc.blocked_count, 0)
  assert.equal(acc.historical, 1)
  assert.equal(acc.total_new, 2)
  assert.equal(acc.pending, 1) // 只有 1000000003 待导出
  assert.equal(acc.exported_batches, 1)

  // 验证全局设置默认 concurrency 存在
  assert.equal(store.getSetting('concurrency'), '1')

  // 验证旧批次不会被重新导出，只导出新增的尾数
  const made = store.flush({ accountId: accId, tail: true })
  assert.equal(made.length, 1)
  const newBatch = store.batches(accId).find(b => b.id === made[0])
  assert.equal(newBatch.count, 1)
  // 读取新导出的文件内容，只包含 1000000003
  const newBatchPath = join(root, 'exports', newBatch.relative_path)
  assert.equal(readFileSync(newBatchPath, 'utf8').trim(), '1000000003')
  // 待导出变为 0
  assert.equal(store.account(accId).pending, 0)
})

test('设置持久化：默认检查间隔在新建账号生效，自定义导出目录隔离新旧批次', t => {
  const env = setup(t)
  const { store, root } = env

  // 1. 设置默认间隔为 20 分钟
  store.setSetting('default_interval', '20')
  const newAccount = store.addAccount('新间隔账号')
  assert.equal(newAccount.interval_minutes, 20)

  // 2. 自定义导出目录
  const customDir = join(root, 'custom-exports-test')
  store.setSetting('export_dir', customDir)
  assert.equal(store.exportRoot, customDir)

  // 建立基线并新增粉丝导出
  store.ingest(newAccount.id, scan(ids(10), true, '9999999999'))
  store.ingest(newAccount.id, scan(ids(15), true, '9999999999'))
  const batches = store.flush({ accountId: newAccount.id, tail: true })
  assert.equal(batches.length, 1)

  const batch = store.batches(newAccount.id)[0]
  const filePath = store.getBatchFilePath(batch)
  assert.ok(filePath.startsWith(customDir))
  assert.ok(existsSync(filePath))
})

test('用真实结构的旧数据库迁移后，backups 里必须有备份文件', t => {
  const root = mkdtempSync(join(tmpdir(), 'weibo-real-legacy-'))

  // 构建与旧版本（0.1.0 / commit bd788d7）真实结构完全一致的旧数据库
  const legacyDb = new DatabaseSync(join(root, 'monitor.sqlite'))
  legacyDb.exec(`
    PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(
      id TEXT PRIMARY KEY, label TEXT NOT NULL, profile TEXT UNIQUE NOT NULL, owner TEXT UNIQUE,
      baseline_at TEXT, enabled INTEGER NOT NULL DEFAULT 0, interval_minutes INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'ready', message TEXT NOT NULL DEFAULT '',
      last_attempt TEXT, last_success TEXT, next_due INTEGER NOT NULL DEFAULT 0,
      displayed_total INTEGER, read_count INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE batches(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id),
      created_at TEXT NOT NULL, count INTEGER NOT NULL, relative_path TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'reserved');
    CREATE TABLE followers(account_id TEXT NOT NULL REFERENCES accounts(id), uid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('historical','candidate','new')), first_seen TEXT NOT NULL,
      confirmed_at TEXT, batch_id INTEGER REFERENCES batches(id), PRIMARY KEY(account_id,uid));
    CREATE INDEX pending ON followers(account_id,kind,batch_id);
    CREATE TABLE scans(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), at TEXT NOT NULL,
      complete INTEGER NOT NULL, total INTEGER, read_count INTEGER NOT NULL, reason TEXT NOT NULL);
  `)
  // 插入真实账号 A（真实 UID 7718778629）、真实历史粉丝与扫描记录
  const accountId = 'real-account-a-uuid'
  legacyDb.prepare(`
    INSERT INTO accounts(id, label, profile, owner, baseline_at, enabled, interval_minutes, status, message, read_count)
    VALUES(?, '账号 A', 'A', '7718778629', '2026-11-08T08:00:00.000Z', 1, 5, 'ready', '已按可见列表完成比对。', 3)
  `).run(accountId)
  legacyDb.prepare("INSERT INTO followers(account_id, uid, kind, first_seen) VALUES(?, '6600000001', 'historical', '2026-11-08T08:00:00.000Z')").run(accountId)
  legacyDb.prepare("INSERT INTO followers(account_id, uid, kind, first_seen) VALUES(?, '6600000002', 'historical', '2026-11-08T08:00:00.000Z')").run(accountId)
  legacyDb.prepare("INSERT INTO followers(account_id, uid, kind, first_seen) VALUES(?, '6600000003', 'historical', '2026-11-08T08:00:00.000Z')").run(accountId)
  legacyDb.prepare("INSERT INTO scans(id, account_id, at, complete, total, read_count, reason) VALUES(1, ?, '2026-11-08T08:00:00.000Z', 1, 3, 3, 'visible-end')").run(accountId)
  legacyDb.close()

  // 用 MonitorStore 打开旧数据库触发自动备份与兼容迁移
  const store = new MonitorStore(root)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  // 1. backups 目录必须存在，且必须有备份文件
  const backupDir = join(root, 'backups')
  assert.ok(existsSync(backupDir), 'backups 目录必须存在')
  const backupFiles = readdirSync(backupDir).filter(f => f.startsWith('monitor.before-migration-') && f.endsWith('.sqlite'))
  assert.ok(backupFiles.length >= 1, 'backups 目录中必须有 monitor.before-migration-*.sqlite 备份文件')

  // 2. 备份文件必须保留迁移前的旧结构（无 nickname 列）
  const backupDb = new DatabaseSync(join(backupDir, backupFiles[0]))
  const backupCols = new Set(backupDb.prepare('PRAGMA table_info(accounts)').all().map(c => c.name))
  assert.equal(backupCols.has('nickname'), false, '备份文件必须保留迁移前的旧结构')
  backupDb.close()

  // 3. 验证迁移后的新数据库字段补齐且数据完好
  const a = store.account(accountId)
  assert.equal(a.owner, '7718778629')
  assert.equal(a.label, '账号 A')
  assert.equal(a.interval_minutes, 10, '旧版本的 5 分钟间隔必须迁移为 10 分钟')
  assert.equal(a.nickname, null)
  assert.equal(a.full_scan_needed, 0)
  assert.equal(a.blocked_count, 0)
  assert.equal(a.historical, 3)

  // 4. 验证 scans 表补充了 mode 与 added 列
  const scansCols = new Set(store.db.prepare('PRAGMA table_info(scans)').all().map(c => c.name))
  assert.ok(scansCols.has('mode'), 'scans 表必须补充 mode 列')
  assert.ok(scansCols.has('added'), 'scans 表必须补充 added 列')

  // 5. 验证 settings 表存在
  assert.equal(store.getSetting('concurrency'), '1')
})
