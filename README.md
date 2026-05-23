# CryptoAI Scanner 🤖

Scanner automático que analiza el mercado crypto cada 5 minutos usando GitHub Actions.

## Estructura
```
cryptoai-scanner/
├── .github/workflows/scanner.yml  ← el que corre automático
├── scanner.js                     ← lógica de análisis
├── signals.json                   ← señales generadas
└── package.json
```

## Cómo funciona
1. GitHub Actions ejecuta `scanner.js` cada 5 minutos
2. El scanner consulta Kraken para BTC, ETH, SOL, BNB, XRP, DOGE
3. Analiza 5 timeframes + patrones de velas + auditoría
4. Si hay señal de calidad → la guarda en `signals.json`
5. La app en Netlify lee `signals.json` automáticamente

## URL de señales
Una vez configurado, las señales están en:
`https://raw.githubusercontent.com/Nancysevegit/cryptoai-scanner/main/signals.json`
