const $ = id => document.getElementById(id)
const csrf = document.querySelector('meta[name="csrf-token"]').content

let state = { accounts: [], activeIds: [] }
let currentFilter = 'all'
let searchQuery = ''
let selectedAccountId = null
let activeDrawerTab = 'followers'
let menuAccountId = null
let confirmAction = null
let editId = null
let stopped = false
let toastTimer = null

const statusTextMap = {
  'needs-login': '需要登录',
  'logging-in': '等待登录',
  checking: '正在读取',
  ready: '监测中',
  incomplete: '读取中断',
  error: '检查失败',
  blocked: '访问受限',
  'needs-action': '需要处理'
}

function time(value) {
  if (!value) return '—'
  const d = new Date(value)
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23'
  })
}

function formatMinutesLeft(due) {
  if (!due) return '等待调度'
  const diff = due - Date.now()
  if (diff <= 0) return '即将检查'
  const mins = Math.max(1, Math.round(diff / 60000))
  return `${mins} 分钟后检查`
}

function el(tag, text, className) {
  const n = document.createElement(tag)
  if (text != null) n.textContent = text
  if (className) n.className = className
  return n
}

function toast(text) {
  const t = $('toast')
  t.textContent = text
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 4000)
}

async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(data)
  })
  const value = await response.json()
  if (!response.ok) throw Error(value.error ?? '操作失败')
  return value
}

async function action(fn, button) {
  if (button) button.disabled = true
  try {
    await fn()
    await refresh()
  } catch (e) {
    toast(e.message)
  } finally {
    if (button) button.disabled = false
  }
}

function confirm(title, text, fn) {
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  confirmAction = fn
  $('confirm-dialog').showModal()
}

function copyText(str, successMessage) {
  navigator.clipboard.writeText(str).then(() => {
    toast(successMessage)
  }).catch(() => {
    toast('复制失败，请手动选择复制。')
  })
}

function getAccountFilterType(a) {
  if (a.status === 'needs-login' || a.status === 'logging-in' || !a.owner) return 'login'
  if (['error', 'incomplete', 'blocked', 'needs-action'].includes(a.status)) return 'error'
  if (!a.enabled) return 'paused'
  return 'normal'
}

function filterAccounts() {
  const q = searchQuery.trim().toLowerCase()
  return state.accounts.filter(a => {
    const type = getAccountFilterType(a)
    if (currentFilter !== 'all' && type !== currentFilter) return false
    if (!q) return true
    const nick = (a.nickname || '').toLowerCase()
    const label = (a.label || '').toLowerCase()
    const owner = (a.owner || '').toLowerCase()
    return nick.includes(q) || label.includes(q) || owner.includes(q)
  })
}

function renderOverview() {
  const accounts = state.accounts
  $('account-count').textContent = accounts.length

  const normalCount = accounts.filter(a => getAccountFilterType(a) === 'normal').length
  const loginCount = accounts.filter(a => getAccountFilterType(a) === 'login').length
  const errorCount = accounts.filter(a => getAccountFilterType(a) === 'error').length
  const pausedCount = accounts.filter(a => getAccountFilterType(a) === 'paused').length

  $('account-sub').textContent = `正常 ${normalCount} / 需登录 ${loginCount}`
  $('today-count').textContent = accounts.reduce((n, a) => n + (a.today_new || 0), 0)
  $('pending-count').textContent = accounts.reduce((n, a) => n + (a.pending || 0), 0)
  $('batch-count').textContent = accounts.reduce((n, a) => n + (a.exported_batches || 0), 0)
  $('export-path').textContent = state.exportRoot ?? ''

  $('count-all').textContent = accounts.length
  $('count-normal').textContent = normalCount
  $('count-login').textContent = loginCount
  $('count-error').textContent = errorCount
  $('count-paused').textContent = pausedCount

  const activeSet = new Set(state.activeIds ?? (state.activeId ? [state.activeId] : []))
  const activeAccounts = accounts.filter(a => activeSet.has(a.id))
  const statusBadge = $('app-status')

  if (activeAccounts.length > 0) {
    statusBadge.className = 'app-status-badge busy'
    statusBadge.textContent = `正在检查 ${activeAccounts.map(a => a.nickname || a.label).join('、')}`
  } else if (accounts.some(a => a.enabled)) {
    statusBadge.className = 'app-status-badge running'
    statusBadge.textContent = '运行中'
  } else {
    statusBadge.className = 'app-status-badge stopped'
    statusBadge.textContent = '已停止'
  }

  $('alert').hidden = !state.exportError
  $('alert').textContent = state.exportError ? `${state.exportError} 后台会自动重试。` : ''
}

