import {BrowserReader} from './monitor-browser.mjs'
import {weiboAdapter} from './weibo-a.mjs'

export async function collectTargetHead(page,viewer,target,{anchors=target?.head||[],limit=120,timeoutMs=90000}={}){
  const identity=await weiboAdapter(page).identify()
  if(identity.status!=='ok')throw Error('登录状态无效，请重新登录查看账号。')
  if(viewer.owner&&identity.owner!==viewer.owner)throw Error('当前登录账号发生变化，请登录原查看账号。')

  const anchorSet=new Set(anchors)

  // 1. 优先尝试同源直连首屏 API
  try{
    const currentUrl=page.url()
    if(!currentUrl.startsWith('https://weibo.com')){
      await page.goto('https://weibo.com/',{waitUntil:'domcontentloaded',timeout:25000})
    }
    const firstResult=await page.evaluate(async({uid})=>{
      try{
        const res=await fetch(`/ajax/friendships/friends?relate=fans&page=1&uid=${uid}&type=all`,{
          headers:{'accept':'application/json, text/plain, */*','x-requested-with':'XMLHttpRequest'},
          credentials:'include',
          signal:AbortSignal.timeout(15000)
        })
        if(!res.ok)return {ok:false,status:res.status}
        const data=await res.json()
        return {ok:true,data}
      }catch(e){return {ok:false,error:e.message}}
    },{uid:target.uid})

    if(firstResult?.ok&&firstResult.data&&Array.isArray(firstResult.data.users)){
      const data=firstResult.data
      let total=Number.isSafeInteger(data.total_number)?data.total_number:null
      const seen=new Set()
      let hitAnchor=false

      for(const u of data.users){
        const uidStr=u.idstr?String(u.idstr):(u.id?String(u.id):null)
        if(uidStr&&/^[1-9]\d{0,19}$/.test(uidStr)){
          seen.add(uidStr)
          if(anchorSet.has(uidStr))hitAnchor=true
        }
      }

      // 第 1 页（前 20 人）只要命中有效哨兵锚点就立即停止翻页并返回结果
      if(hitAnchor||seen.size>=limit||data.next_cursor===0||!data.users.length){
        if(!seen.size&&total!==0)throw Error('没有读到有效粉丝列表，本轮保留底册。')
        const after=await weiboAdapter(page).identify()
        if(after.status!=='ok'||after.owner!==identity.owner)throw Error('读取期间登录身份变化，本轮没有记录。')
        return {
          targetUid:target.uid,
          viewerUid:identity.owner,
          uids:[...seen],
          total,
          complete:true,
          at:new Date().toISOString(),
          reason:hitAnchor?'anchor-hit':(seen.size>=limit?'head-window':'visible-end'),
          visibilityLimited:false
        }
      }

      // 仅当第 1 页全部是新粉丝（未命中哨兵）时才继续拉取 page=2（最多拉取到 120 人封顶）
      const maxPages=Math.ceil(limit/20)
      for(let p=2;p<=maxPages;p++){
        const pResult=await page.evaluate(async({uid,pageNum})=>{
          try{
            const res=await fetch(`/ajax/friendships/friends?relate=fans&page=${pageNum}&uid=${uid}&type=all`,{
              headers:{'accept':'application/json, text/plain, */*','x-requested-with':'XMLHttpRequest'},
              credentials:'include',
              signal:AbortSignal.timeout(15000)
            })
            if(!res.ok)return {ok:false,status:res.status}
            const resData=await res.json()
            return {ok:true,data:resData}
          }catch(e){return {ok:false,error:e.message}}
        },{uid:target.uid,pageNum:p})

        if(!pResult?.ok||!pResult.data?.users?.length)break
        const pData=pResult.data
        let pageHit=false
        for(const u of pData.users){
          const uidStr=u.idstr?String(u.idstr):(u.id?String(u.id):null)
          if(uidStr&&/^[1-9]\d{0,19}$/.test(uidStr)){
            seen.add(uidStr)
            if(anchorSet.has(uidStr)){
              pageHit=true
              hitAnchor=true
            }
          }
        }
        if(pageHit||seen.size>=limit||pData.next_cursor===0)break
      }

      if(!seen.size&&total!==0)throw Error('没有读到有效粉丝列表，本轮保留底册。')
      const after=await weiboAdapter(page).identify()
      if(after.status!=='ok'||after.owner!==identity.owner)throw Error('读取期间登录身份变化，本轮没有记录。')
      return {
        targetUid:target.uid,
        viewerUid:identity.owner,
        uids:[...seen],
        total,
        complete:true,
        at:new Date().toISOString(),
        reason:hitAnchor?'anchor-hit':(seen.size>=limit?'head-window':'visible-end'),
        visibilityLimited:false
      }
    }
  }catch(e){if(/^[\u4e00-\u9fff]/.test(e?.message))throw e}

  // 2. 降级：页面渲染模式（保持与原有行为及 mock 测试 100% 兼容）
  let total=null;const network=[]
  const response=async r=>{try{const u=new URL(r.url());if(u.hostname==='weibo.com'&&u.pathname==='/ajax/friendships/friends'&&u.searchParams.get('uid')===target.uid&&u.searchParams.get('relate')==='fans'){const body=await r.json();if(Number.isSafeInteger(body.total_number))total=body.total_number;network.push({next:body.next_cursor,count:body.users?.length,status:r.status()})}}catch{}}
  page.on('response',response)
  const deadline=Date.now()+timeoutMs,seen=new Set(),indices=new Set();let stableEnd=0,hitAnchor=false
  try{
    const entry=page.locator(`a[href="/u/page/follow/${target.uid}?relate=fans"]`)
    if(await entry.count()>0){
      const countText=(await entry.first().innerText()).trim();if(/^\d+\s*粉丝$/.test(countText))total=Number(countText.replace(/\D/g,''))
      await entry.first().click();await page.waitForURL(u=>u.pathname===`/u/page/follow/${target.uid}`&&u.searchParams.get('relate')==='fans',{timeout:15000}).catch(()=>{})
    }else{
      await page.goto(`https://weibo.com/u/page/follow/${target.uid}?relate=fans`,{waitUntil:'domcontentloaded',timeout:25000}).catch(async()=>{
        await page.goto(`https://weibo.com/u/${target.uid}`,{waitUntil:'domcontentloaded',timeout:25000})
        const targetEntry=page.locator(`a[href="/u/page/follow/${target.uid}?relate=fans"]`)
        await targetEntry.waitFor({timeout:15000})
        const cText=(await targetEntry.innerText()).trim();if(/^\d+\s*粉丝$/.test(cText))total=Number(cText.replace(/\D/g,''))
        await targetEntry.click();await page.waitForURL(u=>u.pathname===`/u/page/follow/${target.uid}`&&u.searchParams.get('relate')==='fans')
      })
    }
    const list=page.locator('.vue-recycle-scroller.ready').filter({visible:true}).first()
    await list.waitFor({timeout:15000})
    for(let step=0;step<100&&Date.now()<deadline;step++){
      const current=new URL(page.url());if(current.hostname!=='weibo.com'||current.pathname!==`/u/page/follow/${target.uid}`||current.searchParams.get('relate')!=='fans')throw Error('目标页面发生变化，本轮没有记录。')
      if(await page.getByText(/^(安全验证|访问异常|访问受限|操作频繁|请输入验证码)$/).filter({visible:true}).count())throw Error('微博访问受限，请稍后重试或在登录窗口处理验证。')
      const view=await list.evaluate(el=>{const b=el.getBoundingClientRect();return {bottom:b.bottom,viewport:innerHeight,rows:[...el.querySelectorAll('.wbpro-scroller-item')].filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>Math.max(60,b.top)&&r.top<Math.min(innerHeight,b.bottom)}).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top).map(n=>({index:Number(n.dataset.index),uids:[...n.querySelectorAll('a[href]')].filter(a=>a.querySelector('img')).map(a=>{const u=new URL(a.href);return u.hostname==='weibo.com'?u.pathname.match(/^\/u\/(\d+)$/)?.[1]:null}).filter(Boolean)}))}})
      for(const row of view.rows){
        if(row.uids.length!==1||!Number.isInteger(row.index))throw Error('粉丝列表格式发生变化，本轮没有记录。')
        indices.add(row.index);seen.add(row.uids[0])
        if(anchorSet.has(row.uids[0]))hitAnchor=true
      }
      const enough=seen.size>=limit||hitAnchor
      const terminal=network.at(-1)?.next===0||await page.getByText('没有更多内容了',{exact:true}).filter({visible:true}).count()>0
      if(view.bottom<=view.viewport+3&&terminal)stableEnd++;else stableEnd=0
      if(enough||stableEnd>=3){
        if(!seen.size&&total!==0)throw Error('没有读到有效粉丝列表，本轮保留底册。')
        if(indices.size&&([...indices].some(x=>x<0)||indices.size!==Math.max(...indices)+1))throw Error('本轮顶部读取存在跳行，保留底册后重试。')
        const after=await weiboAdapter(page).identify();if(after.status!=='ok'||after.owner!==identity.owner)throw Error('读取期间登录身份变化，本轮没有记录。')
        return {targetUid:target.uid,viewerUid:identity.owner,uids:[...seen],total,complete:true,at:new Date().toISOString(),reason:hitAnchor?'anchor-hit':(enough?'head-window':'visible-end'),visibilityLimited:await page.getByText(/部分账号暂不展示/).count()>0}
      }
      const box=await list.boundingBox();await page.mouse.move(Math.min(1100,Math.max(300,box.x+box.width/2)),650)
      await page.mouse.wheel(0,500);await page.waitForTimeout(stableEnd?1200:550)
    }
    throw Error('顶部列表读取超时，已保留底册，下一轮重试。')
  }finally{page.off('response',response)}
}

