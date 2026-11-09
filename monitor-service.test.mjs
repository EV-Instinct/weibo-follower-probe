import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MonitorStore } from './monitor-store.mjs'
import { MonitorService } from './monitor-service.mjs'

test('50账号串行轮询，错误隔离，暂停和重新入队不重叠',async t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-schedule-')),store=new MonitorStore(root)
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
  let active=0,maxActive=0,calls=0
  const reader={async scan(a){active++;maxActive=Math.max(maxActive,active);calls++;await new Promise(r=>setTimeout(r,1));active--;
    if(a.label==='账号3')throw Error('需要重新登录。')
    return {owner:String(1000000000+Number(a.label.slice(2))),uids:[],total:0,complete:true,reason:'visible-complete'}},async close(){}}
  const service=new MonitorService(store,reader)
  const accounts=Array.from({length:50},(_,i)=>store.addAccount(`账号${i}`))
  for(const a of accounts)store.update(a.id,{enabled:1})
  await Promise.all([service.tick(),service.tick(),service.tick()])
  for(let i=0;i<49;i++)await service.tick()
  assert.equal(calls,50);assert.equal(maxActive,1)
  assert.equal(store.account(accounts[3].id).status,'needs-login')
  assert.equal(store.account(accounts[3].id).enabled,0)
  assert.ok(store.account(accounts[49].id).baseline_at)
  service.enqueue(accounts[0].id);service.enqueue(accounts[0].id)
  await service.tick();assert.equal(calls,51)
  service.enqueue(accounts[1].id);service.pause(accounts[1].id)
  await service.tick();assert.equal(calls,51)
})
