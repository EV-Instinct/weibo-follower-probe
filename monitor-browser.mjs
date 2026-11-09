import { chromium } from 'playwright-core'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { weiboAdapter } from './weibo-a.mjs'
import { collectRound } from './browser-round.mjs'

export function edgeExecutable() {
  const paths=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean).map(p=>join(p,'Microsoft','Edge','Application','msedge.exe'))
  const found=paths.find(existsSync);if(!found)throw Error('未找到 Microsoft Edge，请先安装 Edge。');return found
}
const run=promisify(execFile)
async function assertAvailable(profile) {
  const script=String.raw`$p=[regex]::Escape($env:WEIBO_PROFILE_CHECK); $a=Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -match ('(?i)--user-data-dir="?' + $p + '(?="|\s|$)') -and $_.CommandLine -notmatch '(?:^| )--type=' }; if($a){'busy'}else{'free'}`
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,WEIBO_PROFILE_CHECK:profile},windowsHide:true,timeout:10000})
  if(stdout.trim()!=='free')throw Error('账号的独立浏览器正在使用，请关闭该账号窗口后重试。')
}
export class BrowserReader {
  constructor(root){this.root=root;this.login=null;this.contexts=new Set()}
  async launch(account,headless) {
    const profile=join(this.root,'profiles',account.profile)
    await assertAvailable(profile)
    let context
    try{context=await chromium.launchPersistentContext(profile,{executablePath:edgeExecutable(),headless,viewport:{width:1280,height:800},timeout:20000,args:['--disable-background-mode']})}
    catch{throw Error('无法启动账号浏览器，请检查该账号窗口是否已经关闭。')}
    this.contexts.add(context);context.on('close',()=>this.contexts.delete(context))
    const page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(10000)
    return {context,page}
  }
  async home(page) {
    const response=await page.goto('https://weibo.com/',{waitUntil:'domcontentloaded',timeout:25000})
    if([401,403,429].includes(response?.status()))throw Error('微博暂时拒绝访问，请稍后重试。')
  }
  async openLogin(account) {
    if(this.login)throw Error('请先完成或取消当前账号的登录。')
    const session=await this.launch(account,false)
    this.login={id:account.id,...session,openedAt:Date.now()}
    try{await this.home(session.page)}catch(e){await this.cancelLogin();throw e}
  }
  async loginState() {
    if(!this.login)return null
    if(this.login.page.isClosed()){const id=this.login.id;this.login=null;return {id,closed:true}}
    if(Date.now()-this.login.openedAt>15*60*1000){const id=this.login.id;await this.cancelLogin();return {id,closed:true}}
    try{
      const adapter=weiboAdapter(this.login.page)
      const identity=await adapter.identify()
      return {id:this.login.id,ready:identity.status==='ok',nickname:identity.nickname??null}
    }catch{
      if(this.login?.page?.isClosed()){const id=this.login.id;this.login=null;return {id,closed:true}}
      return null
    }
  }
  async cancelLogin(){const session=this.login;this.login=null;await session?.context.close().catch(()=>{})}
  async scan(account,{mode=null,isKnown=null}={}) {
    let session
    if(this.login?.id===account.id){session=this.login;this.login=null}
    else session=await this.launch(account,true)
    const scanMode=mode??(!account.baseline_at?'baseline':account.full_scan_needed?'full':'incremental')
    const isFull=scanMode==='baseline'||scanMode==='full'
    const maxWindows=isFull?1500:40
    const timeoutMs=isFull?15*60*1000:5*60*1000
    const timeout=setTimeout(()=>session.context.close().catch(()=>{}),timeoutMs)
    try{
      await this.home(session.page)
      const adapter=weiboAdapter(session.page,{full:true})
      const round=await collectRound(adapter,{expectedOwner:account.owner,maxWindows,isKnown,mode:scanMode})
      if(!round.owner){const messages={'login-required':'登录已失效，请点击登录账号。','identity-mismatch':'登录账号与已绑定账号不一致，请登录原账号。','access-blocked':'出现验证码或访问限制，请点击登录账号处理。'};throw Error(messages[round.endReason]??'无法核实登录身份，请点击登录账号检查。')}
      const uids=[...new Set(round.pages.flat())], total=round.coverage.exactTotals.length===1?round.coverage.exactTotals[0]:null
      const complete=round.coverage.unresolvedLinks===0 && (
        scanMode==='incremental'
          ? (round.endReason==='incremental-hit'||round.endReason==='visible-end')
          : (round.endReason==='visible-end')
      )
      return {owner:round.owner,nickname:adapter.nickname??round.nickname??null,uids,total,complete,mode:scanMode,
        at:round.endedAt,reason:round.endReason,unresolvedLinks:round.coverage.unresolvedLinks,
        windows:round.coverage.windows,visibilityLimited:adapter.evidence.visibilityLimited}
    } finally {clearTimeout(timeout);await session.context.close().catch(()=>{})}
  }
  async close(){this.login=null;await Promise.allSettled([...this.contexts].map(c=>c.close()))}
}
