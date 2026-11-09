import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WatchStore} from './watch-store.mjs'
import {WatchService} from './watch-service.mjs'

test('同一查看账号串行读取、登录失效保留底册、目标之间记录隔离',async t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-service-'));const s=new WatchStore(root);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})});s.set('viewer',{owner:'80001',profile:'viewer',status:'ready'})
  const a=s.addTarget('90001'),b=s.addTarget('90002');let reading=0,max=0,fail=false;const reader={async scanTarget(viewer,target){reading++;max=Math.max(max,reading);await new Promise(r=>setTimeout(r,10));reading--;if(fail)throw Error('登录已失效。');return {viewerUid:viewer.owner,targetUid:target.uid,uids:['101','102','103'],total:500,complete:true}},async close(){}}
  const service=new WatchService(s,reader);await Promise.all([service.tick(),service.tick(),service.tick()]);await service.tick();assert.equal(max,1);assert.ok(s.target(a.id).baseline_at);assert.ok(s.target(b.id).baseline_at);assert.equal(s.target(a.id).pending,0)
  fail=true;service.enqueue(a.id);await service.tick();assert.equal(s.get('viewer').status,'needs-login');assert.deepEqual(s.target(a.id).head,['101','102','103']);assert.equal(s.target(b.id).pending,0);await service.close()
})
