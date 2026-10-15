// A small TradingView-style candle chart for one option: candles, a volume strip along the bottom, and a crosshair
// readout (open, high, low, close, volume). Used by the option drawer and the expired-options panel.
import { el, inr2, compact, themeColors } from './util.js';

const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

export function candleChart(box, { height = 260 } = {}) {
  const c = themeColors();
  const legend = el('div', { class: 'cc-legend' });
  const host = el('div', { style: { height: height + 'px' } });
  box.replaceChildren(el('div', { class: 'sc-wrap' }, host, legend));
  const chart = LightweightCharts.createChart(host, {
    autoSize: true,
    layout: { attributionLogo: false, background: { type: 'solid', color: c.bg }, textColor: c.muted, fontFamily: 'Inter, Segoe UI, system-ui, sans-serif', fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.line, scaleMargins: { top: 0.12, bottom: 0.22 } },
    timeScale: { borderColor: c.line, timeVisible: true, secondsVisible: false, rightOffset: 3 },
    crosshair: { mode: 0 }, localization: { priceFormatter: (p) => inr2.format(p) },
  });
  const price = chart.addCandlestickSeries({ upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down });
  const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  let rows = [];
  const show = (b) => {
    if (!b) { legend.replaceChildren(); return; }
    const k = (t, v, cls = '') => [el('span', { text: t }), el('b', { class: cls, text: v })];
    const prev = rows[rows.indexOf(b) - 1];
    legend.replaceChildren(el('div', { class: 'sc-row sc-ohlc' }, ...k('O', inr2.format(b.o)), ...k('H', inr2.format(b.h)), ...k('L', inr2.format(b.l)), ...k('C', inr2.format(b.c), b.c >= b.o ? 'up' : 'down'),
      ...(b.v ? k('Vol', compact.format(b.v)) : []), prev ? el('span', { class: b.c >= prev.c ? 'up' : 'down', text: `${b.c >= prev.c ? '+' : '−'}${(Math.abs(b.c / prev.c - 1) * 100).toFixed(2)}%` }) : null));
  };
  chart.subscribeCrosshairMove((p) => show(p.time == null ? rows[rows.length - 1] : rows.find((r) => r.t === p.time)));
  return {
    chart,
    // candles: [{ t, o, h, l, c, v }]; daily: t is a date (seconds at midnight) so the axis shows days, not times.
    set(candles, { fit = false, daily = false } = {}) {
      rows = candles;
      chart.applyOptions({ timeScale: { timeVisible: !daily } });
      price.setData(candles.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })));
      vol.setData(candles.map((b) => ({ time: b.t, value: b.v || 0, color: rgba(b.c >= b.o ? c.up : c.down, 0.35) })));
      if (fit) chart.timeScale().fitContent();
      show(candles[candles.length - 1]);
    },
    remove() { chart.remove(); },
  };
}
