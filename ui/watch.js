const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s),csrf=$('meta[name="csrf-token"]').content
let state=null,editing=null,toastTimer,refreshing=false,currentFilter='all',searchQuery=''
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const time=x=>x?new Date(x).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'尚未读取'
const labels={waiting:'等待底册',ready:'监控中',reading:'正在读取',gap:'需要核对',error:'读取异常',blocked:'受限冷却中','needs-login':'等待登录','logging-in':'正在登录'}

function toast(msg){$('#toast').textContent=msg;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4500)}
async function api(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'操作失败');return data}
async function action(fn){try{await fn();await refresh()}catch(e){toast(e.message)}}

async function refresh(){
  if(refreshing)return;refreshing=true
  try{
    state=await api('/api/state')
    render()
    $('#error').textContent=state.exportError
    $('#error').hidden=!state.exportError
  }catch(e){
    $('#error').textContent='后台连接失败，请重新打开软件。'
    $('#error').hidden=false
  }finally{refreshing=false}
}

function renderViewers(){
  const viewers=state.viewers||(state.viewer?[state.viewer]:[])
  const activeCount=(state.activeTargets||[]).length||(state.activeId?1:0)
  $('#cancelLogin').hidden=!state.loginOpen
  const v0=viewers[0]||state.viewer||{}
  if($('#viewerTitle'))$('#viewerTitle').textContent=v0.owner?`查看账号 UID ${v0.owner}`:'尚未登录微博'
  if($('#viewerMessage'))$('#viewerMessage').textContent=v0.message||(v0.status==='ready'?'已登录，可以监控博主。':'请先登录查看账号。')

  $('#viewersList').innerHTML=viewers.map(v=>{
    const isCooling=v.status==='blocked'&&(v.cooldown_until||0)>Date.now()
    const remainMin=isCooling?Math.ceil((v.cooldown_until-Date.now())/60000):0
    const statusText=isCooling?`受限冷却中（剩余 ${remainMin} 分钟）`:labels[v.status]||v.status
    const badgeClass=v.status==='ready'?'ready':(isCooling||v.status==='blocked')?'warn':v.status==='logging-in'?'info':'error'
    const ownerText=v.owner?`UID ${v.owner}`:'未绑定'
    return `<div class="viewer-card ${badgeClass}">
      <div class="vc-top">
        <div>
          <strong class="vc-label">${esc(v.label||v.profile)}</strong>
          <span class="vc-profile">(${esc(v.profile)})</span>
        </div>
        <span class="tag ${badgeClass==='warn'?'warn':badgeClass==='error'?'error':''}">${esc(statusText)}</span>
      </div>
      <div class="vc-info">
        <small>登录账号：<b>${esc(ownerText)}</b></small>
        <p class="vc-msg">${esc(v.message||'—')}</p>
      </div>
      <div class="vc-actions">
        <button data-vact="login" data-vid="${esc(v.id)}" ${state.loginOpen?'disabled':''}>${v.status==='ready'?'重新登录':'立即登录'}</button>
        ${viewers.length>1?`<button data-vact="delete" data-vid="${esc(v.id)}" class="danger" ${state.loginOpen?'disabled':''}>删除</button>`:''}
      </div>
    </div>`
  }).join('')
}

