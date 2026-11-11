import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright-core'
import {createWatchApp} from './watch-app.mjs'

test('多查看账号池与批量目标监控UI：单号与批量添加、筛选搜索、批量操作、设置与双分辨率无报错', {timeout:45000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-http-'));let round=0
  const reader={
    login:null,
    async close(){},
    async scanTarget(viewer,target){
      return {targetUid:target.uid,viewerUid:viewer.owner,uids:round++?['90000004','90000001','90000002','90000003']:['90000001','90000002','90000003','90000004'],total:4000,complete:true}
    }
  }
  const app=await createWatchApp({root,port:0,reader,autoTick:false,importLegacy:false,defaultExportRoot:join(root,'exports')})
  const browser=await chromium.launch({channel:'msedge',headless:true})
  t.after(async()=>{await browser.close();await app.close();rmSync(root,{recursive:true,force:true})})
  
  app.store.set('viewer',{profile:'viewer',owner:'80000001',status:'ready',label:'查看主账号'})
  const page=await browser.newPage({viewport:{width:1280,height:820}})
  const errors=[]
  page.on('pageerror',e=>errors.push(e.message))

  await page.goto(app.address)

  // 1. 单个添加监控
  await page.getByLabel('博主 UID').fill('90010001')
  await page.getByLabel('备注（可选）').fill('观察目标1')
  await page.getByRole('button',{name:'添加监控',exact:true}).click()
  await page.getByText('观察目标1',{exact:true}).waitFor()
  assert.equal(app.store.targets().length,1)

  // 2. 批量添加监控
  await page.getByRole('button',{name:'批量添加监控'}).click()
  await page.locator('#batchText').fill('90010002 观察目标2\n90010003 观察目标3\n90010001 重复目标跳过')
  await page.getByRole('button',{name:'确认批量导入'}).click()
  await page.waitForFunction(()=>document.body.innerText.includes('批量导入完成'))
  assert.equal(app.store.targets().length,3)
  await page.getByText('观察目标2',{exact:true}).waitFor()

  // 3. 搜索与筛选
  await page.locator('#searchInput').fill('目标2')
  await page.waitForFunction(()=>document.querySelectorAll('.target').length===1)
  await page.locator('#searchInput').fill('')
  await page.waitForFunction(()=>document.querySelectorAll('.target').length===3)

  // 4. 读底册与新增生成
  await app.service.tick()
  const id=app.store.targets()[0].id
  assert.equal(app.store.target(id).pending,0)
  app.service.enqueue(id)
  await app.service.tick()
  assert.equal(app.store.target(id).pending,1)

  // 5. 详情查看
  await page.reload()
  await page.locator('.target').first().getByRole('button',{name:'记录与文件'}).click()
  await page.getByText('90000004',{exact:true}).waitFor()
  await page.getByRole('button',{name:'关闭详情'}).click()

  // 6. 批量操作：全部暂停与全部开始
  await page.getByRole('button',{name:'一键全部暂停'}).click()
  await page.waitForFunction(()=>document.body.innerText.includes('已暂停全部 3 个'))
  assert.ok(app.store.targets().every(t=>!t.enabled))

  await page.getByRole('button',{name:'一键全部开始'}).click()
  await page.waitForFunction(()=>document.body.innerText.includes('已启动全部 3 个'))
  assert.ok(app.store.targets().every(t=>t.enabled))

  // 7. 一键导出所有尾数与打开导出文件夹
  page.once('dialog',d=>d.accept())
  await page.getByRole('button',{name:'一键导出所有尾数'}).click()
  await page.waitForFunction(()=>document.body.innerText.includes('生成文件'))
  assert.equal(app.store.batches().length,1)

  // 测试点击“打开导出文件夹”
  await page.locator('#folder').click()
  await page.waitForFunction(()=>document.body.innerText.includes('已打开导出文件夹'))

  // 8. 设置修改
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await page.getByLabel('导出文件夹').fill(join(root,'new-exports'))
  await page.getByRole('button',{name:'保存设置'}).click()
  assert.equal(app.store.exportRoot,join(root,'new-exports'))

  // 9. CSRF 防护与接口参数校验
  const bad=await fetch(app.address+'api/targets',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})
  assert.equal(bad.status,403)

  // 验证死按钮 #login 已被移除
  assert.equal(await page.$('#login'),null)

  // 验证批量修改间隔非法值返回 400
  const csrfToken=await page.evaluate(()=>document.querySelector('meta[name="csrf-token"]').content)
  const badBatch=await fetch(app.address+'api/targets/batch-action',{
    method:'POST',
    headers:{Origin:app.address.slice(0,-1),'Content-Type':'application/json','x-csrf-token':csrfToken},
    body:JSON.stringify({action:'settings',interval_minutes:0})
  })
  assert.equal(badBatch.status,400)

  // 10. 双视口截图与横向无溢出验证
  mkdirSync('.build',{recursive:true})
  await page.screenshot({path:'.build/watch-ui-desktop.png'})
  await page.setViewportSize({width:390,height:844})
  await page.screenshot({path:'.build/watch-ui-mobile.png'})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  assert.deepEqual(errors,[])
})
