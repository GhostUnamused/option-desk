// Plain-English glossary. term() marks a label as explainable; one shared tooltip shows the text on hover, focus or tap.
import { el } from './util.js';

export const GLOSSARY = {
  'call': 'A call option gains value when the index rises. Buying one is a bet on the market going up.',
  'put': 'A put option gains value when the index falls. Buying one is a bet on the market going down.',
  'strike': 'The index level the option is tied to. A call pays out above its strike; a put pays out below it.',
  'expiry': 'The date the option ends. After it, the option is settled and stops existing.',
  'spot': 'The index level right now.',
  'ltp': 'Last traded price: the most recent price someone paid for this option, per unit.',
  'bid': 'The highest price a buyer is offering right now. If you sell, you get roughly this.',
  'ask': 'The lowest price a seller is asking right now. If you buy, you pay roughly this.',
  'bid / ask': 'Bid is what buyers offer (you sell here); ask is what sellers want (you buy here). The gap between them is a hidden cost.',
  'oi': 'Open interest: how many contracts are currently open. Big numbers show strikes where lots of traders are positioned.',
  'open interest': 'How many contracts are currently open. Big numbers show strikes where lots of traders are positioned.',
  'chg oi': 'Change in open interest today. Positive means new positions are being opened at this strike.',
  'volume': 'How many contracts traded today. Higher volume usually means tighter, fairer prices.',
  'iv': 'Implied volatility: how much movement option prices are expecting, as a yearly %. Higher IV means pricier options.',
  'implied vol': 'How much movement option prices are expecting, as a yearly %. Higher means options are more expensive.',
  'atm implied vol': 'The implied volatility of the strike closest to the current index level. A good single number for how pricey options are.',
  'realized vol': 'How much the index actually moved recently, as a yearly %. Compare it with implied vol to judge if options are cheap or expensive.',
  'delta': 'Delta = Direction. How many rupees the option moves when the index moves 1 point. 0.5 means it follows about half of the index move. Try it in the Learn tab.',
  'theta': 'Theta = Time. What the option loses each day just from time passing, even if nothing moves. Buyers pay it like rent; sellers collect it. Try it in the Learn tab.',
  'vega': 'Vega = Volatility. How much the price changes if implied volatility (the market\'s fear level) rises by 1 point. Try it in the Learn tab.',
  'gamma': 'Gamma = gas pedal for delta. How fast delta changes as the index moves. Highest at the money near expiry. Try it in the Learn tab.',
  'greeks': 'Delta, theta, vega and gamma: numbers that show how an option reacts to price, time and volatility.',
  'atm strike': 'At the money: the strike closest to the current index level.',
  'itm': 'In the money: an option that would be worth something if it expired right now.',
  'put–call ratio': 'Open puts divided by open calls. Above 1 means more puts are open, often read as traders expecting support.',
  'max pain': 'The index level where the most options would expire worthless. Some traders watch it near expiry.',
  'lot size': 'Options trade in fixed bundles called lots. One lot = this many units, so multiply prices by it to get rupees.',
  'lots': 'Options trade in fixed bundles called lots. Your rupee cost is price × lot size × number of lots.',
  'premium': 'The price of an option. Buyers pay it upfront; sellers receive it.',
  'margin': 'Money blocked by the broker when you sell options, as a safety deposit against losses.',
  'margin needed': 'Money that would be blocked from your balance as a safety deposit while this position is open. An estimate.',
  'margin blocked': 'Money held aside as a safety deposit for options you have sold. You get it back when you exit.',
  'breakeven': 'The index level at expiry where you neither make nor lose money.',
  'india vix': 'The market\'s "fear gauge". It measures how much movement traders expect over the next month. Higher = more nervous.',
  'expected move': 'How far option prices suggest the index could move by expiry, roughly two times in three.',
  'max profit': 'The most this position can make, at expiry.',
  'max loss': 'The most this position can lose, at expiry. "Unlimited" means there is no ceiling, so use a stop-loss.',
  'chance of profit': 'A rough probability that the position is in profit at expiry, based on what options are pricing in.',
  'reward to risk': 'Max profit divided by max loss. 2 : 1 means you could make twice what you could lose.',
  'credit received': 'You collect this money upfront because you sold more premium than you bought.',
  'cost to enter': 'The money you pay upfront for this position.',
  'average outcome': 'The expected result if implied volatility turns out to be right. Usually slightly negative because of costs.',
  'open p&l': 'Profit or loss on positions you still hold, if you closed them right now. Not locked in yet.',
  'booked p&l': 'Profit or loss you have locked in by closing or by expiry.',
  'total p&l': 'Everything you have gained or lost since you started, after charges.',
  'charges paid': 'Brokerage, government taxes and exchange fees. These add up when you trade often.',
  'free to trade': 'Cash you can still use for new orders.',
  'account value': 'Your cash plus what your open positions are worth right now.',
  'call wall / put wall': 'The strikes with the most open calls (a ceiling) and puts (a floor). Markets often stall near them.',
  'fill price': 'The price your paper order executes at: the ask when you buy, the bid when you sell.',
  'avg price': 'The average price you paid (or received) per unit for this position.',
  'premium you pay': 'Option price × units. This leaves your account now.',
  'premium you receive': 'Option price × units. This is added to your account now, but margin is blocked as a safety deposit.',
  'charges': 'Brokerage, government taxes and exchange fees for this order.',
  'charge brokerage': 'The broker\'s fee: a flat ₹20 for every executed order at Zerodha, Groww and Angel One, however many lots it is for. A strategy with 4 legs is 4 orders.',
  'charge stt': 'Securities Transaction Tax, paid to the government when you sell an option: 0.15% of the premium (since April 2026). Options you bought that expire in the money also pay it on their payout.',
  'charge exchange': 'NSE\'s fee for handling the trade, about 0.035% of the premium, on both buys and sells.',
  'charge sebi': 'A small fee for the market regulator SEBI: ₹10 per crore of premium.',
  'charge stamp': 'Stamp duty paid to the government when you buy: 0.003% of the premium.',
  'charge gst': '18% GST on the brokerage, exchange charges and SEBI fee.',
  'p&l': 'Profit and loss: how much you are up (green) or down (red).',
  'lot': 'How many units make one tradable bundle (lot) for this index.',
  'prev close': 'Where the index closed on the previous trading day. Today\'s change is measured from here.',
  '52-week range': 'The lowest and highest levels of the past year. The marker shows where the index is now.',
  "today's range": 'The lowest and highest levels traded so far today.',
  'trend':'Direction of the index, judged by its 20-day and 50-day average prices.',
  // Replay
  'replay day': 'The day in history you are trading. Every price on screen is from that day\'s close or earlier.',
  'risk-free rate': 'The interest rate on safe money (like a treasury bill). It goes into the Black–Scholes formula used to work out implied volatility and the Greeks.',
  'win rate': 'Out of the trades you closed (or that settled at expiry), how many made money.',
  'best day': 'The day your account gained the most.',
  'worst day': 'The day your account lost the most.',
  'largest drop': 'The biggest fall from a high point of your account to a later low (traders call it drawdown). It shows how bad it felt along the way.',
  'trading days': 'Days NSE was open. Weekends and holidays are skipped.',
  'sell / buy fill': 'In replay you sell a little below the day\'s close and buy a little above it. The gap is slippage: wider for strikes far from the index and for ones that barely traded.',
  'slippage': 'The difference between the quoted price and the price you actually get. It is a real cost of trading, largest in options that rarely trade.',
};

