import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WatchStore,compareHeads} from './watch-store.mjs'
import {MonitorStore} from './monitor-store.mjs'
import {createHash} from 'node:crypto'

test('顶部插入、旧粉丝重新置顶、重复扫描、头部取关分别处理',()=>{
  assert.deepEqual(compareHeads(['11','12','13','14'],['15','11','12','13']).events,['15'])
  assert.deepEqual(compareHeads(['11','12','13','14'],['14','11','12','13']).events,['14'])
  assert.deepEqual(compareHeads(['14','11','12','13'],['14','11','12','13']).events,[])
  assert.deepEqual(compareHeads(['11','12','13','14'],['12','13','14']).events,[])
  assert.equal(compareHeads(['11','12','13'],['21','22','23']).reliable,false)
  assert.equal(compareHeads(['11','12','13','14'],['11','13','12','14']).reliable,false)
})
test('事件持久化：底册不计新增、重新关注重复 UID、60 条导出和重启幂等',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-store-'));let s=new WatchStore(root)
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})
  const target=s.addTarget('9001','目标');const baseline=['101','102','103','104'];
  const ingest=(uids)=>s.ingest(target.id,{targetUid:'9001',viewerUid:'8001',uids,total:999,complete:true})
  assert.equal(ingest(baseline).added,0)
  ingest(['104','101','102','103']);assert.equal(s.target(target.id).pending,1)
  ingest(['104','101','102','103']);assert.equal(s.target(target.id).pending,1)
  ingest(['101','102','103']);ingest(['104','101','102','103']);assert.equal(s.target(target.id).pending,2)
  const more=Array.from({length:59},(_,i)=>String(200+i));ingest([...more,'104','101','102','103'])
  assert.equal(s.target(target.id).pending,61);s.flush();assert.equal(s.target(target.id).pending,1)
  const b=s.batches()[0];const lines=readFileSync(b.path,'utf8').trim().split(/\r?\n/);assert.equal(lines.length,60);assert.equal(lines.filter(x=>x==='https://weibo.com/u/104').length,2);assert.ok(lines.every(x=>x.startsWith('https://weibo.com/u/')))
  assert.match(b.path, /\d{2}\.\d{2}_\d{2}\.\d{2}_目标_UID9001_60条\.txt$/)
  const oldId=s.databaseId;s.close();s=new WatchStore(root);assert.equal(s.databaseId,oldId);s.flush();assert.equal(s.batches().length,1)
  assert.throws(()=>s.ingest(target.id,{targetUid:'9002',uids:baseline,complete:true}),/目标/)
  const oldHead=s.target(target.id).head;ingest(['800','801','802']);assert.deepEqual(s.target(target.id).head,oldHead);assert.equal(s.target(target.id).status,'gap')
})

test('导出预留后中断可恢复，改目录不搬运旧批次，目标之间分别累计',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-recover-'));let s=new WatchStore(root);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})
  const a=s.addTarget('90001'),b=s.addTarget('90002');for(const target of [a,b])s.ingest(target.id,{targetUid:target.uid,uids:['101','102','103'],complete:true})
  const ids=Array.from({length:60},(_,i)=>String(1000+i));s.ingest(a.id,{targetUid:a.uid,uids:[...ids,'101','102','103'],complete:true});assert.throws(()=>s.flush({fault:()=>{throw Error('crash')}}),/crash/)
  const path=s.batches()[0].path;s.close();s=new WatchStore(root);s.set('export_dir',join(root,'changed'));s.flush();assert.equal(s.batches().length,1);assert.equal(s.batches()[0].path,path);assert.equal(readFileSync(path,'utf8').trim().split(/\r?\n/).length,60);assert.equal(s.target(b.id).total_new,0)
})

test('升级只继承一个查看账号和导出路径，不改旧数据库、不把旧账号当目标',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-upgrade-'));const old=new MonitorStore(root);const a=old.addAccount('旧账号','A');old.update(a.id,{owner:'80000001'});old.setSetting('export_dir',join(root,'chosen-exports'));old.close()
  const hash=()=>createHash('sha256').update(readFileSync(join(root,'monitor.sqlite'))).digest('hex');const before=hash();const s=new WatchStore(root);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})
  assert.equal(s.get('viewer').owner,'80000001');assert.equal(s.get('viewer').profile,'A');assert.equal(s.exportRoot,join(root,'chosen-exports'));assert.equal(s.targets().length,0);assert.equal(hash(),before)
})

