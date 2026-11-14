'use strict';
/* ===== Shared data layer: Binance public data + universe + scoring =====
   Pure Node 20 (global fetch), zero npm deps. Mirrors the browser scanner's
   network + compute path exactly, so live rows == browser rows. */
const C = require('./core.js');

const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
let hostIdx = 0, nextSlot = 0;
const MIN_GAP_MS = 70;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function slot() { const now = Date.now(), s = Math.max(now, nextSlot); nextSlot = s + MIN_GAP_MS; if (s > now) await sleep(s - now); }
let lastNetErr = '';

async function jget(path, tries = 5) {
  for (let t = 0; t < tries; t++) {
    try {
      await slot();
      const host = HOSTS[hostIdx % HOSTS.length];
      const r = await fetch(host + path);
      if (r.status === 429 || r.status === 418) { await sleep(3000 * (t + 1)); nextSlot = Date.now(); continue; }
      if (r.status === 451 || r.status === 403) { hostIdx++; lastNetErr = 'HTTP ' + r.status + ' from ' + host; continue; }
      if (!r.ok) { lastNetErr = 'HTTP ' + r.status + ' from ' + host; await sleep(500 * (t + 1)); continue; }
      return await r.json();
    } catch (e) { lastNetErr = 'network error on ' + host + ' (' + (e.message || e) + ')'; hostIdx++; await sleep(500 * (t + 1)); }
  }
  throw new Error('Could not reach Binance market data. Last problem: ' + lastNetErr);
}

async function pool(items, limit, fn) {
  let i = 0; const errs = {};
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) { const k = i++; if (k >= items.length) return; try { await fn(items[k], k); } catch (e) { errs[items[k]] = e; } }
  }));
  return errs;
}

function parseRows(raw, now) {
  const out = [];
  for (const r of raw) {
    if (Number(r[6]) >= now) continue;               // drop the still-forming candle
    out.push([Number(r[0]), +r[1], +r[2], +r[3], +r[4], +r[5], +r[7], +r[10]]);
  }
  return out;
}

async function fetchHistory(sym, tf, need) {
  const now = Date.now();
  let rows = [], end = null;
  for (let guard = 0; guard < 40 && rows.length < need; guard++) {
    const p = '/api/v3/klines?symbol=' + sym + '&interval=' + tf + '&limit=1000' + (end !== null ? '&endTime=' + end : '');
    const raw = await jget(p);
    if (!raw.length) break;
    rows = parseRows(raw, now).concat(rows);
    end = Number(raw[0][0]) - 1;
    if (raw.length < 1000) break;
  }
  rows.sort((a, b) => a[0] - b[0]);
  const ded = []; for (const r of rows) { if (!ded.length || r[0] > ded[ded.length - 1][0]) ded.push(r); }
  return ded.length > need ? ded.slice(ded.length - need) : ded;
}

async function fetchCandles(syms, tf, conc, onProg) {
  const out = new Map(); let done = 0;
  const errs = await pool(syms, conc || 6, async (sym) => {
    out.set(sym, await fetchHistory(sym, tf, C.needBars(tf)));
    done++; if (onProg) onProg(done, syms.length);
  });
  return { map: out, errs };
}

function universe(tick, topN, minVol) {
  const bases = new Set(tick.map(t => t.symbol).filter(s => s.endsWith('USDT')).map(s => s.slice(0, -4)));
  const cands = tick.filter(t => C.isCandidateSymbol(t.symbol, bases) && Number(t.quoteVolume) >= minVol)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0, topN);
  if (!cands.find(t => t.symbol === 'BTCUSDT')) { const b = tick.find(t => t.symbol === 'BTCUSDT'); if (b) cands.unshift(b); }
  return cands.map(t => ({ sym: t.symbol, price: Number(t.lastPrice), chg: Number(t.priceChangePercent), qv: Number(t.quoteVolume) }));
}

/* Score the last closed candle of every symbol, exactly like the browser's computeTf:
   features -> magnitude model p(fall/rise/any) per W -> event sizes per W -> direction lean per W.
   Also marks per-W "flag" = top 5% of p_any in this cross-section (live equivalent of the
   offline top-5% band used in the stress test). */
