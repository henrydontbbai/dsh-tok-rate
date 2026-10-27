/**
 * dsh-tok-rate — Client half (plain JS, no build step).
 *
 * Registers one row in the `conversation.input.dock` slot: a live tokens/second
 * readout for the session it belongs to, plus a popup with the global history
 * grouped by (model, provider).
 *
 * The live number comes from two sources and prefers the faster one:
 *   1. the streaming assistant text of this session, measured locally on every
 *      delta (`ctx.get('uiConversation').binding(sessionId).target('chat')`);
 *   2. the Host half's chunk-timed rate, polled over its read-only route.
 * History, model/provider names, the calibrated chars-per-token factor and the
 * settled (usage-calibrated) value all come from the Host half.
 *
 * Only `react` is required. All styling uses `--dsw-alias-*` theme tokens
 * (visual pass 2026-10-26: inline pill, no colour fallbacks).
 */
window.__ModuleLoader__.load({
  id: 'dsh-tok-rate',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LIVE_PATH = '/plugins/dsh-tok-rate/live'
    const HISTORY_PATH = '/plugins/dsh-tok-rate/history'
    const POLL_MS = 160
    const WINDOW_MS = 1500
    const EMA_ALPHA = 0.35
    const IDLE_MS = 600
    const SETTLED_TTL_MS = 60000
    const DEFAULT_CHARS_PER_TOKEN = 1.7

    const ZH = {
      idle: 'tok/s · 待测',
      idleLast: '上次 {v} tok/s',
      settled: '已结算',
      title: (model, provider) => '实时解码速率；点击展开按模型 + provider 分组的历史。\n模型：' + model + '\nprovider：' + provider,
      popTitle: 'tok/s 历史',
      popTitleSub: '按模型 + provider 分组',
      empty: '暂无数据',
      emptySub: '完成一次回复后，这里会出现各模型的速率',
      error: '统计接口读取失败',
      errorSub: '插件仍在计时，历史稍后自动重试',
      loading: '读取中…',
      close: '关闭',
      count: n => '共 ' + n + ' 个样本',
      excluded: n => '已排除 ' + n + ' 个非流式样本（无可用解码时长，不计入平均）',
      lowConfidence: n => n + ' 个低置信样本（停顿主导或跨度过短，已从统计中排除，账本中仍保留）',
      samplesBefore: '样本 ',
      samplesAfter: '',
      lastBefore: '最近 ',
      lastAfter: '',
      meanBefore: '均值 ',
      meanAfter: '',
      rowTitle: (median, mean, p95, trimmed, samples) =>
        '主数字为样本中位数；均值 ' + mean + '、P95 ' + p95 + '、5-95 截尾均值 ' + trimmed + '（共 ' + samples + ' 个样本）',
      justNow: '刚刚',
      minutes: n => n + ' 分钟前',
      hours: n => n + ' 小时前',
      days: n => n + ' 天前',
    }
    const EN = {
      idle: 'tok/s · not measured',
      idleLast: 'last {v} tok/s',
      settled: 'settled',
      title: (model, provider) => 'Live decoding speed. Click for per-model / per-provider history.\nModel: ' + model + '\nProvider: ' + provider,
      popTitle: 'tok/s history',
      popTitleSub: 'grouped by model + provider',
      empty: 'No data yet',
      emptySub: 'Finish one reply and per-model speeds will appear here',
      error: 'Failed to read the stats route',
      errorSub: 'Live timing keeps running; history retries automatically',
      loading: 'Loading…',
      close: 'Close',
      count: n => (n === 1 ? '1 sample' : n + ' samples'),
      excluded: n => n + ' burst sample(s) excluded (no usable decode time)',
      lowConfidence: n => n + ' low-confidence sample(s) excluded from the statistics (pause-dominated or too short; still in the ledger)',
      samplesBefore: '',
      samplesAfter: ' samples',
      lastBefore: 'last ',
      lastAfter: '',
      meanBefore: 'mean ',
      meanAfter: '',
      rowTitle: (median, mean, p95, trimmed, samples) =>
        'headline is the sample median; mean ' + mean + ', P95 ' + p95 + ', 5-95 trimmed mean ' + trimmed + ' (' + samples + ' samples)',
      justNow: 'just now',
      minutes: n => n + ' min ago',
      hours: n => n + ' h ago',
      days: n => n + ' d ago',
    }

    function pickStrings() {
      let language = 'zh'
      try {
        language = String(window.navigator?.language ?? 'zh')
      } catch (error) {
        void error
      }
      return /^en\b/i.test(language) ? EN : ZH
    }

    function formatWhen(ts, t) {
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—'
      const delta = Date.now() - ts
      if (delta < 60000) return t.justNow
      if (delta < 3600000) return t.minutes(Math.floor(delta / 60000))
      if (delta < 86400000) return t.hours(Math.floor(delta / 3600000))
      return t.days(Math.floor(delta / 86400000))
    }

    // Full model path -> last segment ('remote-magpie/auto/deepseek-v4.1-flash'
    // -> 'deepseek-v4.1-flash'); the full path stays available in tooltips.
    function shortModel(model) {
      if (typeof model !== 'string' || model === '') return ''
      const last = model.split('/').filter(Boolean).pop()
      return typeof last === 'string' && last !== '' ? last : model
    }

    // ── reading the live stream without subscribing to the whole Chat snapshot ──
    function blocksLength(blocks, out) {
      if (!Array.isArray(blocks)) return
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue
        if (block.kind === 'text' && typeof block.text === 'string') out.text += block.text.length
        else if (block.kind === 'reasoning' && typeof block.text === 'string') out.reasoning += block.text.length
        else if (block.kind === 'tool-call' && typeof block.argsRaw === 'string') out.tool += block.argsRaw.length
      }
    }

    function lengthsOf(snapshot) {
      const out = { text: 0, reasoning: 0, tool: 0 }
      if (snapshot === null || typeof snapshot !== 'object') return out
      const partial = snapshot.legacy?.partial
      if (partial !== null && typeof partial === 'object' && Array.isArray(partial.blocks)) {
        blocksLength(partial.blocks, out)
        return out
      }
      // Fallback for a build without `legacy.partial`: read the running assistant step.
      try {
        const nodes = snapshot.nodes
        const list = nodes !== null && typeof nodes === 'object' && typeof nodes.values === 'function' ? Array.from(nodes.values()) : []
        for (const node of list) {
          const data = node?.data
          if (data === null || data === undefined) continue
          if (data.status === 'running') blocksLength(data.blocks, out)
        }
      } catch (error) {
        void error
      }
      return out
    }

    function chatTarget(ctx, sessionId) {
      try {
        if (ctx === null || ctx === undefined || typeof ctx.get !== 'function' || sessionId === '') return undefined
        const conversation = ctx.get('uiConversation', false)
        if (conversation === null || conversation === undefined || typeof conversation.binding !== 'function') return undefined
        const binding = conversation.binding(sessionId)
        if (binding === null || binding === undefined || typeof binding.target !== 'function') return undefined
        const target = binding.target('chat')
        if (target === null || target === undefined || typeof target.subscribe !== 'function' || typeof target.getSnapshot !== 'function') return undefined
        return target
      } catch (error) {
        void error
        return undefined
      }
    }

    // ── one store per session ──────────────────────────────────────────────────
    const stores = new Map()

    function storeFor(ctx, sessionId, t) {
      const key = sessionId === '' ? '__global__' : sessionId
      const existing = stores.get(key)
      if (existing !== undefined) return existing
      const store = {
        ctx,
        sessionId,
        t,
        listeners: new Set(),
        tick: 0,
        timer: null,
        unsubChat: null,
        target: undefined,
        polls: 0,
        text: 0,
        reasoning: 0,
        tool: 0,
        lastChars: 0,
        lastActiveAt: 0,
        ema: 0,
        localRate: 0,
        samples: [],
        model: null,
        provider: null,
        decoding: false,
        hostRate: 0,
        settled: null,
        charsPerToken: DEFAULT_CHARS_PER_TOKEN,
        hostError: null,
        rows: [],
        total: 0,
        excluded: 0,
        lowConfidence: 0,
        historyStatus: 'idle',
        display: { rate: 0, estimated: true, settled: false },
      }
      store.getTick = () => store.tick
      store.notify = () => {
        store.tick += 1
        for (const listener of [...store.listeners]) {
          try {
            listener()
          } catch (error) {
            void error
          }
        }
      }
      store.subscribe = listener => {
        store.listeners.add(listener)
        if (store.listeners.size === 1) store.start()
        return () => {
          store.listeners.delete(listener)
          if (store.listeners.size === 0) store.stop()
        }
      }

      store.computeDisplay = now => {
        const localFresh = store.localRate > 0 && now - store.lastActiveAt < IDLE_MS
        if (localFresh) {
          store.display = { rate: store.localRate, estimated: true, settled: false }
          return
        }
        if (store.decoding && store.hostRate > 0) {
          store.display = { rate: store.hostRate, estimated: true, settled: false }
          return
        }
        const settled = store.settled
        if (settled !== null && typeof settled === 'object' && typeof settled.tps === 'number' && now - settled.at < SETTLED_TTL_MS) {
          store.display = { rate: settled.tps, estimated: settled.estimated === true, settled: true }
          return
        }
        store.display = { rate: 0, estimated: true, settled: false }
      }

      store.resetWindow = (now, chars) => {
        store.samples = [{ t: now, c: chars }]
        store.lastChars = chars
        store.ema = 0
        store.localRate = 0
      }

      store.attachTarget = () => {
        if (store.target !== undefined) return
        const target = chatTarget(store.ctx, store.sessionId)
        if (target === undefined) return
        store.target = target
        try {
          store.unsubChat = target.subscribe(() => store.onChat()) ?? null
        } catch (error) {
          void error
          store.unsubChat = null
        }
        try {
          store.onChat()
        } catch (error) {
          void error
        }
      }

      store.onChat = () => {
        let snapshot
        try {
          snapshot = store.target.getSnapshot()
        } catch (error) {
          return
        }
        const lengths = lengthsOf(snapshot)
        const total = lengths.text + lengths.reasoning + lengths.tool
        const now = Date.now()
        if (total < store.lastChars) {
          store.resetWindow(now, total)
          store.computeDisplay(now)
          store.notify()
          return
        }
        if (total > store.lastChars) {
          store.samples.push({ t: now, c: total })
          while (store.samples.length > 1 && now - store.samples[0].t > WINDOW_MS) store.samples.shift()
          const first = store.samples[0]
          const span = now - first.t
          if (span >= 120) {
            const instant = (total - first.c) / span
            store.ema = store.ema > 0 ? store.ema * (1 - EMA_ALPHA) + instant * EMA_ALPHA : instant
            store.localRate = store.ema * 1000 / store.charsPerToken
          }
          store.lastChars = total
          store.lastActiveAt = now
          store.text = lengths.text
          store.reasoning = lengths.reasoning
          store.tool = lengths.tool
        }
        store.computeDisplay(now)
        store.notify()
      }

      store.poll = async () => {
        store.polls += 1
        if (store.target === undefined && store.polls % 8 === 1) store.attachTarget()
        if (store.sessionId !== '') {
          try {
            const response = await fetch(LIVE_PATH + '?sessionId=' + encodeURIComponent(store.sessionId), { cache: 'no-store' })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const payload = await response.json()
            if (payload !== null && typeof payload === 'object' && payload.ok === true) {
              store.hostError = null
              store.model = typeof payload.model === 'string' && payload.model !== '' ? payload.model : null
              store.provider = typeof payload.provider === 'string' && payload.provider !== '' ? payload.provider : null
              store.decoding = payload.decoding === true
              store.hostRate = typeof payload.rate === 'number' && Number.isFinite(payload.rate) ? payload.rate : 0
              store.settled = payload.settled ?? null
              const perToken = payload.charsPerToken
              if (typeof perToken === 'number' && perToken > 0.2 && perToken < 40) store.charsPerToken = perToken
            }
          } catch (error) {
            store.hostError = String(error?.message ?? error)
            store.decoding = false
            store.hostRate = 0
          }
        }
        store.computeDisplay(Date.now())
        store.notify()
      }

      store.fetchHistory = async () => {
        if (store.historyStatus === 'idle') store.historyStatus = 'loading'
        try {
          const response = await fetch(HISTORY_PATH, { cache: 'no-store' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const payload = await response.json()
          if (payload === null || typeof payload !== 'object' || payload.ok !== true) throw new Error('bad payload')
          store.rows = Array.isArray(payload.rows) ? payload.rows : []
          store.total = typeof payload.total === 'number' ? payload.total : store.rows.length
          store.excluded = typeof payload.excluded === 'number' ? payload.excluded : 0
          store.lowConfidence = typeof payload.lowConfidence === 'number' ? payload.lowConfidence : 0
          store.historyStatus = 'ok'
        } catch (error) {
          store.historyError = String(error?.message ?? error)
          store.historyStatus = 'error'
        }
        store.notify()
      }

      store.start = () => {
        if (store.timer !== null) return
        store.attachTarget()
        store.timer = window.setInterval(() => {
          void store.poll()
        }, POLL_MS)
        void store.poll()
      }

      store.stop = () => {
        if (store.timer !== null) {
          window.clearInterval(store.timer)
          store.timer = null
        }
        if (store.unsubChat !== null) {
          try {
            store.unsubChat()
          } catch (error) {
            void error
          }
        }
        store.unsubChat = null
        store.target = undefined
      }

      stores.set(key, store)
      return store
    }

    // ── styles: theme tokens only, scoped to this plugin's own attribute ───────
    // Design source: deliverables/dsh-tok-rate-design-pass-2026-10-26.md.
    // No colour fallbacks (#hex/rgba) anywhere — tokens degrade silently.
    const CSS = [
      // root + pill (§1.1): inline pill, width follows content, transparent at rest
      '[data-dsh-tok-rate]{position:relative;display:inline-flex;align-items:center;width:max-content;max-width:100%;margin:0;padding:0;line-height:20px}',
      '[data-dsh-tok-rate] .dshTokRateBtn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;margin:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;user-select:none;transition:background-color .12s ease,color .12s ease}',
      '[data-dsh-tok-rate] .dshTokRateBtn:hover,[data-dsh-tok-rate] .dshTokRateBtn[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '[data-dsh-tok-rate] .dshTokRateBtn:active{background:var(--dsw-alias-interactive-bg-active)}',
      '[data-dsh-tok-rate] .dshTokRateBtn:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',
      '[data-dsh-tok-rate] .dshTokRateBtn.isIdle{opacity:.6}',
      '[data-dsh-tok-rate] .dshTokRateBtn.isIdle .dshTokRateNum{color:var(--dsw-alias-label-secondary)}',
      // activity dot (§1.4): breathing brand-blue dot, streaming only
      '[data-dsh-tok-rate] .dshTokRateDot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);animation:dshTokRateBreath 1.6s ease-in-out infinite}',
      '@keyframes dshTokRateBreath{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.82)}}',
      // number / unit / short model name / 2px separator dot (§1.2, §1.4, §1.5)
      '[data-dsh-tok-rate] .dshTokRateNum{display:inline-block;min-width:6ch;text-align:right;font-size:14px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;color:var(--dsw-alias-label-primary)}',
      '[data-dsh-tok-rate] .dshTokRateApprox{margin-right:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
      '[data-dsh-tok-rate] .dshTokRateUnit{margin-left:3px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
      '[data-dsh-tok-rate] .dshTokRateFlag{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
      '[data-dsh-tok-rate] .dshTokRateModel{flex:0 1 auto;min-width:0;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
      '[data-dsh-tok-rate] .dshTokRateSep{flex:none;display:inline-block;vertical-align:middle;width:2px;height:2px;border-radius:1px;background:var(--dsw-alias-label-caption)}',
      // chevron (§1.6): 12px inline SVG, rotates 180deg when expanded
      '[data-dsh-tok-rate] .dshTokRateChevron{flex:none;display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;color:inherit;opacity:.85;transition:transform .12s ease}',
      '[data-dsh-tok-rate] .dshTokRateBtn[aria-expanded="true"] .dshTokRateChevron{transform:rotate(180deg)}',
      // popover surface (§2.1): 16px radius, token border + shadow, theme scrollbars
      '[data-dsh-tok-rate] .dshTokRatePop{position:absolute;bottom:calc(100% + 6px);left:0;z-index:40;box-sizing:border-box;width:min(560px,calc(100vw - 48px));min-width:min(420px,calc(100vw - 48px));max-height:min(360px,45vh);overflow:auto;padding:8px;border:0;border-radius:var(--dsw-radius-lg);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-stroke),0 8px 24px var(--dsw-alias-bg-mask-1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;cursor:default;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}',
      '[data-dsh-tok-rate] .dshTokRatePop::-webkit-scrollbar{width:8px;height:8px}',
      '[data-dsh-tok-rate] .dshTokRatePop::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:999px}',
      '[data-dsh-tok-rate] .dshTokRatePop::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}',
      // popover head (§2.2): title + count + svg close button
      '[data-dsh-tok-rate] .dshTokRatePopHead{display:flex;align-items:center;gap:8px;padding:2px 4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '[data-dsh-tok-rate] .dshTokRatePopTitle{flex:1;min-width:0;font-size:12px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '[data-dsh-tok-rate] .dshTokRatePopTitleSub{font-size:11px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-caption);margin-left:6px;white-space:nowrap}',
      '[data-dsh-tok-rate] .dshTokRatePopCount{font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption);white-space:nowrap}',
      '[data-dsh-tok-rate] .dshTokRatePopNote{padding:4px 8px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
      '[data-dsh-tok-rate] .dshTokRateClose{flex:none;width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '[data-dsh-tok-rate] .dshTokRateClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '[data-dsh-tok-rate] .dshTokRateClose:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',
      // per-model rows (§2.3): 2-row x 2-col grid, main number right-aligned
      '[data-dsh-tok-rate] .dshTokRateList{display:flex;flex-direction:column;gap:2px;padding-top:6px}',
      '[data-dsh-tok-rate] .dshTokRateRow{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:20px;row-gap:1px;align-items:baseline;padding:6px 8px;border-radius:var(--dsw-radius-sm);cursor:default}',
      '[data-dsh-tok-rate] .dshTokRateRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '[data-dsh-tok-rate] .dshTokRateRowName{grid-column:1;grid-row:1;min-width:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '[data-dsh-tok-rate] .dshTokRateRowProv{grid-column:1;grid-row:2;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '[data-dsh-tok-rate] .dshTokRateRowMain{grid-column:2;grid-row:1;white-space:nowrap;text-align:right;font-size:15px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;min-width:5ch}',
      '[data-dsh-tok-rate] .dshTokRateRowMain .u{margin-left:3px;font-size:11px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-caption)}',
      '[data-dsh-tok-rate] .dshTokRateRowSub{grid-column:2;grid-row:2;white-space:nowrap;text-align:right;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
      '[data-dsh-tok-rate] .dshTokRateRowSub b{font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '[data-dsh-tok-rate] .dshTokRateRowSub .dshTokRateSep{margin:0 6px}',
      // empty / loading / error states (§2.4)
      '[data-dsh-tok-rate] .dshTokRateEmpty{padding:22px 8px 24px;text-align:center;font-size:12px;line-height:20px;color:var(--dsw-alias-label-caption)}',
      '[data-dsh-tok-rate] .dshTokRateEmptySub{margin-top:2px;font-size:11px;line-height:16px;opacity:.85}',
      '[data-dsh-tok-rate] .dshTokRateEmptyGlyph{display:block;margin:0 auto 8px;width:20px;height:20px;color:var(--dsw-alias-label-caption);opacity:.6}',
      // reduced motion (1.4)
      '@media (prefers-reduced-motion:reduce){[data-dsh-tok-rate] .dshTokRateDot{animation:none;opacity:.65}[data-dsh-tok-rate] .dshTokRateBtn,[data-dsh-tok-rate] .dshTokRateChevron{transition:none}}',
    ].join('')

    function fixed(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '—'
    }

    // -- inline icons (no icon library) --
    function svgIcon(pathD, size) {
      return h('svg', { viewBox: '0 0 ' + size + ' ' + size, fill: 'none', width: size, height: size, 'aria-hidden': 'true' },
        h('path', { d: pathD, stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
    }
    const chevronSvg = () => svgIcon('M2.75 7.75 6 4.5 9.25 7.75', 12)
    const closeSvg = () => svgIcon('M3 3l6 6M9 3l-6 6', 12)
    const emptyGlyphSvg = () => svgIcon('M3 6h14M6 10h11M9 14h8', 20)

    // Right-bottom meta segment: grey label + half-weight value, per spec 2.3.
    function metaSeg(key, before, value, after) {
      return h('span', { key }, [
        before === '' ? null : h('span', { key: 'pre' }, before),
        h('b', { key: 'v' }, value),
        after === '' ? null : h('span', { key: 'post' }, after),
      ])
    }
    function metaDot(key) {
      return h('span', { key, className: 'dshTokRateSep', 'aria-hidden': 'true' })
    }

    function HistoryPopover(props) {
      const store = props.store
      const t = props.t
      const onClose = props.onClose
      React.useEffect(() => {
        void store.fetchHistory()
        const timer = window.setInterval(() => {
          void store.fetchHistory()
        }, 3000)
        return () => window.clearInterval(timer)
      }, [store])

      let body
      if (store.rows.length === 0) {
        let main = t.empty
        let sub = t.emptySub
        if (store.historyStatus === 'loading') {
          main = t.loading
          sub = null
        } else if (store.historyStatus === 'error') {
          main = t.error
          sub = t.errorSub
        }
        body = h('div', { key: 'empty', className: 'dshTokRateEmpty' }, [
          h('span', { key: 'glyph', className: 'dshTokRateEmptyGlyph', 'aria-hidden': 'true' }, emptyGlyphSvg()),
          h('div', { key: 'main' }, main),
          sub === null ? null : h('div', { key: 'sub', className: 'dshTokRateEmptySub' }, sub),
        ])
      } else {
        body = h('div', { key: 'list', className: 'dshTokRateList' }, store.rows.map(row => {
          const fullModel = String(row.model ?? '')
          const short = shortModel(fullModel)
          const subChildren = [
            metaSeg('samples', t.samplesBefore, String(row.samples ?? 0), t.samplesAfter),
            metaDot('dot1'),
            metaSeg('last', t.lastBefore, fixed(row.lastTps), t.lastAfter),
            metaDot('dot2'),
            // P1-1: the mean is no longer the headline — it rides here as the
            // secondary figure, because a long right tail inflates it by 6-11%.
            metaSeg('mean', t.meanBefore, fixed(row.avgTps), t.meanAfter),
            metaDot('dot3'),
            h('span', { key: 'when' }, formatWhen(row.lastAt, t)),
          ]
          return h('div', { key: String(row.model) + '::' + String(row.provider), className: 'dshTokRateRow' }, [
            h('span', { key: 'name', className: 'dshTokRateRowName', title: fullModel }, short === '' ? (fullModel === '' ? '—' : fullModel) : short),
            h('span', { key: 'prov', className: 'dshTokRateRowProv' }, String(row.provider ?? '—')),
            h('span', {
              key: 'main',
              className: 'dshTokRateRowMain',
              title: t.rowTitle(
                fixed(row.medianTps),
                fixed(row.avgTps),
                fixed(row.p95Tps),
                fixed(row.trimmedMeanTps),
                String(row.samples ?? 0),
              ),
            }, [
              // P1-1: median is the headline; an older host that does not send it
              // yet falls back to the mean instead of rendering a dash.
              fixed(row.medianTps ?? row.avgTps),
              h('span', { key: 'u', className: 'u' }, 'tok/s'),
            ]),
            h('span', { key: 'sub', className: 'dshTokRateRowSub' }, subChildren),
          ])
        }))
      }

      return h('div', { className: 'dshTokRatePop', role: 'dialog', 'aria-label': t.popTitle }, [
        h('div', { key: 'head', className: 'dshTokRatePopHead' }, [
          h('span', { key: 'title', className: 'dshTokRatePopTitle' }, [
            t.popTitle,
            h('span', { key: 'sub', className: 'dshTokRatePopTitleSub' }, t.popTitleSub),
          ]),
          h('span', { key: 'count', className: 'dshTokRatePopCount' }, t.count(store.total)),
          h('button', { key: 'close', type: 'button', className: 'dshTokRateClose', 'aria-label': t.close, onClick: onClose }, closeSvg()),
        ]),
        store.excluded > 0 ? h('div', { key: 'excluded', className: 'dshTokRatePopNote' }, t.excluded(store.excluded)) : null,
        store.lowConfidence > 0 ? h('div', { key: 'lowConf', className: 'dshTokRatePopNote' }, t.lowConfidence(store.lowConfidence)) : null,
        store.historyStatus === 'error' && store.rows.length > 0 ? h('div', { key: 'err', className: 'dshTokRatePopNote' }, t.error) : null,
        body,
      ])
    }

    function RateBar(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const ctx = props?.ctx
      const t = props?.t ?? ZH
      const store = React.useMemo(() => storeFor(ctx, sessionId, t), [ctx, sessionId, t])
      React.useSyncExternalStore(store.subscribe, store.getTick, store.getTick)
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      const styleTag = React.useMemo(() => h('style', { key: 'style', 'data-dsh-tok-rate-style': '' }, CSS), [])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = event => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onDown = event => {
          const root = rootRef.current
          if (root !== null && event.target instanceof Node && root.contains(event.target)) return
          setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        window.addEventListener('pointerdown', onDown, true)
        return () => {
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('pointerdown', onDown, true)
        }
      }, [open])

      // State machine from design spec 1.3 (criteria unchanged, display only):
      //   S3 streaming   -> breathing dot + number + unit
      //   S2 just settled-> number + unit + caption flag
      //   S1 idle w/ last-> '上次 42.3 tok/s', whole pill at opacity .6
      //   S0 never       -> 'tok/s · 待测', tertiary text only, no dash
      const display = store.display
      const settled = store.settled
      const settledTps = settled !== null && typeof settled === 'object' && typeof settled.tps === 'number' && Number.isFinite(settled.tps) && settled.tps > 0
        ? settled.tps
        : 0
      const streaming = display.rate > 0 && display.settled === false
      const justSettled = display.rate > 0 && display.settled === true
      const idleWithLast = !streaming && !justSettled && settledTps > 0
      const short = store.model === null ? '' : shortModel(store.model)

      const parts = []
      if (streaming) {
        parts.push(h('span', { key: 'dot', className: 'dshTokRateDot', 'aria-hidden': 'true' }))
      }
      if (streaming || justSettled) {
        if (display.estimated) parts.push(h('span', { key: 'approx', className: 'dshTokRateApprox' }, '≈'))
        parts.push(h('span', { key: 'num', className: 'dshTokRateNum' }, display.rate.toFixed(1)))
        parts.push(h('span', { key: 'unit', className: 'dshTokRateUnit' }, 'tok/s'))
      } else if (idleWithLast) {
        const template = typeof t.idleLast === 'string' ? t.idleLast : ZH.idleLast
        const split = template.split('{v}')
        const before = String(split[0] ?? '')
        const after = String(split[1] ?? '').trim()
        if (before !== '') parts.push(h('span', { key: 'pre', className: 'dshTokRateApprox' }, before))
        parts.push(h('span', { key: 'num', className: 'dshTokRateNum' }, settledTps.toFixed(1)))
        if (after !== '') parts.push(h('span', { key: 'unit', className: 'dshTokRateUnit' }, after))
      } else {
        parts.push(h('span', { key: 'idle' }, t.idle))
      }
      if (short !== '') {
        parts.push(h('span', { key: 'sepModel', className: 'dshTokRateSep', 'aria-hidden': 'true' }))
        parts.push(h('span', { key: 'model', className: 'dshTokRateModel' }, short))
      }
      if (justSettled) {
        parts.push(h('span', { key: 'sepSettled', className: 'dshTokRateSep', 'aria-hidden': 'true' }))
        parts.push(h('span', { key: 'settled', className: 'dshTokRateFlag' }, t.settled))
      }
      parts.push(h('span', { key: 'chevron', className: 'dshTokRateChevron', 'aria-hidden': 'true' }, chevronSvg()))

      const titleText = typeof t.title === 'function'
        ? t.title(store.model ?? '—', store.provider ?? '—')
        : String(t.title ?? '')

      return h('div', { ref: rootRef, 'data-dsh-tok-rate': '' }, [
        styleTag,
        h('button', {
          key: 'toggle',
          type: 'button',
          className: 'dshTokRateBtn' + (idleWithLast ? ' isIdle' : ''),
          title: titleText,
          'aria-expanded': open,
          onClick: () => setOpen(value => !value),
        }, parts),
        open ? h(HistoryPopover, { key: 'pop', store, t, onClose: () => setOpen(false) }) : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = pickStrings()
        const disposers = []
        disposers.push(ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'tok-rate',
          order: 30,
          inject: sessionId => ({ sessionId, ctx, t }),
        }, RateBar)))
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch (error) {
              void error
            }
          }
          for (const store of stores.values()) {
            try {
              store.stop()
            } catch (error) {
              void error
            }
            store.listeners.clear()
          }
          stores.clear()
        }
      },
    }
  },
})