function openDropdown(button, accountId) {
  menuAccountId = accountId
  const menu = $('dropdown-menu')
  const rect = button.getBoundingClientRect()
  menu.hidden = false
  menu.style.top = `${rect.bottom + 4}px`
  menu.style.left = `${Math.min(window.innerWidth - 160, rect.left - 100)}px`

  const account = state.accounts.find(a => a.id === accountId)
  if (account) {
    $('menu-toggle-pause').textContent = account.enabled ? '暂停监测' : '恢复监测'
  }
}

function closeDropdown() {
  $('dropdown-menu').hidden = true
  menuAccountId = null
}

function renderList() {
  const filtered = filterAccounts()
  const tbody = $('accounts')
  const activeSet = new Set(state.activeIds ?? (state.activeId ? [state.activeId] : []))

  $('empty').hidden = state.accounts.length > 0
  $('no-search-results').hidden = state.accounts.length === 0 || filtered.length > 0
  document.querySelector('.table-wrap').hidden = state.accounts.length === 0

  tbody.replaceChildren(...filtered.map(a => {
    const row = el('tr')
    row.dataset.id = a.id
    if (selectedAccountId === a.id) row.classList.add('selected-row')

    // 1. 账号信息
    const tdAccount = el('td', null, 'td-account')
    const primaryName = a.nickname ? a.nickname : a.label
    const nickEl = el('span', primaryName, 'acc-nickname')
    const subWrap = el('div', null, 'acc-label-owner')

    if (a.nickname && a.label) {
      subWrap.append(el('span', a.label, 'acc-tag'))
    }
    subWrap.append(el('span', a.owner ? `UID ${a.owner}` : '尚未绑定微博账号'))
    tdAccount.append(nickEl, subWrap)

    // 2. 状态标签与说明
    const tdStatus = el('td', null, 'td-status')
    tdStatus.dataset.label = '状态：'
    const filterType = getAccountFilterType(a)
    let badgeClass = 'status-badge normal'
    let badgeLabel = '监测中'
    let descText = a.enabled ? (a.next_due ? formatMinutesLeft(a.next_due) : '等待调度') : '已暂停检查'

    if (activeSet.has(a.id) || a.status === 'checking') {
      badgeClass = 'status-badge reading'
      badgeLabel = '正在读取'
      descText = a.read_count ? `已读 ${a.read_count} 个` : (a.message || '正在读取粉丝列表...')
    } else if (filterType === 'login') {
      badgeClass = 'status-badge login'
      badgeLabel = '需要登录'
      descText = '点击登录绑定微博'
    } else if (filterType === 'error') {
      badgeClass = 'status-badge error'
      badgeLabel = statusTextMap[a.status] ?? '异常'
      descText = a.message || '请查看检查记录'
    } else if (filterType === 'paused') {
      badgeClass = 'status-badge paused'
      badgeLabel = '已暂停'
      descText = '已暂停自动检查'
    }

    tdStatus.append(el('span', badgeLabel, badgeClass))
    tdStatus.append(el('span', descText, 'status-desc'))

    // 3. 粉丝数
    const tdFollowers = el('td', null, 'td-followers')
    tdFollowers.dataset.label = '粉丝数：'
    const totalCountText = a.displayed_total != null ? `${a.displayed_total}` : '—'
    const readCountText = ` / ${a.read_count ?? 0}`
    tdFollowers.append(el('span', totalCountText, 'bold-num'), el('span', readCountText, 'time-text'))

    // 4. 今日新增
    const tdToday = el('td', null, 'td-today')
    tdToday.dataset.label = '今日新增：'
    tdToday.append(el('span', `${a.today_new ?? 0}`, 'today-num'))

    // 5. 待导出
    const tdPending = el('td', null, 'td-pending')
    tdPending.dataset.label = '待导出：'
    const pendingWrap = el('div', null, 'pending-wrap')
    const progress = document.createElement('progress')
    progress.className = 'pending-progress'
    progress.value = Math.min(60, a.pending || 0)
    progress.max = 60
    pendingWrap.append(el('span', `${a.pending || 0} / 60`, 'pending-text'), progress)
    if (a.candidates) {
      pendingWrap.append(el('span', `待确认 ${a.candidates}`, 'pending-sub'))
    }
    tdPending.append(pendingWrap)

    // 6. 最近检查时间
    const tdTime = el('td', null, 'td-time')
    tdTime.dataset.label = '最近检查：'
    tdTime.append(el('span', time(a.last_success || a.last_attempt), 'time-text'))

    // 7. 操作区
    const tdOps = el('td', null, 'td-ops')
    const opsWrap = el('div', null, 'row-ops')

    // 主按钮逻辑
    const mainBtn = el('button', '', 'btn-action-main primary')
    if (filterType === 'login') {
      mainBtn.textContent = '登录绑定'
      mainBtn.onclick = e => {
        e.stopPropagation()
        action(() => api(`/api/accounts/${a.id}/login`, {}), mainBtn)
      }
      opsWrap.append(mainBtn)
    } else if (a.enabled) {
      mainBtn.textContent = '立即检查'
      mainBtn.onclick = e => {
        e.stopPropagation()
        action(() => api(`/api/accounts/${a.id}/check`, {}), mainBtn)
      }
      opsWrap.append(mainBtn)
    } else {
      mainBtn.textContent = '恢复'
      mainBtn.onclick = e => {
        e.stopPropagation()
        action(() => api(`/api/accounts/${a.id}/start`, {}), mainBtn)
      }
      opsWrap.append(mainBtn)
    }

    // 导出按钮（一直显示，没有待导出时变灰）
    const exportBtn = el('button', '导出', 'btn-action-export')
    if (!a.pending || a.pending <= 0) {
      exportBtn.disabled = true
      exportBtn.title = '暂无新 UID'
    } else {
      exportBtn.title = `导出当前 ${a.pending} 个未导出的 UID`
      exportBtn.onclick = e => {
        e.stopPropagation()
        const displayName = a.nickname || a.label
        confirm(
          '导出未满60个的记录',
          `将为「${displayName}」生成当前剩余 ${a.pending} 个 UID 的文件，之后不会重复导出这些记录。`,
          () => api(`/api/accounts/${a.id}/tail`, {})
        )
      }
    }
    opsWrap.append(exportBtn)

    // 更多菜单按钮「⋯」
    const moreBtn = el('button', '⋯', 'btn-more')
    moreBtn.title = '更多操作'
    moreBtn.onclick = e => {
      e.stopPropagation()
      openDropdown(moreBtn, a.id)
    }
    opsWrap.append(moreBtn)

    tdOps.append(opsWrap)
    row.append(tdAccount, tdStatus, tdFollowers, tdToday, tdPending, tdTime, tdOps)

    // 点击行打开详情抽屉
    row.onclick = e => {
      if (e.target.closest('button') || e.target.closest('a') || e.target.closest('.dropdown-menu')) return
      openDrawer(a.id)
    }

    return row
  }))
}

