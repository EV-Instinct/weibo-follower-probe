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
function openFile(executable,args){return new Promise((resolve,reject)=>{const p=spawn(executable,args,{windowsHide:true,detached:true,stdio:'ignore'});p.once('error',reject);p.once('spawn',()=>{p.unref();resolve()})})}
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
    if(req.headers.host!==new URL(address).host||(req.headers.origin&&req.headers.origin!==origin))return json(res,403,{error:'请求来源不正确。'})
    const path=new URL(req.url,address).pathname
    try{
      if(path.startsWith('/api/')&&path!=='/api/stop')store.assertStorageCurrent()
      if(req.method==='GET'){
        const files={'/':['watch.html','text/html; charset=utf-8'],'/watch.js':['watch.js','text/javascript; charset=utf-8'],'/watch.css':['watch.css','text/css; charset=utf-8']}
        if(files[path]){const [name,type]=files[path];return res.writeHead(200,{'Content-Type':type}).end(readFileSync(join(here,'ui',name),'utf8').replace('{{CSRF}}',csrf))}
        if(path==='/favicon.ico')return res.writeHead(204).end()
        if(path==='/api/state')return json(res,200,{app:'weibo-follower-monitor',version:WATCH_VERSION,mode:'public-targets',pid:process.pid,databaseId:store.databaseId,dataRoot:root,viewer:store.get('viewer'),targets:store.targets().map(({head,...t})=>t),activeId:service.activeId,loginOpen:!!service.reader.login,exportRoot:store.exportRoot,exportError:service.exportError,batchCount:store.batches().filter(b=>b.status==='ready').length})
        const detail=path.match(/^\/api\/targets\/([a-f0-9-]+)$/);if(detail)return json(res,200,store.detail(detail[1]))
        const download=path.match(/^\/api\/batches\/(\d+)\/download$/);if(download){const b=store.batches().find(b=>String(b.id)===download[1]);if(!b||!existsSync(b.path))throw Error('导出文件不存在，请检查文件位置。');return res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="followers-${b.id}.txt"`}).end(readFileSync(b.path))}
        return json(res,404,{error:'页面不存在。'})
      }
      if(req.method!=='POST')return json(res,405,{error:'不支持的操作。'})
      if(req.headers.origin!==origin||req.headers['x-csrf-token']!==csrf)return json(res,403,{error:'页面校验失效，请刷新。'})
      let body='';for await(const chunk of req.setEncoding('utf8')){body+=chunk;if(body.length>16384)return json(res,413,{error:'内容过长。'})}const input=JSON.parse(body||'{}')
      if(path==='/api/stop'){json(res,200,{ok:true});setTimeout(()=>app.close(),50);return}
      if(path==='/api/login'){await service.login();return json(res,200,{ok:true})}
      if(path==='/api/cancel-login'){await service.reader.cancelLogin();store.set('viewer',{...store.get('viewer'),status:'needs-login',message:'登录已取消。'});return json(res,200,{ok:true})}
      if(path==='/api/targets'){const uid=String(input.uid??'').trim();if(!validTargetUid(uid))throw Error('请输入5至20位的数字 UID。');const t=store.addTarget(uid,input.label??'');return json(res,200,{id:t.id})}
      if(path==='/api/settings'){if(typeof input.export_dir!=='string'||!input.export_dir.trim())throw Error('请输入导出文件夹路径。');const dir=resolve(input.export_dir.trim());checkDirectoryWritable(dir);store.set('export_dir',dir);return json(res,200,{ok:true})}
      if(path==='/api/folder'){mkdirSync(store.exportRoot,{recursive:true});await openFile('explorer.exe',[store.exportRoot]);return json(res,200,{ok:true})}
      const action=path.match(/^\/api\/targets\/([a-f0-9-]+)\/(check|pause|start|tail|settings|rebaseline|delete)$/)
      if(action){const [,id,verb]=action;store.target(id)
        if(['delete','rebaseline'].includes(verb)&&service.activeId===id)throw Error('该目标正在读取，请稍后再操作。')
        if(verb==='check'){if(store.get('viewer').status!=='ready')throw Error('请先登录查看账号。');service.enqueue(id)}
        if(verb==='pause')service.pause(id)
        if(verb==='start')store.update(id,{enabled:1,next_due:0})
        if(verb==='tail')store.flush({targetId:id,tail:true})
        if(verb==='rebaseline'){store.rebaseline(id);service.enqueue(id)}
        if(verb==='delete'){service.queue.delete(id);store.remove(id)}
        if(verb==='settings'){const interval=Number(input.interval_minutes);if(!Number.isInteger(interval)||interval<1||interval>1440)throw Error('检查间隔需要为1至1440分钟。');if(typeof input.label!=='string'||!input.label.trim()||input.label.length>80)throw Error('备注需为1至80字。');store.update(id,{label:input.label.trim(),interval_minutes:interval,next_due:0})}
        return json(res,200,{ok:true})
      }
      return json(res,404,{error:'操作不存在。'})
    }catch(e){return json(res,400,{error:/^[\u4e00-\u9fff]/.test(e.message)?e.message:'操作失败，请检查输入或数据目录。'})}
  })
  const app={store,service,server,address,async close(){if(closing)return;closing=true;await service.close();await new Promise(r=>server.close(r));store.close()}}
  if(autoTick)service.start();return app
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  createWatchApp({port:Number(process.env.WEIBO_MONITOR_PORT||8766)}).then(async app=>{console.log(app.address);for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close());if(process.argv.includes('--open'))await openFile(edgeExecutable(),[`--app=${app.address}`,'--window-size=1280,820'])}).catch(e=>{console.error(/^[\u4e00-\u9fff]/.test(e.message)?e.message:'启动失败，请先退出旧版后台，再重试。');process.exitCode=1})
}
