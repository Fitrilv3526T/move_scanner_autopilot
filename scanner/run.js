'use strict';
/* ===== MOVE-SCANNER AUTOPILOT (data collector) =====
   Runs on GitHub Actions every 15 minutes. Fetches Binance public data, scores every
   liquid coin with the verified engine (magnitude + direction models), appends EVERY
   signal to docs/data/signals-<date>.jsonl with its full feature vector, then resolves
   each signal's outcome from later candles into outcomes-<date>.jsonl, and maintains
   live calibration stats. Paper only: it never places orders and uses no API keys.
   The data files are the point: download them later and retrain with them.

   Time convention: "t" everywhere = OPEN time of the signal candle (the last closed
   candle when the scan ran), identical to the offline backtest's idx*step+t0.
   Outcomes walk candles t+step .. t+6*step. */
const fs = require('fs'), path = require('path');
const C = require('./core.js');
const S = require('./scan.js');

const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'docs', 'data'), CFG = path.join(ROOT, 'config.json');
const TFS = ['15m', '1h'];
const DEFAULTS = { topN: 40, minVolUsd: 1000000, retentionDays: 120, startMs: null };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const DAY = 86400000;

const r5 = (x) => Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : null;
const r4 = (x) => Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null;
const r3 = (x) => Number.isFinite(x) ? Math.round(x * 1e3) / 1e3 : null;
const r6 = (x) => Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const readJSON = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } };
const writeJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
const append = (p, line) => fs.appendFileSync(p, line + '\n');
const fileFor = (kind, ms) => path.join(DATA, `${kind}-${ymd(ms)}.jsonl`);

function signalRow(r, tf, tOpen) {
  return {
    t: tOpen, tf, s: r.sym, px: r6(r.price),
    dvd: Math.round(r.dvd), lq: r3(r.liq),
    f: r.vec.map(r5), x: r.dx5.map(r5),
    u: C.WINDOWS.map(w => r4(r.thr[w].up)), d: C.WINDOWS.map(w => r4(r.thr[w].dn)),
    pa: C.WINDOWS.map(w => r4(r.p.any[w])), pr: C.WINDOWS.map(w => r4(r.p.rise[w])), pf: C.WINDOWS.map(w => r4(r.p.fall[w])),
    dl: C.WINDOWS.map(w => (r.dir[w] == null ? null : r4(r.dir[w]))),
    fl: C.WINDOWS.reduce((acc, w, i) => acc | (r.flagW[w] ? (1 << i) : 0), 0)
  };
}

/* Live calibration counters. sig = signal row; out = {fd:[6], ...} resolved. */
function updateStats(st, sig, out) {
  if (!out || !out.fd) return;
  for (let i = 0; i < C.WINDOWS.length; i++) {
    const W = String(C.WINDOWS[i]);
    const fd = out.fd[i];
    if (fd === null || fd === undefined) continue;                 // window not complete
    const key = sig.tf + '|' + W;
    const event = (fd === 1 || fd === -1 || fd === 9);             // any event-size touch within W
    if (fd === 1 || fd === -1) {                                    // unambiguous first touch -> direction stats
      const lean = sig.dl[i];
      if (lean != null) {
        const pts = Math.abs(lean - 0.5) * 100;
        const bucket = pts >= 15 ? '15' : (pts >= 10 ? '10' : '5');
        const b = st.dir[key][bucket]; b.n++; b.pred += lean; if (fd === 1) b.up++;
        const a = st.dir[key].all; a.n++; a.pred += lean; if (fd === 1) a.up++;
      }
    }
    if (sig.fl & (1 << i)) {                                         // flagged (top 5% this candle) -> event hit rate
      const m = st.mag[key]; m.n++; if (event) m.hits++;
    }
    const pa = sig.pa[i];
    if (pa != null && W === '6' && st.calib[sig.tf]) {               // calibration curve, W=6, all rows
      const b = st.calib[sig.tf]['6'].find(bb => pa >= bb.lo && pa < bb.hi);
      if (b) { b.n++; if (event) b.hits++; }
    }
  }
}

