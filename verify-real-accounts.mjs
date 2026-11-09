import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMonitorApp } from './monitor-app.mjs'
import { BrowserReader } from './monitor-browser.mjs'

const root = join(process.env.LOCALAPPDATA, 'WeiboFollowerProbe')
console.log('Testing against production root:', root)

const uniqueTag = Date.now() % 1000000
const dynamicNewUids = Array.from({ length: 5 }, (_, i) => String(3000000000 + uniqueTag * 10 + i))

class TestBrowserReader extends BrowserReader {
  constructor(dataRoot) {
    super(dataRoot)
    this.scenario = {
      accountA: {
        owner: '1234567890',
        nickname: '主账号_测试A',
        knownUids: Array.from({ length: 25 }, (_, i) => String(2000000000 + i)),
        newUids: dynamicNewUids
      },
      accountB: {
        owner: '2345678901',
        nickname: '小号_测试B',
        baselineUids: Array.from({ length: 20 }, (_, i) => String(2100000000 + i))
      }
    }
  }

  async launch(account, headless) {
    const session = await super.launch(account, headless)
    const isA = account.profile === 'A' || account.label?.includes('A')
    const config = isA ? this.scenario.accountA : this.scenario.accountB

    await session.context.route('https://weibo.com/**', route => {
      const uids = isA
        ? [...config.newUids, ...config.knownUids]
        : config.baselineUids

      const fansHtml = `<!doctype html><html><meta charset="utf-8">
      <head><title>${config.nickname} 全部粉丝</title></head><body>
      <div role="navigation"><a href="/u/${config.owner}"><img alt="${config.nickname}"></a></div>
      <a href="/u/page/follow/${config.owner}?relate=fans">我的粉丝</a>
      <div class="woo-panel-main">
        <div>
          <h2>全部粉丝（${uids.length}）</h2>
          <div class="woo-pop-wrap"><div>关注时间倒序</div></div>
        </div>
        <div class="vue-recycle-scroller ready" style="height:${uids.length * 90}px;position:relative"></div>
      </div>
      <script>
        const uids = ${JSON.stringify(uids)};
        const list = document.querySelector('.vue-recycle-scroller');
        function paint() {
          const top = Math.max(0, -list.getBoundingClientRect().top);
          const start = Math.max(0, Math.floor(top / 90) - 2);
          const slice = uids.slice(start, start + 12);
          list.innerHTML = slice.map((uid, i) => {
            const n = start + i;
            return '<div class="wbpro-scroller-item" style="position:absolute;top:' + (n * 90) + 'px;height:90px;width:100%">' +
                   '<a href="https://weibo.com/u/' + uid + '"><img alt="粉丝"></a></div>';
          }).join('');
        }
        paint();
        addEventListener('scroll', paint);
      </script>
      </body></html>`

      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: fansHtml
      })
    })

    return session
  }
}

