import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync,readFileSync,mkdirSync,copyFileSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { MonitorStore } from './monitor-store.mjs'
import { BrowserReader,edgeExecutable } from './monitor-browser.mjs'
import { MonitorService } from './monitor-service.mjs'

const here=dirname(fileURLToPath(import.meta.url))
async function openLocal(exe,args) {
  const child=spawn(exe,args,{stdio:'ignore',detached:true,windowsHide:true})
  await once(child,'spawn');child.unref()
}
export async function createMonitorApp({root,port=8766,reader,importProfiles=true,autoTick=true}={}) {
  if(!root)root=join(process.env.LOCALAPPDATA,'WeiboFollowerProbe')
  const store=new MonitorStore(root),service=new MonitorService(store,reader??new BrowserReader(root)),csrf=randomUUID()
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
        if(path==='/api/state')return json(res,200,{app:'weibo-follower-monitor',accounts:store.accounts(),activeId:service.activeId,loginId:service.reader.login?.id??null,exportError:service.exportError,exportRoot:store.exportRoot,dataRoot:root})
        if(path==='/api/batches')return json(res,200,store.batches().slice(0,200).map(b=>({...b,label:store.account(b.account_id).label})))
        const fileMatch=path.match(/^\/api\/batches\/(\d+)\/file$/)
        if(fileMatch){
          const batch=store.batches().find(b=>b.id===Number(fileMatch[1]))
          if(!batch||batch.status!=='ready')return json(res,404,{error:'文件尚未生成。'})
          const destination=join(store.exportRoot,batch.relative_path)
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
      if(path==='/api/accounts'){const a=store.addAccount(input.label);return json(res,200,{id:a.id})}
      if(path==='/api/folder'){mkdirSync(store.exportRoot,{recursive:true});await openLocal('explorer.exe',[store.exportRoot]);return json(res,200,{ok:true})}
      if(path==='/api/retry-exports'){store.flush();service.exportError='';return json(res,200,{ok:true})}
      if(path==='/api/stop'){json(res,200,{ok:true});setTimeout(()=>app.close(),50);return}
      const match=path.match(/^\/api\/accounts\/([a-f0-9-]+)\/(login|cancel-login|start|pause|check|tail|settings)$/)
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
      return json(res,200,{ok:true})
    } catch(e){const message=e instanceof Error&&/^[\u4e00-\u9fff]/.test(e.message)?e.message:'操作失败，请检查数据目录和浏览器状态。';return json(res,400,{error:message})}
  })
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})}catch(e){store.close();throw e}
  const app={store,service,server,address:`http://127.0.0.1:${server.address().port}/`,async close(){
    if(closing)return;closing=true
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
    if(process.argv.includes('--open'))await openLocal(edgeExecutable(),[`--app=${app.address}`])
    process.once('SIGINT',()=>app.close());process.once('SIGTERM',()=>app.close())
  }).catch(async e=>{
    if(e.code==='EADDRINUSE'&&process.argv.includes('--open')){
      try{const res=await fetch(`http://127.0.0.1:${port}/api/state`);if((await res.json()).app==='weibo-follower-monitor'){await openLocal(edgeExecutable(),[`--app=http://127.0.0.1:${port}/`]);return}}catch{}
    }
    console.error('启动失败，请检查端口是否被占用，以及数据目录是否可写。');process.exitCode=1
  })
}