async function openDrawer(accountId) {
  selectedAccountId = accountId
  renderList()
  $('drawer-backdrop').hidden = false
  $('detail-drawer').hidden = false
  await loadDrawerDetail(accountId)
}

function closeDrawer() {
  selectedAccountId = null
  $('drawer-backdrop').hidden = true
  $('detail-drawer').hidden = true
  renderList()
}

async function loadDrawerDetail(accountId) {
  const account = state.accounts.find(a => a.id === accountId)
  if (!account) return

  $('drawer-account-name').textContent = account.nickname || account.label
  $('drawer-account-sub').textContent = account.owner ? `UID: ${account.owner} · 备注: ${account.label}` : `备注: ${account.label}（尚未绑定）`

  try {
    const detail = await (await fetch(`/api/accounts/${accountId}/detail`)).json()
    if (!detail || detail.error) return

    // 1. 最近新增选项卡
    const followers = detail.recent_followers || []
    const unexported = detail.unexported_uids || []
    $('unexported-summary').textContent = `待导出 ${unexported.length} 个（共显示最近 ${followers.length} 条记录）`

    const followersList = $('followers-list')
    if (!followers.length) {
      followersList.replaceChildren(el('div', '暂无新增 UID 记录。', 'empty-tip'))
    } else {
      followersList.replaceChildren(...followers.map(f => {
        const item = el('div', null, 'drawer-item')
        const left = el('div', null, 'item-left')
        left.append(el('span', f.uid, 'item-title'))
        left.append(el('span', `发现时间: ${time(f.confirmed_at || f.first_seen)}`, 'item-sub'))

        const right = el('div', null, 'item-actions')
        const badge = el('span', f.is_exported ? '已导出' : '未导出', `status-badge ${f.is_exported ? 'normal' : 'warn'}`)
        const copyBtn = el('button', '复制', 'btn-mini quiet-btn')
        copyBtn.onclick = () => copyText(f.uid, `已复制 UID: ${f.uid}`)

        right.append(badge, copyBtn)
        item.append(left, right)
        return item
      }))
    }

    $('btn-copy-unexported').onclick = () => {
      if (!unexported.length) {
        toast('暂无未导出的 UID。')
        return
      }
      copyText(unexported.join('\r\n'), `已复制 ${unexported.length} 个未导出 UID 到剪贴板`)
    }

    // 2. 导出文件选项卡
    const batches = detail.batches || []
    $('batches-summary').textContent = `已生成 ${batches.length} 份文件`
    const batchesList = $('batches-list')

    if (!batches.length) {
      batchesList.replaceChildren(el('div', '尚未生成导出文件。每累计满 60 个 UID 会自动生成文件。', 'empty-tip'))
    } else {
      batchesList.replaceChildren(...batches.map(b => {
        const item = el('div', null, 'drawer-item')
        const left = el('div', null, 'item-left')
        const fileName = (b.relative_path || '').split(/[\\/]/).pop() || `批次 #${b.id}`
        left.append(el('span', fileName, 'item-title'))
        left.append(el('span', `${b.count} 个 UID · ${time(b.created_at)}`, 'item-sub'))

        const actions = el('div', null, 'item-actions')
        const openBtn = el('button', '定位', 'btn-mini quiet-btn')
        openBtn.title = '在文件夹中定位此文件'
        openBtn.onclick = () => action(async () => {
          await api(`/api/batches/${b.id}/open`, {})
          toast('已在资源管理器中定位文件。')
        }, openBtn)

        const copyContentBtn = el('button', '复制内容', 'btn-mini quiet-btn')
        copyContentBtn.title = '复制该文件内的全部 UID'
        copyContentBtn.onclick = () => action(async () => {
          const res = await api(`/api/batches/${b.id}/content`, {})
          copyText(res.content, '已复制文件内容到剪贴板')
        }, copyContentBtn)

        const dlLink = el('a', '下载', 'btn-mini quiet-btn')
        dlLink.href = `/api/batches/${b.id}/file`
        dlLink.download = ''

        actions.append(openBtn, copyContentBtn, dlLink)
        item.append(left, actions)
        return item
      }))
    }

    $('btn-open-account-folder').onclick = () => action(async () => {
      await api(`/api/accounts/${accountId}/folder`, {})
      toast('已打开该账号导出文件夹。')
    }, $('btn-open-account-folder'))

    // 3. 检查记录选项卡
    const scans = detail.recent_scans || []
    const scansList = $('scans-list')

    if (!scans.length) {
      scansList.replaceChildren(el('div', '暂无检查记录。', 'empty-tip'))
    } else {
      scansList.replaceChildren(...scans.map(s => {
        const item = el('div', null, 'drawer-item')
        const left = el('div', null, 'item-left')

        let modeText = '增量读取'
        if (s.mode === 'baseline') modeText = '初始建立'
        else if (s.mode === 'full') modeText = '完整读取'
        else if (s.mode === 'legacy') modeText = '历史导入'

        const addedText = s.added != null ? `新增 ${s.added} 个` : (s.complete ? '完成' : '未完成')
        left.append(el('span', `${modeText} · ${addedText}`, 'item-title'))

        let reasonCn = s.reason
        if (s.reason === 'incremental-hit') reasonCn = '连续读到已知粉丝，正常结束'
        else if (s.reason === 'visible-end') reasonCn = '已滚至页面末尾'
        else if (s.reason === 'window-budget') reasonCn = '读满 40 屏未遇已知粉丝，转入候选'
        else if (s.reason === 'visible-complete') reasonCn = '完整读取完成'
        else if (s.reason === 'legacy-history-import') reasonCn = '导入旧版历史记录'

        left.append(el('span', `${time(s.at)} · 读取 ${s.read_count} 个 · ${reasonCn || '正常'}`, 'item-sub'))

        const right = el('div', null, 'item-actions')
        const statusBadge = el('span', s.complete ? '成功' : '未到末尾', `status-badge ${s.complete ? 'normal' : 'warn'}`)
        right.append(statusBadge)

        item.append(left, right)
        return item
      }))
    }
  } catch {
    // 忽略详情拉取静默失败
  }
}

