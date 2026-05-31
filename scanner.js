// CryptoAI Scanner v2.0 — sincronizado con app v12
// Fixes: velas cerradas, filtro de tendencia intradía, fecha completa
// Timeframes intradía: 1m · 5m · 15m · 1H

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

// ✅ FIX v2: excluir última vela (está abierta/incompleta)
async function kOHLC(pair, interval, limit = 200) {
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`);
  const d = await r.json();
  if (d.error?.length) throw new Error(d.error[0]);
  const key = Object.keys(d.result).find(k => k !== 'last');
  // slice(-limit-1, -1) excluye la última vela abierta
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

// ✅ FIX v2: volScore usa velas cerradas (ya excluidas en kOHLC)
function volScore(vols) {
  if (vols.length < 2) return 1;
  const last = vols[vols.length - 1];
  const ma = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(vols.length, 20);
  return ma > 0 ? last / ma : 1;
}

// ✅ FIX v2: patrones en velas cerradas
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
//  AUDITORÍA INTRADÍA
// ══════════════════════════════════════════
function auditSignal(a1m, a5m, a15m, a1h, patterns) {
  const dirs = [a1m.dir, a5m.dir, a15m.dir, a1h.dir];
  const longCount = dirs.filter(d => d === 'L').length;
  const shortCount = dirs.filter(d => d === 'S').length;
  const mainDir = longCount > shortCount ? 'L' : 'S';
  const confluenceOk = longCount >= 3 || shortCount >= 3;
  const volOk = a5m.VS > 0.8;
  const rsiOk = mainDir === 'L' ? a5m.RSI < 75 : a5m.RSI > 25;
  const macdOk = mainDir === 'L' ? a5m.macd.hist > 0 : a5m.macd.hist < 0;
  const hasStrong = patterns.some(p => STRONG_PATS.includes(p.name));
  const hardFails = [!confluenceOk, !volOk, !rsiOk, !macdOk].filter(Boolean).length;
  const quality = hardFails === 0 ? 'ALTA' : hardFails === 1 ? 'MEDIA' : 'BAJA';
  return { quality, hardFails, mainDir, longCount, shortCount, confluenceOk, volOk, rsiOk, macdOk, hasStrong };
}

// ══════════════════════════════════════════
//  DECISIÓN CON FILTRO DE TENDENCIA
// ══════════════════════════════════════════
function buildDecision(a1m, a5m, a15m, a1h, price, audit) {
  if (audit.quality === 'BAJA') {
    return { verdict: 'ESPERAR', probability: 20, confidence: 'BAJA', riskPct: 0 };
  }

  // Pesos intradía: 1m(25%) + 5m(35%) + 15m(25%) + 1H(15%)
  const tot = a1m.score * 0.25 + a5m.score * 0.35 + a15m.score * 0.25 + a1h.score * 0.15;
  let verdict = tot > 1.2 ? 'LONG' : tot < -1.2 ? 'SHORT' : 'ESPERAR';
  const prob = Math.min(Math.max(Math.abs(tot) / 8 * 100, 40), 88);

  // ✅ FIX v2: FILTRO DE TENDENCIA
  // Contexto basado en 1H
  const macroCtx = a1h.score > 1 ? 'bull' : a1h.score < -1 ? 'bear' : 'neutral';

  // En contexto alcista: ignorar SHORT salvo >90% confianza
  if (macroCtx === 'bull' && verdict === 'SHORT' && prob < 90) {
    verdict = 'ESPERAR';
    console.log(`    → Filtro tendencia: contexto 1H alcista, SHORT ignorado (${prob.toFixed(0)}% < 90%)`);
  }
  // En contexto bajista: ignorar LONG salvo >90% confianza
  if (macroCtx === 'bear' && verdict === 'LONG' && prob < 90) {
    verdict = 'ESPERAR';
    console.log(`    → Filtro tendencia: contexto 1H bajista, LONG ignorado (${prob.toFixed(0)}% < 90%)`);
  }
  // RSI extremo: no entrar
  if (verdict === 'LONG' && a5m.RSI > 72) {
    verdict = 'ESPERAR';
    console.log(`    → RSI 5m sobrecomprado (${a5m.RSI.toFixed(0)}), LONG ignorado`);
  }
  if (verdict === 'SHORT' && a5m.RSI < 28) {
    verdict = 'ESPERAR';
    console.log(`    → RSI 5m sobrevendido (${a5m.RSI.toFixed(0)}), SHORT ignorado`);
  }

  const riskPct = audit.quality === 'ALTA' ? 2 : 1;
  const isL = verdict === 'LONG';
  const sl = isL ? price * 0.988 : price * 1.012;
  const tp1 = isL ? price * 1.015 : price * 0.985;
  const tp2 = isL ? price * 1.025 : price * 0.975;

  return { verdict, probability: Math.round(prob), confidence: audit.quality, riskPct, entry: price, stopLoss: sl, target1: tp1, target2: tp2, macroCtx };
}

// ══════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════
async function scanAll() {
  const now = new Date();
  console.log(`\n🔍 CryptoAI Scanner v2.0 — ${now.toLocaleTimeString('es-AR')}`);
  console.log(`📅 Fecha: ${now.toLocaleDateString('es-AR')}`);
  console.log(`✅ Usando velas cerradas + filtro de tendencia intradía\n`);

  let existing = [];
  try { existing = JSON.parse(fs.readFileSync('signals.json', 'utf8')); } catch(e) {}

  const newSignals = [];

  for (const [short, krakenPair] of Object.entries(PAIRS)) {
    try {
      console.log(`  Analizando ${short}...`);
      const tick = await kTicker(krakenPair);

      // ✅ FIX v2: timeframes intradía (sin 4H ni 1D)
      const [c1m, c5m, c15m, c1h] = await Promise.all([
        kOHLC(krakenPair, 1, 100),
        kOHLC(krakenPair, 5, 120),
        kOHLC(krakenPair, 15, 150),
        kOHLC(krakenPair, 60, 150),
      ]);

      const a1m = analyzeTF(c1m), a5m = analyzeTF(c5m);
      const a15m = analyzeTF(c15m), a1h = analyzeTF(c1h);

      // Recolectar patrones de velas cerradas
      const allPats = [];
      [[a5m,4],[a15m,3],[a1m,2],[a1h,1]].forEach(([a,w]) => {
        a.patterns.forEach(p => allPats.push({...p, weight: w}));
      });
      const dispPats = allPats.filter((v,i,a) => a.findIndex(t => t.name === v.name) === i).slice(0, 6);

      const audit = auditSignal(a1m, a5m, a15m, a1h, dispPats);
      const decision = buildDecision(a1m, a5m, a15m, a1h, tick.price, audit);

      console.log(`    RSI 5m: ${a5m.RSI.toFixed(0)} | Vol: ${a5m.VS.toFixed(2)}x | Contexto 1H: ${decision.macroCtx || 'neutral'}`);

      // Solo guardar señales de calidad ≥75%
      if (decision.verdict !== 'ESPERAR' && decision.probability >= 75) {
        const recent = existing.find(s =>
          s.pair === short &&
          Date.now() - s.ts < 1800000 // 30 min entre señales del mismo par
        );

        if (!recent) {
          // ✅ FIX v2: guardar fecha completa
          const sigNow = new Date();
          const dateStr = sigNow.toLocaleDateString('es-AR', {day:'2-digit', month:'2-digit', year:'2-digit'});
          const timeStr = sigNow.toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit'});

          const signal = {
            id: Date.now(),
            ts: Date.now(),
            pair: short,
            dir: decision.verdict === 'LONG' ? 'long' : 'short',
            verdict: decision.verdict,
            title: `${decision.verdict} — ${decision.confidence} CONFIANZA`,
            conf: decision.probability,
            entryPrice: tick.price,
            stopLoss: decision.stopLoss,
            target1: decision.target1,
            target2: decision.target2,
            riskPct: decision.riskPct,
            patterns: dispPats.slice(0, 3),
            auditQuality: audit.quality,
            confluence: `${Math.max(audit.longCount, audit.shortCount)}/4`,
            date: dateStr,       // ✅ fecha dd/mm/aa
            time: timeStr,       // ✅ hora hh:mm
            datetime: dateStr + ' ' + timeStr,
            verifyAt: Date.now() + 900000, // verificar en 15 minutos
            source: 'cloud',
            result: null,
            exitPrice: null,
            pnlPct: null,
          };
          newSignals.push(signal);
          console.log(`  ✅ ${short}: ${decision.verdict} ${decision.probability}% — ${decision.confidence} | ${dateStr} ${timeStr}`);
        } else {
          console.log(`  ⏭ ${short}: señal reciente, skip`);
        }
      } else {
        console.log(`  ⏸ ${short}: ${decision.verdict} — filtrado`);
      }

      await new Promise(r => setTimeout(r, 600));

    } catch(err) {
      console.error(`  ❌ ${short}: ${err.message}`);
    }
  }

  // Verificar señales pendientes a 15 minutos
  for (const sig of existing) {
    if (!sig.result && Date.now() >= (sig.verifyAt || sig.ts + 900000)) {
      try {
        const tick = await kTicker(PAIRS[sig.pair] || sig.pair);
        const pnl = sig.dir === 'long'
          ? (tick.price - sig.entryPrice) / sig.entryPrice * 100
          : (sig.entryPrice - tick.price) / sig.entryPrice * 100;
        sig.result = pnl > 0 ? 'win' : 'loss';
        sig.exitPrice = tick.price;
        sig.pnlPct = pnl;
        console.log(`  🔍 Verificado ${sig.pair}: ${sig.result} (${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}%)`);
      } catch(e) {}
    }
  }

  const combined = [...newSignals, ...existing].slice(0, 50);
  fs.writeFileSync('signals.json', JSON.stringify(combined, null, 2));
  console.log(`\n✅ Scanner v2.0 completado. ${newSignals.length} señales nuevas. Total: ${combined.length}`);
}

scanAll().catch(err => {
  console.error('Scanner error:', err);
  process.exit(1);
});
