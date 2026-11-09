export class MonitorService {
  constructor(store,reader){this.store=store;this.reader=reader;this.queue=new Set();this.activeId=null;this.busy=false;this.stopped=false;this.exportError='';this.loginOpening=false}
  enqueue(id){this.store.account(id);if(this.activeId!==id)this.queue.add(id)}
  pause(id){this.store.update(id,{enabled:0});this.queue.delete(id)}
  async login(id){
    if(this.busy||this.loginOpening)throw Error('正在处理当前操作，请稍后再打开登录窗口。')
    if(this.reader.login)throw Error('请先完成或取消当前账号的登录。')
    this.store.account(id);this.loginOpening=true;this.pause(id)
    try{await this.reader.openLogin(this.store.account(id));this.store.update(id,{status:'logging-in',message:'请在独立浏览器里登录，成功后自动读取并开始监测。'})}
    finally{this.loginOpening=false}
  }
  async tick() {
    if(this.busy||this.stopped||this.loginOpening)return
    this.busy=true
    try {
      if(!this.loginOpening&&this.reader.loginState){
        const login=await this.reader.loginState()
        if(login?.closed)this.store.update(login.id,{status:'needs-login',message:'登录窗口已关闭，点击登录账号重试。'})
        if(login?.ready){this.store.update(login.id,{enabled:1});this.enqueue(login.id)}
      }
      const loginId=this.reader.login?.id
      let id=[...this.queue].find(id=>id!==loginId||this.store.account(id).enabled)
      if(!id)id=this.store.accounts().filter(a=>a.enabled&&a.id!==loginId&&a.next_due<=Date.now()).sort((a,b)=>a.next_due-b.next_due)[0]?.id
      if(id){
        this.queue.delete(id);this.activeId=id
        const a=this.store.account(id)
        this.store.update(id,{status:'checking',message:a.baseline_at?'正在读取并比较粉丝列表。':'正在建立初始粉丝记录，本轮已有粉丝不导出。',last_attempt:new Date().toISOString()})
        try {
          const snapshot=await this.reader.scan(a)
          const result=this.store.ingest(id,snapshot)
          this.store.update(id,{next_due:Date.now()+a.interval_minutes*60000})
          if(result.complete&&snapshot.visibilityLimited)this.store.update(id,{message:'已完成可见列表比对；微博提示部分账号可能不展示。'})
        } catch(e) {
          const failures=a.failures+1
          const safe=e instanceof Error&&/^[\u4e00-\u9fff]/.test(e.message)?e.message:'读取失败，已保留历史记录，请稍后重试。'
          const loginIssue=/登录|验证码|访问限制/.test(safe)
          this.store.update(id,{status:loginIssue?'needs-login':'error',message:safe,failures,next_due:Date.now()+Math.min(60,a.interval_minutes*2**Math.min(failures,4))*60000,...(loginIssue?{enabled:0}:{})})
        } finally {this.activeId=null}
      }
      try{this.store.flush();this.exportError=''}catch(e){this.exportError=/^[\u4e00-\u9fff]/.test(e.message)?e.message:'导出失败，请检查导出目录空间和写入权限；数据已保留。'}
    } finally {this.busy=false}
  }
  start(){this.timer=setInterval(()=>this.tick().catch(()=>{this.exportError='后台检查遇到异常，请检查数据目录后重启。'}),2000);this.timer.unref()}
  async close(){this.stopped=true;clearInterval(this.timer);await this.reader.close();while(this.busy)await new Promise(r=>setTimeout(r,50))}
}
