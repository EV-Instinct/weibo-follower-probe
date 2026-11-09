import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MonitorStore} from './monitor-store.mjs'
import {createMonitorApp} from './monitor-app.mjs'

function setup(t){const root=mkdtempSync(join(tmpdir(),'weibo-safety-'));let store=new MonitorStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})});return{root,get store(){return store},reopen(){store.close();store=new MonitorStore(root)}}}
test('用户选择5分钟后，重启不得当作旧版默认值改回10分钟',t=>{
  const env=setup(t),a=env.store.addAccount('账号')
  env.store.update(a.id,{interval_minutes:5});env.reopen()
  assert.equal(env.store.account(a.id).interval_minutes,5)
})
test('切换导出目录后，旧批次保留原路径且不复制到新目录',t=>{
  const {store,root}=setup(t),a=store.addAccount('账号')
  store.ingest(a.id,{owner:'9988776655',uids:[],total:0,complete:true,reason:'visible-end'})
  store.ingest(a.id,{owner:'9988776655',uids:['9988776656'],total:1,complete:true,reason:'visible-end'})
  const first=join(root,'one'),second=join(root,'two');store.setSetting('export_dir',first);store.flush({tail:true})
  const batch=store.batches()[0];store.setSetting('export_dir',second);store.flush()
  assert.equal(store.getBatchFilePath(batch),join(first,batch.relative_path))
  assert.equal(existsSync(join(second,batch.relative_path)),false)
})
test('数据库身份与打开时不一致时明确停止，避免向错误库继续写入',t=>{
  const {store}=setup(t);assert.doesNotThrow(()=>store.assertStorageCurrent())
  store.setSetting('database_id','replacement-database')
  assert.throws(()=>store.assertStorageCurrent(),/数据库.*变化/)
})
test('端口占用时不创建或迁移第二份数据库',async t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-instance-')),other=join(root,'other')
  const reader={async close(){}}
  const app=await createMonitorApp({root,port:0,reader,autoTick:false,importProfiles:false})
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true})})
  await assert.rejects(()=>createMonitorApp({root:other,port:app.server.address().port,reader,autoTick:false,importProfiles:false}),{code:'EADDRINUSE'})
  assert.equal(existsSync(join(other,'monitor.sqlite')),false)
})
