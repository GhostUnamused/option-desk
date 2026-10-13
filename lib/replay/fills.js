// Replay fill model. A bhavcopy has one price per option per day, not a bid and ask, so the replay quotes
// around the day's price: buys fill at price + half-spread, sells at price − half-spread. The half-spread
// widens the further the strike is from the index and the fewer contracts changed hands that day.
import { REPLAY } from '../config.js';

const roundTo = (x, tick, dir) => Math[dir](x / tick - 1e-9 * (dir === 'ceil' ? 1 : -1)) * tick;

export function halfSpread({ price, spot, strike, volume }, cfg = REPLAY.slippage) {
  if (!(price > 0)) return 0;
  const away = spot ? Math.abs(strike / spot - 1) * 100 : 0; // % from spot, either side
  const liquidity = 1 + cfg.volumeK / Math.sqrt(Math.max(volume || 0, 1));
  const pct = Math.min(cfg.maxPct, (cfg.basePct + cfg.perPctAway * away) * liquidity);
  return Math.max(cfg.tick, price * pct);
}

// { bid, ask } on the exchange tick grid. bid is never below one tick.
export function quoteSides(row, spot, cfg = REPLAY.slippage) {
  const h = halfSpread({ price: row.price, spot, strike: row.strike, volume: row.volume }, cfg);
  const t = cfg.tick;
  const bid = Math.max(t, roundTo(row.price - h, t, 'floor'));
  const ask = Math.max(bid + t, roundTo(row.price + h, t, 'ceil'));
  return { bid: +bid.toFixed(2), ask: +ask.toFixed(2) };
}
