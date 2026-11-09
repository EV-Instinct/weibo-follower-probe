import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {mkdirSync,existsSync,readFileSync,writeFileSync,linkSync,unlinkSync} from 'node:fs'
import {join,dirname,resolve} from 'node:path'
import {chinaTime,formatExportRelativePath} from './monitor-store.mjs'

export const validTargetUid=x=>typeof x==='string'&&/^[1-9]\d{4,19}$/.test(x)
const validSampleUid=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x)

// An unchanged ordered suffix anchors new head entries. A known UID moved ahead
// of this suffix is an observed re-follow, not permanently excluded by history.
export function compareHeads(previous,current){
  if(!previous.length)return {reliable:true,events:current}
  const positions=new Map(previous.map((id,i)=>[id,i]))
  const common=current.map((id,i)=>({id,i,p:positions.get(id)})).filter(x=>x.p!==undefined)
  if(!common.length)return {reliable:false,events:[]}
  const length=Array(common.length).fill(1)
  for(let i=common.length-1;i>=0;i--)for(let j=i+1;j<common.length;j++)if(common[j].p>common[i].p)length[i]=Math.max(length[i],1+length[j])
  const best=Math.max(...length),first=length.indexOf(best),suffix=common.slice(first)
  if(best<Math.min(3,previous.length)||suffix.some((x,i)=>i&&x.p<=suffix[i-1].p))return {reliable:false,events:[]}
  return {reliable:true,events:current.slice(0,common[first].i)}
}

