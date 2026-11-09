import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
