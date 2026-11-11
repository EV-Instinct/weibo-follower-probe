import { mkdirSync,copyFileSync,readdirSync,writeFileSync,existsSync,unlinkSync } from 'node:fs'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root=dirname(fileURLToPath(import.meta.url)),out=join(root,'dist','微博粉丝助手_0.3.0')
// fs.cpSync crashes in this Windows runtime on the Chinese workspace path.
// Copy explicitly; fail on unexpected links instead of following outside the package.
function copyTree(source,target){
  mkdirSync(target,{recursive:true})
  for(const item of readdirSync(source,{withFileTypes:true})){
    if(item.isSymbolicLink())throw Error('打包源包含意外的符号链接。')
    if(item.isDirectory())copyTree(join(source,item.name),join(target,item.name))
    else copyFileSync(join(source,item.name),join(target,item.name))
  }
}
mkdirSync(join(out,'app','node_modules'),{recursive:true});mkdirSync(join(out,'runtime'),{recursive:true})
for(const file of ['watch-app.mjs','watch-store.mjs','watch-service.mjs','watch-browser.mjs','monitor-browser.mjs','monitor-store.mjs','monitor-system.mjs','weibo-a.mjs','browser-round.mjs','observations.mjs','observation-store.mjs'])copyFileSync(join(root,file),join(out,'app',file))
copyTree(join(root,'ui'),join(out,'app','ui'))
copyTree(join(root,'node_modules','playwright-core'),join(out,'app','node_modules','playwright-core'))
try{copyFileSync(process.execPath,join(out,'runtime','node.exe'))}catch(e){if(e.code==='EBUSY'&&existsSync(join(out,'runtime','node.exe')))console.log('runtime/node.exe 正在被运行中的实例占用，沿用已有可执行文件。');else throw e}
for(const name of ['LICENSE','LICENSE.txt'])if(existsSync(join(dirname(process.execPath),name)))copyFileSync(join(dirname(process.execPath),name),join(out,'runtime',name))
copyFileSync(join(root,'third-party','Node-LICENSE.txt'),join(out,'runtime','LICENSE.txt'))
const compiler=join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe')
execFileSync(compiler,['/nologo','/target:winexe','/optimize+','/platform:anycpu','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',`/out:${join(out,'微博粉丝助手.exe')}`,join(root,'launcher','Launcher.cs')],{windowsHide:true,stdio:'inherit'})
copyFileSync(join(out,'微博粉丝助手.exe'),join(root,'启动新版微博粉丝助手.exe'))
for(const extra of ['使用说明.md','版本.txt','启动微博粉丝助手.cmd','启动调试.cmd']){
  const p=join(out,extra)
  if(existsSync(p))unlinkSync(p)
}
console.log(out)