function newStats(startMs) {
  const st = { startMs, updatedMs: 0, totals: { signals: 0, outcomes: 0 }, byTf: {}, dir: {}, mag: {}, calib: {}, daily: {} };
  for (const tf of TFS) {
    st.byTf[tf] = { sig: 0, out: 0 };
    st.calib[tf] = {};
    for (const W of C.WINDOWS) {
      const key = tf + '|' + W;
      st.dir[key] = { '5': { n: 0, pred: 0, up: 0 }, '10': { n: 0, pred: 0, up: 0 }, '15': { n: 0, pred: 0, up: 0 }, all: { n: 0, pred: 0, up: 0 } };
      st.mag[key] = { n: 0, hits: 0 };
    }
    st.calib[tf]['6'] = [];
    for (let lo = 0.10; lo < 0.99; lo += 0.10) st.calib[tf]['6'].push({ lo: +lo.toFixed(2), hi: +(lo + 0.10).toFixed(2), n: 0, hits: 0 });
  }
  return st;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let user = readJSON(CFG, {});
  const cfg = Object.assign({}, DEFAULTS, user);
  let cfgChanged = false;
  if (!cfg.startMs) { cfg.startMs = Date.now(); user.startMs = cfg.startMs; cfgChanged = true; log('data collection starts now'); }
  if (cfgChanged || !fs.existsSync(CFG)) fs.writeFileSync(CFG, JSON.stringify(user, null, 2) + '\n');

  const oldState = readJSON(path.join(DATA, 'state.json'), null);
  const pending = readJSON(path.join(DATA, 'pending.json'), null) || { open: {} };
  if (!pending.open) pending.open = {};
  const stats = readJSON(path.join(DATA, 'stats.json'), null) || newStats(cfg.startMs);
  if (!stats.startMs) stats.startMs = cfg.startMs;

  const t0 = Date.now();
  log('loading tickers');
  const tick = await S.jget('/api/v3/ticker/24hr');
  const uni = S.universe(tick, cfg.topN, cfg.minVolUsd || 1000000);
  const uniSyms = uni.map(u => u.sym);
  if (!uniSyms.length) throw new Error('no coins passed the universe filter');
  const uniMap = new Map(uni.map(u => [u.sym, u]));

  const maps = {}, scored = {}, perTf = {};
  for (const tf of TFS) {
    const last = oldState && oldState.perTf && oldState.perTf[tf] ? oldState.perTf[tf].lastCloseMs : 0;
    const pendSyms = [...new Set(Object.values(pending.open).filter(p => p.tf === tf).map(p => p.s))];
    const syms = [...new Set(uniSyms.concat(pendSyms))];
    log(`fetching ${tf} candles for ${syms.length} coins (${pendSyms.length} extra for outcome tracking)`);
    const { map, errs } = await S.fetchCandles(syms, tf, 6);
    const sc = S.score(tf, map);
    maps[tf] = map; scored[tf] = sc;
    const tOpen = sc.lastCloseMs - C.TF[tf].mins * 60000;             // signal candle open time
    const fresh = !last || sc.lastCloseMs > last;
    let nLogged = 0;
    if (fresh) {
      const file = fileFor('signals', tOpen);
      for (const r of sc.rows) {
        if (!uniMap.has(r.sym)) continue;                            // helper symbols are not logged as signals
        const row = signalRow(r, tf, tOpen);
        append(file, JSON.stringify(row));
        nLogged++;
        stats.totals.signals++; stats.byTf[tf].sig++;
        pending.open[`${tf}|${r.sym}|${tOpen}`] = { tf, s: r.sym, t: tOpen, u: C.WINDOWS.map(w => r4(r.thr[w].up)), d: C.WINDOWS.map(w => r4(r.thr[w].dn)) };
      }
      append(fileFor('scans', Date.now()), JSON.stringify({ t: Date.now(), tf, nUniv: uniSyms.length, nRanked: sc.rows.length, nLogged, skipped: sc.skipped, candle: tOpen, errs: Object.keys(errs).length }));
      // keep stats/calib/pending structures valid if the on-disk file predates a schema fix
      stats.byTf[tf] = stats.byTf[tf] || { sig: 0, out: 0 };
    }
    perTf[tf] = { lastCloseMs: sc.lastCloseMs, fresh, nRanked: sc.rows.length, nLogged, skipped: sc.skipped, errs: Object.keys(errs).length };
    log(`${tf}: ${sc.rows.length} ranked, candle ${new Date(tOpen).toISOString()}, ${nLogged} signals logged (${fresh ? 'new candle' : 'duplicate, skipped'})`);
  }

  // ---- resolve pending outcomes ----
  const tNow = Date.now();
  let nResolved = 0, nDropped = 0;
  for (const [key, p] of Object.entries(pending.open)) {
    if (p.t < tNow - 3 * DAY) { delete pending.open[key]; nDropped++; continue; }   // delisted / stale: give up
    const map = maps[p.tf];
    const rows = map && map.get(p.s);
    if (!rows || !rows.length) continue;                            // not fetched this run; try next run
    const doneAt = p.t + 6 * C.TF[p.tf].mins * 60000 + C.TF[p.tf].mins * 60000; // close of the 6th candle after the signal
    if (perTf[p.tf].lastCloseMs < doneAt) continue;                  // window not complete yet
    const g = C.buildGrid(rows, C.TF[p.tf].mins * 60000);
    const out = S.resolveOutcome(g, p.tf, p.t, { up: p.u, dn: p.d });
    append(fileFor('outcomes', p.t), JSON.stringify({ t: p.t, tf: p.tf, s: p.s, fd: out ? out.fd : null, tc: out ? out.tc : null, upx: out ? r5(out.mfe) : null, dnx: out ? r5(out.mae) : null, c6: out ? r6(out.c6) : null }));
    const sig = findSignal(p);
    if (sig) updateStats(stats, sig, out);
    stats.totals.outcomes++; stats.byTf[p.tf].out++;   // count every resolved outcome, join or not
    delete pending.open[key];
    if (out && out.fd && out.fd.some(v => v !== null)) nResolved++; else nDropped++;
  }

  // find the original signal row (same day file, else one day earlier) to feed the stats
  function findSignal(p) {
    for (const ms of [p.t, p.t - DAY]) {
      const f = fileFor('signals', ms);
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const o = JSON.parse(lines[i]); if (o.tf === p.tf && o.s === p.s && o.t === p.t) return o; } catch (e) {}
      }
    }
    return null;
  }

  // ---- daily series ----
  const dkey = ymd(tNow);
  const day = stats.daily[dkey] || (stats.daily[dkey] = { sig: 0, out: 0 });
  for (const tf of TFS) day.sig += perTf[tf].nLogged;
  day.out += nResolved;
  const dkeys = Object.keys(stats.daily);
  if (dkeys.length > 90) dkeys.sort().slice(0, dkeys.length - 90).forEach(k => delete stats.daily[k]);
  stats.updatedMs = tNow;

  // ---- retention: drop files older than retentionDays ----
  const cutoff = ymd(tNow - (cfg.retentionDays || 120) * DAY);
  try {
    for (const f of fs.readdirSync(DATA)) {
      const m = /^(signals|outcomes|scans)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[2] < cutoff) fs.unlinkSync(path.join(DATA, f));
    }
  } catch (e) { log('retention cleanup skipped:', e.message); }

  // ---- dashboard snapshot ----
  const dispW = 6;
  const topRows = (tf) => scored[tf].rows.slice().sort((a, b) => b.p.any[dispW] - a.p.any[dispW]).slice(0, 25).map(r => ({
    s: r.sym, px: r6(r.price), chg: (uniMap.get(r.sym) || {}).chg != null ? r3(uniMap.get(r.sym).chg) : null,
    pa: C.WINDOWS.map(w => r4(r.p.any[w])), dl: C.WINDOWS.map(w => (r.dir[w] == null ? null : r4(r.dir[w]))),
    u6: r4(r.thr[6].up), d6: r4(r.thr[6].dn), dvd: Math.round(r.dvd), lq: r3(r.liq), fl: !!r.flagW[dispW]
  }));
  let storageBytes = 0; try { for (const f of fs.readdirSync(DATA)) storageBytes += fs.statSync(path.join(DATA, f)).size; } catch (e) {}
  let files = [];
  try {
    files = fs.readdirSync(DATA).filter(f => /\.(jsonl|json)$/.test(f)).map(f => ({ f, b: fs.statSync(path.join(DATA, f)).size })).sort((a, b) => b.b - a.b).slice(0, 400);
  } catch (e) {}
  const head = (tf) => {
    const k = tf + '|6', d = st2(stats.dir[k]);
    return { leanN5: d['5'].n, leanAcc5: d['5'].n ? +(d['5'].up / d['5'].n).toFixed(4) : null, leanPred5: d['5'].n ? +(d['5'].pred / d['5'].n).toFixed(4) : null, leanN10: d['10'].n, leanAcc10: d['10'].n ? +(d['10'].up / d['10'].n).toFixed(4) : null, flagN: stats.mag[k].n, flagHit: stats.mag[k].n ? +(stats.mag[k].hits / stats.mag[k].n).toFixed(4) : null };
  };
  function st2(d) { return d && d['5'] ? d : { '5': { n: 0, pred: 0, up: 0 }, '10': { n: 0, pred: 0, up: 0 }, '15': { n: 0, pred: 0, up: 0 }, all: { n: 0, pred: 0, up: 0 } }; }
  const newState = {
    v: 1, updatedMs: tNow, startMs: cfg.startMs, runMs: tNow - t0,
    cfg: { topN: cfg.topN, minVolUsd: cfg.minVolUsd || 1000000, retentionDays: cfg.retentionDays || 120 },
    universe: uniSyms.length, pendingN: Object.keys(pending.open).length,
    totals: stats.totals, byTf: stats.byTf, dir: stats.dir, mag: stats.mag,
    headline: { '1h': head('1h'), '15m': head('15m') },
    perTf: {}, calib: stats.calib, daily: stats.daily, storageBytes, files,
    top: { '15m': topRows('15m'), '1h': topRows('1h') }
  };
  for (const tf of TFS) newState.perTf[tf] = { lastCloseMs: perTf[tf].lastCloseMs, nRanked: perTf[tf].nRanked, skipped: perTf[tf].skipped, errs: perTf[tf].errs };

  // commit policy: write when something changed, or every 3 hours
  const fp = JSON.stringify([perTf['15m'].lastCloseMs, perTf['1h'].lastCloseMs, stats.totals.signals, stats.totals.outcomes, Object.keys(pending.open).length]);
  const seen = readJSON(path.join(DATA, 'seen.json'), {});
  const changed = fp !== seen.fp, stale = tNow - (seen.lastCommitMs || 0) > 3 * 3600e3;
  const write = changed || stale || !oldState;
  if (write) {
    writeJSON(path.join(DATA, 'state.json'), newState);
    writeJSON(path.join(DATA, 'stats.json'), stats);
    writeJSON(path.join(DATA, 'pending.json'), pending);
    writeJSON(path.join(DATA, 'files.json'), files);
    seen.fp = fp; seen.lastCommitMs = tNow;
    writeJSON(path.join(DATA, 'seen.json'), seen);
  }
  log(`signals ${stats.totals.signals}, outcomes ${stats.totals.outcomes} (+${nResolved} resolved, ${nDropped} dropped), pending ${Object.keys(pending.open).length}, storage ${(storageBytes / 1e6).toFixed(2)}MB, state ${write ? 'written' : 'unchanged (skipped)'}`);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