function render(){
  renderViewers()
  const activeCount=(state.activeTargets||[]).length||(state.activeId?1:0)
  $('#targetCount').textContent=state.targets.length
  $('#activeTargetsInfo').textContent=`${activeCount} 个正在并行巡检`
  $('#todayCount').textContent=state.targets.reduce((n,t)=>n+t.today_new,0)
  $('#pendingCount').textContent=state.targets.reduce((n,t)=>n+t.pending,0)
  $('#batchCount').textContent=state.batchCount

  // 更新筛选计数
  const cAll=state.targets.length
  const cRunning=state.targets.filter(t=>t.enabled&&['ready','reading','waiting'].includes(t.status)).length
  const cPending=state.targets.filter(t=>t.pending>0).length
  const cWarn=state.targets.filter(t=>['gap','blocked','error'].includes(t.status)).length
  const cPaused=state.targets.filter(t=>!t.enabled).length
  $('#countAll').textContent=cAll
  $('#countRunning').textContent=cRunning
  $('#countPending').textContent=cPending
  $('#countWarn').textContent=cWarn
  $('#countPaused').textContent=cPaused

  // 过滤目标
  let filtered=state.targets.filter(t=>{
    if(currentFilter==='running')return t.enabled&&['ready','reading','waiting'].includes(t.status)
    if(currentFilter==='pending')return t.pending>0
    if(currentFilter==='warn')return ['gap','blocked','error'].includes(t.status)
    if(currentFilter==='paused')return !t.enabled
    return true
  })
  if(searchQuery){
    const q=searchQuery.toLowerCase()
    filtered=filtered.filter(t=>t.uid.includes(q)||(t.label||'').toLowerCase().includes(q))
  }

  $('#empty').hidden=filtered.length>0

  $('#targets').innerHTML=filtered.map(t=>{
    const busy=(state.activeTargets||[]).includes(t.id)||state.activeId===t.id
    const badge=!t.enabled&&!busy?'已暂停':busy?'正在读取':labels[t.status]||t.status
    const wait=t.next_due>Date.now()?`${Math.max(1,Math.ceil((t.next_due-Date.now())/1000))} 秒后检查`:'等待依次检查'
    
    // 调频状态徽章
    const intervalSec=t.current_interval||((t.interval_minutes||2)*60)
    let rateBadge=''
    if(t.adaptive){
      if(intervalSec<=45)rateBadge=`<span class="rate-tag fast" title="检测到近期有新增，处于高频快巡档">⚡ 快巡 ${intervalSec}秒</span>`
      else if(intervalSec<=180)rateBadge=`<span class="rate-tag normal" title="常规巡检档">⏳ 常规 ${Math.round(intervalSec/60)}分钟</span>`
      else rateBadge=`<span class="rate-tag quiet" title="连续${t.consecutive_zero||0}轮无新增，已自动省流放缓">💤 省流 ${Math.round(intervalSec/60)}分钟</span>`
    }else{
      rateBadge=`<span class="rate-tag fixed" title="手动固定检查间隔">🔒 固定 ${t.interval_minutes}分钟</span>`
    }

    return `<article class="target" data-id="${esc(t.id)}">
      <div class="identity">
        <h3>${esc(t.label)}</h3>
        <small>UID ${esc(t.uid)}</small>
        <div class="mt-6">${rateBadge}</div>
      </div>
      <div>
        <span class="tag ${['gap','blocked'].includes(t.status)?'warn':t.status==='error'?'error':busy?'info':''}">${esc(badge)}</span>
        <p>${esc(t.message)}</p>
        <small>${t.enabled?esc(wait):'自动检查已暂停'}</small>
      </div>
      <div>
        <div class="metric-label">粉丝总数</div>
        <b>${t.total===null?'—':esc(t.total.toLocaleString())}</b>
        <small>顶部读取 ${t.read_count} 人</small>
      </div>
      <div>
        <div class="metric-label">待导出</div>
        <b class="number">${t.pending}</b>
        <small>满 60 条自动出文件</small>
      </div>
      <div>
        <div class="metric-label">最近成功读取</div>
        <b>${esc(time(t.last_success))}</b>
        <small>今日新增 ${t.today_new} 条</small>
      </div>
      <div class="buttons">
        <button data-action="check" ${busy?'disabled':''}>立即检查</button>
        <button data-action="${t.enabled?'pause':'start'}">${t.enabled?'暂停':'开始'}</button>
        <button data-action="detail">记录与文件</button>
        <button data-action="tail" ${t.pending?'':'disabled'}>导出尾数</button>
        <button data-action="settings">目标设置</button>
        ${t.status==='gap'?'<button data-action="rebaseline">重新建立底册</button>':''}
        <button data-action="delete" class="danger" ${busy?'disabled':''}>移除</button>
      </div>
    </article>`
  }).join('')
}