function editAccount(account) {
  editId = account?.id ?? null
  $('dialog-title').textContent = account ? '修改账号设置' : '添加微博账号'
  $('label').value = account?.label ?? ''
  $('interval').value = account?.interval_minutes ?? 10
  $('interval-field').hidden = !account
  $('account-dialog').showModal()
  $('label').focus()
}

async function refresh() {
  if (stopped) return
  try {
    state = await api('/api/state')
    renderOverview()
    renderList()
    if (selectedAccountId) {
      loadDrawerDetail(selectedAccountId)
    }
  } catch {
    $('app-status').className = 'app-status-badge stopped'
    $('app-status').textContent = '未连接后台'
  }
}

// 绑定筛选事件
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    currentFilter = btn.dataset.filter
    renderList()
  }
})

// 搜索事件
$('search-input').oninput = e => {
  searchQuery = e.target.value
  renderList()
}

// 抽屉选项卡事件
document.querySelectorAll('.drawer-tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.drawer-tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.drawer-pane').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    activeDrawerTab = btn.dataset.tab
    $(`tab-${activeDrawerTab}`).classList.add('active')
  }
})

// 抽屉关闭事件
$('drawer-close').onclick = $('drawer-backdrop').onclick = closeDrawer

// 下拉菜单外部点击关闭
document.addEventListener('click', e => {
  if (!e.target.closest('#dropdown-menu') && !e.target.closest('.btn-more')) {
    closeDropdown()
  }
})

