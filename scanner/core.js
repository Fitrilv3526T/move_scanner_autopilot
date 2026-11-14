'use strict';
/* ===== Verified engine (bit-identical port from the stress-tested scanner v2) =====
   Magnitude model features + logistic models + direction models.
   Pure functions, no DOM. Loaded models: models.json (MODEL), direction.json (DIRECTION). */
const MODEL = require('./models.json');
const DIRECTION = require('./direction.json');
const FEATS = ["trend","rsi","vol_z","atr_exp","rel6","atr_rel90","amihud_z","spread_z","dvol_shock","taker_imb","liq_rank"];
const TF = {"15m":{mins:15,bpd:96,sm:96}, "1h":{mins:60,bpd:24,sm:24}};
const FEAT_W = 6, LOOKBACK_D = 90, Z_DAYS = 60, VOL_D = 30, EVENT_PCTL = 0.9, ROW_FLOOR = 3e6;
const WINDOWS = [1,2,3,4,5,6];
const TARGETS = ["any","fall","rise"];
const STABLE_BASES = new Set(["USDC","FDUSD","TUSD","BUSD","DAI","USDP","USDD","USDT","EUR","GBP","AUD","TRY","BRL","RUB","UAH","NGN","ARS","PLN","RON","CZK","ZAR","IDR","JPY","MXN","WBTC","WBETH","BETH","AEUR","USD1","XUSD","PYUSD","USDE","SUSD","UST","VAI","EURI","BFUSD","USDS"]);

function needBars(tf){ return LOOKBACK_D*TF[tf].bpd + 450; }

function rollStats(x, w, minp){
  const n = x.length;
  let s = 0, c = 0;
  for (let i=0;i<n;i++){ const v=x[i]; if (v===v){ s+=v; c++; } }
  const mu0 = c ? s/c : 0;
  const P1 = new Float64Array(n+1), P2 = new Float64Array(n+1), C = new Int32Array(n+1);
  for (let i=0;i<n;i++){
    const v = x[i];
    if (v===v){ const d=v-mu0; P1[i+1]=P1[i]+d; P2[i+1]=P2[i]+d*d; C[i+1]=C[i]+1; }
    else { P1[i+1]=P1[i]; P2[i+1]=P2[i]; C[i+1]=C[i]; }
  }
  const mean = new Float64Array(n).fill(NaN), std = new Float64Array(n).fill(NaN), sum = new Float64Array(n).fill(NaN);
  for (let i=0;i<n;i++){
    const j=i+1, k=Math.max(0,j-w), cnt=C[j]-C[k];
    if (cnt>=minp && cnt>0){
      const s1=P1[j]-P1[k], s2=P2[j]-P2[k];
      mean[i]=mu0+s1/cnt; sum[i]=cnt*mu0+s1;
      if (cnt>1){ let v=(s2-s1*s1/cnt)/(cnt-1); if (v<0) v=0; std[i]=Math.sqrt(v); }
    }
  }
  return {mean, std, sum};
}
function zscore(x, w){
  const r = rollStats(x, w, Math.floor(w*0.8)), n=x.length, out=new Float64Array(n).fill(NaN);
  for (let i=0;i<n;i++){ const v=(x[i]-r.mean[i])/r.std[i]; out[i]=Number.isFinite(v)?v:NaN; }
  return out;
}
function ewm(x, alpha, minp){
  const n=x.length, out=new Float64Array(n).fill(NaN), f=1-alpha;
  if (!n) return out;
  let wavg=x[0], oldWt=1, nobs=(x[0]===x[0])?1:0;
  out[0]=nobs>=minp?wavg:NaN;
  for (let i=1;i<n;i++){
    const cur=x[i], isObs=(cur===cur);
    if (isObs) nobs++;
    if (wavg===wavg){
      oldWt*=f;
      if (isObs){ if (wavg!==cur) wavg=(oldWt*wavg+alpha*cur)/(oldWt+alpha); oldWt=1; }
    } else if (isObs){ wavg=cur; }
    out[i]=nobs>=minp?wavg:NaN;
  }
  return out;
}
function pctChange(c, k){
  const n=c.length, out=new Float64Array(n).fill(NaN);
  for (let i=k;i<n;i++){ const a=c[i], b=c[i-k]; if (a===a && b===b && b!==0) out[i]=a/b-1; }
  return out;
}
function buildGrid(rows, stepMs){
  // rows: [[openTime,o,h,l,c,v,qv,tbq], ...] ascending, numbers
  const t0=rows[0][0], tN=rows[rows.length-1][0], n=Math.round((tN-t0)/stepMs)+1;
  const g={t0, step:stepMs, n}, names=["o","h","l","c","v","qv","tb"];
  for (const nm of names) g[nm]=new Float64Array(n).fill(NaN);
  for (const r of rows){
    const i=Math.round((r[0]-t0)/stepMs);
    if (i<0||i>=n) continue;
    g.o[i]=r[1]; g.h[i]=r[2]; g.l[i]=r[3]; g.c[i]=r[4]; g.v[i]=r[5]; g.qv[i]=r[6]; g.tb[i]=r[7];
  }
  return g;
}
function btcRet(grid){ return {t0:grid.t0, step:grid.step, r:pctChange(grid.c, FEAT_W)}; }

