import test from 'node:test'
import assert from 'node:assert/strict'
import {chromium} from 'playwright-core'
import {collectTargetHead} from './watch-browser.mjs'

test('公开目标读取：登录者与目标分离，只收集顶部，排除推荐区和登录者UID',{timeout:25000},async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1400,height:950}})
  await page.route('https://weibo.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><meta charset="utf-8"><body><div role="navigation" style="height:75px"><a href="/u/80000001"><img alt="profile" style="width:30px;height:30px"></a></div><a href="/u/page/follow/90010001?relate=fans">3408粉丝</a><div class="vue-recycle-scroller ready" style="position:relative;height:6000px"></div><aside><a href="/u/70000001"><img alt="推荐"></a></aside><script>const list=document.querySelector('.vue-recycle-scroller');function paint(){const start=Math.max(0,Math.floor(-list.getBoundingClientRect().top/100)-2);list.innerHTML=Array.from({length:Math.min(15,60-start)},(_,i)=>{const n=start+i;return '<div class="wbpro-scroller-item" data-index="'+n+'" style="position:absolute;top:'+n*100+'px;height:100px"><a href="/u/'+(60000000+n)+'"><img alt="粉丝" style="width:30px;height:30px"></a></div>'}).join('')}paint();addEventListener('scroll',paint)</script></body></html>`}))
  await page.goto('https://weibo.com/');const result=await collectTargetHead(page,{owner:'80000001'},{uid:'90010001'},{limit:30,timeoutMs:15000});assert.equal(result.targetUid,'90010001');assert.equal(result.viewerUid,'80000001');assert.equal(result.total,3408);assert.ok(result.uids.length>=30);assert.equal(result.uids[0],'60000000');assert.ok(result.uids.every(u=>/^600000\d\d$/.test(u)));assert.equal(result.reason,'head-window')
  await assert.rejects(collectTargetHead(page,{owner:'80000002'},{uid:'90010001'}),/登录账号/)
})
