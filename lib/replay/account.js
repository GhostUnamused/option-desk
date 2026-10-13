// Replay account: the paper engine running on the replay clock, with its own balance (replay.json),
// fills at the day's price ± slippage, no fills in strikes that did not trade, one equity point per day,
// and a trade journal (entry notes, P&L by day, end-of-session summary).
import { PaperAccount } from '../paper.js';
import { REPLAY } from '../config.js';

const round2 = (x) => Math.round(x * 100) / 100;
const istDate = (t) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);

export class ReplayAccount extends PaperAccount {
  constructor(file, provider, clock) {
    super(file, provider, { now: clock });
  }

  fresh(balance = REPLAY.startBalance) { return { ...super.fresh(balance), session: null }; }

  // Mark positions at the day's price itself, not the middle of the made-up spread.
  async quote(l) { const q = await super.quote(l); return { ...q, mid: q.ltp }; }

  checkQuote(l, q) {
    if (!(q.vol > 0)) throw new Error(`No ${l.strike} ${l.type} contracts traded on this day, so there is no price to fill at. Pick a strike that traded (volume above 0), or try again on a later day.`);
  }

  async markToMarket() {
    let v = this.state.cash;
    for (const p of this.state.positions) { try { v += p.qty * (await this.quote(p)).mid; } catch { v += p.qty * p.avg; } }
    return v;
  }

  // Exactly one equity point per replay day: the latest value for today replaces the earlier one.
  async snapshot(force, equity) {
    if (equity == null) equity = await this.markToMarket();
    const eq = this.state.equity; const last = eq[eq.length - 1]; const t = this.now(); const v = round2(equity);
    if (last && last.t === t) { if (last.v === v) return; last.v = v; } else eq.push({ t, v });
    this.write();
  }

  // Trades with their notes, P&L by day, and summary numbers. Works mid-session and after it ends.
  journal() {
    const st = this.state;
    const days = []; let prev = st.startBalance, peak = st.startBalance, maxDd = 0;
    for (const e of st.equity) {
      const date = istDate(e.t);
      if (days.length && days[days.length - 1].date === date) { days.pop(); prev = days.length ? days[days.length - 1].equity : st.startBalance; }
      days.push({ date, equity: e.v, pnl: round2(e.v - prev), total: round2(e.v - st.startBalance) });
      prev = e.v; peak = Math.max(peak, e.v); maxDd = Math.max(maxDd, peak - e.v);
    }
    const played = days.filter((d, i) => i > 0 || d.pnl !== 0);
    const closes = st.orders.filter((o) => o.realized);
    const wins = closes.filter((o) => o.realized > 0), losses = closes.filter((o) => o.realized < 0);
    const sum = (a) => a.reduce((s, o) => s + o.realized, 0);
    const best = played.reduce((a, d) => (!a || d.pnl > a.pnl ? d : a), null), worst = played.reduce((a, d) => (!a || d.pnl < a.pnl ? d : a), null);
    const equity = days.length ? days[days.length - 1].equity : st.startBalance;
    return {
      session: st.session,
      trades: st.orders.map((o) => ({ ...o, date: istDate(o.t) })),
      days,
      stats: {
        startBalance: st.startBalance, equity, totalPnl: round2(equity - st.startBalance), returnPct: round2((equity / st.startBalance - 1) * 100),
        realized: st.realized, charges: st.charges, orders: st.orders.filter((o) => !o.id.startsWith('S')).length, settlements: st.orders.filter((o) => o.id.startsWith('S')).length,
        closedTrades: closes.length, wins: wins.length, losses: losses.length, winRate: closes.length ? round2(wins.length / closes.length * 100) : null,
        avgWin: wins.length ? round2(sum(wins) / wins.length) : null, avgLoss: losses.length ? round2(sum(losses) / losses.length) : null,
        bestDay: best && best.pnl > 0 ? best : null, worstDay: worst && worst.pnl < 0 ? worst : null, maxDrawdown: round2(maxDd),
        tradingDays: days.length, openPositions: st.positions.length,
        withNotes: st.orders.filter((o) => o.note).length,
      },
    };
  }
}
