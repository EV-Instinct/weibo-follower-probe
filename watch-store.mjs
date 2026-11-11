import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {mkdirSync,existsSync,readFileSync,writeFileSync,linkSync,unlinkSync} from 'node:fs'
import {join,dirname,resolve} from 'node:path'
import {chinaTime,formatExportRelativePath} from './monitor-store.mjs'

export const validTargetUid=x=>typeof x==='string'&&/^[1-9]\d{4,19}$/.test(x)
const validSampleUid=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x)

export const ANCHOR_QUEUE_LIMIT=20

// 顺位哨兵链机制（排头粉丝取关自动顺延 + 防复关误判）
// 保存上次顶部前 N 名粉丝作为有序候补哨兵队列 [哨兵1, 哨兵2, 哨兵3, ...]
// 正常情况下，新列表从顶部往下扫，命中“哨兵1”时，排在“哨兵1”前面的全部计为新增关注。
// 若“哨兵1”取消关注，自动顺延使用他后面的“哨兵2”作为截点；若“哨兵1、哨兵2”都取关，顺延到“哨兵3”。
// 防误判：若排在后面的旧哨兵（如哨兵5）重关跳到最前，而哨兵1、哨兵2仍在后面且相对顺序正常，以哨兵1为截点，将跳到前面的哨兵5正常计为重关事件。
export function compareHeads(previous,current,{maxAnchors=ANCHOR_QUEUE_LIMIT}={}){
  if(!previous||!previous.length)return {reliable:false,events:[]}
  if(!current||!current.length)return {reliable:false,events:[]}
  const anchors=previous.slice(0,maxAnchors)
  const anchorPositions=new Map(anchors.map((id,i)=>[id,i]))
  const currentPositions=new Map()
  for(let i=0;i<current.length;i++){if(!currentPositions.has(current[i]))currentPositions.set(current[i],i)}
  for(let sIdx=0;sIdx<anchors.length;sIdx++){
    const sentinel=anchors[sIdx]
    const cutPos=currentPositions.get(sentinel)
    if(cutPos===undefined)continue
    const afterElements=current.slice(cutPos+1)
    let isMonotonic=true,prevAnchorIdx=sIdx
    for(const id of afterElements){
      const pIdx=anchorPositions.get(id)
      if(pIdx!==undefined){
        if(pIdx<=prevAnchorIdx){isMonotonic=false;break}
        prevAnchorIdx=pIdx
      }
    }
    if(!isMonotonic)return {reliable:false,events:[]}
    return {reliable:true,events:current.slice(0,cutPos)}
  }
  return {reliable:false,events:[]}
}