// 下拉菜单项事件
$('menu-relogin').onclick = () => {
  const id = menuAccountId
  closeDropdown()
  if (id) action(() => api(`/api/accounts/${id}/login`, {}))
}

$('menu-toggle-pause').onclick = () => {
  const id = menuAccountId
  closeDropdown()
  if (!id) return
  const account = state.accounts.find(a => a.id === id)
  if (account) {
    action(() => api(`/api/accounts/${id}/${account.enabled ? 'pause' : 'start'}`, {}))
  }
}

$('menu-settings').onclick = () => {
  const id = menuAccountId
  closeDropdown()
  if (!id) return
  const account = state.accounts.find(a => a.id === id)
  if (account) editAccount(account)
}

$('menu-view-detail').onclick = () => {
  const id = menuAccountId
  closeDropdown()
  if (id) openDrawer(id)
}

$('menu-delete').onclick = () => {
  const id = menuAccountId
  closeDropdown()
  if (!id) return
  const account = state.accounts.find(a => a.id === id)
  const name = account ? (account.nickname || account.label) : '此账号'
  confirm('删除账号', `确定要删除「${name}」吗？历史记录会删除，已导出的文件保留在原位置。`, async () => {
    await api(`/api/accounts/${id}/delete`, {})
    if (selectedAccountId === id) closeDrawer()
    toast(`已删除账号「${name}」。`)
  })
}