test('顺位哨兵链机制：哨兵1取关顺延到哨兵2、连续多个哨兵取关顺延、旧粉重新关注跳到排头防误判',()=>{
  // 1. 哨兵1取关顺延到哨兵2
  const prev1=['s1','s2','s3','s4']
  const r1=compareHeads(prev1,['new1','new2','s2','s3','s4'])
  assert.equal(r1.reliable,true)
  assert.deepEqual(r1.events,['new1','new2'])

  // 哨兵1取关且无新增关注
  const r1_no_new=compareHeads(prev1,['s2','s3','s4'])
  assert.equal(r1_no_new.reliable,true)
  assert.deepEqual(r1_no_new.events,[])

  // 2. 连续多个哨兵取关顺延（哨兵1、哨兵2、哨兵3取关顺延到哨兵4）
  const prev2=['s1','s2','s3','s4','s5']
  const r2=compareHeads(prev2,['new1','s4','s5'])
  assert.equal(r2.reliable,true)
  assert.deepEqual(r2.events,['new1'])

  // 连续4个哨兵取关顺延到哨兵5
  const r2_multi=compareHeads(prev2,['new1','new2','s5'])
  assert.equal(r2_multi.reliable,true)
  assert.deepEqual(r2_multi.events,['new1','new2'])

  // 3. 旧粉重新关注跳到排头（防误判：以哨兵1为截点，哨兵5正常计入重关，不漏算中间新粉）
  const r3=compareHeads(prev2,['s5','new1','s1','s2','s3','s4'])
  assert.equal(r3.reliable,true)
  assert.deepEqual(r3.events,['s5','new1'])

  // 4. 哨兵1取关顺延到哨兵2，同时旧哨兵5重新关注跳到排头
  const r4=compareHeads(prev2,['s5','new1','s2','s3','s4'])
  assert.equal(r4.reliable,true)
  assert.deepEqual(r4.events,['s5','new1'])

  // 5. 后半段微调不报 gap（前 20 个哨兵稳定，第 25/26 名微调或取关）
  const longPrev=Array.from({length:60},(_,i)=>`fan_${1000+i}`)
  const longCur=['fan_new',...longPrev.slice(0,20),'fan_1025','fan_1024',...longPrev.slice(23,40)]
  const r5=compareHeads(longPrev,longCur)
  assert.equal(r5.reliable,true)
  assert.deepEqual(r5.events,['fan_new'])
})

test('智能自适应动态调频：活跃快巡(30s)、静默阶梯放缓(4~10min)、检测到新增瞬间回切高频档',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-adaptive-'))
  const s=new WatchStore(root)
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})

  const target=s.addTarget('99001','自适应目标')
  s.ingest(target.id,{targetUid:'99001',uids:['101','102','103'],total:100,complete:true})
  assert.equal(s.target(target.id).consecutive_zero,0)
  assert.equal(s.target(target.id).current_interval,120)

  s.ingest(target.id,{targetUid:'99001',uids:['101','102','103'],total:100,complete:true})
  assert.equal(s.target(target.id).consecutive_zero,1)
  assert.equal(s.target(target.id).current_interval,120)

  s.ingest(target.id,{targetUid:'99001',uids:['101','102','103'],total:100,complete:true})
  assert.equal(s.target(target.id).consecutive_zero,2)
  assert.equal(s.target(target.id).current_interval,120)

  // 连续 0 新增第 3 轮（放缓至 240 秒）
  s.ingest(target.id,{targetUid:'99001',uids:['101','102','103'],total:100,complete:true})
  assert.equal(s.target(target.id).consecutive_zero,3)
  assert.equal(s.target(target.id).current_interval,240)

  // 连续 0 新增到第 6 轮（放缓至 360 秒）
  for(let i=0;i<3;i++)s.ingest(target.id,{targetUid:'99001',uids:['101','102','103'],total:100,complete:true})
  assert.equal(s.target(target.id).consecutive_zero,6)
  assert.equal(s.target(target.id).current_interval,360)

  // 连续 0 新增到第 10 轮（放缓至 600 秒封顶）
  for(let i=0;i<4;i++)s.ingest(target.id,{targetUid:'99001',uids:['101','102','103'],total:100,complete:true})
  assert.equal(s.target(target.id).consecutive_zero,10)
  assert.equal(s.target(target.id).current_interval,600)

  // 出现新增粉丝：立即唤醒切回活跃快巡档（30秒），consecutive_zero 重置为 0
  s.ingest(target.id,{targetUid:'99001',uids:['104','101','102','103'],total:101,complete:true})
  assert.equal(s.target(target.id).consecutive_zero,0)
  assert.equal(s.target(target.id).current_interval,30)

  // 手动固定模式（adaptive = 0）：始终保持固定的 interval_minutes * 60
  s.update(target.id,{adaptive:0,interval_minutes:5})
  s.ingest(target.id,{targetUid:'99001',uids:['104','101','102','103'],total:101,complete:true})
  assert.equal(s.target(target.id).current_interval,300)
  s.ingest(target.id,{targetUid:'99001',uids:['104','101','102','103'],total:101,complete:true})
  assert.equal(s.target(target.id).current_interval,300)
})

