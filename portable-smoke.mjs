import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const root=dirname(fileURLToPath(import.meta.url)),out=join(root,'dist','微博粉丝助手_0.1.0')
const temp=mkdtempSync(join(tmpdir(),'weibo-portable-')),probe=createServer()
await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
const child=spawn(join(out,'runtime','node.exe'),['--disable-warning=ExperimentalWarning',join(out,'app','monitor-app.mjs')],{env:{...process.env,WEIBO_MONITOR_DATA_DIR:temp,WEIBO_MONITOR_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']})
const stopped=once(child,'exit'),lines=createInterface({input:child.stdout})
try{
  const [line]=await Promise.race([once(lines,'line',{signal:AbortSignal.timeout(15000)}),stopped.then(()=>{throw Error('便携后台启动失败')})])
  const address=line.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];assert.ok(address)
  const state=await (await fetch(address+'api/state')).json();assert.equal(state.app,'weibo-follower-monitor');assert.equal(state.accounts.length,0)
  const html=await (await fetch(address)).text(),csrf=html.match(/name="csrf-token" content="([^"]+)"/)[1]
  const post=(path,data)=>fetch(address+path,{method:'POST',headers:{Origin:new URL(address).origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)})
  assert.equal((await post('api/accounts',{label:'便携启动验证'})).status,200)
  assert.equal((await (await fetch(address+'api/state')).json()).accounts.length,1)
  await post('api/stop',{});await stopped
  console.log('便携包自带 Node：启动、数据库、添加账号、正常退出全部通过。')
}finally{
  lines.close();if(child.exitCode===null){child.kill();await stopped}
  if(dirname(temp)===tmpdir())rmSync(temp,{recursive:true,force:true})
}