export class WatchBrowser extends BrowserReader{
  constructor(root){
    super(root)
    this.residentSessions=new Map()
    this.launching=new Map()
  }
  async getResidentSession(viewer){
    const key=viewer.id||viewer.profile||'viewer'
    const existing=this.residentSessions.get(key)
    if(existing){
      try{
        if(!existing.context.pages().length||existing.page.isClosed()||(viewer.owner&&existing.owner!==viewer.owner)){
          this.residentSessions.delete(key)
          await existing.context.close().catch(()=>{})
        }else{
          return existing
        }
      }catch{
        this.residentSessions.delete(key)
      }
    }
    if(this.launching.has(key))return await this.launching.get(key)
    const p=(async()=>{
      try{
        if(this.login?.id===key)throw Error('该账号正在登录中，请在微博窗口完成登录后再试。')
        const session=await this.launch({...viewer,id:key},true)
        session.owner=viewer.owner
        session.context.on('close',()=>{if(this.residentSessions.get(key)===session)this.residentSessions.delete(key)})
        await this.home(session.page)
        this.residentSessions.set(key,session)
        return session
      }finally{
        this.launching.delete(key)
      }
    })()
    this.launching.set(key,p)
    return await p
  }
  async scanTarget(viewer,target,options={}){
    const anchors=options.anchors||target?.head||[]
    const session=await this.getResidentSession(viewer)
    return await collectTargetHead(session.page,viewer,target,{...options,anchors})
  }
  async openLogin(account){
    const key=account.id||account.profile||'viewer'
    const existing=this.residentSessions.get(key)
    if(existing){
      this.residentSessions.delete(key)
      await existing.context.close().catch(()=>{})
    }
    return await super.openLogin(account)
  }
  async closeViewerSession(viewerId){
    const existing=this.residentSessions.get(viewerId)
    if(existing){
      this.residentSessions.delete(viewerId)
      await existing.context.close().catch(()=>{})
    }
  }
  async close(){
    const sessions=[...this.residentSessions.values()]
    this.residentSessions.clear()
    await Promise.allSettled(sessions.map(s=>s.context.close()))
    await super.close()
  }
}