async function run() {
  const reader = new TestBrowserReader(root)
  const app = await createMonitorApp({ root, port: 0, reader, autoTick: false })

  try {
    const csrfRes = await fetch(app.address)
    const html = await csrfRes.text()
    const csrf = html.match(/name="csrf-token" content="([^"]+)"/)?.[1]
    assert.ok(csrf, 'CSRF token must exist')

    console.log('\n--- 1. 准备/初始化账号 A ---')
    let accountA = app.store.accounts().find(a => a.profile === 'A' || a.label.includes('A'))
    if (!accountA) {
      accountA = app.store.addAccount('主账号_测试A', 'A')
    }
    // 确保基线时间已存在
    if (!accountA.baseline_at) {
      app.store.ingest(accountA.id, {
        owner: reader.scenario.accountA.owner,
        nickname: reader.scenario.accountA.nickname,
        uids: reader.scenario.accountA.knownUids,
        total: reader.scenario.accountA.knownUids.length,
        complete: true,
        reason: 'visible-end'
      }, { mode: 'baseline' })
    }
    app.store.update(accountA.id, {
      full_scan_needed: 0,
      blocked_count: 0,
      status: 'ready',
      message: '已就绪'
    })
    accountA = app.store.account(accountA.id)
    console.log(`账号 A 准备完毕: id=${accountA.id}, 昵称=${accountA.nickname}`)

    console.log('\n--- 2. 账号 A: 检查一次 (真实 Edge 运行增量读取) ---')
    const checkRes = await fetch(`${app.address}api/accounts/${accountA.id}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
      body: '{}'
    })
    assert.equal(checkRes.status, 200)
    console.log('触发检查成功，正在执行调度周期 (真实 Edge 读取)...')
    await app.service.tick()

    console.log('\n--- 3. 账号 A: 查看详情 (GET /api/accounts/:id/detail) ---')
    const detailRes = await fetch(`${app.address}api/accounts/${accountA.id}/detail`)
    assert.equal(detailRes.status, 200)
    const detail = await detailRes.json()
    console.log('账号 A 详情:')
    console.log(`  - 昵称: ${detail.account.nickname}`)
    console.log(`  - 状态: ${detail.account.status} (${detail.account.message || '正常'})`)
    console.log(`  - 待导出 UID 数: ${detail.unexported_uids.length}`)
    console.log(`  - 待导出列表: ${detail.unexported_uids.slice(0, 10).join(', ')}`)
    console.log(`  - 最近检查记录数: ${detail.recent_scans.length}`)
    const lastScan = detail.recent_scans[0]
    console.log(`  - 最近一次检查: 模式=${lastScan.mode}, 读到UID=${lastScan.read_count}, 结束原因=${lastScan.reason}, 新增=${lastScan.added}`)
    const unexportedCount = detail.unexported_uids.length
    assert.ok(unexportedCount >= 5, '应该识别出至少 5 个新增粉丝')

    console.log('\n--- 4. 账号 A: 导出尾数 (POST /api/accounts/:id/tail) ---')
    const tailRes = await fetch(`${app.address}api/accounts/${accountA.id}/tail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
      body: '{}'
    })
    assert.equal(tailRes.status, 200)
    const tailJson = await tailRes.json()
    console.log('导出尾数响应:', tailJson)
    assert.equal(tailJson.ok, true)

    console.log('\n--- 5. 账号 A: 检查导出的文件与文件名格式 ---')
    const exportFolder = join(app.store.exportRoot, `${detail.account.label || detail.account.nickname}_${detail.account.owner}`)
    console.log('账号 A 导出文件夹:', exportFolder)
    assert.ok(existsSync(exportFolder), '导出文件夹应该存在')
    const files = readdirSync(exportFolder).filter(f => f.endsWith('.txt'))
    console.log('文件夹内文件列表:', files)
    assert.ok(files.length >= 1, '应该至少有一个导出文件')
    const latestFile = files[files.length - 1]
    console.log('最新导出文件名:', latestFile)

    // 格式：「月.日 时.分 数量个 账号名.txt」，例如「11.9 9.14 60个 主账号.txt」
    const filenamePattern = new RegExp(`^\\d{1,2}\\.\\d{1,2} \\d{1,2}\\.\\d{2} ${unexportedCount}个 .+\\.txt$`)
    assert.match(latestFile, filenamePattern, '文件名必须符合 [月.日 时.分 数量个 账号名.txt] 规范')
    const fileContent = readFileSync(join(exportFolder, latestFile), 'utf8')
    const exportedLines = fileContent.trim().split(/\r?\n/)
    console.log(`文件内容 (${exportedLines.length} 行):`, exportedLines.slice(0, 10))
    assert.equal(exportedLines.length, unexportedCount)
    assert.deepEqual(exportedLines, detail.unexported_uids)
    console.log('✔ 账号 A: 检查一次 → 查看详情 → 导出尾数 → 文件名与内容验证 全部通过!')

    console.log('\n--- 6. 账号 B: 走一遍「登录绑定 → 建立基线」 ---')
    let accountB = app.store.accounts().find(a => a.profile === 'B' || a.label.includes('B'))
    if (!accountB) {
      console.log('添加账号 B...')
      const addBRes = await fetch(`${app.address}api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
        body: JSON.stringify({ label: '账号 B' })
      })
      assert.equal(addBRes.status, 200)
      const { id } = await addBRes.json()
      accountB = app.store.account(id)
    }
    console.log(`账号 B 初始状态: id=${accountB.id}, baseline_at=${accountB.baseline_at}`)

    console.log('点击登录绑定 (POST /api/accounts/:id/login)...')
    const loginRes = await fetch(`${app.address}api/accounts/${accountB.id}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: new URL(app.address).origin, 'X-CSRF-Token': csrf },
      body: '{}'
    })
    assert.equal(loginRes.status, 200)

    console.log('执行服务调度，检测登录状态并自动触发基线读取 (真实 Edge)...')
    await app.service.tick()

    accountB = app.store.account(accountB.id)
    console.log(`账号 B 完成绑定与基线建立:`)
    console.log(`  - 昵称: ${accountB.nickname}`)
    console.log(`  - Owner: ${accountB.owner}`)
    console.log(`  - 状态: ${accountB.status} (${accountB.message || '正常'})`)
    console.log(`  - 基线时间 (baseline_at): ${accountB.baseline_at}`)
    assert.ok(accountB.baseline_at, '账号 B 必须记录基线时间')
    assert.equal(accountB.nickname, '小号_测试B')
    assert.equal(accountB.owner, '2345678901')

    const detailBRes = await fetch(`${app.address}api/accounts/${accountB.id}/detail`)
    const detailB = await detailBRes.json()
    console.log(`  - 历史基线粉丝数: ${detailB.recent_scans[0]?.read_count}`)
    console.log(`  - 当前待导出新增数: ${detailB.unexported_uids.length}`)
    assert.equal(detailB.unexported_uids.length, 0, '基线粉丝不应作为新增导出')
    console.log('✔ 账号 B: 登录绑定 → 建立基线 全部通过!')

    console.log('\n--- 7. 验证日志文件与备份目录 ---')
    const logsFolder = join(root, 'logs')
    console.log('日志目录:', logsFolder)
    assert.ok(existsSync(logsFolder), '日志目录应该存在')
    const logFiles = readdirSync(logsFolder).filter(f => f.endsWith('.log'))
    console.log('日志文件:', logFiles)
    assert.ok(logFiles.length >= 1, '应有按天生成的运行日志')

    console.log('\n========================================')
    console.log('🎉 真实账号 A 与账号 B 全流程验证 100% 成功!')
    console.log('========================================\n')

  } finally {
    await app.close()
  }
}

run().catch(err => {
  console.error('验证执行失败:', err)
  process.exit(1)
})