function score(tf, rowsMap) {
  const step = C.TF[tf].mins * 60000;
  const btcRows = rowsMap.get('BTCUSDT');
  if (!btcRows || btcRows.length < 500) throw new Error('BTCUSDT history missing at ' + tf);
  const btc = C.btcRet(C.buildGrid(btcRows, step));
  const lastBtc = btcRows[btcRows.length - 1][0];
  const need = C.needBars(tf), res = [], skipped = { short: 0, stale: 0, floor: 0, nan: 0 };
  for (const [sym, rows] of rowsMap) {
    if (rows.length < need * 0.95) { skipped.short++; continue; }
    if (rows[rows.length - 1][0] !== lastBtc) { skipped.stale++; continue; }
    const g = C.buildGrid(rows, step);
    const f = C.lastFeatures(g, tf, btc);
    if (!(f.dvd >= C.ROW_FLOOR)) { skipped.floor++; continue; }
    if (f.vec.some(v => !Number.isFinite(v))) { skipped.nan++; continue; }
    res.push({ sym, vec: f.vec.slice(), dvd: f.dvd, price: g.c[g.n - 1], g });
  }
  const ranks = C.percentRank(res.map(r => r.dvd));
  for (let i = 0; i < res.length; i++) {
    const r = res[i]; r.liq = ranks[i];
    r.p = {}; for (const t of C.TARGETS) { r.p[t] = {}; for (const W of C.WINDOWS) r.p[t][W] = C.predict(C.MODEL.tf[tf].models[W][t], r.vec).cal; }
    r.thr = C.thresholds(r.g, tf);
    const dx = C.directionExtras(r.g, tf);
    r.dx5 = [dx.imb3, dx.imb3_z, dx.r1, dx.r3, dx.pos20];
    r.dir = {}; for (const W of C.WINDOWS) r.dir[W] = C.directionLean(tf, W, r.vec, dx, r.p.rise[W], r.p.fall[W], r.thr[W]);
    delete r.g;
  }
  // per-W cross-sectional flag: top 5% by p_any
  const k = Math.max(1, Math.round(0.05 * res.length));
  for (const W of C.WINDOWS) {
    const idx = res.map((r, i) => i).sort((a, b) => res[b].p.any[W] - res[a].p.any[W]);
    for (let j = 0; j < res.length; j++) { const r = res[idx[j]]; (r.flagW = r.flagW || {})[W] = j < k; }
  }
  return { rows: res, skipped, lastCloseMs: lastBtc + step };
}

/* Resolve first-touch outcomes for one signal from its grid.
   thr = {up:[W...], dn:[W...]} in %. Returns per-W first touch (1 up, -1 down, 0 none, 9 both
   in the same candle), candles-to-touch, plus MFE/MAE/close over 6 candles. */
function resolveOutcome(g, tf, tClose, thr) {
  const step = C.TF[tf].mins * 60000;
  const i0 = Math.round((tClose - g.t0) / g.step);
  if (i0 < 0 || i0 >= g.n) return null;
  const c0 = g.c[i0];
  if (!(c0 === c0)) return null;
  const fd = [], tc = [];
  for (const W of C.WINDOWS) {
    let touch = 0, when = -1;
    for (let k = 1; k <= W; k++) {
      const j = i0 + k; if (j >= g.n) { when = -2; break; }        // -2 = not enough candles yet
      const hh = g.h[j], ll = g.l[j];
      if (!(hh === hh) || !(ll === ll)) continue;
      const up = hh >= c0 * (1 + thr.up[W - 1] / 100);
      const dn = ll <= c0 * (1 - thr.dn[W - 1] / 100);
      if (up && dn) { touch = 9; when = k; break; }
      if (up) { touch = 1; when = k; break; }
      if (dn) { touch = -1; when = k; break; }
    }
    fd.push(when === -2 ? null : touch); tc.push(when === -2 ? null : when);
  }
  let mfe = -Infinity, mae = -Infinity, c6 = null, ok6 = true;
  for (let k = 1; k <= 6; k++) {
    const j = i0 + k; if (j >= g.n) { ok6 = false; break; }
    const hh = g.h[j], ll = g.l[j], cc = g.c[j];
    if (hh === hh) mfe = Math.max(mfe, hh / c0 - 1);
    if (ll === ll) mae = Math.max(mae, 1 - ll / c0);
    if (k === 6 && cc === cc) c6 = cc;
  }
  return { fd, tc, mfe: ok6 && Number.isFinite(mfe) ? mfe : null, mae: ok6 && Number.isFinite(mae) ? mae : null, c6 };
}

module.exports = { jget, pool, parseRows, fetchHistory, fetchCandles, universe, score, resolveOutcome, sleep, HOSTS };
