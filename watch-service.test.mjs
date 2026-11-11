import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WatchStore} from './watch-store.mjs'
import {WatchService} from './watch-service.mjs'

test('同一查看账号串行读取、登录失效保留底册、目标之间记录隔离',async t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-service-'));const s=new WatchStore(root);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})});s.set('viewer',{owner:'80001',profile:'viewer',status:'ready'})
  const a=s.addTarget('90001'),b=s.addTarget('90002');let reading=0,max=0,fail=false;const reader={async scanTarget(viewer,target){reading++;max=Math.max(max,reading);await new Promise(r=>setTimeout(r,10));reading--;if(fail)throw Error('登录已失效。');return {viewerUid:viewer.owner,targetUid:target.uid,uids:['101','102','103'],total:500,complete:true}},async close(){}}
  const service=new WatchService(s,reader);await Promise.all([service.tick(),service.tick(),service.tick()]);await service.tick();assert.equal(max,1);assert.ok(s.target(a.id).baseline_at);assert.ok(s.target(b.id).baseline_at);assert.equal(s.target(a.id).pending,0)
  fail=true;service.enqueue(a.id);await service.tick();assert.equal(s.get('viewer').status,'needs-login');assert.deepEqual(s.target(a.id).head,['101','102','103']);assert.equal(s.target(b.id).pending,0);await service.close()
})

test('多查看账号池分流调度：多账号并行分流、单账号严格串行',async t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-pool-'))
  const s=new WatchStore(root)
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})

  // 配置两个已就绪的查看账号
  s.set('viewer',{owner:'80001',profile:'viewer_1',status:'ready'})
  const v2=s.addViewer('viewer_2','账号2')
  s.updateViewer(v2.id,{owner:'80002',status:'ready'})

  const t1=s.addTarget('90001'),t2=s.addTarget('90002')
  let currentConcurrency=0,maxConcurrency=0
  const scannedBy=new Map()

  const reader={
    async scanTarget(viewer,target){
      currentConcurrency++
      maxConcurrency=Math.max(maxConcurrency,currentConcurrency)
      if(!scannedBy.has(viewer.id))scannedBy.set(viewer.id,[])
      scannedBy.get(viewer.id).push(target.uid)
      await new Promise(r=>setTimeout(r,50))
      currentConcurrency--
      return {viewerUid:viewer.owner,targetUid:target.uid,uids:['101','102'],total:100,complete:true}
    },
    async close(){}
  }

  const service=new WatchService(s,reader)
  await service.tick()

  // 验证多账号之间并行分流，最大并发数达到 2
  assert.equal(maxConcurrency,2)
  assert.equal(scannedBy.size,2)
  assert.ok(s.target(t1.id).baseline_at)
  assert.ok(s.target(t2.id).baseline_at)
  await service.close()
})

test('故障自动转移（Failover）：单账号受限仅隔离自身，目标由池中其他账号无缝接管不停摆',async t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-failover-'))
  const s=new WatchStore(root)
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})

  s.set('viewer',{owner:'80001',profile:'viewer_1',status:'ready'})
  const v2=s.addViewer('viewer_2','账号2')
  s.updateViewer(v2.id,{owner:'80002',status:'ready'})

  const target=s.addTarget('90001','关键目标')
  let failA=true

  const reader={
    async scanTarget(viewer,tObj){
      if(viewer.owner==='80001'&&failA){
        throw Error('访问频繁受限，请输入验证码。')
      }
      return {viewerUid:viewer.owner,targetUid:tObj.uid,uids:['101','102'],total:200,complete:true}
    },
    async closeViewerSession(){},
    async close(){}
  }

  const service=new WatchService(s,reader)

  // 第 1 轮 tick：账号1受限
  await service.tick()

  // 账号1被冷却隔离
  const v1=s.viewers().find(v=>v.owner==='80001')
  assert.equal(v1.status,'blocked')
  assert.ok(v1.cooldown_until>Date.now())

  // 监控目标未被停摆60分钟，而是自动放回就绪队列等待其他账号接管
  const tState=s.target(target.id)
  assert.notEqual(tState.status,'blocked')
  assert.equal(tState.next_due,0)

  // 第 2 轮 tick：账号2自动无缝接管并成功读取
  await service.tick()
  const tAfter=s.target(target.id)
  assert.equal(tAfter.status,'ready')
  assert.ok(tAfter.baseline_at)

  await service.close()
})