test('多查看账号池：添加、查询、更新、移除及平滑迁移旧viewer',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-viewers-'))
  const s=new WatchStore(root)
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})

  assert.equal(s.viewers().length,1)
  assert.equal(s.get('viewer').profile,'viewer')

  const v2=s.addViewer('viewer_b','备用账号')
  assert.equal(s.viewers().length,2)
  assert.equal(v2.profile,'viewer_b')

  s.updateViewer(v2.id,{owner:'88880002',status:'ready',message:'运行良好'})
  assert.equal(s.viewer(v2.id).owner,'88880002')
  assert.equal(s.viewer(v2.id).status,'ready')

  s.removeViewer(v2.id)
  assert.equal(s.viewers().length,1)
  assert.throws(()=>s.removeViewer('not-exist-id'),/找不到/)
  assert.throws(()=>s.removeViewer(s.viewers()[0].id),/至少/)
})

test('导出文件格式：完整微博主页链接、文件名包含时间+博主备注+UID+条数，同名顺延_2',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-export-format-'))
  const s=new WatchStore(root)
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})

  const target=s.addTarget('1856404484','博主备注')
  s.ingest(target.id,{targetUid:'1856404484',uids:['101','102','103'],complete:true})

  // 模拟产生 120 个新增粉丝（分为 2 个 60 条批次）
  const fans=Array.from({length:120},(_,i)=>String(5000000000+i))
  s.ingest(target.id,{targetUid:'1856404484',uids:[...fans,'101','102','103'],complete:true})
  assert.equal(s.target(target.id).pending,120)

  const created=s.flush()
  assert.equal(created.length,2)

  const batches=s.batches(target.id)
  assert.equal(batches.length,2)

  // 检查第 1 个批次（较早的 60 条，文件名不带 _2）
  const b1=batches[1] // 按 id DESC 排序，所以 batches[1] 是第 1 个批次
  const b2=batches[0] // batches[0] 是第 2 个批次

  assert.match(b1.path, /\d{2}\.\d{2}_\d{2}\.\d{2}_博主备注_UID1856404484_60条\.txt$/)
  assert.match(b2.path, /\d{2}\.\d{2}_\d{2}\.\d{2}_博主备注_UID1856404484_60条_2\.txt$/)

  const content1=readFileSync(b1.path,'utf8').trim().split(/\r?\n/)
  assert.equal(content1.length,60)
  for(const line of content1){
    assert.match(line, /^https:\/\/weibo\.com\/u\/\d+$/)
  }
})

test('空列表防护：空列表不建立有效底册，compareHeads 对空底册返回不可靠',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-empty-'))
  const s=new WatchStore(root)
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})
  const target=s.addTarget('990001','防空目标')

  assert.throws(()=>s.ingest(target.id,{targetUid:'990001',uids:[],total:100,complete:true}),/没有读到有效粉丝列表/)
  assert.equal(s.target(target.id).head,null)

  assert.equal(compareHeads([],['1','2','3']).reliable,false)
  assert.equal(compareHeads(null,['1','2','3']).reliable,false)
})

test('断层自愈：连续两次断层（超速涨粉或关机过久）自动接续新底册恢复监控',t=>{
  const root=mkdtempSync(join(tmpdir(),'weibo-watch-gap-heal-'))
  const s=new WatchStore(root)
  t.after(()=>{s.close();rmSync(root,{recursive:true,force:true})})
  const target=s.addTarget('990002','自愈目标')
  s.ingest(target.id,{targetUid:'990002',uids:['1','2','3','4'],complete:true})

  const r1=s.ingest(target.id,{targetUid:'990002',uids:['101','102','103'],complete:true})
  assert.equal(r1.complete,false)
  assert.equal(s.target(target.id).status,'gap')
  assert.deepEqual(s.target(target.id).head,['1','2','3','4'])

  const r2=s.ingest(target.id,{targetUid:'990002',uids:['101','102','103'],complete:true})
  assert.equal(r2.complete,true)
  assert.equal(s.target(target.id).status,'ready')
  assert.deepEqual(s.target(target.id).head,['101','102','103'])
})
