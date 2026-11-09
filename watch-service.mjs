export class WatchService{
  constructor(store,reader){this.store=store;this.reader=reader;this.busy=false;this.activeId=null;this.loginOpening=false;this.stopped=false;this.exportError='';this.queue=new Set()}
  async login(){if(this.busy||this.loginOpening||this.reader.login)throw Error('正在读取或已有登录窗口，请稍后再试。');this.loginOpening=true;try{await this.reader.openLogin({...this.store.get('viewer'),id:'viewer'});this.store.set('viewer',{...this.store.get('viewer'),status:'logging-in',message:'请在微博窗口中完成登录。'})}finally{this.loginOpening=false}}
  enqueue(id){this.store.target(id);this.queue.add(id)}
  pause(id){this.queue.delete(id);this.store.update(id,{enabled:0})}
  async tick(){
    if(this.busy||this.stopped||this.loginOpening)return;this.busy=true
    try{
      this.store.assertStorageCurrent()
      if(this.reader.login){
        const login=await this.reader.loginState();const viewer=this.store.get('viewer')
        if(login?.closed)this.store.set('viewer',{...viewer,status:'needs-login',message:'登录窗口已关闭，请重新登录。'})
        if(login?.ready){if(viewer.owner&&viewer.owner!==login.owner){await this.reader.cancelLogin();this.store.set('viewer',{...viewer,status:'needs-login',message:'请登录原来的查看账号，避免切换身份影响底册。'})}else{await this.reader.cancelLogin();this.store.set('viewer',{...viewer,owner:login.owner,status:'ready',message:'已登录，可查看目标博主。'});for(const t of this.store.targets().filter(t=>t.enabled))this.store.update(t.id,{next_due:0})}}
        return
      }
      try{this.store.flush();this.exportError=''}catch(e){this.exportError=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'导出失败，记录已保留，请检查导出目录。'}
      const viewer=this.store.get('viewer');if(viewer.status!=='ready'||this.stopped)return
      const id=[...this.queue][0]??this.store.targets().filter(t=>t.enabled&&t.next_due<=Date.now()).sort((a,b)=>a.next_due-b.next_due)[0]?.id
      if(!id)return;this.queue.delete(id);this.activeId=id;const target=this.store.target(id)
      this.store.update(id,{status:'reading',message:'正在读取列表顶部…',last_attempt:new Date().toISOString()})
      try{
        const scan=await this.reader.scanTarget(viewer,target)
        if(this.stopped)return
        if(scan.viewerUid!==viewer.owner)throw Error('登录身份不一致，请重新登录原查看账号。')
        this.store.ingest(id,scan)
        this.store.update(id,{next_due:Date.now()+target.interval_minutes*60000})
        try{this.store.flush();this.exportError=''}catch(e){this.exportError=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'导出失败，记录已保留。'}
      }catch(e){
        const message=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'读取失败，底册和已有记录已保留，下轮重试。'
        const blocked=/验证|受限|频繁/.test(message),login=/登录/.test(message)
        this.store.update(id,{status:login?'needs-login':blocked?'blocked':'error',message,next_due:Date.now()+(blocked?60:Math.max(target.interval_minutes,5))*60000})
        if(login)this.store.set('viewer',{...viewer,status:'needs-login',message})
        // A shared login restriction applies to every target; do not rotate targets through it.
        if(blocked)for(const t of this.store.targets())this.store.update(t.id,{next_due:Date.now()+3600000})
        if(blocked)this.queue.clear()
      }finally{this.activeId=null}
    }finally{this.busy=false}
  }
  start(){this.timer=setInterval(()=>this.tick().catch(e=>{this.exportError=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'后台异常，请退出后重启。'}),2000);this.timer.unref()}
  async close(){this.stopped=true;clearInterval(this.timer);while(this.loginOpening)await new Promise(r=>setTimeout(r,30));await this.reader.close();while(this.busy)await new Promise(r=>setTimeout(r,30))}
}
