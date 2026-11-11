import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {readFileSync,mkdirSync,existsSync} from 'node:fs'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {WatchStore,validTargetUid} from './watch-store.mjs'
import {WatchService} from './watch-service.mjs'
import {WatchBrowser} from './watch-browser.mjs'
import {edgeExecutable} from './monitor-browser.mjs'
import {checkDirectoryWritable} from './monitor-system.mjs'

const here=dirname(fileURLToPath(import.meta.url))
export const WATCH_VERSION='0.3.0'
const isTestEnv=(
  process.env.NODE_ENV==='test'||
  process.argv?.some(a=>a.includes('.test.'))||
  process.execArgv?.some(a=>a.startsWith('--test'))
)
function openFile(executable,args,{windowsHide=true}={}){
  if(isTestEnv&&executable==='explorer.exe')return Promise.resolve()
  return new Promise((resolve,reject)=>{
    const p=spawn(executable,args,{windowsHide,detached:true,stdio:'ignore'})
    p.once('error',reject)
    p.once('spawn',()=>{p.unref();resolve()})
  })
}
export async function createWatchApp({root=process.env.WEIBO_MONITOR_DATA_DIR||join(process.env.LOCALAPPDATA,'WeiboFollowerProbe'),port=8766,reader,autoTick=true,importLegacy=true,defaultExportRoot=process.env.WEIBO_MONITOR_EXPORT_DIR||join(here,'粉丝UID导出')}={}){
  root=resolve(root);const server=createServer(),starting=(req,res)=>res.writeHead(503).end('Starting');server.on('request',starting)
  await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r)})
  let store;try{store=new WatchStore(root,{defaultExportRoot,importLegacy})}catch(e){await new Promise(r=>server.close(r));throw e}
  const service=new WatchService(store,reader??new WatchBrowser(root)),csrf=randomUUID();let closing=false
  const json=(res,status,body)=>res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(body))
  server.removeListener('request',starting)
  const address=`http://127.0.0.1:${server.address().port}/`,origin=new URL(address).origin
  server.on('request',async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    try{
      if(req.headers.host!==new URL(address).host||(req.headers.origin&&req.headers.origin!==origin))return json(res,403,{error:'请求来源不正确。'})
      const path=new URL(req.url,address).pathname
      if(path.startsWith('/api/')&&path!=='/api/stop')store.assertStorageCurrent()
      if(req.method==='GET'){
        const files={'/':['watch.html','text/html; charset=utf-8'],'/watch.js':['watch.js','text/javascript; charset=utf-8'],'/watch.css':['watch.css','text/css; charset=utf-8']}
        if(files[path]){const [name,type]=files[path];return res.writeHead(200,{'Content-Type':type}).end(readFileSync(join(here,'ui',name),'utf8').replace('{{CSRF}}',csrf))}
        if(path==='/favicon.ico')return res.writeHead(204).end()
        if(path==='/api/state')return json(res,200,{app:'weibo-follower-monitor',version:WATCH_VERSION,mode:'public-targets',pid:process.pid,databaseId:store.databaseId,dataRoot:root,viewer:store.get('viewer'),viewers:store.viewers(),targets:store.targets().map(({head,...t})=>t),activeId:service.activeId,activeTargets:service.activeTargetIds,loginOpen:!!service.reader.login,exportRoot:store.exportRoot,exportError:service.exportError,batchCount:store.batches().filter(b=>b.status==='ready').length})
        const detail=path.match(/^\/api\/targets\/([a-f0-9-]+)$/);if(detail)return json(res,200,store.detail(detail[1]))
        const download=path.match(/^\/api\/batches\/(\d+)\/download$/);if(download){const b=store.batches().find(b=>String(b.id)===download[1]);if(!b||!existsSync(b.path))throw Error('导出文件不存在，请检查文件位置。');return res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="followers-${b.id}.txt"`}).end(readFileSync(b.path))}
        return json(res,404,{error:'页面不存在。'})
      }
      if(req.method!=='POST')return json(res,405,{error:'不支持的操作。'})
      if(req.headers.origin!==origin||req.headers['x-csrf-token']!==csrf)return json(res,403,{error:'页面校验失效，请刷新。'})
      let body='';for await(const chunk of req.setEncoding('utf8')){body+=chunk;if(body.length>131072)return json(res,413,{error:'内容过长。'})}const input=JSON.parse(body||'{}')
      if(path==='/api/stop'){json(res,200,{ok:true});setTimeout(()=>app.close(),50);return}
      if(path==='/api/login'){await service.login(input.viewerId||null);return json(res,200,{ok:true})}
      if(path==='/api/cancel-login'){
        await service.reader.cancelLogin()
        const vid=service.loginViewerId||'viewer'
        try{store.updateViewer(vid,{status:'needs-login',message:'登录已取消。'})}catch{store.set('viewer',{...store.get('viewer'),status:'needs-login',message:'登录已取消。'})}
        service.loginViewerId=null
        return json(res,200,{ok:true})
      }
      if(path==='/api/viewers'){
        const v=store.addViewer(input.profile,input.label||'')
        return json(res,200,v)
      }
      const vAction=path.match(/^\/api\/viewers\/([a-f0-9-]+|viewer)\/(login|delete)$/)
      if(vAction){
        const [,vid,vverb]=vAction
        if(vverb==='login'){await service.login(vid);return json(res,200,{ok:true})}
        if(vverb==='delete'){
          await service.reader.closeViewerSession?.(vid).catch(()=>{})
          store.removeViewer(vid)
          return json(res,200,{ok:true})
        }
      }
      if(path==='/api/targets/batch'){
        const lines=typeof input.text==='string'?input.text.split(/\r?\n/):(Array.isArray(input.items)?input.items:[])
        let added=0,skipped=0
        const existingUids=new Set(store.targets().map(t=>t.uid))
        for(const item of lines){
          let rawUid='',rawLabel=''
          if(typeof item==='string'){
            const line=item.trim()
            if(!line)continue
            const parts=line.split(/[\s,，\t]+/)
            rawUid=parts[0]||'';rawLabel=parts.slice(1).join(' ')
          }else if(item&&typeof item==='object'){
            rawUid=String(item.uid||'').trim();rawLabel=String(item.label||'').trim()
          }
          if(!validTargetUid(rawUid)||existingUids.has(rawUid)){skipped++;continue}
          try{
            store.addTarget(rawUid,rawLabel)
            existingUids.add(rawUid)
            added++
          }catch{skipped++}
        }
        return json(res,200,{ok:true,added,skipped})
      }
      if(path==='/api/targets/batch-action'){
        const {action:act,ids,interval_minutes,adaptive}=input
        const allTargets=store.targets()
        const targetList=Array.isArray(ids)&&ids.length?allTargets.filter(t=>ids.includes(t.id)):allTargets
        if(act==='start'){
          for(const t of targetList)store.update(t.id,{enabled:1,next_due:0})
          return json(res,200,{ok:true,count:targetList.length})
        }
        if(act==='pause'){
          for(const t of targetList)service.pause(t.id)
          return json(res,200,{ok:true,count:targetList.length})
        }
        if(act==='tail'){
          let exportedCount=0
          for(const t of targetList){
            if(t.pending>0){
              store.flush({targetId:t.id,tail:true})
              exportedCount++
            }
          }
          return json(res,200,{ok:true,exportedCount})
        }
        if(act==='settings'){
          const interval=Number(interval_minutes)
          if(!Number.isInteger(interval)||interval<1||interval>1440)throw Error('检查间隔需要为1至1440分钟。');
          const adaptVal=adaptive===undefined?1:(adaptive?1:0)
          for(const t of targetList){
            store.update(t.id,{interval_minutes:interval,adaptive:adaptVal,next_due:0})
          }
          return json(res,200,{ok:true,count:targetList.length})
        }
        throw Error('不支持的批量操作。')
      }
      if(path==='/api/targets'){const uid=String(input.uid??'').trim();if(!validTargetUid(uid))throw Error('请输入5至20位的数字 UID。');const t=store.addTarget(uid,input.label??'');return json(res,200,{id:t.id})}
      if(path==='/api/settings'){if(typeof input.export_dir!=='string'||!input.export_dir.trim())throw Error('请输入导出文件夹路径。');const dir=resolve(input.export_dir.trim());checkDirectoryWritable(dir);store.set('export_dir',dir);return json(res,200,{ok:true})}
      if(path==='/api/folder'){
        mkdirSync(store.exportRoot,{recursive:true});
        const exe=process.platform==='win32'?'explorer.exe':(process.platform==='darwin'?'open':'xdg-open');
        await openFile(exe,[store.exportRoot],{windowsHide:false});
        return json(res,200,{ok:true})
      }
      const action=path.match(/^\/api\/targets\/([a-f0-9-]+)\/(check|pause|start|tail|settings|rebaseline|delete)$/)
      if(action){const [,id,verb]=action;store.target(id)
        if(['delete','rebaseline'].includes(verb)&&service.runningTargets.has(id))throw Error('该目标正在读取，请稍后再操作。')
        if(verb==='check'){
          const hasReady=store.viewers().some(v=>v.status==='ready'&&v.owner&&((v.cooldown_until||0)<=Date.now()))
          if(!hasReady)throw Error('请先登录至少一个查看账号。')
          service.enqueue(id)
        }
        if(verb==='pause')service.pause(id)
        if(verb==='start')store.update(id,{enabled:1,next_due:0})
        if(verb==='tail')store.flush({targetId:id,tail:true})
        if(verb==='rebaseline'){store.rebaseline(id);service.enqueue(id)}
        if(verb==='delete'){service.queue.delete(id);store.remove(id)}
        if(verb==='settings'){
          const interval=Number(input.interval_minutes);
          if(!Number.isInteger(interval)||interval<1||interval>1440)throw Error('检查间隔需要为1至1440分钟。');
          if(typeof input.label!=='string'||!input.label.trim()||input.label.length>80)throw Error('备注需为1至80字。');
          const adaptive=input.adaptive===undefined?1:(input.adaptive?1:0)
          store.update(id,{label:input.label.trim(),interval_minutes:interval,adaptive,next_due:0})
        }
        return json(res,200,{ok:true})
      }
      return json(res,404,{error:'操作不存在。'})
    }catch(e){return json(res,400,{error:/^[\u4e00-\u9fff]/.test(e.message)?e.message:'操作失败，请检查输入或数据目录。'})}
  })
  const app={
    store,service,server,address,
    async close(){
      if(closing)return;
      closing=true;
      try{server.closeAllConnections?.()}catch{}
      await new Promise(r=>server.close(r)).catch(()=>{});
      await service.close();
      store.close()
    }
  }
  if(autoTick)service.start();return app
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.on('unhandledRejection',err=>console.error('未捕获异常:',err));
  createWatchApp({port:Number(process.env.WEIBO_MONITOR_PORT||8766)}).then(async app=>{console.log(app.address);for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close());if(process.argv.includes('--open'))await openFile(edgeExecutable(),[`--app=${app.address}`,'--window-size=1280,820'])}).catch(e=>{
    if(/^[\u4e00-\u9fff]/.test(e.message)){
      console.error(e.message)
    }else if(e.message?.includes('file is not a database')||e.code==='SQLITE_CORRUPT'){
      console.error('启动失败：数据文件已损坏（file is not a database），请备份或重建 watch.sqlite。')
    }else if(e.code==='EADDRINUSE'||e.message?.includes('EADDRINUSE')){
      console.error('启动失败，端口被占用，请先退出旧版后台再重试。')
    }else{
      console.error(/^[\u4e00-\u9fff]/.test(e.message)?e.message:'启动失败，请先退出旧版后台，再重试。')
    }
    process.exitCode=1
  })
}
