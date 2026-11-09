import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WatchStore,compareHeads} from './watch-store.mjs'
import {MonitorStore} from './monitor-store.mjs'
import {createHash} from 'node:crypto'

test('顶部插入、旧粉丝重新置顶、重复扫描、头部取关分别处理',()=>{
  assert.deepEqual(compareHeads(['11','12','13','14'],['15','11','12','13']).events,['15'])
  assert.deepEqual(compareHeads(['11','12','13','14'],['14','11','12','13']).events,['14'])
  assert.deepEqual(compareHeads(['14','11','12','13'],['14','11','12','13']).events,[])
  assert.deepEqual(compareHeads(['11','12','13','14'],['12','13','14']).events,[])
  assert.equal(compareHeads(['11','12','13'],['21','22','23']).reliable,false)
  assert.equal(compareHeads(['11','12','13','14'],['11','13','12','14']).reliable,false)
})
test('事件持久化：底册不计新增、重新关注重复 UID、60 条导出和重启幂等',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-store-'));let s=new WatchStore(root)
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})
  const target=s.addTarget('9001','目标');const baseline=['101','102','103','104'];
  const ingest=(uids)=>s.ingest(target.id,{targetUid:'9001',viewerUid:'8001',uids,total:999,complete:true})
  assert.equal(ingest(baseline).added,0)
  ingest(['104','101','102','103']);assert.equal(s.target(target.id).pending,1)
  ingest(['104','101','102','103']);assert.equal(s.target(target.id).pending,1)
  ingest(['101','102','103']);ingest(['104','101','102','103']);assert.equal(s.target(target.id).pending,2)
  const more=Array.from({length:59},(_,i)=>String(200+i));ingest([...more,'104','101','102','103'])
  assert.equal(s.target(target.id).pending,61);s.flush();assert.equal(s.target(target.id).pending,1)
  const b=s.batches()[0];const lines=readFileSync(b.path,'utf8').trim().split(/\r?\n/);assert.equal(lines.length,60);assert.equal(lines.filter(x=>x==='104').length,2)
  const oldId=s.databaseId;s.close();s=new WatchStore(root);assert.equal(s.databaseId,oldId);s.flush();assert.equal(s.batches().length,1)
  assert.throws(()=>s.ingest(target.id,{targetUid:'9002',uids:baseline,complete:true}),/目标/)
  const oldHead=s.target(target.id).head;ingest(['800','801','802']);assert.deepEqual(s.target(target.id).head,oldHead);assert.equal(s.target(target.id).status,'gap')
})

test('导出预留后中断可恢复，改目录不搬运旧批次，目标之间分别累计',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-recover-'));let s=new WatchStore(root);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})
  const a=s.addTarget('90001'),b=s.addTarget('90002');for(const target of [a,b])s.ingest(target.id,{targetUid:target.uid,uids:['101','102','103'],complete:true})
  const ids=Array.from({length:60},(_,i)=>String(1000+i));s.ingest(a.id,{targetUid:a.uid,uids:[...ids,'101','102','103'],complete:true});assert.throws(()=>s.flush({fault:()=>{throw Error('crash')}}),/crash/)
  const path=s.batches()[0].path;s.close();s=new WatchStore(root);s.set('export_dir',join(root,'changed'));s.flush();assert.equal(s.batches().length,1);assert.equal(s.batches()[0].path,path);assert.equal(readFileSync(path,'utf8').trim().split(/\r?\n/).length,60);assert.equal(s.target(b.id).total_new,0)
})

test('升级只继承一个查看账号和导出路径，不改旧数据库、不把旧账号当目标',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-upgrade-'));const old=new MonitorStore(root);const a=old.addAccount('旧账号','A');old.update(a.id,{owner:'80000001'});old.setSetting('export_dir',join(root,'chosen-exports'));old.close()
  const hash=()=>createHash('sha256').update(readFileSync(join(root,'monitor.sqlite'))).digest('hex');const before=hash();const s=new WatchStore(root);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})
  assert.equal(s.get('viewer').owner,'80000001');assert.equal(s.get('viewer').profile,'A');assert.equal(s.exportRoot,join(root,'chosen-exports'));assert.equal(s.targets().length,0);assert.equal(hash(),before)
})
