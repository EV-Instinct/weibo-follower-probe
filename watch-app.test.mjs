import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright-core'
import {createWatchApp} from './watch-app.mjs'

test('一个查看账号管理多个目标：界面添加UID、底册、重新关注、设置和导出', {timeout:45000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-http-'));let round=0
  const reader={login:null,async close(){},async scanTarget(viewer,target){return {targetUid:target.uid,viewerUid:viewer.owner,uids:round++?['90000004','90000001','90000002','90000003']:['90000001','90000002','90000003','90000004'],total:4000,complete:true}}}
  const app=await createWatchApp({root,port:0,reader,autoTick:false,importLegacy:false,defaultExportRoot:join(root,'exports')})
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(async()=>{await browser.close();await app.close();rmSync(root,{recursive:true,force:true})})
  app.store.set('viewer',{profile:'viewer',owner:'80000001',status:'ready'})
  const page=await browser.newPage({viewport:{width:1280,height:820}});const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(app.address);await page.getByLabel('博主 UID').fill('90010001');await page.getByLabel('备注（可选）').fill('观察目标');await page.getByRole('button',{name:'添加监控',exact:true}).click();await page.getByText('观察目标',{exact:true}).waitFor()
  assert.equal(app.store.targets().length,1);await app.service.tick();const id=app.store.targets()[0].id;assert.equal(app.store.target(id).pending,0)
  app.service.enqueue(id);await app.service.tick();assert.equal(app.store.target(id).pending,1)
  await page.reload();await page.getByRole('button',{name:'记录与文件'}).click();await page.getByText('90000004',{exact:true}).waitFor()
  await page.getByRole('button',{name:'关闭详情'}).click();await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByLabel('导出文件夹').fill(join(root,'new-exports'));await page.getByRole('button',{name:'保存设置'}).click();assert.equal(app.store.exportRoot,join(root,'new-exports'))
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'导出尾数',exact:true}).click();await page.waitForFunction(()=>document.body.innerText.includes('导出完成'));assert.equal(app.store.batches().length,1)
  const bad=await fetch(app.address+'api/targets',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(bad.status,403)
  mkdirSync('.build',{recursive:true});await page.screenshot({path:'.build/watch-ui-desktop.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.build/watch-ui-mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[])
})
