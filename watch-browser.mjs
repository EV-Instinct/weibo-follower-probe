import {BrowserReader} from './monitor-browser.mjs'
import {weiboAdapter} from './weibo-a.mjs'

export async function collectTargetHead(page,viewer,target,{limit=120,timeoutMs=90000}={}){
  const identity=await weiboAdapter(page).identify()
  if(identity.status!=='ok')throw Error('登录状态无效，请重新登录查看账号。')
  if(viewer.owner&&identity.owner!==viewer.owner)throw Error('当前登录账号发生变化，请登录原查看账号。')
  let total=null;const network=[]
  const response=async r=>{try{const u=new URL(r.url());if(u.hostname==='weibo.com'&&u.pathname==='/ajax/friendships/friends'&&u.searchParams.get('uid')===target.uid&&u.searchParams.get('relate')==='fans'){const body=await r.json();if(Number.isSafeInteger(body.total_number))total=body.total_number;network.push({next:body.next_cursor,count:body.users?.length,status:r.status()})}}catch{}}
  page.on('response',response)
  const deadline=Date.now()+timeoutMs,seen=new Set(),indices=new Set();let stableEnd=0
  try{
    await page.goto(`https://weibo.com/u/${target.uid}`,{waitUntil:'domcontentloaded',timeout:25000})
    const entry=page.locator(`a[href="/u/page/follow/${target.uid}?relate=fans"]`)
    await entry.waitFor({timeout:15000})
    const countText=(await entry.innerText()).trim();if(/^\d+\s*粉丝$/.test(countText))total=Number(countText.replace(/\D/g,''))
    await entry.click();await page.waitForURL(u=>u.pathname===`/u/page/follow/${target.uid}`&&u.searchParams.get('relate')==='fans')
    const list=page.locator('.vue-recycle-scroller.ready').filter({visible:true}).first()
    await list.waitFor({timeout:15000})
    for(let step=0;step<100&&Date.now()<deadline;step++){
      const current=new URL(page.url());if(current.hostname!=='weibo.com'||current.pathname!==`/u/page/follow/${target.uid}`||current.searchParams.get('relate')!=='fans')throw Error('目标页面发生变化，本轮没有记录。')
      if(await page.getByText(/^(安全验证|访问异常|访问受限|操作频繁|请输入验证码)$/).filter({visible:true}).count())throw Error('微博访问受限，请稍后重试或在登录窗口处理验证。')
      const view=await list.evaluate(el=>{const b=el.getBoundingClientRect();return {bottom:b.bottom,viewport:innerHeight,rows:[...el.querySelectorAll('.wbpro-scroller-item')].filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>Math.max(60,b.top)&&r.top<Math.min(innerHeight,b.bottom)}).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top).map(n=>({index:Number(n.dataset.index),uids:[...n.querySelectorAll('a[href]')].filter(a=>a.querySelector('img')).map(a=>{const u=new URL(a.href);return u.hostname==='weibo.com'?u.pathname.match(/^\/u\/(\d+)$/)?.[1]:null}).filter(Boolean)}))}})
      for(const row of view.rows){if(row.uids.length!==1||!Number.isInteger(row.index))throw Error('粉丝列表格式发生变化，本轮没有记录。');indices.add(row.index);seen.add(row.uids[0])}
      const enough=seen.size>=limit
      const terminal=network.at(-1)?.next===0||await page.getByText('没有更多内容了',{exact:true}).filter({visible:true}).count()>0
      if(view.bottom<=view.viewport+3&&terminal)stableEnd++;else stableEnd=0
      if(enough||stableEnd>=3){
        if(!seen.size&&total!==0)throw Error('没有读到有效粉丝列表，本轮保留底册。')
        if(indices.size&&([...indices].some(x=>x<0)||indices.size!==Math.max(...indices)+1))throw Error('本轮顶部读取存在跳行，保留底册后重试。')
        const after=await weiboAdapter(page).identify();if(after.status!=='ok'||after.owner!==identity.owner)throw Error('读取期间登录身份变化，本轮没有记录。')
        return {targetUid:target.uid,viewerUid:identity.owner,uids:[...seen],total,complete:true,at:new Date().toISOString(),reason:enough?'head-window':'visible-end',visibilityLimited:await page.getByText(/部分账号暂不展示/).count()>0}
      }
      const box=await list.boundingBox();await page.mouse.move(Math.min(1100,Math.max(300,box.x+box.width/2)),650)
      await page.mouse.wheel(0,500);await page.waitForTimeout(stableEnd?1200:550)
    }
    throw Error('顶部列表读取超时，已保留底册，下一轮重试。')
  }finally{page.off('response',response)}
}

export class WatchBrowser extends BrowserReader{
  async scanTarget(viewer,target){
    const session=await this.launch({...viewer,id:'viewer'},true)
    const timer=setTimeout(()=>session.context.close().catch(()=>{}),110000)
    try{await this.home(session.page);return await collectTargetHead(session.page,viewer,target)}finally{clearTimeout(timer);await session.context.close().catch(()=>{})}
  }
}
