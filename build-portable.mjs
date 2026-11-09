import { mkdirSync,copyFileSync,readdirSync,writeFileSync,existsSync,unlinkSync } from 'node:fs'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=dirname(fileURLToPath(import.meta.url)),out=join(root,'dist','微博粉丝助手_0.2.0')
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
for(const file of ['monitor-app.mjs','monitor-service.mjs','monitor-browser.mjs','monitor-store.mjs','monitor-logger.mjs','monitor-system.mjs','weibo-a.mjs','browser-round.mjs','observations.mjs','observation-store.mjs'])copyFileSync(join(root,file),join(out,'app',file))
copyTree(join(root,'ui'),join(out,'app','ui'))
copyTree(join(root,'node_modules','playwright-core'),join(out,'app','node_modules','playwright-core'))
copyFileSync(process.execPath,join(out,'runtime','node.exe'))
for(const name of ['LICENSE','LICENSE.txt'])if(existsSync(join(dirname(process.execPath),name)))copyFileSync(join(dirname(process.execPath),name),join(out,'runtime',name))
copyFileSync(join(root,'third-party','Node-LICENSE.txt'),join(out,'runtime','LICENSE.txt'))
writeFileSync(join(out,'启动微博粉丝助手.vbs'),'Set ws = CreateObject("WScript.Shell")\r\nSet fso = CreateObject("Scripting.FileSystemObject")\r\ncurDir = fso.GetParentFolderName(WScript.ScriptFullName)\r\nws.Run Chr(34) & curDir & "\\runtime\\node.exe" & Chr(34) & " --disable-warning=ExperimentalWarning " & Chr(34) & curDir & "\\app\\monitor-app.mjs" & Chr(34) & " --open", 0, False\r\n')
writeFileSync(join(out,'启动微博粉丝助手.cmd'),'@echo off\r\nwscript //nologo "%~dp0启动微博粉丝助手.vbs"\r\n')
writeFileSync(join(out,'启动调试.cmd'),'@echo off\r\n"%~dp0runtime\\node.exe" --disable-warning=ExperimentalWarning "%~dp0app\\monitor-app.mjs" --open\r\npause\r\n')
copyFileSync(join(root,'使用说明.md'),join(out,'使用说明.md'))
writeFileSync(join(out,'版本.txt'),'微博粉丝助手 0.2.0\r\nWindows + Microsoft Edge\r\n内含 Node.js 运行时和 Playwright Core；不含任何账号登录资料、密码、真实 UID 或监测数据库。\r\n')
console.log(out)
