import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'

const validUid = value => typeof value==='string' && /^[1-9]\d{0,19}$/.test(value)
export function chinaTime(date=new Date()) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]))
  return {year:p.year,date:`${p.year}-${p.month}-${p.day}`,file:`${p.month}.${p.day} ${p.hour}.${p.minute}.${p.second}`}
}
export class MonitorStore {
  constructor(root) {
    this.root=root;this.exportRoot=join(root,'exports');mkdirSync(root,{recursive:true})
    this.db=new DatabaseSync(join(root,'monitor.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(
        id TEXT PRIMARY KEY, label TEXT NOT NULL, profile TEXT UNIQUE NOT NULL, owner TEXT UNIQUE,
        baseline_at TEXT, enabled INTEGER NOT NULL DEFAULT 0, interval_minutes INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL DEFAULT 'needs-login', message TEXT NOT NULL DEFAULT '',
        last_attempt TEXT, last_success TEXT, next_due INTEGER NOT NULL DEFAULT 0,
        displayed_total INTEGER, read_count INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id),
        created_at TEXT NOT NULL, count INTEGER NOT NULL, relative_path TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'reserved');
      CREATE TABLE IF NOT EXISTS followers(account_id TEXT NOT NULL REFERENCES accounts(id), uid TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('historical','candidate','new')), first_seen TEXT NOT NULL,
        confirmed_at TEXT, batch_id INTEGER REFERENCES batches(id), PRIMARY KEY(account_id,uid));
      CREATE INDEX IF NOT EXISTS pending ON followers(account_id,kind,batch_id);
      CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), at TEXT NOT NULL,
        complete INTEGER NOT NULL, total INTEGER, read_count INTEGER NOT NULL, reason TEXT NOT NULL);
    `)
  }
  close(){this.db.close()}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result}catch(e){this.db.exec('ROLLBACK');throw e}}
  addAccount(label,profile=randomUUID()) {
    if(typeof label!=='string'||!label.trim()||label.length>80||!/^[A-Za-z0-9_-]{1,80}$/.test(profile))throw Error('账号名称或档案无效。')
    const id=randomUUID()
    this.db.prepare('INSERT INTO accounts(id,label,profile) VALUES(?,?,?)').run(id,label.trim(),profile)
    return this.account(id)
  }
  account(id) {
    const a=this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id)
    if(!a)throw Error('找不到该账号。')
    const counts=this.db.prepare(`SELECT SUM(kind='new' AND batch_id IS NULL) pending,SUM(kind='candidate') candidates,
      SUM(kind='new') total_new, SUM(kind='historical') historical FROM followers WHERE account_id=?`).get(id)
    const rows=this.db.prepare("SELECT confirmed_at FROM followers WHERE account_id=? AND kind='new' AND confirmed_at>=?").all(id,new Date(Date.now()-48*3600000).toISOString())
    const today=chinaTime().date
    return {...a,...Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,v??0])),today_new:rows.filter(r=>chinaTime(new Date(r.confirmed_at)).date===today).length,
      exported_batches:this.db.prepare("SELECT COUNT(*) n FROM batches WHERE account_id=? AND status='ready'").get(id).n,
      waiting_files:this.db.prepare("SELECT COUNT(*) n FROM batches WHERE account_id=? AND status='reserved'").get(id).n}
  }
  accounts(){return this.db.prepare('SELECT id FROM accounts ORDER BY rowid').all().map(r=>this.account(r.id))}
  update(id,values) {
    this.account(id)
    const allowed=new Set(['label','enabled','interval_minutes','status','message','last_attempt','last_success','next_due','failures'])
    const entries=Object.entries(values);if(!entries.length||entries.some(([k])=>!allowed.has(k)))throw Error('无效更新。')
    this.db.prepare(`UPDATE accounts SET ${entries.map(([k])=>`${k}=?`).join(',')} WHERE id=?`).run(...entries.map(([,v])=>v),id)
  }
  ingest(id,scan) {
    if(!validUid(scan.owner)||!Array.isArray(scan.uids)||scan.uids.some(u=>!validUid(u)))throw Error('账号身份或UID数据无效。')
    const uids=[...new Set(scan.uids)], at=scan.at??new Date().toISOString()
    if(!Number.isFinite(Date.parse(at)))throw Error('观测时间无效。')
    const complete=scan.complete===true && Number.isSafeInteger(scan.total) && scan.total===uids.length
    return this.transaction(()=>{
      const a=this.account(id)
      if(a.owner && a.owner!==scan.owner)throw Error('登录账号与已绑定账号不一致，请登录原账号。')
      const other=this.db.prepare('SELECT id FROM accounts WHERE owner=? AND id<>?').get(scan.owner,id)
      if(other)throw Error('这个微博账号已经绑定，请使用原来的账号记录。')
      this.db.prepare('UPDATE accounts SET owner=? WHERE id=?').run(scan.owner,id)
      const insert=this.db.prepare('INSERT OR IGNORE INTO followers(account_id,uid,kind,first_seen,confirmed_at) VALUES(?,?,?,?,?)')
      let added=0
      for(const uid of uids) {
        const kind=!a.baseline_at?'historical':complete?'new':'candidate'
        const r=insert.run(id,uid,kind,at,kind==='new'?at:null)
        if(kind==='new')added+=Number(r.changes)
        if(a.baseline_at&&complete)added+=Number(this.db.prepare("UPDATE followers SET kind='new',confirmed_at=? WHERE account_id=? AND uid=? AND kind='candidate'").run(at,id,uid).changes)
      }
      this.db.prepare(`UPDATE accounts SET baseline_at=CASE WHEN baseline_at IS NULL AND ? THEN ? ELSE baseline_at END,
        displayed_total=?,read_count=?,last_attempt=?,last_success=CASE WHEN ? THEN ? ELSE last_success END,
        status=?,message=?,failures=CASE WHEN ? THEN 0 ELSE failures+1 END WHERE id=?`).run(
          complete?1:0,at,scan.total??null,uids.length,at,complete?1:0,at,
          complete?'ready':'incomplete',complete?'已按可见列表完成比对。':`本轮读取 ${uids.length} / ${scan.total??'未知'}，等待完整读取；未导出本轮不确定记录。`,complete?1:0,id)
      this.db.prepare('INSERT INTO scans(account_id,at,complete,total,read_count,reason) VALUES(?,?,?,?,?,?)').run(id,at,complete?1:0,scan.total??null,uids.length,scan.reason??'unknown')
      this.db.prepare('DELETE FROM scans WHERE account_id=? AND id NOT IN (SELECT id FROM scans WHERE account_id=? ORDER BY id DESC LIMIT 100)').run(id,id)
      return {baseline:!a.baseline_at&&complete,added,complete}
    })
  }
  batches(accountId) {
    return accountId?this.db.prepare('SELECT * FROM batches WHERE account_id=? ORDER BY id DESC').all(accountId):this.db.prepare('SELECT * FROM batches ORDER BY id DESC').all()
  }
  flush({accountId=null,tail=false,fault=()=>{}}={}) {
    const created=this.transaction(()=>{
      const made=[]
      for(const a of this.accounts().filter(a=>!accountId||a.id===accountId)) {
        const rows=this.db.prepare("SELECT uid FROM followers WHERE account_id=? AND kind='new' AND batch_id IS NULL ORDER BY confirmed_at,first_seen,uid").all(a.id)
        for(let start=0;start<rows.length;start+=60) {
          const group=rows.slice(start,start+60);if(group.length<60&&!tail)break
          const at=new Date().toISOString(), stamp=chinaTime(new Date(at))
          const id=Number(this.db.prepare('INSERT INTO batches(account_id,created_at,count) VALUES(?,?,?)').run(a.id,at,group.length).lastInsertRowid)
          const relative=join(`${a.profile}_${a.owner}`,stamp.year,`${stamp.file} ${group.length}个_${String(id).padStart(4,'0')}.txt`)
          this.db.prepare('UPDATE batches SET relative_path=? WHERE id=?').run(relative,id)
          for(const {uid} of group)this.db.prepare('UPDATE followers SET batch_id=? WHERE account_id=? AND uid=? AND batch_id IS NULL').run(id,a.id,uid)
          made.push(id)
        }
      }
      return made
    })
    if(created.length)fault('reserved')
    for(const batch of this.batches(accountId)) {
      const destination=join(this.exportRoot,batch.relative_path)
      if(batch.status==='ready'&&existsSync(destination))continue
      const rows=this.db.prepare('SELECT uid FROM followers WHERE batch_id=? ORDER BY confirmed_at,first_seen,uid').all(batch.id)
      if(rows.length!==batch.count)throw Error('批次记录数量不一致，请保留数据并检查。')
      const content=rows.map(r=>r.uid).join('\r\n')+'\r\n'
      mkdirSync(dirname(destination),{recursive:true})
      if(existsSync(destination)) {
        if(readFileSync(destination,'utf8')!==content)throw Error('导出文件已被修改，未覆盖，请移走冲突文件后重试。')
      } else {
        const temp=destination+'.tmp'
        writeFileSync(temp,content,{encoding:'utf8',flush:true})
        linkSync(temp,destination)
        unlinkSync(temp)
      }
      fault('written')
      this.db.prepare("UPDATE batches SET status='ready' WHERE id=?").run(batch.id)
    }
    return created
  }
}