export class WatchStore{
  constructor(root,{defaultExportRoot=join(root,'exports'),importLegacy=true}={}){
    this.root=resolve(root);mkdirSync(this.root,{recursive:true});this.file=join(this.root,'watch.sqlite')
    this.db=new DatabaseSync(this.file);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS viewers(id TEXT PRIMARY KEY,profile TEXT UNIQUE NOT NULL,owner TEXT,label TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'needs-login',message TEXT NOT NULL DEFAULT '',cooldown_until INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS targets(id TEXT PRIMARY KEY,uid TEXT UNIQUE NOT NULL,label TEXT NOT NULL,head TEXT,baseline_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,interval_minutes INTEGER NOT NULL DEFAULT 2,status TEXT NOT NULL DEFAULT 'waiting',message TEXT NOT NULL DEFAULT '',
        last_success TEXT,last_attempt TEXT,next_due INTEGER NOT NULL DEFAULT 0,total INTEGER,read_count INTEGER NOT NULL DEFAULT 0,
        adaptive INTEGER NOT NULL DEFAULT 1,consecutive_zero INTEGER NOT NULL DEFAULT 0,current_interval INTEGER NOT NULL DEFAULT 120);
      CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY AUTOINCREMENT,target_id TEXT NOT NULL REFERENCES targets(id),at TEXT NOT NULL,count INTEGER NOT NULL,path TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'reserved');
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,target_id TEXT NOT NULL REFERENCES targets(id),uid TEXT NOT NULL,at TEXT NOT NULL,batch_id INTEGER REFERENCES batches(id));
      CREATE INDEX IF NOT EXISTS pending_events ON events(target_id,batch_id,id);
      CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY AUTOINCREMENT,target_id TEXT NOT NULL REFERENCES targets(id),at TEXT NOT NULL,count INTEGER,total INTEGER,added INTEGER,status TEXT,message TEXT);`)
    try{this.db.exec('ALTER TABLE targets ADD COLUMN adaptive INTEGER NOT NULL DEFAULT 1')}catch{}
    try{this.db.exec('ALTER TABLE targets ADD COLUMN consecutive_zero INTEGER NOT NULL DEFAULT 0')}catch{}
    try{this.db.exec('ALTER TABLE targets ADD COLUMN current_interval INTEGER NOT NULL DEFAULT 120')}catch{}
    if(!this.get('database_id')){
      this.set('database_id',randomUUID());this.set('export_dir',resolve(defaultExportRoot));this.set('viewer',{profile:'viewer',owner:null,status:'needs-login',message:'请先登录你的微博账号。'})
      if(importLegacy&&existsSync(join(root,'monitor.sqlite'))){let old
        try{old=new DatabaseSync(join(root,'monitor.sqlite'),{readOnly:true});const a=old.prepare("SELECT profile,owner FROM accounts WHERE owner IS NOT NULL ORDER BY CASE WHEN profile='A' THEN 0 ELSE 1 END,rowid LIMIT 1").get();if(a&&/^[a-zA-Z0-9_-]{1,80}$/.test(a.profile))this.set('viewer',{...a,status:'ready',message:'已沿用原登录档案，检查时会验证登录状态。'});const dir=old.prepare("SELECT value FROM settings WHERE key='export_dir'").get()?.value;if(dir)this.set('export_dir',dir)}finally{old?.close()}
      }
    }
    // 自动平滑迁移旧单 viewer 配置到 viewers 表
    const viewerRows=this.db.prepare('SELECT COUNT(*) c FROM viewers').get()?.c||0
    if(viewerRows===0){
      const oldV=this.get('viewer')||{profile:'viewer',owner:null,status:'needs-login',message:'请先登录你的微博账号。'}
      this.db.prepare('INSERT INTO viewers(id,profile,owner,label,status,message,cooldown_until,created_at) VALUES(?,?,?,?,?,?,?,?)').run(
        'viewer',oldV.profile||'viewer',oldV.owner||null,oldV.label||'查看账号1',oldV.status||'needs-login',oldV.message||'请先登录你的微博账号。',0,new Date().toISOString()
      )
    }
    this.databaseId=this.get('database_id')
  }
  close(){this.db.close()}
  get(key){
    if(key==='viewer'){
      const primary=this.db.prepare('SELECT * FROM viewers ORDER BY CASE WHEN id=\'viewer\' THEN 0 ELSE 1 END,rowid LIMIT 1').get()
      if(primary)return primary
    }
    const s=this.db.prepare('SELECT value FROM config WHERE key=?').get(key)?.value
    return s?JSON.parse(s):null
  }
  set(key,value){
    this.db.prepare('INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value))
    if(key==='viewer'&&value&&typeof value==='object'){
      const primary=this.db.prepare('SELECT id FROM viewers ORDER BY CASE WHEN id=\'viewer\' THEN 0 ELSE 1 END,rowid LIMIT 1').get()
      if(primary){
        this.db.prepare('UPDATE viewers SET profile=?,owner=?,status=?,message=? WHERE id=?').run(value.profile||'viewer',value.owner||null,value.status||'needs-login',value.message||'',primary.id)
      }else{
        this.db.prepare('INSERT INTO viewers(id,profile,owner,label,status,message,cooldown_until,created_at) VALUES(?,?,?,?,?,?,?,?)').run(
          'viewer',value.profile||'viewer',value.owner||null,value.label||'查看账号1',value.status||'needs-login',value.message||'',0,new Date().toISOString()
        )
      }
    }
  }
  get exportRoot(){return this.get('export_dir')}
  assertStorageCurrent(){let disk;try{disk=new DatabaseSync(this.file,{readOnly:true});if(JSON.parse(disk.prepare("SELECT value FROM config WHERE key='database_id'").get()?.value)!==this.databaseId)throw Error()}catch{throw Error('数据库身份发生变化，请退出后重启。')}finally{disk?.close()}}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r}catch(e){this.db.exec('ROLLBACK');throw e}}
  viewers(){return this.db.prepare('SELECT * FROM viewers ORDER BY rowid').all()}
  viewer(id){const v=this.db.prepare('SELECT * FROM viewers WHERE id=?').get(id);if(!v)throw Error('找不到这个查看账号。');return v}
  addViewer(profile,label=''){
    profile=String(profile||'').trim()
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(profile))throw Error('档案名称只能包含字母、数字、下划线或连字符（1-80位）。')
    if(this.db.prepare('SELECT 1 FROM viewers WHERE profile=?').get(profile))throw Error('该浏览器档案名称已存在。')
    const id=randomUUID()
    this.db.prepare('INSERT INTO viewers(id,profile,owner,label,status,message,cooldown_until,created_at) VALUES(?,?,?,?,?,?,?,?)').run(
      id,profile,null,label.trim()||`查看账号 ${this.viewers().length+1}`,'needs-login','请在微博窗口中完成登录。',0,new Date().toISOString()
    )
    return this.viewer(id)
  }
  updateViewer(id,values){
    this.viewer(id)
    const keys=new Set(['label','owner','status','message','cooldown_until'])
    const entries=Object.entries(values).filter(([k])=>keys.has(k))
    if(!entries.length)return
    this.db.prepare(`UPDATE viewers SET ${entries.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...entries.map(([,v])=>v),id)
    const primary=this.viewers()[0]
    if(primary&&primary.id===id)this.set('viewer',primary)
  }
  removeViewer(id){
    this.viewer(id)
    const list=this.viewers()
    if(list.length<=1)throw Error('至少需要保留一个查看账号。')
    this.db.prepare('DELETE FROM viewers WHERE id=?').run(id)
    const primary=this.viewers()[0]
    if(primary)this.set('viewer',primary)
  }
  addTarget(uid,label=''){
    if(!validSampleUid(uid))throw Error('请输入正确的数字 UID。')
    if(typeof label!=='string'||label.length>80)throw Error('备注不能超过80字。')
    if(this.db.prepare('SELECT 1 FROM targets WHERE uid=?').get(uid))throw Error('这个 UID 已在监控列表中。')
    const id=randomUUID();this.db.prepare('INSERT INTO targets(id,uid,label) VALUES(?,?,?)').run(id,uid,label.trim()||uid);return this.target(id)
  }
  target(id){
    const a=this.db.prepare('SELECT * FROM targets WHERE id=?').get(id)
    if(!a)throw Error('找不到这个监控目标。')
    const counts=this.db.prepare('SELECT COUNT(*) total_new,SUM(batch_id IS NULL) pending FROM events WHERE target_id=?').get(id)
    const today=chinaTime().date
    const rows=this.db.prepare('SELECT at FROM events WHERE target_id=? AND at>=?').all(id,new Date(Date.now()-48*3600000).toISOString())
    return {
      ...a,
      head:a.head?JSON.parse(a.head):null,
      ...counts,
      pending:counts.pending||0,
      today_new:rows.filter(x=>chinaTime(new Date(x.at)).date===today).length,
      adaptive:a.adaptive??1,
      consecutive_zero:a.consecutive_zero??0,
      current_interval:a.current_interval??((a.interval_minutes||2)*60)
    }
  }
  targets(){return this.db.prepare('SELECT id FROM targets ORDER BY rowid').all().map(x=>this.target(x.id))}
  update(id,values){this.target(id);const keys=new Set(['label','enabled','interval_minutes','status','message','next_due','last_attempt','adaptive','consecutive_zero','current_interval']);const entries=Object.entries(values);if(!entries.length||entries.some(([k])=>!keys.has(k)))throw Error('无效设置。');this.db.prepare(`UPDATE targets SET ${entries.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...entries.map(([,v])=>v),id)}
  rebaseline(id){this.target(id);this.db.prepare("UPDATE targets SET head=NULL,baseline_at=NULL,status='waiting',message='等待重新建立底册；已有新增记录保留。',next_due=0 WHERE id=?").run(id)}
  remove(id){this.transaction(()=>{this.db.prepare('DELETE FROM scans WHERE target_id=?').run(id);this.db.prepare('DELETE FROM events WHERE target_id=?').run(id);this.db.prepare('DELETE FROM batches WHERE target_id=?').run(id);this.db.prepare('DELETE FROM targets WHERE id=?').run(id)})}
  ingest(id,scan){
    const a=this.target(id),at=scan.at??new Date().toISOString()
    if(scan.targetUid!==a.uid)throw Error('读取目标 UID 不一致，已拒绝记录。')
    if(!scan.complete||!Array.isArray(scan.uids)||scan.uids.some(x=>!validSampleUid(x))||!Number.isFinite(Date.parse(at)))throw Error('本轮读取不完整，已保留上一次底册。')
    const current=[...new Set(scan.uids)]
    if(!current.length&&scan.total!==0)throw Error('没有读到有效粉丝列表，本轮保留底册。')
    const comparison=a.head===null?{reliable:true,events:[]}:compareHeads(a.head,current)
    return this.transaction(()=>{
      const baseSeconds=Math.max(30,(a.interval_minutes||2)*60)
      if(!comparison.reliable&&a.status==='gap'&&current.length>0){
        const autoMsg='检测到新增断层（超速涨粉或离线），已自动更新底册恢复监控。'
        this.db.prepare('UPDATE targets SET head=?,baseline_at=COALESCE(baseline_at,?),last_success=?,status=?,message=?,last_attempt=?,total=?,read_count=?,consecutive_zero=0,current_interval=? WHERE id=?').run(
          JSON.stringify(current),at,at,'ready',autoMsg,at,scan.total??null,current.length,baseSeconds,id
        )
        this.db.prepare('INSERT INTO scans(target_id,at,count,total,added,status,message) VALUES(?,?,?,?,?,?,?)').run(
          id,at,current.length,scan.total??null,0,'ready','检测到断层，已自动重置底册接续监控'
        )
        return {added:0,baseline:false,complete:true,current_interval:baseSeconds,consecutive_zero:0}
      }
      const added=comparison.reliable?comparison.events.length:0,status=comparison.reliable?'ready':'gap'
      const message=!comparison.reliable?'顶部列表与上次无法可靠衔接，暂不计数；可重试，或重新建立底册。':a.head===null?'已建立顶部底册，现有粉丝不计新增。':`本轮新增 ${added} 条关注记录。`
      let consecutiveZero=a.consecutive_zero||0
      let currentInterval=a.current_interval||(a.interval_minutes*60)
      if(comparison.reliable){
        if(a.adaptive){
          const totalChanged=a.total!==null&&scan.total!==null&&scan.total!==a.total
          if(a.head===null){
            consecutiveZero=0
            currentInterval=baseSeconds
          }else if(added>0||totalChanged){
            consecutiveZero=0
            currentInterval=Math.min(30,baseSeconds)
          }else{
            consecutiveZero+=1
            if(consecutiveZero<3)currentInterval=baseSeconds
            else if(consecutiveZero<6)currentInterval=Math.max(baseSeconds,240)
            else if(consecutiveZero<10)currentInterval=Math.max(baseSeconds,360)
            else currentInterval=Math.max(baseSeconds,600)
          }
        }else{
          currentInterval=baseSeconds
          consecutiveZero=added===0?consecutiveZero+1:0
        }
        for(const uid of [...comparison.events].reverse())this.db.prepare('INSERT INTO events(target_id,uid,at) VALUES(?,?,?)').run(id,uid,at);
        this.db.prepare('UPDATE targets SET head=?,baseline_at=COALESCE(baseline_at,?),last_success=?,consecutive_zero=?,current_interval=? WHERE id=?').run(JSON.stringify(current),at,at,consecutiveZero,currentInterval,id)
      }
      this.db.prepare('UPDATE targets SET status=?,message=?,last_attempt=?,total=?,read_count=? WHERE id=?').run(status,message,at,scan.total??null,current.length,id)
      this.db.prepare('INSERT INTO scans(target_id,at,count,total,added,status,message) VALUES(?,?,?,?,?,?,?)').run(id,at,current.length,scan.total??null,added,status,message)
      return {added,baseline:a.head===null,complete:comparison.reliable,current_interval:currentInterval,consecutive_zero:consecutiveZero}
    })
  }
  batches(id=null){return id?this.db.prepare('SELECT * FROM batches WHERE target_id=? ORDER BY id DESC').all(id):this.db.prepare('SELECT * FROM batches ORDER BY id DESC').all()}
  detail(id){return {target:this.target(id),events:this.db.prepare('SELECT * FROM events WHERE target_id=? ORDER BY id DESC LIMIT 200').all(id),batches:this.batches(id),scans:this.db.prepare('SELECT * FROM scans WHERE target_id=? ORDER BY id DESC LIMIT 30').all(id)}}
  flush({targetId=null,tail=false,fault=()=>{}}={}){
    const created=this.transaction(()=>{const ids=[];for(const a of targetId?[this.target(targetId)]:this.targets()){
      const pending=this.db.prepare('SELECT id FROM events WHERE target_id=? AND batch_id IS NULL ORDER BY id').all(a.id)
      for(let start=0;start<pending.length;start+=60){const group=pending.slice(start,start+60);if(group.length<60&&!tail)break;const at=new Date().toISOString();const id=Number(this.db.prepare('INSERT INTO batches(target_id,at,count) VALUES(?,?,?)').run(a.id,at,group.length).lastInsertRowid);const relative=formatExportRelativePath({account:{label:a.label,owner:a.uid},count:group.length,at,store:this,exportRoot:this.exportRoot});const path=join(this.exportRoot,relative);this.db.prepare('UPDATE batches SET path=? WHERE id=?').run(path,id);for(const e of group)this.db.prepare('UPDATE events SET batch_id=? WHERE id=?').run(id,e.id);ids.push(id)}
    }return ids});if(created.length)fault('reserved')
    let lastError=null
    for(const b of this.batches(targetId)){
      if(b.status==='ready'&&existsSync(b.path))continue;
      try{
        const rows=this.db.prepare('SELECT uid FROM events WHERE batch_id=? ORDER BY id').all(b.id);
        if(rows.length!==b.count)throw Error('导出批次记录不一致，请保留数据。');
        const body=rows.map(r=>`https://weibo.com/u/${r.uid}`).join('\r\n')+'\r\n';
        mkdirSync(dirname(b.path),{recursive:true});
        if(existsSync(b.path)){
          if(readFileSync(b.path,'utf8')!==body)throw Error('导出文件同名冲突，已有文件未覆盖。')
        }else{
          const tmp=b.path+'.'+randomUUID()+'.tmp';
          writeFileSync(tmp,body,{encoding:'utf8',flag:'wx'});
          try{linkSync(tmp,b.path)}finally{unlinkSync(tmp)}
        }
        fault('written');
        this.db.prepare("UPDATE batches SET status='ready' WHERE id=?").run(b.id)
      }catch(e){
        lastError=e
      }
    }
    if(lastError&&targetId)throw lastError
    if(lastError&&!created.length)throw lastError
    return created
  }
}
