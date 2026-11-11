export class WatchService{
  constructor(store,reader){
    this.store=store;this.reader=reader;this.activeId=null;this.loginOpening=false;this.stopped=false;this.exportError='';this.queue=new Set()
    this.busyViewers=new Set();this.runningTargets=new Set();this.activeTargets=new Map();this.loginViewerId=null
  }
  get busy(){return this.runningTargets.size>0}
  get activeTargetIds(){return [...this.runningTargets]}
  async login(viewerId=null){
    if(this.loginOpening||this.reader.login)throw Error('已有登录窗口，请稍后再试。')
    const v=viewerId?this.store.viewer(viewerId):(this.store.viewers().find(x=>x.status==='needs-login')||this.store.viewers()[0])
    if(!v)throw Error('没有找到查看账号。')
    this.loginOpening=true;this.loginViewerId=v.id
    try{
      await this.reader.openLogin({...v,id:v.id})
      this.store.updateViewer(v.id,{status:'logging-in',message:'请在微博窗口中完成登录。'})
    }finally{this.loginOpening=false}
  }
  enqueue(id){this.store.target(id);this.queue.add(id)}
  pause(id){this.queue.delete(id);this.store.update(id,{enabled:0})}
  async dispatchScan(viewer,targetId){
    this.busyViewers.add(viewer.id)
    this.runningTargets.add(targetId)
    this.activeTargets.set(targetId,viewer.id)
    this.activeId=[...this.runningTargets][0]||null
    const target=this.store.target(targetId)
    this.store.update(targetId,{status:'reading',message:`正在读取列表顶部…`,last_attempt:new Date().toISOString()})
    try{
      const scan=await this.reader.scanTarget(viewer,target,{anchors:target.head||[]})
      if(this.stopped)return
      if(scan.viewerUid!==viewer.owner)throw Error('登录身份不一致，请重新登录原查看账号。')
      this.store.ingest(targetId,scan)
      const updated=this.store.target(targetId)
      const intervalSec=updated.current_interval||(updated.interval_minutes*60)
      this.store.update(targetId,{next_due:Date.now()+intervalSec*1000})
      try{this.store.flush();this.exportError=''}catch(e){this.exportError=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'导出失败，记录已保留。'}
    }catch(e){
      const message=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'读取失败，底册和已有记录已保留，下轮重试。'
      const blocked=/验证|受限|频繁/.test(message),login=/登录/.test(message)
      if(blocked){
        this.store.updateViewer(viewer.id,{status:'blocked',message:`该账号访问受限（${message}），已进入冷却。`,cooldown_until:Date.now()+3600000})
        await this.reader.closeViewerSession?.(viewer.id).catch(()=>{})
      }else if(login){
        this.store.updateViewer(viewer.id,{status:'needs-login',message})
        await this.reader.closeViewerSession?.(viewer.id).catch(()=>{})
      }
      const otherReady=this.store.viewers().some(v=>v.id!==viewer.id&&v.status==='ready'&&v.owner&&((v.cooldown_until||0)<=Date.now()))
      if((blocked||login)&&otherReady){
        // 故障转移：池中有可用账号接管，目标不设为停摆，立即重新加入队列
        this.store.update(targetId,{status:'waiting',message:'上个查看账号受限，已自动由其他账号接管继续检测。',next_due:0})
        this.queue.add(targetId)
      }else{
        this.store.update(targetId,{status:login?'needs-login':blocked?'blocked':'error',message,next_due:Date.now()+(blocked?60:Math.max(target.interval_minutes,5))*60000})
        if(blocked&&!otherReady){
          for(const t of this.store.targets())this.store.update(t.id,{next_due:Date.now()+3600000})
          this.queue.clear()
        }
      }
    }finally{
      await new Promise(r=>setTimeout(r,50))
      this.busyViewers.delete(viewer.id)
      this.runningTargets.delete(targetId)
      this.activeTargets.delete(targetId)
      this.activeId=[...this.runningTargets][0]||null
    }
  }
  async tick(){
    if(this.stopped||this.loginOpening)return
    this.store.assertStorageCurrent()
    if(this.reader.login){
      const login=await this.reader.loginState()
      const vid=this.loginViewerId||this.reader.login.id||'viewer'
      let viewer;try{viewer=this.store.viewer(vid)}catch{viewer=this.store.get('viewer')}
      if(login?.closed){
        this.store.updateViewer(vid,{status:'needs-login',message:'登录窗口已关闭，请重新登录。'})
        this.loginViewerId=null
      }
      if(login?.ready){
        if(viewer?.owner&&viewer.owner!==login.owner){
          await this.reader.cancelLogin()
          this.store.updateViewer(vid,{status:'needs-login',message:'请登录原来的查看账号，避免切换身份影响底册。'})
        }else{
          await this.reader.cancelLogin()
          this.store.updateViewer(vid,{owner:login.owner,status:'ready',message:'已登录，可查看目标博主。',cooldown_until:0})
          for(const t of this.store.targets().filter(t=>t.enabled))this.store.update(t.id,{next_due:0})
        }
        this.loginViewerId=null
      }
      return
    }
    try{this.store.flush();this.exportError=''}catch(e){this.exportError=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'导出失败，记录已保留，请检查导出目录。'}
    const now=Date.now()
    const readyViewers=this.store.viewers().filter(v=>v.status==='ready'&&v.owner&&((v.cooldown_until||0)<=now)&&!this.busyViewers.has(v.id))
    if(!readyViewers.length||this.stopped)return
    const queuedIds=[...this.queue].filter(id=>!this.runningTargets.has(id))
    const dueTargets=this.store.targets().filter(t=>t.enabled&&t.next_due<=now&&!this.runningTargets.has(t.id)).sort((a,b)=>a.next_due-b.next_due)
    const candidateIds=[...new Set([...queuedIds,...dueTargets.map(t=>t.id)])]
    if(!candidateIds.length)return
    const count=Math.min(readyViewers.length,candidateIds.length)
    const tasks=[]
    for(let i=0;i<count;i++){
      const viewer=readyViewers[i]
      const targetId=candidateIds[i]
      this.queue.delete(targetId)
      tasks.push(this.dispatchScan(viewer,targetId))
    }
    await Promise.all(tasks)
  }
  start(){this.timer=setInterval(()=>this.tick().catch(e=>{this.exportError=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'后台异常，请退出后重启。'}),1000);this.timer.unref()}
  async close(){
    this.stopped=true
    clearInterval(this.timer)
    const deadline=Date.now()+3000
    while(this.loginOpening&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30))
    await this.reader.close().catch(()=>{})
    while(this.runningTargets.size>0&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30))
  }
}
