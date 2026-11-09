import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:net'
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'

const project=dirname(fileURLToPath(import.meta.url)),root=mkdtempSync(join(tmpdir(),'weibo-native-launch-'))
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r))
const address=`http://127.0.0.1:${port}/`,env={...process.env,WEIBO_MONITOR_DATA_DIR:root,WEIBO_MONITOR_PORT:String(port)}
async function launch(file){
  const child=spawn(file,['--verify'],{env,windowsHide:true,stdio:'ignore'})
  const [code]=await once(child,'exit',{signal:AbortSignal.timeout(45000)})
  assert.equal(code,0,existsSync(join(root,'launcher-error.log'))?readFileSync(join(root,'launcher-error.log'),'utf8'):'EXE 启动失败')
  return (await fetch(address+'api/state')).json()
}
async function post(path,data){const html=await(await fetch(address)).text(),csrf=html.match(/name="csrf-token" content="([^"]+)"/)[1];return fetch(address+path,{method:'POST',headers:{Origin:new URL(address).origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)})}
async function stop(){await post('api/stop',{});for(let i=0;i<100;i++){try{await fetch(address+'api/state')}catch{return}await new Promise(r=>setTimeout(r,50))}throw Error('后台未退出')}
try {
  const first=await launch(join(project,'dist','微博粉丝助手_0.2.1','微博粉丝助手.exe'))
  assert.equal(first.version,'0.2.1');assert.equal(first.accounts.length,0)
  const added=await post('api/accounts',{label:'独立启动验证'});assert.equal(added.status,200)
  const repeated=await launch(join(project,'启动新版微博粉丝助手.exe'))
  assert.equal(repeated.pid,first.pid);assert.equal(repeated.databaseId,first.databaseId);assert.equal(repeated.accounts.length,1)
  await stop()
  const restarted=await launch(join(project,'启动新版微博粉丝助手.exe'))
  assert.equal(restarted.accounts.length,1);assert.equal(restarted.databaseId,first.databaseId)
  await stop()
  console.log('EXE：独立启动、重复点击复用同一进程、根目录入口、重启保留数据，全部通过。')
}finally{
  try{const s=await(await fetch(address+'api/state')).json();if(s.dataRoot===root)await stop()}catch{}
  if(dirname(root)===tmpdir())rmSync(root,{recursive:true,force:true})
}
