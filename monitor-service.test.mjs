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

test('随机间隔范围：10分钟浮动 ±20%（8～12分钟）', async t => {
  const root = mkdtempSync(join(tmpdir(), 'weibo-jitter-')), store = new MonitorStore(root)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const a = store.addAccount('浮动测试', 'A')
  store.update(a.id, { enabled: 1, interval_minutes: 10 })

  const reader = {
    async scan() {
      return { owner: '1234567890', uids: ['1000000001'], total: 1, complete: true, reason: 'visible-end' }
    },
    async close() {}
  }
  const service = new MonitorService(store, reader, { minDelay: 0, maxDelay: 0 })

  const results = []
  for (let i = 0; i < 50; i++) {
    const before = Date.now()
    service.enqueue(a.id)
    await service.tick()
    const after = Date.now()
    const acc = store.account(a.id)
    const diff = acc.next_due - before
    // 10 分钟 = 600,000 ms; ±20% 范围为 [480,000, 720,000] ms
    assert.ok(diff >= 479000, `diff too small: ${diff}`)
    assert.ok(diff <= 721000, `diff too large: ${diff}`)
    results.push(diff)
  }
  // 浮动具有随机性（最小值与最大值不同）
  const min = Math.min(...results)
  const max = Math.max(...results)
  assert.ok(max - min > 50000, `jitter variance should exist: min=${min}, max=${max}`)
})

test('遇到验证码或访问限制停 60 分钟，连续 3 次设为「需要处理」并停止自动检查', async t => {
  const root = mkdtempSync(join(tmpdir(), 'weibo-block-')), store = new MonitorStore(root)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const a = store.addAccount('风控测试', 'A')
  store.update(a.id, { enabled: 1 })

  let callCount = 0
  const reader = {
    async scan() {
      callCount++
      throw new Error('出现验证码或访问限制，请在页面处理。')
    },
    async close() {}
  }
  const service = new MonitorService(store, reader, { minDelay: 0, maxDelay: 0 })

  // 第 1 次被拦截
  const t1 = Date.now()
  service.enqueue(a.id)
  await service.tick()
  let acc = store.account(a.id)
  assert.equal(acc.status, 'blocked')
  assert.equal(acc.blocked_count, 1)
  assert.equal(acc.enabled, 1) // 保持启用以等待 60 分钟后重试
  assert.ok(acc.next_due >= t1 + 59 * 60 * 1000 && acc.next_due <= t1 + 61 * 60 * 1000)

  // 第 2 次被拦截
  const t2 = Date.now()
  service.enqueue(a.id)
  await service.tick()
  acc = store.account(a.id)
  assert.equal(acc.status, 'blocked')
  assert.equal(acc.blocked_count, 2)
  assert.equal(acc.enabled, 1)

  // 第 3 次被拦截 -> 变为 needs-action，停止自动检查 (enabled = 0)
  service.enqueue(a.id)
  await service.tick()
  acc = store.account(a.id)
  assert.equal(acc.status, 'needs-action')
  assert.equal(acc.blocked_count, 3)
  assert.equal(acc.enabled, 0)
  assert.match(acc.message, /连续3次/)
})

test('全局设置「同时读取账号数」1～3 并发调度与随机间隔设置', async t => {
  const root = mkdtempSync(join(tmpdir(), 'weibo-concur-')), store = new MonitorStore(root)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })

  store.setSetting('concurrency', '3')
  assert.equal(store.getSetting('concurrency'), '3')

  let active = 0, peakActive = 0
  const reader = {
    async scan() {
      active++
      peakActive = Math.max(peakActive, active)
      await new Promise(r => setTimeout(r, 20))
      active--
      return { owner: '1234567890', uids: [], total: 0, complete: true, reason: 'visible-end' }
    },
    async close() {}
  }

  const service = new MonitorService(store, reader, { minDelay: 0, maxDelay: 0 })
  assert.equal(service.concurrency, 3)

  const accounts = Array.from({ length: 3 }, (_, i) => store.addAccount(`并发${i}`))
  for (const acc of accounts) store.update(acc.id, { enabled: 1 })

  await service.tick()
  assert.equal(peakActive, 3) // 3 个账号同时执行！
})

test('Windows 通知限频：同一账号进入需要登录/处理时 1 小时内只提醒一次', async t => {
  const root = mkdtempSync(join(tmpdir(), 'weibo-notify-')), store = new MonitorStore(root)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const a = store.addAccount('提醒测试')
  store.update(a.id, { enabled: 1 })

  const reader = {
    async scan() { throw Error('登录已失效，请重新登录') },
    async close() {}
  }
  const service = new MonitorService(store, reader, { minDelay: 0, maxDelay: 0 })

  // 第一次触发
  service.enqueue(a.id)
  await service.tick()
  assert.equal(store.account(a.id).status, 'needs-login')
  const firstNoticeTime = service.lastNotified.get(a.id)
  assert.ok(firstNoticeTime)

  // 立即再次触发（模拟再次检测）
  service.enqueue(a.id)
  await service.tick()
  // 时间戳未变，说明 1 小时内被防抖限频
  assert.equal(service.lastNotified.get(a.id), firstNoticeTime)

  // 模拟过了 1 小时之后再次触发
  service.lastNotified.set(a.id, Date.now() - 3601 * 1000)
  service.enqueue(a.id)
  await service.tick()
  assert.ok(service.lastNotified.get(a.id) > firstNoticeTime)
})
