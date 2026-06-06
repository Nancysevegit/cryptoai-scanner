// CryptoAI Scanner v3.0 — sincronizado con app v13
// Pesos: 1m(15%) + 5m(35%) + 15m(30%) + 1H(20%) = 100%
// Tendencia dominante con 1H+4H
// Verificación automática de resultados cada ejecución

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const fs = require('fs');

const PAIRS = {
  BTC: 'XXBTZUSD',
  ETH: 'XETHZUSD',
  SOL: 'SOLUSD',
  BNB: 'BNBUSD',
  XRP: 'XXRPZUSD',
  DOGE: 'XDGUSD',
};

const STRONG_PATS = ['Engulfing Alcista','Engulfing Bajista','Morning Star','Evening Star','Pin Bar Alcista','Pin Bar Bajista'];

// ══════════════════════════════════════════
//  KRAKEN API
// ══════════════════════════════════════════
async function kTicker(pair) {
  const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  const d = await r.json();
  if (d.error?.length) throw new Error(d.error[0]);
  const t = Object.values(d.result)[0];
  return {
    price: parseFloat(t.c[0]),
    chgPct: ((parseFloat(t.c[0]) - parseFloat(t.o)) / parseFloat(t.o) * 100),
  };
}

async function kOHLC(pair, interval, limit = 200) {
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`);
  const d = await r.json();
  if (d.error?.length) throw new Error(d.error[0]);
  const key = Object.keys(d.result).find(k => k !== 'last');
  return d.result[key].slice(-limit-1, -1).map(c => ({
    t: c[0], o: parseFloat(c[1]), h: parseFloat(c[2]),
    l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseFloat(c[6])
  }));
}

// ══════════════════════════════════════════
//  INDICADORES
// ══════════════════════════════════════════
function ema(arr, p) {
  const k = 2 / (p + 1);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function rsi14(arr, p = 14) {
  if (arr.length < p + 2) return 50;
  let g = 0, l = 0;
  for (let i = arr.length - p; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    d > 0 ? g += d : l += Math.abs(d);
  }
  const al = l / p;
  return al === 0 ? 100 : 100 - 100 / (1 + (g / p) / al);
}

function macdCalc(c) {
  const e12 = ema(c, 12), e26 = ema(c, 26), ml = e12 - e26;
  const ma = c.map((_, i) => i >= 26 ? ema(c.slice(0, i+1), 12) - ema(c.slice(0, i+1), 26) : 0).slice(26);
  const sig = ema(ma, 9);
  return { macd: ml, signal: sig, hist: ml - sig };
}

function volScore(vols) {
  if (vols.length < 2) return 1;
  const last = vols[vols.length - 1];
  const ma = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(vols.length, 20);
  return ma > 0 ? last / ma : 1;
}

function detectPatterns(candles) {
  const P = [];
  if (candles.length < 3) return P;
  const n = candles.length;
  const c0 = candles[n-1], c1 = candles[n-2], c2 = candles[n-3];
  const b0 = Math.abs(c0.c - c0.o), b1 = Math.abs(c1.c - c1.o), b2 = Math.abs(c2.c - c2.o);
  const r0 = c0.h - c0.l;
  const us0 = c0.h - Math.max(c0.o, c0.c), ls0 = Math.min(c0.o, c0.c) - c0.l;
  const bull0 = c0.c > c0.o, bull1 = c1.c > c1.o, bull2 = c2.c > c2.o;

  if (b0 < r0 * 0.1 && r0 > 0) P.push({ name: 'Doji', type: 'neutral' });
  if (!bull1 && ls0 > b0 * 2 && us0 < b0 * 0.3 && b0 > 0) P.push({ name: 'Martillo', type: 'bull' });
  if (!bull1 && us0 > b0 * 2 && ls0 < b0 * 0.3 && b0 > 0) P.push({ name: 'Martillo Invertido', type: 'bull' });
  if (bull1 && us0 > b0 * 2 && ls0 < b0 * 0.3 && b0 > 0) P.push({ name: 'Estrella Fugaz', type: 'bear' });
  if (us0 > r0 * 0.6 && b0 < r0 * 0.2) P.push({ name: 'Pin Bar Bajista', type: 'bear' });
  if (ls0 > r0 * 0.6 && b0 < r0 * 0.2) P.push({ name: 'Pin Bar Alcista', type: 'bull' });
  if (bull0 && !bull1 && c0.o < c1.c && c0.c > c1.o && b0 > b1 * 1.2) P.push({ name: 'Engulfing Alcista', type: 'bull' });
  if (!bull0 && bull1 && c0.o > c1.c && c0.c < c1.o && b0 > b1 * 1.2) P.push({ name: 'Engulfing Bajista', type: 'bear' });
  const sb1 = b1 < Math.max(b0, b2) * 0.3;
  if (!bull2 && sb1 && bull0 && b0 > b2 * 0.7) P.push({ name: 'Morning Star', type: 'bull' });
  if (bull2 && sb1 && !bull0 && b0 > b2 * 0.7) P.push({ name: 'Evening Star', type: 'bear' });
  if (bull0 && Math.abs(us0) < b0 * 0.05 && Math.abs(ls0) < b0 * 0.05 && b0 > r0 * 0.9) P.push({ name: 'Marubozu Alcista', type: 'bull' });
  if (!bull0 && Math.abs(us0) < b0 * 0.05 && Math.abs(ls0) < b0 * 0.05 && b0 > r0 * 0.9) P.push({ name: 'Marubozu Bajista', type: 'bear' });
  return P;
}

function analyzeTF(candles) {
  const closes = candles.map(c => c.c), vols = candles.map(c => c.v);
  const last = closes[closes.length - 1], prev = closes[closes.length - 2] || last;
  const RSI = rsi14(closes);
  const EMA7 = ema(closes, 7), EMA21 = ema(closes, 21), EMA50 = ema(closes, Math.min(50, closes.length - 1));
  const VS = volScore(vols), mom = (last - prev) / prev * 100;
  const patterns = detectPatterns(candles);
  const macd = macdCalc(closes);

  let score = 0;
  if (last > EMA7) score += 1.5; else score -= 1.5;
  if (last > EMA21) score += 1.5; else score -= 1.5;
  if (last > EMA50) score += 2; else score -= 2;
  if (EMA7 > EMA21) score += 1; else score -= 1;
  if (RSI < 38) score += 1.5; else if (RSI > 62) score -= 1.5;
  if (mom > 0.15) score += 1; else if (mom < -0.15) score -= 1;
  if (VS > 1.3) score *= 1.15;

  let ps = 0;
  patterns.forEach(p => {
    const w = STRONG_PATS.includes(p.name) ? 3 : 2;
    if (p.type === 'bull') ps += w; else if (p.type === 'bear') ps -= w;
  });

  const fs = score * 0.55 + ps * 0.45;
  return { RSI, VS, score: fs, dir: fs > 0.8 ? 'L' : fs < -0.8 ? 'S' : 'N', last, patterns, macd };
}

// ══════════════════════════════════════════
//  v13: TENDENCIA DOMINANTE 1H + 4H
// ══════════════════════════════════════════
function detectDominantTrend(c1h, c4h) {
  const closes1h = c1h.map(c => c.c);
  const closes4h = c4h.map(c => c.c);
  const highs1h = c1h.map(c => c.h), lows1h = c1h.map(c => c.l);

  const ema20_1h = ema(closes1h, 20), ema50_1h = ema(closes1h, 50);
  const ema200_1h = ema(closes1h, Math.min(200, closes1h.length - 1));
  const price1h = closes1h[closes1h.length - 1];
  const ema20_4h = ema(closes4h, 20), ema50_4h = ema(closes4h, 50);
  const price4h = closes4h[closes4h.length - 1];
  const rsi1h = rsi14(closes1h);
  const rsi4h = rsi14(closes4h);
  const slope1h = closes1h.length >= 6
    ? (closes1h[closes1h.length-1] - closes1h[closes1h.length-6]) / closes1h[closes1h.length-6] * 100 : 0;
  const slope4h = closes4h.length >= 4
    ? (closes4h[closes4h.length-1] - closes4h[closes4h.length-4]) / closes4h[closes4h.length-4] * 100 : 0;

  const recentHighs = highs1h.slice(-12), recentLows = lows1h.slice(-12);
  const hhll = recentHighs[recentHighs.length-1] < recentHighs[0] && recentLows[recentLows.length-1] < recentLows[0]
    ? 'bear' : recentHighs[recentHighs.length-1] > recentHighs[0] && recentLows[recentLows.length-1] > recentLows[0]
    ? 'bull' : 'neutral';

  let score = 0;
  if (price1h < ema20_1h) score -= 2; else score += 2;
  if (price1h < ema50_1h) score -= 2; else score += 2;
  if (price1h < ema200_1h) score -= 3; else score += 3;
  if (ema20_1h < ema50_1h) score -= 2; else score += 2;
  if (slope1h < -1) score -= 2; else if (slope1h > 1) score += 2;
  if (rsi1h < 40) score -= 1; else if (rsi1h > 60) score += 1;
  if (price4h < ema20_4h) score -= 3; else score += 3;
  if (price4h < ema50_4h) score -= 3; else score += 3;
  if (slope4h < -1.5) score -= 3; else if (slope4h > 1.5) score += 3;
  if (rsi4h < 40) score -= 2; else if (rsi4h > 60) score += 2;
  if (hhll === 'bear') score -= 3; else if (hhll === 'bull') score += 3;

  const strength = Math.min(Math.round(Math.abs(score) / 28 * 100), 99);
  const dir = score <= -8 ? 'bear' : score >= 8 ? 'bull' : 'neutral';
  return { dir, strength, score, slope1h, slope4h, rsi1h, rsi4h, hhll };
}

// ══════════════════════════════════════════
//  AUDITORÍA
// ══════════════════════════════════════════
function auditSignal(a1m, a5m, a15m, a1h, patterns, trend) {
  const dirs = [a1m.dir, a5m.dir, a15m.dir, a1h.dir];
  const longCount = dirs.filter(d => d === 'L').length;
  const shortCount = dirs.filter(d => d === 'S').length;
  const mainDir = longCount > shortCount ? 'L' : 'S';
  const confluenceOk = longCount >= 3 || shortCount >= 3;
  const volOk = a5m.VS > 0.8;
  const rsiOk = mainDir === 'L' ? a5m.RSI < 75 : a5m.RSI > 25;
  const macdOk = mainDir === 'L' ? a5m.macd.hist > 0 : a5m.macd.hist < 0;
  const trendAligned = (mainDir === 'L' && trend.dir === 'bull') ||
                       (mainDir === 'S' && trend.dir === 'bear') ||
                       trend.dir === 'neutral';
  const hardFails = [!confluenceOk, !volOk, !rsiOk, !macdOk].filter(Boolean).length;
  const quality = hardFails === 0 ? 'ALTA' : hardFails === 1 ? 'MEDIA' : 'BAJA';
  return { quality, hardFails, mainDir, longCount, shortCount, trendAligned };
}

// ══════════════════════════════════════════
//  DECISIÓN — pesos v13: 1m·15% 5m·35% 15m·30% 1H·20%
// ══════════════════════════════════════════
function buildDecision(a1m, a5m, a15m, a1h, price, audit, trend) {
  if (audit.quality === 'BAJA') {
    return { verdict: 'ESPERAR', probability: 20, confidence: 'BAJA', riskPct: 0 };
  }

  // ✅ v13: pesos actualizados y tendencia dominante aporta al score
  const trendBonus = trend.dir === 'bull' ? trend.strength / 100 * 2.5
                   : trend.dir === 'bear' ? -trend.strength / 100 * 2.5 : 0;
  const tot = a1m.score * 0.15 + a5m.score * 0.35 + a15m.score * 0.30 + a1h.score * 0.20 + trendBonus * 0.10;
  let verdict = tot > 1.2 ? 'LONG' : tot < -1.2 ? 'SHORT' : 'ESPERAR';
  let prob = Math.min(Math.max(Math.abs(tot) / 8 * 100, 40), 90);

  // Filtro de tendencia dominante fuerte
  if (trend.dir === 'bear' && verdict === 'LONG' && trend.strength >= 60) {
    verdict = 'ESPERAR';
    console.log(`    → Tendencia bajista fuerte (${trend.strength}%), LONG ignorado`);
  }
  if (trend.dir === 'bull' && verdict === 'SHORT' && trend.strength >= 60) {
    verdict = 'ESPERAR';
    console.log(`    → Tendencia alcista fuerte (${trend.strength}%), SHORT ignorado`);
  }
  // RSI extremo
  if (verdict === 'LONG' && a5m.RSI > 72) {
    verdict = 'ESPERAR';
    console.log(`    → RSI sobrecomprado (${a5m.RSI.toFixed(0)}), LONG ignorado`);
  }
  if (verdict === 'SHORT' && a5m.RSI < 28) {
    verdict = 'ESPERAR';
    console.log(`    → RSI sobrevendido (${a5m.RSI.toFixed(0)}), SHORT ignorado`);
  }

  const riskPct = audit.quality === 'ALTA' ? 2 : 1;
  const isL = verdict === 'LONG';
  const sl = isL ? price * 0.988 : price * 1.012;
  const tp1 = isL ? price * 1.015 : price * 0.985;
  const tp2 = isL ? price * 1.025 : price * 0.975;

  return {
    verdict, probability: Math.round(prob), confidence: audit.quality,
    riskPct, entry: price, stopLoss: sl, target1: tp1, target2: tp2,
    trendDir: trend.dir, trendStrength: trend.strength,
  };
}

// ══════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════
async function scanAll() {
  const now = new Date();
  console.log(`\n🔍 CryptoAI Scanner v3.0 — ${now.toLocaleTimeString('es-AR')}`);
  console.log(`📅 ${now.toLocaleDateString('es-AR')} | Pesos: 1m·15% 5m·35% 15m·30% 1H·20%\n`);

  let existing = [];
  try { existing = JSON.parse(fs.readFileSync('signals.json', 'utf8')); } catch(e) { existing = []; }

  // ══════════════════════════════════════════
  //  1. VERIFICAR SEÑALES PENDIENTES PRIMERO
  // ══════════════════════════════════════════
  let verified = 0;
  for (const sig of existing) {
    if (!sig.result && Date.now() >= (sig.verifyAt || sig.ts + 900000)) {
      try {
        await new Promise(r => setTimeout(r, 300));
        const tick = await kTicker(PAIRS[sig.pair] || sig.pair);
        const pnl = sig.dir === 'long'
          ? (tick.price - sig.entryPrice) / sig.entryPrice * 100
          : (sig.entryPrice - tick.price) / sig.entryPrice * 100;
        sig.result = pnl > 0 ? 'win' : 'loss';
        sig.exitPrice = parseFloat(tick.price.toFixed(2));
        sig.pnlPct = parseFloat(pnl.toFixed(2));
        verified++;
        console.log(`  ✔ Verificado ${sig.pair} ${sig.dir}: ${sig.result} (${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%) | entrada ${sig.entryPrice} → salida ${tick.price.toFixed(2)}`);
      } catch(e) {
        console.log(`  ⚠ No se pudo verificar ${sig.pair}: ${e.message}`);
      }
    }
  }
  if (verified > 0) console.log(`\n  📊 ${verified} señal(es) verificada(s)\n`);

  // ══════════════════════════════════════════
  //  2. ESCANEAR NUEVAS SEÑALES
  // ══════════════════════════════════════════
  const newSignals = [];

  for (const [short, krakenPair] of Object.entries(PAIRS)) {
    try {
      console.log(`  Analizando ${short}...`);
      const tick = await kTicker(krakenPair);

      // v13: fetch 4H para tendencia dominante
      const [c1m, c5m, c15m, c1h, c4h] = await Promise.all([
        kOHLC(krakenPair, 1, 100),
        kOHLC(krakenPair, 5, 120),
        kOHLC(krakenPair, 15, 150),
        kOHLC(krakenPair, 60, 150),
        kOHLC(krakenPair, 240, 100),
      ]);

      const a1m = analyzeTF(c1m), a5m = analyzeTF(c5m);
      const a15m = analyzeTF(c15m), a1h = analyzeTF(c1h);

      // Tendencia dominante
      const trend = detectDominantTrend(c1h, c4h);
      console.log(`    Tendencia: ${trend.dir} (${trend.strength}%) | RSI5m: ${a5m.RSI.toFixed(0)} | Vol: ${a5m.VS.toFixed(2)}x`);

      const allPats = [];
      [[a5m,4],[a15m,3],[a1m,2],[a1h,1]].forEach(([a,w]) => {
        a.patterns.forEach(p => allPats.push({...p, weight: w}));
      });
      const dispPats = allPats.filter((v,i,a) => a.findIndex(t => t.name === v.name) === i).slice(0, 6);

      const audit = auditSignal(a1m, a5m, a15m, a1h, dispPats, trend);
      const decision = buildDecision(a1m, a5m, a15m, a1h, tick.price, audit, trend);

      // Solo guardar señales ≥75% y calidad MEDIA o ALTA
      if (decision.verdict !== 'ESPERAR' && decision.probability >= 75) {
        const recent = existing.find(s => s.pair === short && Date.now() - s.ts < 1800000);
        if (!recent) {
          const sigNow = new Date();
          const dateStr = sigNow.toLocaleDateString('es-AR', {day:'2-digit', month:'2-digit', year:'2-digit'});
          const timeStr = sigNow.toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit'});

          const signal = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            ts: Date.now(),
            pair: short,
            dir: decision.verdict === 'LONG' ? 'long' : 'short',
            verdict: decision.verdict,
            title: `${decision.verdict} — ${decision.confidence} CONFIANZA`,
            conf: decision.probability,
            entryPrice: tick.price,
            stopLoss: parseFloat(decision.stopLoss.toFixed(2)),
            target1: parseFloat(decision.target1.toFixed(2)),
            target2: parseFloat(decision.target2.toFixed(2)),
            riskPct: decision.riskPct,
            patterns: dispPats.slice(0, 3),
            auditQuality: audit.quality,
            confluence: `${Math.max(audit.longCount, audit.shortCount)}/4`,
            trend: decision.trendDir,
            trendStrength: decision.trendStrength,
            date: dateStr,
            time: timeStr,
            datetime: dateStr + ' ' + timeStr,
            verifyAt: Date.now() + 900000, // 15 minutos
            source: 'cloud',
            result: null,
            exitPrice: null,
            pnlPct: null,
          };
          newSignals.push(signal);
          console.log(`  ✅ ${short}: ${decision.verdict} ${decision.probability}% — ${decision.confidence} | ${timeStr}`);
        } else {
          console.log(`  ⏭ ${short}: señal reciente (${Math.round((Date.now()-recent.ts)/60000)}min), skip`);
        }
      } else {
        console.log(`  ⏸ ${short}: ${decision.verdict} ${decision.probability}% — no cumple umbral`);
      }

      await new Promise(r => setTimeout(r, 600));

    } catch(err) {
      console.error(`  ❌ ${short}: ${err.message}`);
    }
  }

  // ══════════════════════════════════════════
  //  3. GUARDAR
  // ══════════════════════════════════════════
  const combined = [...newSignals, ...existing].slice(0, 60);
  fs.writeFileSync('signals.json', JSON.stringify(combined, null, 2));

  const wins = combined.filter(s => s.result === 'win').length;
  const losses = combined.filter(s => s.result === 'loss').length;
  const pending = combined.filter(s => !s.result).length;
  console.log(`\n✅ Scanner v3.0 completado.`);
  console.log(`   Nuevas: ${newSignals.length} | Verificadas hoy: ${verified}`);
  console.log(`   Historial: ✅${wins} aciertos / ❌${losses} fallos / ⏳${pending} pendientes`);
  if (wins + losses > 0) console.log(`   Win rate: ${(wins/(wins+losses)*100).toFixed(0)}%`);
}

scanAll().catch(err => {
  console.error('Scanner error:', err);
  process.exit(1);
});