// "Delta (per lot)" and "Implied vol (ATM)" fall back to their base term.
export function explain(label) { const k = String(label).toLowerCase().trim(); return GLOSSARY[k] || GLOSSARY[k.replace(/\s*\(.*\)$/, '')] || null; }

// Wraps a label with a dotted underline and tooltip when the glossary knows it; returns plain text otherwise.
export function term(label, key = label) {
  const tip = explain(key);
  if (!tip) return label;
  return el('span', { class: 'term', tabindex: '0', 'data-tip': tip }, label);
}

let tipEl, current;
function place(target) {
  const r = target.getBoundingClientRect();
  tipEl.style.left = '0px'; tipEl.style.top = '0px'; tipEl.hidden = false;
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  const top = r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8;
  tipEl.style.left = left + 'px'; tipEl.style.top = top + 'px';
}
function showTip(target) { current = target; tipEl.textContent = target.dataset.tip; place(target); }
function hideTip() { current = null; tipEl.hidden = true; }

export function initGlossary() {
  tipEl = el('div', { class: 'gtip', role: 'tooltip', hidden: true });
  document.body.append(tipEl);
  const find = (e) => e.target.closest?.('.term');
  document.addEventListener('mouseover', (e) => { const t = find(e); if (t && t !== current) showTip(t); else if (!t && current) hideTip(); });
  document.addEventListener('focusin', (e) => { const t = find(e); if (t) showTip(t); });
  document.addEventListener('focusout', (e) => { if (find(e)) hideTip(); });
  document.addEventListener('click', (e) => { const t = find(e); if (t) { e.stopPropagation(); t === current && !tipEl.hidden ? hideTip() : showTip(t); } }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  addEventListener('scroll', hideTip, true);
}
