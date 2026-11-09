import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { weiboAdapter } from './weibo-a.mjs'
import { collectRound } from './browser-round.mjs'

test('真实适配器遍历虚拟滚动列表，覆盖45个UID并到达可见末尾', {timeout:30000}, async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true})
  t.after(()=>browser.close())
  const page=await browser.newPage({viewport:{width:1000,height:600}})
  await page.route('https://weibo.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><meta charset="utf-8"><body>
    <div role="navigation"><a href="/u/1234567890"><img alt="profile"></a></div>
    <aside><span class="name">其他用户的昵称</span></aside>
    <a href="/u/page/follow/1234567890?relate=fans">我的粉丝</a>
    <div class="woo-panel-main"><div><h2>全部粉丝（45）</h2><div class="woo-pop-wrap"><div>关注时间倒序</div></div></div>
    <div class="vue-recycle-scroller ready" style="height:4050px;position:relative"></div></div>
    <script>
    const list=document.querySelector('.vue-recycle-scroller');
    function paint(){const top=Math.max(0,-list.getBoundingClientRect().top);const start=Math.max(0,Math.floor(top/90)-2);list.innerHTML=Array.from({length:Math.min(12,45-start)},(_,i)=>{const n=start+i;return '<div class="wbpro-scroller-item" style="position:absolute;top:'+n*90+'px;height:90px;width:100%"><a href="https://weibo.com/u/'+(2000000000+n)+'"><img alt="粉丝"></a></div>'}).join('')};paint();addEventListener('scroll',paint)
    </script></body></html>`}))
  await page.goto('https://weibo.com/')
  page.setDefaultTimeout(2000)
  const adapter=weiboAdapter(page,{full:true})
  const round=await collectRound(adapter,{maxWindows:100})
  assert.equal(round.coverage.unique,45,JSON.stringify({reason:round.endReason,evidence:adapter.evidence}))
  assert.equal(round.endReason,'visible-end')
  assert.ok(round.coverage.windows>1)
  assert.equal(round.coverage.unresolvedLinks,0)
  assert.equal(round.nickname,null,'头像通用alt与其他用户姓名不能作为登录账号昵称')
})
