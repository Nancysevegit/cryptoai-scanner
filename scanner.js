// CryptoAI Scanner v1.0
// Corre en GitHub Actions cada 5 minutos
// Analiza BTC, ETH, SOL, BNB, XRP, DOGE via Kraken

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
  return d.result[key].slice(-limit).map(c => ({
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
  const ma = c.map((_, i) => i >= 26 ? ema(c.slice(0, i + 1), 12) - ema(c.slice(0, i + 1), 26) : 0).slice(26);
  const sig = ema(ma, 9);
  return { macd: ml, signal: sig, hist: ml - sig };
}

function bollCalc(c, p = 20) {
  const sl = c.slice(-p), mid = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
  return { upper: mid + 2 * std, lower: mid - 2 * std, mid, std };
}

function volScore(vols) {
  const last = vols[vols.length - 1];
  const ma = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  return ma > 0 ? last / ma : 1;
}

// ══════════════════════════════════════════
//  PATRONES DE VELAS
// ══════════════════════════════════════════
function detectPatterns(candles) {
  const P = [];
  if (candles.length < 3) return P;
  const n = candles.length, c0 = candles[n-1], c1 = candles[n-2], c2 = candles[n-3];
  const b0 = Math.abs(c0.c - c0.o), b1 = Math.abs(c1.c - c1.o), b2 = Math.abs(c2.c - c2.o);
  const r0 = c0.h - c0.l;
  const us0 = c0.h - Math.max(c0.o, c0.c), ls0 = Math.min(c0.o, c0.c) - c0.l;
  const bull0 = c0.c > c0.o, bull1 = c1.c > c1.o, bull2 = c2.c > c2.o;

  if (b0 < r0 * 0.1 && r0 > 0) P.push({ name: 'Doji', type: 'neutral' });
  if (!bull1 && ls0 > b0 * 2 && us0 < b0 * 0.3 && b0 > 0) P.push({ name: 'Martillo', type: 'bull' });
  if (bull1 && us0 > b0 * 2 && ls0 < b0 * 0.3 && b0 > 0) P.push({ name: 'Estrella Fugaz', type: 'bear' });
  if (us0 > r0 * 0.6 && b0 < r0 * 0.2) P.push({ name: 'Pin Bar Bajista', type: 'bear' });
  if (ls0 > r0 * 0.6 && b0 < r0 * 0.2) P.push({ name: 'Pin Bar Alcista', type: 'bull' });
  if (bull0 && !bull1 && c0.o < c1.c && c0.c > c1.o && b0 > b1 * 1.2) P.push({ name: 'Engulfing Alcista', type: 'bull' });
  if (!bull0 && bull1 && c0.o > c1.c && c0.c < c1.o && b0 > b1 * 1.2) P.push({ name: 'Engulfing Bajista', type: 'bear' });
  const sb1 = b1 < Math.max(b0, b2) * 0.3;
  if (!bull2 && sb1 && bull0 && b0 > b2 * 0.7) P.push({ name: 'Morning Star', type: 'bull' });
  if (bull2 && sb1 && !bull0 && b0 > b2 * 0.7) P.push({ name: 'Evening Star', type: 'bear' });
  return P;
}

// ══════════════════════════════════════════
//  ANÁLISIS COMPLETO POR TIMEFRAME
// ══════════════════════════════════════════
function analyzeTF(candles) {
  const closes = candles.map(c => c.c), vols = candles.map(c => c.v);
  const last = closes[closes.length - 1], prev = closes[closes.length - 2] || last;
  const RSI = rsi14(closes);
  const EMA7 = ema(closes, 7), EMA21 = ema(closes, 21), EMA50 = ema(closes, Math.min(50, closes.length - 1));
  const VS = volScore(vols), mom = (last - prev) / prev * 100;
  const patterns = detectPatterns(candles);
  const boll = bollCalc(closes), macd = macdCalc(closes);

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
    const w = ['Engulfing Alcista','Engulfing Bajista','Morning Star','Evening Star','Pin Bar Alcista','Pin Bar Bajista'].includes(p.name) ? 3 : 2;
    if (p.type === 'bull') ps += w; else if (p.type === 'bear') ps -= w;
  });
  const fs = score * 0.55 + ps * 0.45;
  return { RSI, VS, mom, score: fs, dir: fs > 0.8 ? 'L' : fs < -0.8 ? 'S' : 'N', last, patterns, boll, macd };
}

// ══════════════════════════════════════════
//  AUDITORÍA DE SEÑAL
// ══════════════════════════════════════════
function auditSignal(a1m, a5m, a1h, a4h, a1d, patterns) {
  const dirs = [a1m.dir, a5m.dir, a1h.dir, a4h.dir, a1d.dir];
  const longCount = dirs.filter(d => d === 'L').length;
  const shortCount = dirs.filter(d => d === 'S').length;
  const mainDir = longCount > shortCount ? 'L' : 'S';
  const confluenceOk = longCount >= 3 || shortCount >= 3;
  const volOk = a1h.VS > 0.9;
  const rsiOk = mainDir === 'L' ? a1h.RSI < 75 : a1h.RSI > 25;
  const macdOk = mainDir === 'L' ? a1h.macd.hist > 0 : a1h.macd.hist < 0;
  const STRONG = ['Engulfing Alcista','Engulfing Bajista','Morning Star','Evening Star','Pin Bar Alcista','Pin Bar Bajista'];
  const hasStrong = patterns.some(p => STRONG.includes(p.name));

  const fails = [!confluenceOk, !volOk, !rsiOk, !macdOk].filter(Boolean).length;
  const quality = fails === 0 ? 'ALTA' : fails === 1 ? 'MEDIA' : 'BAJA';
  return { quality, fails, mainDir, longCount, shortCount, confluenceOk, volOk, rsiOk, macdOk, hasStrong };
}

