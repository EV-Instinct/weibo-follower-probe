import test from 'node:test'
import assert from 'node:assert/strict'
import {chromium} from 'playwright-core'
import {collectTargetHead,WatchBrowser} from './watch-browser.mjs'

test('公开目标读取：登录者与目标分离，只收集顶部，排除推荐区和登录者UID',{timeout:25000},async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1400,height:950}})
  await page.route('https://weibo.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><meta charset="utf-8"><body><div role="navigation" style="height:75px"><a href="/u/80000001"><img alt="profile" style="width:30px;height:30px"></a></div><a href="/u/page/follow/90010001?relate=fans">3408粉丝</a><div class="vue-recycle-scroller ready" style="position:relative;height:6000px"></div><aside><a href="/u/70000001"><img alt="推荐"></a></aside><script>const list=document.querySelector('.vue-recycle-scroller');function paint(){const start=Math.max(0,Math.floor(-list.getBoundingClientRect().top/100)-2);list.innerHTML=Array.from({length:Math.min(15,60-start)},(_,i)=>{const n=start+i;return '<div class="wbpro-scroller-item" data-index="'+n+'" style="position:absolute;top:'+n*100+'px;height:100px"><a href="/u/'+(60000000+n)+'"><img alt="粉丝" style="width:30px;height:30px"></a></div>'}).join('')}paint();addEventListener('scroll',paint)</script></body></html>`}))
  await page.goto('https://weibo.com/');const result=await collectTargetHead(page,{owner:'80000001'},{uid:'90010001'},{limit:30,timeoutMs:15000});assert.equal(result.targetUid,'90010001');assert.equal(result.viewerUid,'80000001');assert.equal(result.total,3408);assert.ok(result.uids.length>=30);assert.equal(result.uids[0],'60000000');assert.ok(result.uids.every(u=>/^600000\d\d$/.test(u)));assert.equal(result.reason,'head-window')
  await assert.rejects(collectTargetHead(page,{owner:'80000002'},{uid:'90010001'}),/登录账号/)
})

test('极速检测：同源直连API，第1页命中哨兵立即停止翻页',{timeout:25000},async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1400,height:950}})
  const requestedPages=[]
  await page.route('https://weibo.com/**',async route=>{
    const u=new URL(route.request().url())
    if(u.pathname==='/ajax/friendships/friends'){
      const p=Number(u.searchParams.get('page')||1)
      requestedPages.push(p)
      if(p===1){
        return route.fulfill({
          contentType:'application/json; charset=utf-8',
          body:JSON.stringify({
            users:Array.from({length:20},(_,i)=>({id:10000000+i,idstr:String(10000000+i),screen_name:`fan_${i}`})),
            next_cursor:20,
            total_number:5000,
            ok:1
          })
        })
      }
      return route.fulfill({
        contentType:'application/json; charset=utf-8',
        body:JSON.stringify({
          users:Array.from({length:20},(_,i)=>({id:10000020+i,idstr:String(10000020+i),screen_name:`fan_${20+i}`})),
          next_cursor:40,
          total_number:5000,
          ok:1
        })
      })
    }
    return route.fulfill({
      contentType:'text/html; charset=utf-8',
      body:`<!doctype html><html><body><div role="navigation"><a href="/u/80000001"><img alt="p"></a></div></body></html>`
    })
  })
  await page.goto('https://weibo.com/')
  const result=await collectTargetHead(page,{owner:'80000001'},{uid:'90010001'},{
    anchors:['10000005','10000006'],
    limit:120,
    timeoutMs:15000
  })
  assert.equal(result.targetUid,'90010001')
  assert.equal(result.viewerUid,'80000001')
  assert.equal(result.reason,'anchor-hit')
  assert.equal(result.uids.length,20)
  assert.deepEqual(requestedPages,[1],'第1页命中哨兵必须立即停止翻页，不得请求page=2')
})

test('极速检测：第1页全为新粉丝未命中哨兵时继续翻至page=2命中即停',{timeout:25000},async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1400,height:950}})
  const requestedPages=[]
  await page.route('https://weibo.com/**',async route=>{
    const u=new URL(route.request().url())
    if(u.pathname==='/ajax/friendships/friends'){
      const p=Number(u.searchParams.get('page')||1)
      requestedPages.push(p)
      if(p===1){
        return route.fulfill({
          contentType:'application/json; charset=utf-8',
          body:JSON.stringify({
            users:Array.from({length:20},(_,i)=>({id:20000000+i,idstr:String(20000000+i)})),
            next_cursor:20,
            total_number:5000,
            ok:1
          })
        })
      }
      return route.fulfill({
        contentType:'application/json; charset=utf-8',
        body:JSON.stringify({
          users:Array.from({length:20},(_,i)=>({id:10000000+i,idstr:String(10000000+i)})),
          next_cursor:40,
          total_number:5000,
          ok:1
        })
      })
    }
    return route.fulfill({
      contentType:'text/html; charset=utf-8',
      body:`<!doctype html><html><body><div role="navigation"><a href="/u/80000001"><img alt="p"></a></div></body></html>`
    })
  })
  await page.goto('https://weibo.com/')
  const result=await collectTargetHead(page,{owner:'80000001'},{uid:'90010001'},{
    anchors:['10000005'],
    limit:120,
    timeoutMs:15000
  })
  assert.equal(result.reason,'anchor-hit')
  assert.equal(result.uids.length,40)
  assert.deepEqual(requestedPages,[1,2],'第1页未命中必须翻到page=2，并在page=2命中后立即停止')
})

test('WatchBrowser 常驻复用：多次检测复用同一个浏览器长连接上下文',{timeout:30000},async t=>{
  const wb=new WatchBrowser('fake-root')
  let launchCount=0,homeCount=0
  const mockPage={
    isClosed:()=>false,
    url:()=>'https://weibo.com/',
    evaluate:async()=>({ok:true,data:{users:[{idstr:'9901'}],total_number:1,next_cursor:0}}),
    locator:()=>({filter:()=>({first:()=>({})})})
  }
  const mockContext={
    pages:()=>[mockPage],
    on:()=>{},
    close:async()=>{}
  }
  wb.launch=async()=>{launchCount++;return {context:mockContext,page:mockPage}}
  wb.home=async()=>{homeCount++}
  t.after(()=>wb.close())

  const s1=await wb.getResidentSession({owner:'80000001',profile:'viewer'})
  assert.equal(launchCount,1)
  assert.equal(homeCount,1)

  const s2=await wb.getResidentSession({owner:'80000001',profile:'viewer'})
  assert.equal(s1,s2)
  assert.equal(launchCount,1)
  assert.equal(homeCount,1)
})