export class WatchStore{
  constructor(root,{defaultExportRoot=join(root,'exports'),importLegacy=true}={}){
    this.root=resolve(root);mkdirSync(this.root,{recursive:true});this.file=join(this.root,'watch.sqlite')
    this.db=new DatabaseSync(this.file);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS targets(id TEXT PRIMARY KEY,uid TEXT UNIQUE NOT NULL,label TEXT NOT NULL,head TEXT,baseline_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,interval_minutes INTEGER NOT NULL DEFAULT 2,status TEXT NOT NULL DEFAULT 'waiting',message TEXT NOT NULL DEFAULT '',
        last_success TEXT,last_attempt TEXT,next_due INTEGER NOT NULL DEFAULT 0,total INTEGER,read_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY AUTOINCREMENT,target_id TEXT NOT NULL REFERENCES targets(id),at TEXT NOT NULL,count INTEGER NOT NULL,path TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'reserved');
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,target_id TEXT NOT NULL REFERENCES targets(id),uid TEXT NOT NULL,at TEXT NOT NULL,batch_id INTEGER REFERENCES batches(id));
      CREATE INDEX IF NOT EXISTS pending_events ON events(target_id,batch_id,id);
      CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY AUTOINCREMENT,target_id TEXT NOT NULL REFERENCES targets(id),at TEXT NOT NULL,count INTEGER,total INTEGER,added INTEGER,status TEXT,message TEXT);`)
    if(!this.get('database_id')){
      this.set('database_id',randomUUID());this.set('export_dir',resolve(defaultExportRoot));this.set('viewer',{profile:'viewer',owner:null,status:'needs-login',message:'请先登录你的微博账号。'})
      if(importLegacy&&existsSync(join(root,'monitor.sqlite'))){let old
        try{old=new DatabaseSync(join(root,'monitor.sqlite'),{readOnly:true});const a=old.prepare("SELECT profile,owner FROM accounts WHERE owner IS NOT NULL ORDER BY CASE WHEN profile='A' THEN 0 ELSE 1 END,rowid LIMIT 1").get();if(a&&/^[a-zA-Z0-9_-]{1,80}$/.test(a.profile))this.set('viewer',{...a,status:'ready',message:'已沿用原登录档案，检查时会验证登录状态。'});const dir=old.prepare("SELECT value FROM settings WHERE key='export_dir'").get()?.value;if(dir)this.set('export_dir',dir)}finally{old?.close()}
      }
    }
    this.databaseId=this.get('database_id')
  }
  close(){this.db.close()}
  get(key){const s=this.db.prepare('SELECT value FROM config WHERE key=?').get(key)?.value;return s?JSON.parse(s):null}
  set(key,value){this.db.prepare('INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value))}
  get exportRoot(){return this.get('export_dir')}
  assertStorageCurrent(){let disk;try{disk=new DatabaseSync(this.file,{readOnly:true});if(JSON.parse(disk.prepare("SELECT value FROM config WHERE key='database_id'").get()?.value)!==this.databaseId)throw Error()}catch{throw Error('数据库身份发生变化，请退出后重启。')}finally{disk?.close()}}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r}catch(e){this.db.exec('ROLLBACK');throw e}}
  addTarget(uid,label=''){
    if(!validSampleUid(uid))throw Error('请输入正确的数字 UID。')
    if(typeof label!=='string'||label.length>80)throw Error('备注不能超过80字。')
    if(this.db.prepare('SELECT 1 FROM targets WHERE uid=?').get(uid))throw Error('这个 UID 已在监控列表中。')
    const id=randomUUID();this.db.prepare('INSERT INTO targets(id,uid,label) VALUES(?,?,?)').run(id,uid,label.trim()||uid);return this.target(id)
  }
  target(id){const a=this.db.prepare('SELECT * FROM targets WHERE id=?').get(id);if(!a)throw Error('找不到这个监控目标。');const counts=this.db.prepare('SELECT COUNT(*) total_new,SUM(batch_id IS NULL) pending FROM events WHERE target_id=?').get(id);const today=chinaTime().date;const rows=this.db.prepare('SELECT at FROM events WHERE target_id=? AND at>=?').all(id,new Date(Date.now()-48*3600000).toISOString());return {...a,head:a.head?JSON.parse(a.head):null,...counts,pending:counts.pending||0,today_new:rows.filter(x=>chinaTime(new Date(x.at)).date===today).length}}
  targets(){return this.db.prepare('SELECT id FROM targets ORDER BY rowid').all().map(x=>this.target(x.id))}
  update(id,values){this.target(id);const keys=new Set(['label','enabled','interval_minutes','status','message','next_due','last_attempt']);const entries=Object.entries(values);if(!entries.length||entries.some(([k])=>!keys.has(k)))throw Error('无效设置。');this.db.prepare(`UPDATE targets SET ${entries.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...entries.map(([,v])=>v),id)}
  rebaseline(id){this.target(id);this.db.prepare("UPDATE targets SET head=NULL,baseline_at=NULL,status='waiting',message='等待重新建立底册；已有新增记录保留。',next_due=0 WHERE id=?").run(id)}
  remove(id){this.transaction(()=>{this.db.prepare('DELETE FROM scans WHERE target_id=?').run(id);this.db.prepare('DELETE FROM events WHERE target_id=?').run(id);this.db.prepare('DELETE FROM batches WHERE target_id=?').run(id);this.db.prepare('DELETE FROM targets WHERE id=?').run(id)})}
  ingest(id,scan){
    const a=this.target(id),at=scan.at??new Date().toISOString()
    if(scan.targetUid!==a.uid)throw Error('读取目标 UID 不一致，已拒绝记录。')
    if(!scan.complete||!Array.isArray(scan.uids)||scan.uids.some(x=>!validSampleUid(x))||!Number.isFinite(Date.parse(at)))throw Error('本轮读取不完整，已保留上一次底册。')
    const current=[...new Set(scan.uids)],comparison=a.head===null?{reliable:true,events:[]}:compareHeads(a.head,current)
    return this.transaction(()=>{
      const added=comparison.reliable?comparison.events.length:0,status=comparison.reliable?'ready':'gap'
      const message=!comparison.reliable?'顶部列表与上次无法可靠衔接，暂不计数；可重试，或重新建立底册。':a.head===null?'已建立顶部底册，现有粉丝不计新增。':`本轮新增 ${added} 条关注记录。`
      if(comparison.reliable){for(const uid of [...comparison.events].reverse())this.db.prepare('INSERT INTO events(target_id,uid,at) VALUES(?,?,?)').run(id,uid,at);this.db.prepare('UPDATE targets SET head=?,baseline_at=COALESCE(baseline_at,?),last_success=? WHERE id=?').run(JSON.stringify(current),at,at,id)}
      this.db.prepare('UPDATE targets SET status=?,message=?,last_attempt=?,total=?,read_count=? WHERE id=?').run(status,message,at,scan.total??null,current.length,id)
      this.db.prepare('INSERT INTO scans(target_id,at,count,total,added,status,message) VALUES(?,?,?,?,?,?,?)').run(id,at,current.length,scan.total??null,added,status,message)
      return {added,baseline:a.head===null,complete:comparison.reliable}
    })
  }
  batches(id=null){return id?this.db.prepare('SELECT * FROM batches WHERE target_id=? ORDER BY id DESC').all(id):this.db.prepare('SELECT * FROM batches ORDER BY id DESC').all()}
  detail(id){return {target:this.target(id),events:this.db.prepare('SELECT * FROM events WHERE target_id=? ORDER BY id DESC LIMIT 200').all(id),batches:this.batches(id),scans:this.db.prepare('SELECT * FROM scans WHERE target_id=? ORDER BY id DESC LIMIT 30').all(id)}}
  flush({targetId=null,tail=false,fault=()=>{}}={}){
    const created=this.transaction(()=>{const ids=[];for(const a of targetId?[this.target(targetId)]:this.targets()){
      const pending=this.db.prepare('SELECT id FROM events WHERE target_id=? AND batch_id IS NULL ORDER BY id').all(a.id)
      for(let start=0;start<pending.length;start+=60){const group=pending.slice(start,start+60);if(group.length<60&&!tail)break;const at=new Date().toISOString();const id=Number(this.db.prepare('INSERT INTO batches(target_id,at,count) VALUES(?,?,?)').run(a.id,at,group.length).lastInsertRowid);const relative=formatExportRelativePath({account:{label:a.label,owner:a.uid},count:group.length,at,exportRoot:this.exportRoot});const base=join(this.exportRoot,relative);const path=base.replace(/\.txt$/,`_${id}.txt`);this.db.prepare('UPDATE batches SET path=? WHERE id=?').run(path,id);for(const e of group)this.db.prepare('UPDATE events SET batch_id=? WHERE id=?').run(id,e.id);ids.push(id)}
    }return ids});if(created.length)fault('reserved')
    for(const b of this.batches(targetId)){if(b.status==='ready'&&existsSync(b.path))continue;const rows=this.db.prepare('SELECT uid FROM events WHERE batch_id=? ORDER BY id').all(b.id);if(rows.length!==b.count)throw Error('导出批次记录不一致，请保留数据。');const body=rows.map(r=>r.uid).join('\r\n')+'\r\n';mkdirSync(dirname(b.path),{recursive:true});if(existsSync(b.path)){if(readFileSync(b.path,'utf8')!==body)throw Error('导出文件同名冲突，已有文件未覆盖。')}else{const tmp=b.path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,body,{encoding:'utf8',flag:'wx'});try{linkSync(tmp,b.path)}finally{unlinkSync(tmp)}}fault('written');this.db.prepare("UPDATE batches SET status='ready' WHERE id=?").run(b.id)}
    return created
  }
}