// 批量按钮事件
$('batch-start').onclick = () => {
  confirm('全部开始监测', '确定要为所有已绑定的账号开启定时监测吗？未登录账号除外。', async () => {
    const res = await api('/api/batch-actions', { action: 'start' })
    toast(`已为 ${res.count || 0} 个账号开启定时监测。`)
  })
}

$('batch-pause').onclick = () => {
  confirm('全部暂停监测', '确定要暂停所有账号的定时监测吗？', async () => {
    await api('/api/batch-actions', { action: 'pause' })
    toast('已暂停所有账号的监测。')
  })
}

$('batch-tail').onclick = () => {
  confirm('全部导出尾数', '确定要为所有有待导出的账号生成当前尾数文件吗？之后不会重复导出这些记录。', async () => {
    const res = await api('/api/batch-actions', { action: 'tail' })
    toast(`已为有待导出的账号生成 ${res.count || 0} 份尾数文件。`)
  })
}

// 头部和主功能按钮
$('folder').onclick = () => action(() => api('/api/folder', {}), $('folder'))
$('add').onclick = $('empty-add').onclick = () => editAccount()

$('btn-settings').onclick = () => {
  $('settings-concurrency').value = state.concurrency || 1
  $('settings-dialog').showModal()
}

$('settings-concurrency').onchange = () => action(async () => {
  await api('/api/settings', { concurrency: Number($('settings-concurrency').value) })
  toast('同时读取账号数已更新。')
})

$('btn-help').onclick = () => {
  $('help-dialog').showModal()
}

$('exit').onclick = () => {
  confirm('退出微博粉丝助手', '退出后停止所有检查，已有记录与待导出 UID 会保留。下次启动可继续。', async () => {
    await api('/api/stop', {})
    stopped = true
    $('app-status').className = 'app-status-badge stopped'
    $('app-status').textContent = '已退出程序'
    toast('已停止后台检查，数据已安全保存。')
  })
}

// 模态弹窗关闭与表单提交
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close())

$('account-form').onsubmit = e => {
  e.preventDefault()
  action(async () => {
    if (editId) {
      await api(`/api/accounts/${editId}/settings`, {
        label: $('label').value,
        interval: Number($('interval').value)
      })
      toast('账号设置已保存。')
    } else {
      await api('/api/accounts', { label: $('label').value })
      toast('账号已添加，请点击“登录绑定”。')
    }
    $('account-dialog').close()
  }, e.submitter)
}

$('confirm-yes').onclick = () => action(async () => {
  await confirmAction?.()
  $('confirm-dialog').close()
}, $('confirm-yes'))

await refresh()
setInterval(refresh, 2000)