// 单个添加
$('#addForm').addEventListener('submit',e=>{
  e.preventDefault()
  action(async()=>{
    await api('/api/targets',{uid:$('#uid').value.trim(),label:$('#label').value.trim()})
    $('#addForm').reset()
    toast('监控目标已添加，首次读取不计新增。')
  })
})

// 批量添加
$('#openBatchAdd').onclick=()=>{
  $('#batchText').value=''
  $('#batchAddDialog').showModal()
}
$('#submitBatchAdd').onclick=()=>action(async()=>{
  const text=$('#batchText').value.trim()
  if(!text)throw Error('请输入至少一行目标 UID。')
  const res=await api('/api/targets/batch',{text})
  $('#batchAddDialog').close()
  toast(`批量导入完成：成功添加 ${res.added} 个，跳过重复或无效 ${res.skipped} 个。`)
})

// 批量操作
$('#batchStartBtn').onclick=()=>action(async()=>{
  const res=await api('/api/targets/batch-action',{action:'start'})
  toast(`已启动全部 ${res.count} 个监控目标。`)
})
$('#batchPauseBtn').onclick=()=>action(async()=>{
  const res=await api('/api/targets/batch-action',{action:'pause'})
  toast(`已暂停全部 ${res.count} 个监控目标。`)
})
$('#batchTailBtn').onclick=()=>action(async()=>{
  if(!confirm('确定将所有目标的现有尾数记录立即导出？'))return
  const res=await api('/api/targets/batch-action',{action:'tail'})
  toast(`已为 ${res.exportedCount} 个有未导出记录的目标生成文件。`)
})
$('#batchSettingsBtn').onclick=()=>{
  $('#batchSettingsDialog').showModal()
}
$('#batchSettingsForm').onsubmit=e=>{
  e.preventDefault()
  action(async()=>{
    const interval=Number($('#batchInterval').value)
    const adaptive=$('#batchAdaptive').checked?1:0
    const res=await api('/api/targets/batch-action',{action:'settings',interval_minutes:interval,adaptive})
    $('#batchSettingsDialog').close()
    toast(`已统一更新全部 ${res.count} 个目标的检查间隔与调频模式。`)
  })
}

// 筛选与搜索
$('#statusFilters').onclick=e=>{
  const tab=e.target.closest('.filter-tab')
  if(!tab)return
  $$('#statusFilters .filter-tab').forEach(b=>b.classList.remove('active'))
  tab.classList.add('active')
  currentFilter=tab.dataset.filter
  render()
}
$('#searchInput').addEventListener('input',e=>{
  searchQuery=e.target.value.trim()
  render()
})

// 查看账号池交互
$('#addViewerBtn').onclick=()=>{
  const nextNum=(state.viewers||[]).length+1
  $('#viewerProfileInput').value=`viewer_${nextNum}`
  $('#viewerLabelInput').value=`查看小号${nextNum}`
  $('#addViewerDialog').showModal()
}
$('#addViewerForm').onsubmit=e=>{
  e.preventDefault()
  action(async()=>{
    await api('/api/viewers',{profile:$('#viewerProfileInput').value.trim(),label:$('#viewerLabelInput').value.trim()})
    $('#addViewerDialog').close()
    toast('查看小号已添加，请点击对应卡片的“立即登录”进行微博认证。')
  })
}
$('#viewersList').onclick=e=>{
  const b=e.target.closest('button[data-vact]')
  if(!b)return
  const act=b.dataset.vact,vid=b.dataset.vid
  action(async()=>{
    if(act==='login'){
      await api(`/api/viewers/${vid}/login`,{})
      toast('正在打开登录窗口，请在微博窗口中扫码或登录…')
    }
    if(act==='delete'){
      if(!confirm('确定移除这个查看小号？'))return
      await api(`/api/viewers/${vid}/delete`,{})
      toast('查看小号已移除。')
    }
  })
}

