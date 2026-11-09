import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WatchStore,compareHeads} from './watch-store.mjs'

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
