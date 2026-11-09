import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync,readFileSync,mkdirSync,copyFileSync,rmSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { MonitorStore } from './monitor-store.mjs'
import { BrowserReader,edgeExecutable } from './monitor-browser.mjs'
import { MonitorService } from './monitor-service.mjs'
import { MonitorLogger } from './monitor-logger.mjs'
import { setAutostart,isAutostartEnabled,checkDirectoryWritable } from './monitor-system.mjs'

const here=dirname(fileURLToPath(import.meta.url))
const isTestEnv = typeof process !== 'undefined' && Boolean(
  process.env?.NODE_TEST_CONTEXT ||
  process.env?.NODE_ENV === 'test' ||
  process.argv?.some(a => a.includes('.test.')) ||
  process.execArgv?.some(a => a.startsWith('--test'))
)
async function openLocal(exe,args) {
  if (isTestEnv && exe === 'explorer.exe') return
  const child=spawn(exe,args,{stdio:'ignore',detached:true})
  await once(child,'spawn');child.unref()
}
export async function createMonitorApp({root,port=8766,reader,importProfiles=true,autoTick=true}={}) {
  if(!root)root=join(process.env.LOCALAPPDATA,'WeiboFollowerProbe')
  const logger=new MonitorLogger(root)
  const store=new MonitorStore(root),service=new MonitorService(store,reader??new BrowserReader(root),{logger}),csrf=randomUUID()
  let closing=false
  const json=(res,status,value)=>res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(value))
  const server=createServer({maxHeaderSize:8192},async(req,res)=>{
    const host=`127.0.0.1:${server.address().port}`,origin=`http://${host}`
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff')
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    res.setHeader('Referrer-Policy','same-origin')
    if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin))return json(res,403,{error:'请求来源不正确。'})
    const url=new URL(req.url,origin),path=url.pathname
    try {
      if(req.method==='GET') {
        const files={'/':['monitor.html','text/html; charset=utf-8'],'/monitor.js':['monitor.js','text/javascript; charset=utf-8'],'/monitor.css':['monitor.css','text/css; charset=utf-8']}
        if(files[path]){const [file,type]=files[path];return res.writeHead(200,{'Content-Type':type}).end(readFileSync(join(here,'ui',file),'utf8').replace('{{CSRF}}',csrf))}
        if(path==='/favicon.ico')return res.writeHead(204).end()
        if(path==='/api/state')return json(res,200,{app:'weibo-follower-monitor',accounts:store.accounts(),activeId:service.activeId,activeIds:[...service.activeIds],concurrency:service.concurrency,loginId:service.reader.login?.id??null,exportError:service.exportError,exportRoot:store.exportRoot,dataRoot:root})
        if(path==='/api/settings')return json(res,200,{...store.getSettings(),autostart:isAutostartEnabled()})
        if(path==='/api/batches')return json(res,200,store.batches().slice(0,200).map(b=>({...b,label:store.account(b.account_id).label})))
        const detailMatch=path.match(/^\/api\/accounts\/([a-f0-9-]+)\/detail$/)
        if(detailMatch){
          try{return json(res,200,store.accountDetail(detailMatch[1]))}
          catch{return json(res,404,{error:'找不到该账号。'})}
        }
        const fileMatch=path.match(/^\/api\/batches\/(\d+)\/file$/)
        if(fileMatch){
          const batch=store.batches().find(b=>b.id===Number(fileMatch[1]))
          if(!batch||batch.status!=='ready')return json(res,404,{error:'文件尚未生成。'})
          const destination=store.getBatchFilePath(batch)
          if(!existsSync(destination))store.flush()
          res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(batch.relative_path.split(/[\\/]/).at(-1))}`)
          return res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}).end(readFileSync(destination))
        }
        return json(res,404,{error:'页面不存在。'})
      }
      if(req.method!=='POST')return json(res,405,{error:'不支持的操作。'})
      if(req.headers.origin!==origin||req.headers['x-csrf-token']!==csrf||!req.headers['content-type']?.startsWith('application/json'))return json(res,403,{error:'请求校验失败，请刷新页面。'})
      let body='';for await(const chunk of req.setEncoding('utf8')){body+=chunk;if(body.length>16384)return json(res,413,{error:'内容过长。'})}
      const input=JSON.parse(body||'{}')
      if(path==='/api/accounts'){const a=store.addAccount(input.label);logger.info(`添加账号: ${input.label}`);return json(res,200,{id:a.id})}
      if(path==='/api/settings'){
        if('concurrency' in input){
          const concurrency=Number(input.concurrency)
          if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw Error('同时读取账号数必须为 1～3 之间的整数。')
          store.setSetting('concurrency',String(concurrency))
        }
        if('default_interval' in input){
          const interval=Number(input.default_interval)
          if(!Number.isInteger(interval)||interval<2||interval>1440)throw Error('默认检查间隔必须为 2～1440 分钟之间的整数。')
          store.setSetting('default_interval',String(interval))
        }
        if('export_dir' in input){
          const dir=String(input.export_dir||'').trim()
          if(dir){
            checkDirectoryWritable(dir)
            store.setSetting('export_dir',resolve(dir))
          }else{
            store.setSetting('export_dir','')
          }
        }
        if('autostart' in input){
          const enable=Boolean(input.autostart)
          setAutostart(enable,{appDir:here})
          store.setSetting('autostart',enable?'1':'0')
        }
        if('notifications' in input){
          store.setSetting('notifications',input.notifications?'1':'0')
        }
        logger.info('系统设置已更新',store.getSettings())
        return json(res,200,{ok:true,settings:{...store.getSettings(),autostart:isAutostartEnabled()}})
      }
      if(path==='/api/folder'){mkdirSync(store.exportRoot,{recursive:true});await openLocal('explorer.exe',[store.exportRoot]);return json(res,200,{ok:true})}
      if(path==='/api/logs/folder'){mkdirSync(logger.logsDir,{recursive:true});await openLocal('explorer.exe',[logger.logsDir]);return json(res,200,{ok:true})}
      if(path==='/api/retry-exports'){store.flush();service.exportError='';return json(res,200,{ok:true})}
      if(path==='/api/stop'){logger.info('收到停止指令');json(res,200,{ok:true});setTimeout(()=>app.close(),50);return}
      if(path==='/api/batch-actions'){
        const action=input.action
        if(action==='start'){
          let count=0
          for(const a of store.accounts()){
            if(a.status!=='needs-login'&&a.status!=='logging-in'&&a.owner){
              store.update(a.id,{enabled:1,next_due:0});service.enqueue(a.id);count++
            }
          }
          logger.info(`批量开始检查: ${count} 个账号`)
          return json(res,200,{ok:true,count})
        }
        if(action==='pause'){
          for(const a of store.accounts())service.pause(a.id)
          logger.info('批量暂停所有账号')
          return json(res,200,{ok:true})
        }
        if(action==='tail'){
          const created=store.flush({tail:true})
          logger.info(`批量导出尾数: ${created.length} 份批次`)
          return json(res,200,{ok:true,count:created.length})
        }
        throw Error('未知的批量操作。')
      }
      const batchActionMatch=path.match(/^\/api\/batches\/(\d+)\/(open|content)$/)
      if(batchActionMatch){
        const batchId=Number(batchActionMatch[1]),batchAct=batchActionMatch[2]
        const batch=store.batches().find(b=>b.id===batchId)
        if(!batch||batch.status!=='ready')throw Error('文件尚未生成。')
        const destination=store.getBatchFilePath(batch)
        if(!existsSync(destination))store.flush()
        if(!existsSync(destination))throw Error('找不到导出的文件。')
        if(batchAct==='open'){
          await openLocal('explorer.exe',[`/select,${destination}`])
          return json(res,200,{ok:true})
        }
        if(batchAct==='content'){
          const content=readFileSync(destination,'utf8')
          return json(res,200,{ok:true,content})
        }
      }
      const match=path.match(/^\/api\/accounts\/([a-f0-9-]+)\/(login|cancel-login|start|pause|check|tail|settings|folder|delete)$/)
      if(!match)return json(res,404,{error:'操作不存在。'})
      const [,id,action]=match,a=store.account(id)
      if(action==='login')await service.login(id)
      if(action==='cancel-login'){if(service.reader.login?.id===id)await service.reader.cancelLogin();store.update(id,{status:'needs-login',message:'已取消登录。'})}
      if(action==='start'){store.update(id,{enabled:1,next_due:0});service.enqueue(id)}
      if(action==='pause')service.pause(id)
      if(action==='check'){if(service.reader.login?.id===id)throw Error('请先完成登录，随后会自动读取。');service.enqueue(id)}
      if(action==='tail')store.flush({accountId:id,tail:true})
      if(action==='settings'){
        const interval=Number(input.interval),label=String(input.label??a.label).trim()
        if(!Number.isInteger(interval)||interval<2||interval>1440||!label||label.length>80)throw Error('间隔请输入2～1440分钟，备注不超过80字。')
        store.update(id,{label,interval_minutes:interval,next_due:Date.now()+interval*60000})
      }
      if(action==='folder'){
        const rawName=(a.label?.trim()||a.nickname?.trim()||'未命名')
        const safeName=rawName.replace(/[\\/:*?"<>|]/g,'').slice(0,30).trim()||'未命名'
        const safeOwner=(a.owner||a.profile||'unknown').replace(/[\\/:*?"<>|]/g,'')
        const dirName=`${safeName}_${safeOwner}`
        const accountDir=join(store.exportRoot,dirName)
        mkdirSync(accountDir,{recursive:true})
        await openLocal('explorer.exe',[accountDir])
        return json(res,200,{ok:true})
      }
      if(action==='delete'){
        if(service.activeIds.has(id))throw Error('账号正在读取中，无法删除。')
        if(service.reader.login?.id===id)throw Error('账号正在登录中，无法删除。')
        service.queue.delete(id)
        const deleted=store.deleteAccount(id)
        const profileDir=join(root,'profiles',deleted.profile)
        if(existsSync(profileDir))rmSync(profileDir,{recursive:true,force:true})
        return json(res,200,{ok:true})
      }
      return json(res,200,{ok:true})
    } catch(e){const message=e instanceof Error&&/^[\u4e00-\u9fff]/.test(e.message)?e.message:'操作失败，请检查数据目录和浏览器状态。';return json(res,400,{error:message})}
  })
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})}catch(e){store.close();throw e}
  const app={store,service,logger,server,address:`http://127.0.0.1:${server.address().port}/`,async close(){
    if(closing)return;closing=true
    logger.info('微博粉丝助手服务已退出')
    await new Promise(resolve=>server.close(resolve));await service.close();store.close()
  }}
  if(importProfiles&&!store.accounts().length){
    for(const profile of ['A','B'])if(existsSync(join(root,'profiles',profile))){
      const a=store.addAccount(`账号 ${profile}`,profile)
      const oldFile=profile==='A'?join(root,'weibo-a-observations.json'):null
      if(oldFile&&existsSync(oldFile)){
        try{
          const old=JSON.parse(readFileSync(oldFile,'utf8'))
          const uids=[...new Set(old.rounds.filter(r=>r.owner===old.owner).flatMap(r=>r.pages.flat()))]
          if(old.owner&&uids.length){
            const backup=join(root,'backups','weibo-a-observations.before-monitor.json');mkdirSync(dirname(backup),{recursive:true});if(!existsSync(backup))copyFileSync(oldFile,backup)
            store.ingest(a.id,{owner:old.owner,uids,complete:false,total:null,reason:'legacy-history-import'})
          }
        }catch{store.update(a.id,{message:'旧观测未自动导入，原文件已保留；请先检查旧记录。',status:'error'})}
      }
    }
  }
  if(autoTick)service.start()
  return app
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.WEIBO_MONITOR_PORT??8766)
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('本地端口无效。')
  createMonitorApp({port,root:process.env.WEIBO_MONITOR_DATA_DIR}).then(async app=>{
    console.log(`微博粉丝助手 ${app.address}`)
    if(process.argv.includes('--open'))await openLocal(edgeExecutable(),[`--app=${app.address}`,'--window-size=1280,820'])
    process.once('SIGINT',()=>app.close());process.once('SIGTERM',()=>app.close())
  }).catch(async e=>{
    if(e.code==='EADDRINUSE'&&process.argv.includes('--open')){
      try{
        const res=await fetch(`http://127.0.0.1:${port}/api/state`)
        const data=await res.json()
        if(data.app==='weibo-follower-monitor'){
          await openLocal(edgeExecutable(),[`--app=http://127.0.0.1:${port}/`,'--window-size=1280,820'])
          return
        }
      }catch{}
    }
    console.error('启动失败，请检查端口是否被占用，以及数据目录是否可写。');process.exitCode=1
  })
}