// 通用对话框与全局按钮
$('#cancelLogin').onclick=()=>action(()=>api('/api/cancel-login',{}))
$('#folder').onclick=()=>action(async()=>{
  await api('/api/folder',{})
  toast('已打开导出文件夹')
})
$('#settings').onclick=()=>{if(!state)return;$('#exportDir').value=state.exportRoot;$('#settingsDialog').showModal()}
$('#help').onclick=()=>$('#helpDialog').showModal()
$('#settingsForm').onsubmit=e=>{
  e.preventDefault()
  action(async()=>{
    await api('/api/settings',{export_dir:$('#exportDir').value})
    $('#settingsDialog').close()
    toast('设置已保存。')
  })
}
$('#targetForm').onsubmit=e=>{
  e.preventDefault()
  action(async()=>{
    await api(`/api/targets/${editing}/settings`,{
      label:$('#targetLabel').value,
      interval_minutes:Number($('#targetInterval').value),
      adaptive:$('#targetAdaptive').checked?1:0
    })
    $('#targetDialog').close()
    toast('目标设置已保存。')
  })
}
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close())
$('#exit').onclick=()=>{if(confirm('退出后将停止所有监控，记录会保留。确定退出？'))action(async()=>{await api('/api/stop',{});toast('程序正在退出。')})}

// 目标列表单个操作
$('#targets').onclick=e=>{
  const button=e.target.closest('[data-action]')
  if(!button)return
  const id=button.closest('[data-id]').dataset.id,verb=button.dataset.action,t=state.targets.find(t=>t.id===id)
  action(async()=>{
    if(verb==='settings'){
      editing=id
      $('#targetLabel').value=t.label
      $('#targetInterval').value=t.interval_minutes
      $('#targetAdaptive').checked=!!t.adaptive
      $('#targetDialog').showModal()
      return
    }
    if(verb==='detail'){
      const d=await api('/api/targets/'+id)
      $('#detailTitle').textContent=t.label+' · 记录与文件'
      $('#detailContent').innerHTML=`<h3>导出文件</h3>${d.batches.map(b=>`<div class="file">${esc(b.path)}<br><small>${esc(time(b.at))} · ${b.count} 条 · ${b.status==='ready'?'已生成':'待写入'}</small><br><a href="/api/batches/${b.id}/download">下载 UID 文件</a></div>`).join('')||'<p>尚未生成文件，满 60 条自动导出。</p>'}<h3>最近关注记录</h3><table><thead><tr><th>UID</th><th>发现时间</th><th>导出状态</th></tr></thead><tbody>${d.events.map(x=>`<tr><td>${esc(x.uid)}</td><td>${esc(time(x.at))}</td><td>${x.batch_id?'已分配批次':'待导出'}</td></tr>`).join('')||'<tr><td colspan="3">暂无新增记录</td></tr>'}</tbody></table><h3>最近读取</h3>${d.scans.slice(0,5).map(s=>`<p>${esc(time(s.at))} · 读取 ${s.count} 人 · 新增 ${s.added} 条<br>${esc(s.message)}</p>`).join('')}`
      $('#detailDialog').showModal()
      return
    }
    if(verb==='tail'&&!confirm(`把“${t.label}”当前 ${t.pending} 条记录立即导出？`))return
    if(verb==='delete'&&!confirm(`移除“${t.label}”及它的本地底册和记录？已经生成的文件会保留。`))return
    if(verb==='rebaseline'&&!confirm('重新把当前可见顶部作为底册？无法衔接期间的关注不再追溯，已有新增记录保留。'))return
    await api(`/api/targets/${id}/${verb}`,{})
    toast(verb==='tail'?'导出完成。':verb==='check'?'已加入检查队列。':'操作已完成。')
  })
}

refresh()
setInterval(refresh,3000)
