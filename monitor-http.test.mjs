import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createMonitorApp } from './monitor-app.mjs'

test('管理界面添加账号、检查、批次下载及跨站请求防护', {timeout:30000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-ui-'))
  const reader={login:null,async scan(){return {owner:'1234567890',uids:[],total:0,complete:true,reason:'visible-complete'}},async close(){}}
  const app=await createMonitorApp({root,port:0,reader,importProfiles:false,autoTick:false})
  const browser=await chromium.launch({channel:'msedge',headless:true})
  t.after(async()=>{await browser.close();await app.close();rmSync(root,{recursive:true,force:true})})
  const page=await browser.newPage({viewport:{width:1280,height:800}}), errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto(app.address)
  await page.getByRole('button',{name:'添加账号',exact:true}).click()
  await page.getByLabel('账号备注').fill('测试账号')
  await page.getByRole('button',{name:'保存账号',exact:true}).click()
  await page.getByRole('row').filter({hasText:'测试账号'}).waitFor()
  const a=app.store.accounts()[0]
  await page.getByRole('button',{name:'检查一次',exact:true}).click()
  await page.waitForTimeout(100)
  await app.service.tick()
  assert.ok(app.store.account(a.id).baseline_at)
  app.store.ingest(a.id,{owner:'1234567890',uids:Array.from({length:60},(_,i)=>String(2000000000+i)),total:60,complete:true,reason:'visible-complete'})
  app.store.flush()
  await page.reload()
  await page.getByRole('button',{name:'导出记录',exact:true}).click()
  const download=page.waitForEvent('download')
  await page.getByRole('link',{name:'下载文件',exact:true}).click()
  assert.match((await download).suggestedFilename(),/60个/)
  const batch=app.store.batches()[0]
  const file=await fetch(app.address+`api/batches/${batch.id}/file`)
  assert.equal((await file.text()).trim().split(/\r?\n/).length,60)
  const denied=await fetch(app.address+'api/accounts',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:'{"label":"bad"}'})
  assert.equal(denied.status,403)
  assert.equal(app.store.accounts().length,1)
  assert.deepEqual(errors,[])
})
