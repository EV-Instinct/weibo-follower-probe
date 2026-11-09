const isTestEnv = typeof process !== 'undefined' && Boolean(
  process.env?.NODE_TEST_CONTEXT ||
  process.env?.NODE_ENV === 'test' ||
  process.argv?.some(a => a.includes('.test.')) ||
  process.execArgv?.some(a => a.startsWith('--test'))
)

export class MonitorService {
  constructor(store, reader, { minDelay, maxDelay } = {}) {
    this.store = store
    this.reader = reader
    this.queue = new Set()
    this.activeIds = new Set()
    this.stopped = false
    this.exportError = ''
    this.loginOpening = false
    this.ticking = false
    this.minDelay = minDelay !== undefined ? minDelay : (isTestEnv ? 0 : 5000)
    this.maxDelay = maxDelay !== undefined ? maxDelay : (isTestEnv ? 0 : 20000)
  }

  get activeId() { return [...this.activeIds][0] ?? null }
  get busy() { return this.activeIds.size > 0 }
  get concurrency() {
    return Math.min(3, Math.max(1, Number(this.store.getSetting('concurrency', '1')) || 1))
  }

  enqueue(id) {
    this.store.account(id)
    if (!this.activeIds.has(id)) this.queue.add(id)
  }

  pause(id) {
    this.store.update(id, { enabled: 0 })
    this.queue.delete(id)
  }

  async login(id) {
    if (this.busy || this.loginOpening) throw Error('正在处理当前操作，请稍后再打开登录窗口。')
    if (this.reader.login) throw Error('请先完成或取消当前账号的登录。')
    this.store.account(id)
    this.loginOpening = true
    this.pause(id)
    try {
      await this.reader.openLogin(this.store.account(id))
      this.store.update(id, { status: 'logging-in', message: '请在独立浏览器里登录，成功后自动读取并开始监测。' })
    } finally {
      this.loginOpening = false
    }
  }

  async processAccount(id) {
    this.activeIds.add(id)
    const a = this.store.account(id)
    const mode = !a.baseline_at ? 'baseline' : a.full_scan_needed ? 'full' : 'incremental'
    const message = mode === 'baseline'
      ? '正在建立初始粉丝记录，本轮已有粉丝不导出。'
      : mode === 'full'
        ? '正在完整读取粉丝列表。'
        : '正在读取并比较粉丝列表。'
    this.store.update(id, {
      status: 'checking',
      message,
      last_attempt: new Date().toISOString()
    })

    try {
      const knownUids = this.store.getKnownUids(id)
      const snapshot = await this.reader.scan(a, {
        mode,
        isKnown: uid => knownUids.has(uid)
      })
      const result = this.store.ingest(id, snapshot, { mode })

      const jitter = 0.8 + Math.random() * 0.4
      const nextInterval = Math.round(a.interval_minutes * 60000 * jitter)
      this.store.update(id, {
        next_due: Date.now() + nextInterval,
        blocked_count: 0,
        failures: 0
      })
      if (result.complete && snapshot.visibilityLimited) {
        const cur = this.store.account(id)
        this.store.update(id, { message: cur.message + '；微博提示部分账号可能不展示。' })
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      const isBlocked = /验证码|访问限制|访问受限|访问异常|操作频繁|安全验证|access-blocked|拒绝访问/.test(errMsg)
      const isLogin = /登录/.test(errMsg) && !isBlocked

      if (isBlocked) {
        const blockedCount = (a.blocked_count || 0) + 1
        if (blockedCount >= 3) {
          this.store.update(id, {
            status: 'needs-action',
            message: '连续3次遇到验证码或访问限制，已停止自动检查，请点击登录账号处理。',
            enabled: 0,
            blocked_count: blockedCount,
            failures: a.failures + 1
          })
        } else {
          this.store.update(id, {
            status: 'blocked',
            message: `遇到验证码或访问限制（第 ${blockedCount} 次），已暂停 60 分钟后重试。`,
            next_due: Date.now() + 60 * 60 * 1000,
            blocked_count: blockedCount,
            failures: a.failures + 1
          })
        }
      } else if (isLogin) {
        this.store.update(id, {
          status: 'needs-login',
          message: '登录已失效，请点击登录账号。',
          enabled: 0,
          failures: a.failures + 1
        })
      } else {
        const safe = /^[\u4e00-\u9fff]/.test(errMsg) ? errMsg : '读取失败，已保留历史记录，请稍后重试。'
        const failures = a.failures + 1
        const backoffMin = Math.min(60, a.interval_minutes * (2 ** Math.min(failures, 4)))
        this.store.update(id, {
          status: 'error',
          message: safe,
          failures,
          next_due: Date.now() + backoffMin * 60000
        })
      }
    } finally {
      if (this.maxDelay > 0) {
        const delay = this.minDelay + Math.random() * (this.maxDelay - this.minDelay)
        if (delay > 0) await new Promise(r => setTimeout(r, delay))
      }
      this.activeIds.delete(id)
    }
  }

  async tick() {
    if (this.ticking || this.stopped || this.loginOpening) return
    this.ticking = true
    try {
      if (!this.loginOpening && this.reader.loginState) {
        const login = await this.reader.loginState()
        if (login?.closed) this.store.update(login.id, { status: 'needs-login', message: '登录窗口已关闭，点击登录账号重试。' })
        if (login?.ready) {
          this.store.update(login.id, {
            enabled: 1,
            ...(login.nickname ? { nickname: login.nickname } : {})
          })
          this.enqueue(login.id)
        }
      }

      const maxConcurrency = this.concurrency
      const loginId = this.reader.login?.id
      const launched = []

      while (this.activeIds.size + launched.length < maxConcurrency && !this.stopped && !this.loginOpening) {
        let id = [...this.queue].find(i => !this.activeIds.has(i) && !launched.includes(i) && (i !== loginId || this.store.account(i).enabled))
        if (!id) {
          id = this.store.accounts()
            .filter(a => a.enabled && !this.activeIds.has(a.id) && !launched.includes(a.id) && a.id !== loginId && a.next_due <= Date.now())
            .sort((a, b) => a.next_due - b.next_due)[0]?.id
        }
        if (!id) break
        this.queue.delete(id)
        launched.push(id)
      }

      if (launched.length > 0) {
        await Promise.all(launched.map(id => this.processAccount(id)))
      }

      try {
        this.store.flush()
        this.exportError = ''
      } catch (e) {
        this.exportError = /^[\u4e00-\u9fff]/.test(e.message) ? e.message : '导出失败，请检查导出目录空间和写入权限；数据已保留。'
      }
    } finally {
      this.ticking = false
    }
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {
      this.exportError = '后台检查遇到异常，请检查数据目录后重启。'
    }), 2000)
    this.timer.unref()
  }

  async close() {
    this.stopped = true
    clearInterval(this.timer)
    await this.reader.close()
    while (this.busy) await new Promise(r => setTimeout(r, 50))
  }
}