// quantile with linear interpolation (pandas / numpy default)
function quantileLinear(sortedArr, q){
  const m=sortedArr.length; if (!m) return NaN;
  const pos=(m-1)*q, lo=Math.floor(pos), hi=Math.min(m-1,lo+1), fr=pos-lo;
  return sortedArr[lo]+(sortedArr[hi]-sortedArr[lo])*fr;
}
function thresholds(g, tf){
  const N90=LOOKBACK_D*TF[tf].bpd, mp=Math.floor(N90*0.8), n=g.n, t=n-1, out={};
  for (const W of WINDOWS){
    const end=t-W, start=end-N90+1;
    const up=[], dn=[];
    if (start>=0){
      for (let s=start;s<=end;s++){
        const c0=g.c[s]; if (!(c0===c0)) continue;
        let mx=-Infinity, mn=Infinity, ok=true;
        for (let k=1;k<=W;k++){ const hh=g.h[s+k], ll=g.l[s+k]; if (!(hh===hh) || !(ll===ll)){ ok=false; break; } if (hh>mx) mx=hh; if (ll<mn) mn=ll; }
        if (!ok) continue;
        up.push(mx/c0-1); dn.push(1-mn/c0);
      }
    }
    if (up.length>=mp){
      const a=Float64Array.from(up).sort(), b=Float64Array.from(dn).sort();
      out[W]={up:quantileLinear(a,EVENT_PCTL)*100, dn:quantileLinear(b,EVENT_PCTL)*100};
    } else out[W]={up:NaN, dn:NaN};
  }
  return out;
}
// all features except liq_rank, at the last bar; also dvd (30d average daily $ volume)
function lastFeatures(g, tf, btc){
  const cfg=TF[tf], bpd=cfg.bpd, sm=cfg.sm, smp=Math.max(1,Math.floor(sm*0.75)), n=g.n;
  const N90=LOOKBACK_D*bpd, Z=Z_DAYS*bpd, NV=VOL_D*bpd, FW=FEAT_W;
  const {h,l,c,v,tb}=g;
  const qvRaw=g.qv, qv=new Float64Array(n);
  for (let i=0;i<n;i++) qv[i]=(qvRaw[i]===0)?NaN:qvRaw[i];
  // trend
  const sma200=rollStats(c,200,200).mean, trend=new Float64Array(n);
  for (let i=0;i<n;i++) trend[i]=c[i]/sma200[i]-1;
  // rsi, atr
  const gain=new Float64Array(n).fill(NaN), loss=new Float64Array(n).fill(NaN), tr=new Float64Array(n).fill(NaN);
  for (let i=0;i<n;i++){
    if (i>0){ const d=c[i]-c[i-1]; if (d===d){ gain[i]=Math.max(d,0); loss[i]=Math.max(-d,0); } }
    const a=h[i]-l[i], pc=(i>0)?c[i-1]:NaN, b=Math.abs(h[i]-pc), cc=Math.abs(l[i]-pc);
    let m=-Infinity, any=false;
    if (a===a){ m=Math.max(m,a); any=true; }
    if (b===b){ m=Math.max(m,b); any=true; }
    if (cc===cc){ m=Math.max(m,cc); any=true; }
    if (any) tr[i]=m;
  }
  const ag=ewm(gain,1/14,14), al=ewm(loss,1/14,14), rsi=new Float64Array(n);
  for (let i=0;i<n;i++) rsi[i]=100-100/(1+ag[i]/al[i]);
  const volz=new Float64Array(n), vs=rollStats(v,20,20);
  for (let i=0;i<n;i++) volz[i]=(v[i]-vs.mean[i])/vs.std[i];
  const atr14=ewm(tr,1/14,14), atr100=ewm(tr,1/100,100), atrExp=new Float64Array(n);
  for (let i=0;i<n;i++) atrExp[i]=atr14[i]/atr100[i];
  // rel6 vs BTC
  const r6=pctChange(c,FW), rel6=new Float64Array(n).fill(NaN);
  for (let i=0;i<n;i++){
    const t=g.t0+i*g.step, bi=Math.round((t-btc.t0)/btc.step);
    const bv=(bi>=0&&bi<btc.r.length)?btc.r[bi]:NaN;
    rel6[i]=r6[i]-bv;
  }
  // atr_rel90
  const atrMean=rollStats(atr14,N90,Math.floor(N90*0.8)).mean, atrRel=new Float64Array(n);
  for (let i=0;i<n;i++) atrRel[i]=Math.log(atr14[i]/atrMean[i]);
  // amihud
  const ret=pctChange(c,1), amiIn=new Float64Array(n);
  for (let i=0;i<n;i++) amiIn[i]=Math.abs(ret[i])/qv[i];
  const amiM=rollStats(amiIn,sm,smp).mean, amiLog=new Float64Array(n);
  for (let i=0;i<n;i++) amiLog[i]=(amiM[i]>0)?Math.log(amiM[i]):NaN;
  const amihudZ=zscore(amiLog,Z);
  // corwin-schultz spread
  const k=3-2*Math.SQRT2, spr=new Float64Array(n).fill(NaN);
  for (let i=1;i<n;i++){
    const hl=Math.pow(Math.log(h[i]/l[i]),2), hl1=Math.pow(Math.log(h[i-1]/l[i-1]),2);
    const beta=hl+hl1, gamma=Math.pow(Math.log(Math.max(h[i],h[i-1])/Math.min(l[i],l[i-1])),2);
    const alpha=(Math.sqrt(2*beta)-Math.sqrt(beta))/k-Math.sqrt(gamma/k);
    let s=2*(Math.exp(alpha)-1)/(1+Math.exp(alpha));
    if (s===s) spr[i]=Math.max(s,0);
  }
  const spreadZ=zscore(rollStats(spr,sm,smp).mean,Z);
  // dollar-volume shock, taker imbalance
  const dvs=rollStats(qv,FW,FW-1).sum, dvLog=new Float64Array(n);
  for (let i=0;i<n;i++) dvLog[i]=(dvs[i]>0)?Math.log(dvs[i]):NaN;
  const dvolShock=zscore(dvLog,Z);
  const tin=new Float64Array(n);
  for (let i=0;i<n;i++) tin[i]=(2*tb[i]-qvRaw[i])/qv[i];
  const taker=rollStats(tin,FW,FW-1).mean;
  const dvd=rollStats(qv,NV,Math.floor(NV*0.8)).mean[n-1]*bpd;
  const L=n-1, vec=[trend[L],rsi[L],volz[L],atrExp[L],rel6[L],atrRel[L],amihudZ[L],spreadZ[L],dvolShock[L],taker[L]];
  return {vec, dvd};
}
function directionExtras(g, tf){
  // extra inputs for the direction model, at the last bar (mirrors the Python training exactly)
  const cfg=TF[tf], Z=Z_DAYS*cfg.bpd, n=g.n, L=n-1;
  const qvRaw=g.qv, qv=new Float64Array(n);
  for (let i=0;i<n;i++) qv[i]=(qvRaw[i]===0)?NaN:qvRaw[i];
  const tin=new Float64Array(n);
  for (let i=0;i<n;i++) tin[i]=(2*g.tb[i]-qvRaw[i])/qv[i];
  const imb3=rollStats(tin,3,2).mean;
  const imb3Z=zscore(imb3,Z);
  const r1=pctChange(g.c,1), r3=pctChange(g.c,3);
  let mx=-Infinity, mn=Infinity, cnt=0;
  for (let i=Math.max(0,n-20); i<n; i++){
    const hh=g.h[i], ll=g.l[i];
    if (hh===hh && ll===ll){ if (hh>mx) mx=hh; if (ll<mn) mn=ll; cnt++; }
  }
  let pos20=NaN;
  if (cnt===20 && mx>mn && g.c[L]>0) pos20=(g.c[L]-mn)/(mx-mn);
  return {r1:r1[L], r3:r3[L], imb3:imb3[L], imb3_z:imb3Z[L], pos20:pos20};
}
function directionLean(tf, W, vec, dx, pRise, pFall, thrW){
  // calibrated P(move up first) among unambiguous first touches; null = no lean
  const f=DIRECTION[tf][String(W)];
  if (!f || !thrW || !Number.isFinite(thrW.up) || !Number.isFinite(thrW.dn)) return null;
  const x=[vec[9], dx.imb3, dx.imb3_z, vec[1], vec[0], vec[4], dx.r1, dx.r3, dx.pos20,
           pRise-pFall, vec[2], vec[3], vec[8], vec[6], thrW.up-thrW.dn];
  for (const v of x) if (!Number.isFinite(v)) return null;
  const pr=predict(f, x);
  if (!Number.isFinite(pr.cal)) return null;
  if (Math.abs(pr.cal-0.5)<0.05) return null;
  return pr.cal;
}
function sigmoid(z){ return 1/(1+Math.exp(-z)); }
function interp(x, xs, ys){
  const m=xs.length;
  if (x<=xs[0]) return ys[0];
  if (x>=xs[m-1]) return ys[m-1];
  let lo=0, hi=m-1;
  while (hi-lo>1){ const mid=(lo+hi)>>1; if (xs[mid]<=x) lo=mid; else hi=mid; }
  const fr=(x-xs[lo])/(xs[hi]-xs[lo]);
  return ys[lo]+(ys[hi]-ys[lo])*fr;
}
function predict(model, x){
  let z=model.intercept;
  for (let j=0;j<x.length;j++){
    let u=(x[j]-model.mean[j])/model.scale[j];
    if (u>6) u=6; else if (u<-6) u=-6;
    z+=u*model.coef[j];
  }
  const p=sigmoid(z);
  return {raw:p, cal:interp(p, model.calib_x, model.calib_y)};
}
function percentRank(values){
  // pandas rank(pct=True), method 'average'
  const n=values.length, idx=values.map((v,i)=>i).sort((a,b)=>values[a]-values[b]), out=new Array(n);
  let i=0;
  while (i<n){
    let j=i; while (j+1<n && values[idx[j+1]]===values[idx[i]]) j++;
    const avg=(i+j)/2+1;
    for (let k=i;k<=j;k++) out[idx[k]]=avg/n;
    i=j+1;
  }
  return out;
}
function isCandidateSymbol(sym, allBases){
  if (!sym.endsWith("USDT")) return false;
  const b=sym.slice(0,-4);
  if (!b || STABLE_BASES.has(b)) return false;
  for (const suf of ["UP","DOWN","BULL","BEAR"]){
    if (b.endsWith(suf) && allBases.has(b.slice(0,-suf.length))) return false;
  }
  return true;
}

if (typeof module !== 'undefined') module.exports = { MODEL, DIRECTION, FEATS, TF, FEAT_W, LOOKBACK_D, Z_DAYS, VOL_D, EVENT_PCTL, ROW_FLOOR, WINDOWS, TARGETS, STABLE_BASES, needBars, rollStats, zscore, ewm, pctChange, buildGrid, btcRet, quantileLinear, thresholds, lastFeatures, directionExtras, directionLean, sigmoid, interp, predict, percentRank, isCandidateSymbol };