// ══════════════════════════════════════════
//  DECISIÓN FINAL
// ══════════════════════════════════════════
function buildDecision(a1m, a5m, a1h, a4h, a1d, price, audit) {
  if (audit.quality === 'BAJA') {
    return { verdict: 'ESPERAR', probability: 20, confidence: 'BAJA', riskPct: 0 };
  }
  const scS = a1m.score * 0.4 + a5m.score * 0.4 + a1h.score * 0.2;
  const swS = a1h.score * 0.2 + a4h.score * 0.45 + a1d.score * 0.35;
  const tot = scS + swS;
  const verdict = tot > 1.5 ? 'LONG' : tot < -1.5 ? 'SHORT' : 'ESPERAR';
  const prob = Math.min(Math.max(Math.abs(tot) / 8 * 100, 40), 92);
  const riskPct = audit.quality === 'ALTA' ? 2 : 1;
  const isL = verdict === 'LONG';
  const sl = isL ? price * 0.985 : price * 1.015;
  const tp1 = isL ? price * 1.025 : price * 0.975;
  const tp2 = isL ? price * 1.04 : price * 0.96;
  return { verdict, probability: Math.round(prob), confidence: audit.quality, riskPct, entry: price, stopLoss: sl, target1: tp1, target2: tp2 };
}

// ══════════════════════════════════════════
//  MAIN - ESCANEO DE TODOS LOS PARES
// ══════════════════════════════════════════
async function scanAll() {
  console.log(`\n🔍 CryptoAI Scanner — ${new Date().toLocaleTimeString('es-AR')}`);

  // Cargar señales existentes
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync('signals.json', 'utf8')); } catch(e) {}

  const newSignals = [];

  for (const [short, krakenPair] of Object.entries(PAIRS)) {
    try {
      console.log(`  Analizando ${short}...`);
      const tick = await kTicker(krakenPair);
      const [c1m, c5m, c1h, c4h, c1d] = await Promise.all([
        kOHLC(krakenPair, 1, 100),
        kOHLC(krakenPair, 5, 100),
        kOHLC(krakenPair, 60, 200),
        kOHLC(krakenPair, 240, 200),
        kOHLC(krakenPair, 1440, 100),
      ]);

      const a1m = analyzeTF(c1m), a5m = analyzeTF(c5m);
      const a1h = analyzeTF(c1h), a4h = analyzeTF(c4h), a1d = analyzeTF(c1d);

      // Recolectar patrones
      const allPats = [];
      [[a1h,3],[a4h,4],[a1d,3],[a5m,2],[a1m,1]].forEach(([a,w]) => {
        a.patterns.forEach(p => allPats.push({...p, weight: w}));
      });
      const dispPats = allPats.filter((v,i,a) => a.findIndex(t => t.name === v.name) === i).slice(0, 6);

      const audit = auditSignal(a1m, a5m, a1h, a4h, a1d, dispPats);
      const decision = buildDecision(a1m, a5m, a1h, a4h, a1d, tick.price, audit);

      // Solo guardar señales de calidad
      if (decision.verdict !== 'ESPERAR' && decision.probability >= 75) {
        // Verificar que no sea duplicada (misma dirección en últimos 30 min)
        const recent = existing.find(s =>
          s.pair === short &&
          s.dir === (decision.verdict === 'LONG' ? 'long' : 'short') &&
          Date.now() - s.ts < 1800000
        );

        if (!recent) {
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
            confluence: `${Math.max(audit.longCount, audit.shortCount)}/5`,
            time: new Date().toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit'}),
            source: 'cloud', // indica que vino del scanner en la nube
            result: null,
            exitPrice: null,
            pnlPct: null,
          };
          newSignals.push(signal);
          console.log(`  ✅ ${short}: ${decision.verdict} ${decision.probability}% — ${decision.confidence}`);
        } else {
          console.log(`  ⏭ ${short}: señal duplicada, skip`);
        }
      } else {
        console.log(`  ⏸ ${short}: ${decision.verdict} — sin señal`);
      }

      // Pequeña pausa entre requests
      await new Promise(r => setTimeout(r, 500));

    } catch(err) {
      console.error(`  ❌ ${short}: ${err.message}`);
    }
  }

  // Verificar señales pendientes (1H después)
  const updated = existing.map(sig => {
    if (!sig.result && Date.now() - sig.ts >= 3600000) {
      // Marcar como pendiente de verificación
      // La verificación real se hace en el próximo ciclo con precio actual
      sig.pendingVerify = true;
    }
    return sig;
  });

  // Combinar: nuevas señales + existentes (máx 50)
  const combined = [...newSignals, ...updated].slice(0, 50);

  fs.writeFileSync('signals.json', JSON.stringify(combined, null, 2));
  console.log(`\n✅ Scanner completado. ${newSignals.length} nuevas señales. Total: ${combined.length}`);
}

scanAll().catch(err => {
  console.error('Scanner error:', err);
  process.exit(1);
});
