/**
 * dsh-tok-rate — Host half.
 *
 * Taps the `llm/stream` waterfall, times every model request (first token delta to
 * the terminal `usage` chunk), turns the provider's own token counts into one
 * calibrated sample, appends it to a global on-disk ledger, and serves two
 * read-only routes that the Client half polls.
 *
 * One `llm/stream` call == one sample; tool execution time and the other requests
 * of the same turn are separate samples. Requests without a `sessionId`
 * (compaction, session titles) pass through untouched and are never recorded.
 */
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-tok-rate'
export const inject = ['webServer']

const WINDOW_MS = 1500
const EMA_ALPHA = 0.35
const MAX_ENTRIES = 5000
const MAX_SESSIONS = 60
const DEFAULT_CHARS_PER_TOKEN = 1.7
const ROUTE_BASE = '/plugins/dsh-tok-rate'
/** Wall-clock gap between two deltas that is proxy batching, not decoding. */
const IDLE_GAP_MS = 1000
/** Rolling automatic ledger backups kept beside the ledger itself. */
const MAX_AUTO_BAKS = 2
const AUTO_BAK_SUFFIX = '.auto-bak-'
/** Purge archives kept beside the ledger; older ones are pruned after each write. */
const MAX_PURGE_ARCHIVES = 10
/** Prefix of a purge archive file (shared by the writer and the retention sweep). */
const PURGE_ARCHIVE_PREFIX = 'purge-archive-'
/**
 * Below this effective decode span a sample is too short to time: the provider's
 * own token count is still recorded (never dropped), but it is flagged instead of
 * silently trusted.
 */
const MIN_DECODE_MS = 200
/** Share of the wall span that may be idle before the sample counts as pause-dominated. */
const IDLE_DOMINANT_SHARE = 0.5
/** Share trimmed from each tail when computing `trimmedMeanTps`. */
const TRIM_FRACTION = 0.05

/** Directory this plugin owns inside DSH home; it holds only the ledger. */
function pluginDataDir() {
  const configured = process.env.DSH_HOME
  const home = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : join(homedir(), '.dsh')
  return join(home, 'dsh-tok-rate')
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch (error) {
    void error
  }
}

