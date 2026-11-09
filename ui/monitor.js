const $=id=>document.getElementById(id)
const csrf=document.querySelector('meta[name="csrf-token"]').content
let state={accounts:[]},editId=null,confirmAction=null,stopped=false,lastRender='',toastTimer
const labels={'needs-login':'需要登录','logging-in':'等待登录',checking:'正在读取',ready:'监测中',incomplete:'读取不完整',error:'检查失败'}
function time(value){return value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—'}
function el(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000)}
async function api(path,data){const response=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw Error(value.error??'操作失败');return value}
async function action(fn,button){if(button)button.disabled=true;try{await fn();await refresh()}catch(e){toast(e.message)}finally{if(button)button.disabled=false}}
function confirm(title,text,fn){$('confirm-title').textContent=title;$('confirm-text').textContent=text;confirmAction=fn;$('confirm-dialog').showModal()}
function edit(account){editId=account?.id??null;$('dialog-title').textContent=account?'账号设置':'添加账号';$('label').value=account?.label??'';$('interval').value=account?.interval_minutes??5;$('interval-field').hidden=!account;$('account-dialog').showModal();$('label').focus()}
function button(label,fn){const b=el('button',label);b.onclick=()=>action(()=>fn(b),b);return b}
function render(){
  const accounts=state.accounts
  $('account-count').textContent=accounts.length;$('today-count').textContent=accounts.reduce((n,a)=>n+a.today_new,0)
  $('pending-count').textContent=accounts.reduce((n,a)=>n+a.pending,0);$('batch-count').textContent=accounts.reduce((n,a)=>n+a.exported_batches,0)
  $('export-path').textContent=state.exportRoot??''
  const active=accounts.find(a=>a.id===state.activeId)
  $('activity').textContent=active?`正在检查 ${active.label} · 账号依次处理`:`${accounts.filter(a=>a.enabled).length} 个账号已开启定时检查 · 默认每 5 分钟`
  $('alert').hidden=!state.exportError;$('alert').textContent=state.exportError?`${state.exportError} 后台会自动重试。`:''
  $('empty').hidden=accounts.length>0;document.querySelector('.table-wrap').hidden=!accounts.length
  const key=JSON.stringify([accounts,state.activeId,state.loginId]);if(key===lastRender)return;lastRender=key
  $('accounts').replaceChildren(...accounts.map(a=>{
    const row=el('tr'),name=el('td');name.append(el('strong',a.label),el('span',a.owner?`UID ${a.owner}`:'尚未绑定微博账号','sub'));row.append(name)
    const status=el('td'),paused=!a.enabled&&!['checking','logging-in','needs-login','error','incomplete'].includes(a.status)
    status.append(el('span',paused?'已暂停':labels[a.status]??a.status,`badge ${['error','needs-login'].includes(a.status)?'error':['incomplete','logging-in'].includes(a.status)?'warn':''}`))
    status.append(el('span',a.message||'点击登录账号完成绑定','sub'));if(a.baseline_at)status.append(el('span',`监测起点 ${time(a.baseline_at)}`,'sub'));row.append(status)
    const counts=el('td',`${a.displayed_total??'—'} / ${a.read_count}`);counts.append(el('span',a.baseline_at?'已建立初始记录':'尚未完成初始化','sub'));row.append(counts,el('td',a.today_new))
    const pending=el('td',`${a.pending} / 60`);if(a.candidates)pending.append(el('span',`待确认 ${a.candidates}`,'sub'));if(a.waiting_files)pending.append(el('span',`待写入 ${a.waiting_files} 份`,'sub'));row.append(pending,el('td',time(a.last_success)))
    const operations=el('td'),wrap=el('div',null,'row-actions'),base=`/api/accounts/${a.id}/`
    wrap.append(button('登录账号',()=>api(base+'login',{})),button(a.enabled?'暂停':'开始监测',()=>api(base+(a.enabled?'pause':'start'),{})),button('检查一次',()=>api(base+'check',{})),button('设置',()=>edit(a)))
    if(state.loginId===a.id)wrap.append(button('取消登录',()=>api(base+'cancel-login',{})))
    if(a.pending)wrap.append(button('导出尾数',()=>confirm('导出未满60个的记录',`将为「${a.label}」生成当前剩余 UID 的文件，之后不会重复导出这些记录。`,()=>api(base+'tail',{}))))
    if(state.activeId===a.id)for(const b of wrap.querySelectorAll('button'))if(b.textContent!=='暂停')b.disabled=true
    operations.append(wrap);row.append(operations);return row
  }))
}
async function refresh(){if(stopped)return;try{state=await api('/api/state');render()}catch{$('activity').textContent='后台未连接，请重新打开应用。'}}
$('add').onclick=$('empty-add').onclick=()=>edit()
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close())
$('account-form').onsubmit=e=>{e.preventDefault();action(async()=>{if(editId)await api(`/api/accounts/${editId}/settings`,{label:$('label').value,interval:Number($('interval').value)});else await api('/api/accounts',{label:$('label').value});$('account-dialog').close();toast(editId?'设置已保存':'账号已添加，请点击登录账号。')},e.submitter)}
$('folder').onclick=()=>action(()=>api('/api/folder',{}),$('folder'))
$('history').onclick=()=>action(async()=>{const batches=await api('/api/batches');$('batches').replaceChildren(...batches.map(b=>{const row=el('div',null,'batch'),text=el('div');text.append(el('strong',`${b.label} · ${b.count} 个`),el('span',b.relative_path,'sub'));row.append(text);if(b.status==='ready'){const link=el('a','下载文件');link.href=`/api/batches/${b.id}/file`;link.download='';row.append(link)}else row.append(el('span','等待写入'));return row}));if(!batches.length)$('batches').append(el('p','还没有生成文件。每个账号累计满60个后会自动出现在这里。'));$('history-dialog').showModal()},$('history'))
$('confirm-yes').onclick=()=>action(async()=>{await confirmAction?.();$('confirm-dialog').close()},$('confirm-yes'))
$('exit').onclick=()=>confirm('退出微博粉丝助手','退出后停止所有检查，已有记录与待导出 UID 会保留。下次双击启动可继续。',async()=>{await api('/api/stop',{});stopped=true;$('activity').textContent='程序已退出，可以关闭此窗口。';toast('已停止后台检查，数据已保存。')})
await refresh();setInterval(refresh,2000)