/** Read-only, same-origin: reject a cross-site caller and any write method. */
function allowedRequest(req) {
  const site = req?.headers?.['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET'
  return method === 'GET' || method === 'HEAD'
}

/**
 * Write guard for the purge route. Writes are destructive and irreversible, so
 * they require an explicit `same-origin` marker: a missing `sec-fetch-site`
 * header is a non-browser caller (any local process with plain curl) and is
 * rejected. The read guard above stays lenient on purpose.
 */
function allowedWriteRequest(req) {
  const site = req?.headers?.['sec-fetch-site']
  if (site !== 'same-origin') return false
  const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET'
  return method === 'POST'
}

function queryValue(req, key) {
  try {
    return new URL(typeof req?.url === 'string' ? req.url : '/', 'http://localhost').searchParams.get(key) ?? ''
  } catch (error) {
    void error
    return ''
  }
}

/** Linear-interpolation percentile over an ascending array (numpy's default). */
function percentileOf(sorted, fraction) {
  const count = sorted.length
  if (count === 0) return undefined
  if (count === 1) return sorted[0]
  const position = (count - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Mean of the middle of an ascending array once both `fraction` tails are dropped. */
function trimmedMeanOf(sorted, fraction) {
  const count = sorted.length
  if (count === 0) return undefined
  const drop = Math.floor(count * fraction)
  const kept = drop > 0 && count - drop * 2 > 0 ? sorted.slice(drop, count - drop) : sorted
  let sum = 0
  for (const value of kept) sum += value
  return sum / kept.length
}

/**
 * Aggregate stored raw samples per (model, provider); providers never merge.
 *
 * The headline number is the median: measured glm-5.3-flash data reads
 * mean 64.1 / median 57.8 / 5-95 trimmed 60.8, i.e. a long right tail (proxy
 * batching, non-streamed bursts) lifts the mean by 6-11%. `avgTps` stays in the
 * payload because other readers still consume it, but it is no longer the value
 * the popup leads with. Median, p95 and the trimmed mean are computed from the
 * same filtered sample set as the mean.
 */
export function aggregateEntries(entries) {
  const rows = new Map()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const model = typeof entry.model === 'string' ? entry.model : 'unknown'
    const provider = typeof entry.provider === 'string' ? entry.provider : 'unknown'
    const tps = finite(entry.tps)
    // Two independent marks keep a sample out of the statistics, never out of
    // the ledger: `timingSuspect` means "delivered as an unusable burst",
    // `lowConfidence` means "measured, but the span cannot support the rate".
    if (tps === undefined || entry.timingSuspect === true || entry.lowConfidence === true) continue
    const ts = finite(entry.ts) ?? 0
    const key = model + '\u0000' + provider
    let row = rows.get(key)
    if (row === undefined) {
      row = { model, provider, samples: 0, sumTps: 0, tpsValues: [], lastTps: tps, lastAt: ts, outputTokens: 0 }
      rows.set(key, row)
    }
    row.samples += 1
    row.sumTps += tps
    row.tpsValues.push(tps)
    row.outputTokens += finite(entry.outputTokens) ?? 0
    if (ts >= row.lastAt) {
      row.lastAt = ts
      row.lastTps = tps
    }
  }
  return [...rows.values()]
    .map(row => {
      const sorted = row.tpsValues.slice().sort((left, right) => left - right)
      return {
        model: row.model,
        provider: row.provider,
        samples: row.samples,
        medianTps: percentileOf(sorted, 0.5),
        p95Tps: percentileOf(sorted, 0.95),
        trimmedMeanTps: trimmedMeanOf(sorted, TRIM_FRACTION),
        avgTps: row.sumTps / row.samples,
        lastTps: row.lastTps,
        lastAt: row.lastAt,
        outputTokens: row.outputTokens,
      }
    })
    .sort((left, right) => right.lastAt - left.lastAt)
}

function isEntryLike(value) {
  return value !== null && typeof value === 'object' && typeof value.tps === 'number'
}

export function apply(ctx) {
  const dir = pluginDataDir()
  const file = join(dir, 'ledger.json')

  const ledger = {
    entries: [],
    calibratedChars: 0,
    calibratedTokens: 0,
    calibratedSamples: 0,
    loadError: null,
    saveError: null,
    loaded: false,
    saveTimer: null,
  }
  const sessions = new Map()
  let lastModel = null
  let lastProvider = null

  function recomputeCalibration() {
    ledger.calibratedChars = 0
    ledger.calibratedTokens = 0
    ledger.calibratedSamples = 0
    for (const entry of ledger.entries) {
      // Same two guards as `record()`: the calibrated totals are persisted
      // (charsPerToken / calibratedSamples are derived from them), so a reload
      // must reproduce exactly what the running accumulator built.
      if (entry?.timingSuspect === true || entry?.lowConfidence === true) continue
      const chars = finite(entry?.chars)
      const tokens = finite(entry?.outputTokens)
      if (chars === undefined || chars <= 0 || tokens === undefined || tokens <= 0) continue
      ledger.calibratedChars += chars
      ledger.calibratedTokens += tokens
      ledger.calibratedSamples += 1
    }
  }

  /** Chars per output token measured on this machine; the Client divides by it. */
  function charsPerToken() {
    if (ledger.calibratedSamples > 0 && ledger.calibratedChars > 0 && ledger.calibratedTokens > 0) {
      const value = ledger.calibratedChars / ledger.calibratedTokens
      if (Number.isFinite(value) && value > 0.2 && value < 40) return value
    }
    return DEFAULT_CHARS_PER_TOKEN
  }

  async function exists(path) {
    try {
      await stat(path)
      return true
    } catch (error) {
      void error
      return false
    }
  }

  /**
   * Roll the automatic backups one generation: `ledger.json.auto-bak-1` ->
   * `-2`, then the ledger that was just read successfully -> `-1`. Copy, never
   * rename, so a crash right after startup still finds a readable ledger.
   *
   * Async only, and only on the load path: this must never run at import time
   * or in `apply()`'s synchronous section, because a throw there makes the host
   * skip the whole plugin row.
   */
  async function rotateAutoBackups() {
    for (let index = MAX_AUTO_BAKS; index > 1; index -= 1) {
      try {
        await rename(file + AUTO_BAK_SUFFIX + (index - 1), file + AUTO_BAK_SUFFIX + index)
      } catch (error) {
        void error
      }
    }
    try {
      await copyFile(file, file + AUTO_BAK_SUFFIX + '1')
    } catch (error) {
      void error
    }
  }

  /** Bad JSON: quarantine the file and name the backup it can be restored from. */
  async function quarantineCorruptLedger(error) {
    const reason = String(error?.message ?? error)
    const quarantined = file + '.corrupt-' + Date.now()
    let quarantinedOk = false
    try {
      await rename(file, quarantined)
      quarantinedOk = true
    } catch (renameError) {
      void renameError
    }
    const backups = []
    for (let index = 1; index <= MAX_AUTO_BAKS; index += 1) {
      const candidate = file + AUTO_BAK_SUFFIX + index
      if (await exists(candidate)) backups.push(candidate)
    }
    const where = quarantinedOk ? 'quarantined to ' + quarantined : 'left in place at ' + file
    const recover = backups.length > 0
      ? 'recoverable from ' + backups.join(' or ')
      : 'no automatic backup available yet (this is the first run to see a ledger)'
    ledger.loadError = reason + '; ledger ' + where + '; ' + recover
  }

  async function loadLedger() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter(isEntryLike) : []
      ledger.entries = entries.slice(-MAX_ENTRIES)
      recomputeCalibration()
      // Successful read: snapshot this generation before the run overwrites it.
      await rotateAutoBackups()
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Keep an unreadable ledger instead of silently overwriting it.
        try {
          await quarantineCorruptLedger(error)
        } catch (quarantineError) {
          ledger.loadError = String(quarantineError?.message ?? quarantineError)
        }
      }
    } finally {
      ledger.loaded = true
    }
  }

  const ready = loadLedger()

  async function flushLedger() {
    const tmp = file + '.tmp-' + process.pid
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: ledger.entries }), 'utf8')
      await rename(tmp, file)
      ledger.saveError = null
    } catch (error) {
      ledger.saveError = String(error?.message ?? error)
      try {
        await rm(tmp, { force: true })
      } catch (cleanupError) {
        void cleanupError
      }
    }
  }

  function scheduleSave() {
    if (ledger.saveTimer !== null) return
    ledger.saveTimer = setTimeout(() => {
      ledger.saveTimer = null
      void flushLedger()
    }, 400)
    if (typeof ledger.saveTimer.unref === 'function') ledger.saveTimer.unref()
  }

  function record(entry) {
    ledger.entries.push(entry)
    if (ledger.entries.length > MAX_ENTRIES) ledger.entries.splice(0, ledger.entries.length - MAX_ENTRIES)
    const chars = finite(entry.chars)
    // P1-sem: a low-confidence sample must not push the ratio either. `chars / outputTokens`
    // is the single constant the live estimate divides by, so calibrating it on a
    // span the plugin itself calls unmeasurable makes the on-screen number drift —
    // visibly. Both marks are excluded, and they are independent, hence both tests.
    if (entry.timingSuspect !== true && entry.lowConfidence !== true && chars !== undefined && chars > 0) {
      ledger.calibratedChars += chars
      ledger.calibratedTokens += entry.outputTokens
      ledger.calibratedSamples += 1
    }
    lastModel = entry.model
    lastProvider = entry.provider
    scheduleSave()
  }

  function sessionState(sessionId) {
    let state = sessions.get(sessionId)
    if (state !== undefined) return state
    state = {
      sessionId,
      model: null,
      provider: null,
      decoding: false,
      rate: 0,
      ema: 0,
      chars: 0,
      samples: [],
      lastDeltaAt: 0,
      settled: null,
    }
    sessions.set(sessionId, state)
    if (sessions.size > MAX_SESSIONS) {
      const now = Date.now()
      for (const [key, value] of sessions) {
        if (sessions.size <= MAX_SESSIONS) break
        if (key !== sessionId && value.decoding !== true && now - value.lastDeltaAt > 60000) sessions.delete(key)
      }
    }
    return state
  }

  /** Live estimate from chunk arrival times, in estimated tokens per second. */
  function noteDelta(state, now, chars, perToken) {
    state.chars = chars
    state.samples.push({ t: now, c: chars })
    while (state.samples.length > 1 && now - state.samples[0].t > WINDOW_MS) state.samples.shift()
    const first = state.samples[0]
    const span = now - first.t
    if (span < 120) return
    const instant = (chars - first.c) / span
    state.ema = state.ema > 0 ? state.ema * (1 - EMA_ALPHA) + instant * EMA_ALPHA : instant
    state.rate = (state.ema * 1000) / perToken
  }

  function settle(samples, live, sessionId, provider, model) {
    live.decoding = false
    live.rate = 0
    live.ema = 0
    const usage = samples.usage
    const outputTokens = finite(usage?.outputTokens)
    const reasoningTokens = finite(usage?.reasoningTokens)
    const decodeEnd = samples.usageAt > 0 ? samples.usageAt : samples.lastDeltaAt
    // Raw wall span of the response, idle pauses included (the old denominator).
    const decodeWallMs = samples.firstDeltaAt > 0 && decodeEnd > samples.firstDeltaAt ? decodeEnd - samples.firstDeltaAt : 0
    // `decodeMs` is the real decoding time: the proxy's batching pauses are
    // subtracted and reported as `idleMs`, so rates stop being systematically
    // under-estimated. `decodeWallMs` is kept in the entry so old-口径 rates
    // stay recomputable from the ledger.
    const idleMs = decodeWallMs > 0 ? Math.min(samples.idleMs, decodeWallMs) : 0
    const decodeMs = Math.max(0, decodeWallMs - idleMs)
    // P1-fix regression 1: when the pauses ate the whole span, subtracting them
    // leaves 0 ms and the sample used to be dropped on the floor — silently, so
    // data the pre-P1 code recorded simply stopped existing. Fall back to the
    // wall-clock denominator instead: same sample count as before P1-5, only the
    // 口径 differs, and the fallback is marked `lowConfidence` below.
    const decodeMsEff = decodeMs > 0 ? decodeMs : decodeWallMs
    const perToken = charsPerToken()
    const estimatedTps = samples.chars > 0 && decodeMsEff > 0 ? samples.chars / perToken / decodeMsEff * 1000 : undefined
    // A response with provider usage is always accounted for: only 0 output
    // tokens (or an undeterminable end) is a legitimate reason to skip.
    if (outputTokens !== undefined && outputTokens > 0 && decodeMsEff > 0) {
      const tps = outputTokens / decodeMsEff * 1000
      // P1-fix: `timingSuspect` keeps its exact meaning (a burst the provider
      // delivered in one go). "We could not measure this reliably" is a
      // different statement and gets a different mark, so a pause-dominated
      // sample is never disguised as a burst.
      //
      // The two marks are therefore mutually exclusive: a burst means the
      // denominator was real but tiny (decodeMsEff >= MIN_DECODE_MS), so a rate
      // that still lands above 1000 tok/s is a genuine provider burst. When the
      // span is low-confidence the inflated rate is an artifact of the fallback
      // denominator, not a burst — that sample is reported as lowConfidence and
      // nothing else.
      //
      // "Idle-dominated" on its own is not enough to distrust a sample: a single
      // 1.2 s proxy pause inside a 1.5 s response still leaves ~250 ms of real
      // decoding, and that rate is as usable as any other (excluding it would
      // reproduce the very data loss this fix removes). The span is only called
      // unusable when the pauses take more than half the wall time AND what is
      // left cannot carry a rate — which covers both "the pause ate everything"
      // and "only sub-threshold gaps between pauses were ever seen".
      const idleDominated = idleMs > decodeWallMs * IDLE_DOMINANT_SHARE
      const lowConfidence = decodeMs <= 0 || (idleDominated && decodeMsEff < MIN_DECODE_MS)
      const lowConfidenceReason = lowConfidence
        ? (decodeMs <= 0 || idleDominated ? 'idle-dominated' : 'decode-too-short')
        : undefined
      // A response the provider delivered in one burst carries no usable decode
      // time: keep the sample for auditing, but never let it skew a comparison.
      //
      // P1-sem: the two marks are INDEPENDENT and may both be true. They answer
      // different questions — "burst" (deltaChunks < 3 with > 40 output tokens,
      // or an impossible tps above 1000) and "could not be measured reliably"
      // (see `lowConfidence` above). Hanging the burst rule off `!lowConfidence`
      // made it permanently dead on pause-dominated samples, so the ledger could
      // no longer tell a real burst from a sample it simply could not measure.
      const timingSuspect = (samples.deltaChunks < 3 && outputTokens > 40) || tps > 1000
      // Only calibrated samples reach the ledger: the provider's own usage is the truth.
      record({
        model,
        provider,
        ts: Date.now(),
        sessionId,
        outputTokens,
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        inputTokens: finite(usage?.inputTokens),
        cacheReadTokens: finite(usage?.cacheReadTokens),
        cacheWriteTokens: finite(usage?.cacheWriteTokens),
        decodeMs,
        decodeMsEff,
        decodeWallMs,
        idleMs,
        ...(samples.idleGaps > 0 ? { idleGaps: samples.idleGaps } : {}),
        tps,
        deltaChunks: samples.deltaChunks,
        ...(timingSuspect ? { timingSuspect: true } : {}),
        ...(lowConfidence ? { lowConfidence: true, lowConfidenceReason } : {}),
        ...(estimatedTps === undefined ? {} : { estimatedTps }),
        chars: samples.chars,
        textChars: samples.textChars,
        reasoningChars: samples.reasoningChars,
        toolChars: samples.toolChars,
        charsPerToken: perToken,
      })
      // Low confidence is a ledger mark, not a UI verdict: the instantaneous
      // number is still the best estimate available for this response.
      live.settled = timingSuspect
        ? null
        : {
            tps,
            at: Date.now(),
            outputTokens,
            decodeMs,
            decodeMsEff,
            idleMs,
            model,
            provider,
            estimated: false,
            ...(lowConfidence ? { lowConfidence: true, lowConfidenceReason } : {}),
          }
    } else if (estimatedTps !== undefined) {
      // No provider usage (aborted stream): show the estimate but keep it out of the ledger.
      live.settled = { tps: estimatedTps, at: Date.now(), outputTokens: null, decodeMs, model, provider, estimated: true }
    }
  }

  function observe(source, sessionId, provider, model) {
    const samples = {
      chars: 0,
      textChars: 0,
      reasoningChars: 0,
      toolChars: 0,
      firstDeltaAt: 0,
      lastDeltaAt: 0,
      idleMs: 0,
      idleGaps: 0,
      deltaChunks: 0,
      usageAt: 0,
      usage: undefined,
    }
    const live = sessionState(sessionId)
    live.model = model
    live.provider = provider
    live.decoding = true
    live.rate = 0
    live.ema = 0
    live.chars = 0
    live.samples = []
    live.lastDeltaAt = Date.now()

    return (async function* tap() {
      try {
        for await (const chunk of source) {
          const now = Date.now()
          const type = chunk === null || typeof chunk !== 'object' ? undefined : chunk.type
          let added = 0
          if (type === 'text-delta' && typeof chunk.text === 'string') {
            added = chunk.text.length
            samples.textChars += added
          } else if (type === 'reasoning-delta' && typeof chunk.text === 'string') {
            added = chunk.text.length
            samples.reasoningChars += added
          } else if (type === 'tool-call-delta' && typeof chunk.argumentsDelta === 'string') {
            added = chunk.argumentsDelta.length
            samples.toolChars += added
          }
          if (added > 0) {
            // Wall-clock gap between two deltas: proxy batching. It sits inside
            // the measured decode span but is not decoding, so it is counted
            // separately and subtracted in `settle()`.
            if (samples.lastDeltaAt > 0) {
              const gap = now - samples.lastDeltaAt
              if (gap >= IDLE_GAP_MS) {
                samples.idleMs += gap
                samples.idleGaps += 1
              }
            }
            if (samples.firstDeltaAt === 0) samples.firstDeltaAt = now
            samples.lastDeltaAt = now
            samples.chars += added
            samples.deltaChunks += 1
            try {
              noteDelta(live, now, samples.chars, charsPerToken())
            } catch (error) {
              // Metering must never break the stream it measures: record only.
              ledger.saveError = String(error?.message ?? error)
            }
          }
          if (type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
            samples.usage = chunk.usage
            samples.usageAt = now
          }
          yield chunk
        }
      } finally {
        // Telemetry failure must not replace the normal completion, the
        // provider error or the abort that reached this finally: the exception
        // is recorded and swallowed, and `decoding` is reset either way so the
        // session can never be left stuck in the streaming state.
        try {
          settle(samples, live, sessionId, provider, model)
        } catch (error) {
          try {
            live.decoding = false
            live.rate = 0
            live.ema = 0
          } catch (resetError) {
            void resetError
          }
          ledger.saveError = String(error?.message ?? error)
        }
      }
    })()
  }

  const liveRoute = async (req, res) => {
    if (!allowedRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const sessionId = queryValue(req, 'sessionId')
    const state = sessionId !== '' ? sessions.get(sessionId) : undefined
    const now = Date.now()
    const decoding = state !== undefined && state.decoding === true && now - state.lastDeltaAt < 1000
    sendJson(res, 200, {
      ok: true,
      sessionId,
      model: (state?.model ?? lastModel) || null,
      provider: (state?.provider ?? lastProvider) || null,
      decoding,
      rate: decoding ? state.rate : 0,
      chars: state?.chars ?? 0,
      charsPerToken: charsPerToken(),
      settled: state?.settled ?? null,
      at: now,
      storePath: file,
      ledger: {
        loaded: ledger.loaded,
        entries: ledger.entries.length,
        samples: ledger.calibratedSamples,
        error: ledger.loadError,
        saveError: ledger.saveError,
      },
    })
  }

  const historyRoute = async (req, res) => {
    if (!allowedRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    await ready
    sendJson(res, 200, {
      ok: true,
      rows: aggregateEntries(ledger.entries),
      // `total` is the ledger row count and never shrinks because of a mark;
      // the two marks are reported separately so a reader can tell "burst" from
      // "could not be measured".
      total: ledger.entries.length,
      excluded: ledger.entries.filter(entry => entry?.timingSuspect === true).length,
      lowConfidence: ledger.entries.filter(entry => entry?.lowConfidence === true).length,
      charsPerToken: charsPerToken(),
      calibratedSamples: ledger.calibratedSamples,
      storePath: file,
      updatedAt: new Date().toISOString(),
      error: ledger.loadError ?? ledger.saveError ?? null,
    })
  }

  /**
   * P1-2 side effect: every purge writes a new `purge-archive-*.jsonl` and
   * nothing ever removed one, so the plugin data dir grew without bound. After
   * a write, keep only the newest MAX_PURGE_ARCHIVES and delete the rest.
   *
   * Evidence may only be dropped by this sweep, so every step is individually
   * non-fatal: a readdir or unlink failure is recorded in `saveError` and the
   * sweep gives up, which keeps the *newest* archive (the one this purge just
   * wrote) instead of deleting it on a bad directory listing.
   */
  async function prunePurgeArchives() {
    let names
    try {
      names = await readdir(dir)
    } catch (error) {
      ledger.saveError = String(error?.message ?? error)
      return 0
    }
    const found = []
    for (const name of names) {
      if (!name.startsWith(PURGE_ARCHIVE_PREFIX) || !name.endsWith('.jsonl')) continue
      const candidate = join(dir, name)
      try {
        if (!(await stat(candidate)).isFile()) continue
      } catch (error) {
        void error
        continue
      }
      found.push({ name, candidate })
    }
    // The name is a normalized ISO timestamp, so lexicographic order is age order.
    found.sort((left, right) => left.name.localeCompare(right.name))
    let pruned = 0
    for (const item of found.slice(0, Math.max(0, found.length - MAX_PURGE_ARCHIVES))) {
      try {
        await rm(item.candidate, { force: true })
        pruned += 1
      } catch (error) {
        ledger.saveError = String(error?.message ?? error)
      }
    }
    return pruned
  }

  const purgeRoute = async (req, res) => {
    if (!allowedWriteRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    await ready
    const before = ledger.entries.length
    const archived = []
    const kept = []
    for (const entry of ledger.entries) {
      if (entry?.timingSuspect === true) {
        archived.push(entry)
        continue
      }
      // Legacy pre-restart samples carry no deltaChunks: bursts left unmarked by old code.
      if (entry?.deltaChunks === undefined && typeof entry?.tps === 'number' && entry.tps > 1000) {
        archived.push(entry)
        continue
      }
      kept.push(entry)
    }
    // Purge is the only irreversible action here, so the evidence lands on disk
    // before anything is dropped; if the archive write fails the ledger is left
    // exactly as it was (better to keep stale rows than to lose them).
    let archivePath = null
    if (archived.length > 0) {
      archivePath = join(dir, PURGE_ARCHIVE_PREFIX + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl')
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(archivePath, archived.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
      } catch (error) {
        ledger.saveError = String(error?.message ?? error)
        sendJson(res, 500, { ok: false, error: 'archive-failed', before, archived: 0, removed: 0, after: before })
        return
      }
    }
    // Retention runs only after the new archive is safely on disk, and never
    // removes it: the sweep keeps the newest MAX_PURGE_ARCHIVES.
    const archivePruned = archivePath === null ? 0 : await prunePurgeArchives()
    ledger.entries = kept
    scheduleSave()
    sendJson(res, 200, {
      ok: true,
      before,
      archived: archived.length,
      removed: before - kept.length,
      after: kept.length,
      archivePath,
      archivePruned,
      archiveKept: archivePath === null ? 0 : MAX_PURGE_ARCHIVES,
    })
  }

  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    if (stream === null || stream === undefined) return stream
    if (typeof stream[Symbol.asyncIterator] !== 'function') return stream
    const sessionId = typeof options?.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined
    // Compaction and title generation carry no session: pass them through untouched.
    if (sessionId === undefined) return stream
    const provider = typeof options?.provider === 'string' ? options.provider : 'unknown'
    const model = typeof options?.model === 'string' ? options.model : 'unknown'
    return observe(stream, sessionId, provider, model)
  })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/live', handler: liveRoute }),
    'dsh-tok-rate: live route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/history', handler: historyRoute }),
    'dsh-tok-rate: history route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_BASE + '/purge', handler: purgeRoute }),
    'dsh-tok-rate: purge route',
  )
  ctx.effect(
    () => () => {
      if (ledger.saveTimer !== null) {
        clearTimeout(ledger.saveTimer)
        ledger.saveTimer = null
      }
      sessions.clear()
    },
    'dsh-tok-rate: session meters',
  )
}
