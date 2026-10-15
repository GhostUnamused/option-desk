// Learn tab: short guided lessons on what moves an option's price, beside a playground of sliders.
// Each lesson sets up an experiment, names the Greek only after you have seen it, and ends with one check question.
import { el, $, inr0, inr2, rs, store } from './util.js';
import { S, on, cfg, quote } from './state.js';
import { bs } from './bs.js';
import { term } from './glossary.js';

const p = { type: 'CE', side: 'BUY', spot: 0, strike: 0, days: 14, iv: 14 };
const oldLesson = store.get('learnLesson', null), oldDone = store.get('learnDone', []);
let root, base = 0, baseIv = 14, lesson = store.get('learnLessonV2', oldLesson == null ? 0 : oldLesson + 2), done = new Set(store.get('learnDoneV2', oldDone.map((i) => i + 2))), chartMode = 'spot', answered = null, entryPrice = 0;
const ctl = {};

const b = (t) => el('b', { text: t });
const step = () => cfg().step;
const near = (v) => Math.round(v / step()) * step();
const lot = () => cfg().lot;
const idx = () => cfg().short;
const sign = () => (p.side === 'BUY' ? 1 : -1);
const kind = () => (p.type === 'CE' ? 'call' : 'put');
const val = (o = {}) => { const q = { ...p, ...o }; return bs(q.type, q.spot, q.strike, Math.max(q.days, 0) / 365, S.meta.riskFree, q.iv / 100); };
const intrinsic = (q = p) => Math.max(q.type === 'CE' ? q.spot - q.strike : q.strike - q.spot, 0);
const u = (v) => '₹' + inr2.format(Math.abs(v));                       // per-unit rupees
const perLot = (v) => '₹' + inr0.format(Math.abs(v * lot()));          // per-lot rupees
const gainLose = (v) => (v >= 0 ? 'gain' : 'lose');
const atm = (o = {}) => ({ type: 'CE', side: 'BUY', strike: near(base), spot: near(base), days: 14, iv: baseIv, ...o });

const LESSONS = [
  {
    nav: 'Option contracts', title: 'An option is a right with a deadline', hook: ['Option', 'right for buyer · obligation for seller'],
    body: [
      ['An option is a contract tied to an underlying, such as NIFTY. It names a ', b('strike'), ' (the agreed level) and an ', b('expiry'), ' (the deadline).'],
      ['A call gives its buyer the right to buy at the strike; a put gives the right to sell at the strike. You do not have to use that right. If it is not useful by expiry, it can expire worthless.'],
      ['The buyer pays a ', b('premium'), ' up front for that right. The seller collects it, but must take the other side if the buyer exercises. Buying has a capped loss: the premium. Selling can have much larger losses, so brokers require margin.'],
      ['Exchange options trade in lots: one lot contains many units of the underlying. The playground shows both per-unit and per-lot amounts.'],
      ['Index options in this practice app settle in cash. Real stock options can require delivery of shares at expiry; this simulator settles stock options in cash to keep practice simple.'],
    ],
    tryIt: 'Switch between Buy and Sell in the playground. The contract is the same, but you pay or receive the premium and the risk changes sides. Change the strike to see which level the right is tied to.',
    focus: 'side', chart: 'spot', setup: () => atm(),
    obs: (g) => `This ${kind()} is a right for its buyer and an obligation for its seller. The ${p.side === 'BUY' ? 'buyer pays' : 'seller receives'} ${u(g.price)} per unit now (${perLot(g.price)} for one ${idx()} lot).`,
    quiz: { q: 'You buy a call. What does the contract give you?', opts: ['The right to buy at the strike', 'The duty to buy at the strike', 'A guaranteed profit'], a: 0, why: 'The buyer chooses whether to use the right. Paying the premium does not guarantee a profit.' },
  },
  {
    nav: 'Call, put & payoff', title: 'Call or put: what happens at expiry?', hook: ['Call', 'benefits from rises · Put benefits from falls'],
    body: [
      ['At expiry, a call is worth the amount the index finishes ', b('above'), ' its strike. A put is worth the amount it finishes ', b('below'), ' its strike. Otherwise, the option expires with no payoff.'],
      ['Call payoff = max(index − strike, 0). Put payoff = max(strike − index, 0). This is the amount delivered by the option at expiry, before subtracting what you paid for it.'],
      ['To find your result as a buyer, subtract the premium from that payoff. A call buyer breaks even above strike + premium; a put buyer breaks even below strike − premium. Fees and taxes can shift the real break-even slightly.'],
      ['A view can be directionally right and still lose: if the move is too small, too late, or the premium was too expensive, the payoff may not cover the cost.'],
    ],
    tryIt: 'Use the Call and Put buttons, then move Index level across the strike. Watch “Net at expiry” update. Compare that result with the option premium you would pay today.',
    focus: 'type', chart: 'spot', setup: () => atm(),
    obs: () => `At an expiry finish of ${inr0.format(p.spot)}, this ${kind()} pays ${u(intrinsic())}. After the ${u(entryPrice)} entry premium, the ${p.side === 'BUY' ? 'buyer' : 'seller'} would ${gainLose((intrinsic() - entryPrice) * sign())} about ${perLot((intrinsic() - entryPrice) * sign())} per lot, before costs.`,
    quiz: { q: 'You buy a 23,000 call for ₹100. At expiry the index is 23,060. What is your result per unit before costs?', opts: ['₹60 profit', '₹40 loss', '₹100 profit'], a: 1, why: 'The call pays ₹60 at expiry, but you paid ₹100. Net result = ₹60 − ₹100 = ₹40 loss. A call buyer breaks even at 23,100.' },
  },
  {
    nav: 'Premium & time value', title: 'What am I actually paying for?', hook: ['Premium', 'intrinsic value + time value'],
    body: [
      ['The price of an option is called its ', b('premium'), '. It has two parts. Premium is the price of the contract, not your profit.'],
      [b('Intrinsic value'), ' is what the option would pay if it expired right now. A 23,000 call with the index at 23,100 has ₹100 of intrinsic value per unit. That is not necessarily profit: you may have paid more than ₹100 for it.'],
      [b('Time value'), ' is everything above intrinsic value: what people pay for the chance the contract becomes more valuable before expiry. It can rise or fall while the option is alive, but is zero at expiry.'],
    ],
    tryIt: 'Drag Index level above and below the strike. Under the price, the solid bar is intrinsic value and the striped bar is time value. An option with no intrinsic value can still cost something because it has time left to become valuable.',
    focus: 'spot', chart: 'spot', setup: () => atm({ spot: near(base) + 2 * step() }),
    obs: (g) => {
      const iv = intrinsic(), tv = Math.max(g.price - iv, 0);
      return iv > 0
        ? `Of the ${u(g.price)} price, ${u(iv)} is intrinsic value and ${u(tv)} is time value. Intrinsic value is not profit until you compare it with the entry premium. At expiry only intrinsic value can remain.`
        : `This ${kind()} is not in the money, so all ${u(g.price)} of its price is time value: you are paying for the chance the index moves past ${inr0.format(p.strike)} before expiry.`;
    },
    quiz: { q: 'A 23,000 call costs ₹160 while the index is at 23,100. How much of the ₹160 is time value?', opts: ['₹160', '₹100', '₹60'], a: 2, why: 'Intrinsic value is 23,100 − 23,000 = ₹100. The other ₹60 is time value, and it melts to zero by expiry.' },
  },
  {
    nav: 'Delta', greek: 'delta', title: 'Delta: how closely does it follow the index?', hook: ['Delta', 'Direction'],
    body: [
      ['Delta tells you how many rupees the option moves when the index moves ', b('1 point'), '. A delta of 0.50 means the index +100 points → the option about +₹50 per unit.'],
      ['Calls have positive delta (they like rises). Puts have negative delta (they like falls).'],
      ['Delta runs from 0 to 1 (or 0 to −1 for puts). Deep in-the-money options follow the index almost fully (near 1). Far out-of-the-money options barely react (near 0). At the money is about 0.5.'],
      ['Some traders use absolute delta as a rough chance of ending in the money, so 0.30 might suggest roughly 30%. It is not an exact probability or a guarantee; it depends on market assumptions.'],
    ],
    tryIt: 'Note the price, then drag Index level up by about 100 points: the price rises by roughly delta × 100. Then move Strike far away from the index and watch delta shrink toward 0.',
    focus: 'spot', chart: 'spot', setup: () => atm(),
    obs: (g) => {
      const up = val({ spot: p.spot + 100 }).price;
      return `Delta is ${g.delta.toFixed(2)}. If ${idx()} rises 100 points, this ${kind()} goes from ${u(g.price)} to ${u(up)} per unit (${up >= g.price ? '+' : '−'}${u(up - g.price)}). Delta alone predicted about ${g.delta >= 0 ? '+' : '−'}${u(g.delta * 100)}; the small gap is gamma, lesson 7.`;
    },
    quiz: { q: 'An option has delta 0.30. The index rises 50 points. Roughly how much does the option\'s price change?', opts: ['+₹15', '+₹30', '+₹50'], a: 0, why: '0.30 × 50 = 15. This option follows about 30% of the index\'s move.' },
  },
  {
    nav: 'Theta', greek: 'theta', title: 'Theta: the daily melt', hook: ['Theta', 'Time'],
    body: [
      ['Every day that passes, an option loses some time value, even if the index does not move at all. Theta is that daily loss in rupees per unit.'],
      ['If you are ', b('long'), ' (bought), theta works against you, like rent you pay every day. If you are ', b('short'), ' (sold), you collect that rent.'],
      ['The melt is not even: slow with weeks left, then much faster in the last few days, especially at the money.'],
    ],
    tryIt: 'The chart now shows price against days left. Drag Days to expiry from 30 down to 0: the curve drifts down slowly, then falls off a cliff near the end.',
    focus: 'days', chart: 'time', setup: () => atm({ days: 30 }),
    obs: (g) => {
      if (p.days <= 0) return 'At expiry there is no time left, so no time value: the option is worth only its intrinsic value.';
      const late = val({ days: Math.min(2, p.days) }).theta;
      return `With ${p.days} day${p.days === 1 ? '' : 's'} left, one quiet day costs this ${kind()} about ${u(g.theta)} per unit (${perLot(g.theta)} per lot). With 2 days left the same option would melt about ${u(late)} per day.`;
    },
    quiz: { q: 'You buy an option and the index does not move at all for a week. What happens to your option?', opts: ['It loses value', 'It keeps its value', 'It gains value'], a: 0, why: 'Time value melts every day (theta). With no move to make up for it, a buyer slowly loses and a seller slowly earns.' },
  },
  {
    nav: 'Vega', greek: 'vega', title: 'Vega: the price of fear', hook: ['Vega', 'Volatility'],
    body: [
      [term('Implied volatility', 'iv'), ' (IV) is how big a move the market expects. When traders are nervous they pay more for options, so IV and prices rise. India VIX in the top bar is basically NIFTY\'s IV.'],
      ['Vega is how many rupees the price changes when IV moves 1 point, with the index standing still.'],
      ['The classic beginner trap is the ', b('IV crush'), ': buying options just before a big event (budget, RBI policy, election results), being right about the direction, and still losing because IV collapses once the news is out.'],
    ],
    tryIt: 'Leave the index alone. Drag Implied volatility from about 12% up to 25% and back. The option becomes expensive and cheap with no change in the index at all.',
    focus: 'iv', chart: 'spot', setup: () => atm(),
    obs: (g) => {
      const hi = val({ iv: p.iv + 5 }).price, lo = val({ iv: Math.max(5, p.iv - 5) }).price;
      return `At IV ${p.iv}% this ${kind()} costs ${u(g.price)}. At ${p.iv + 5}% it would cost ${u(hi)}; at ${Math.max(5, p.iv - 5)}% only ${u(lo)}. Same index, same strike: only the fear changed.`;
    },
    quiz: { q: 'The index does not move, but IV falls from 20% to 14% after an event. What happens to a call you bought?', opts: ['It loses value', 'Nothing', 'It gains value'], a: 0, why: 'Lower IV means lower option prices. Buyers lose when IV falls and sellers gain. That is the IV crush.' },
  },
  {
    nav: 'Gamma', greek: 'gamma', title: 'Gamma: how fast delta changes', hook: ['Gamma', 'Gas pedal for delta'],
    body: [
      ['Delta is not fixed: it changes as the index moves. Gamma measures how fast.'],
      ['Gamma is highest for at-the-money options close to expiry. There, a small move can turn an option from "barely moving" (delta 0.2) into "moving almost like the index" (delta 0.8). That is why expiry-day options swing so wildly.'],
      ['Buyers like gamma: good moves snowball in their favour. Sellers fear it: bad moves snowball against them.'],
    ],
    tryIt: 'Days is set to 1. Drag Index level slowly across the strike and watch delta jump. Then set Days to 30 and repeat: delta changes far more gently.',
    focus: 'spot', chart: 'spot', setup: () => atm({ days: 1 }),
    obs: (g) => {
      const d2 = val({ spot: p.spot + 100 }).delta;
      return `Delta is ${g.delta.toFixed(2)} now. After a 100-point rise it would be ${d2.toFixed(2)}. ${p.days <= 2 ? 'Close to expiry, delta swings fast.' : 'With this much time left delta changes slowly. Try 1 day to compare.'}`;
    },
    quiz: { q: 'Which option\'s delta changes fastest when the index moves?', opts: ['At the money, 1 day left', 'At the money, 30 days left', 'Far out of the money, 30 days left'], a: 0, why: 'Gamma peaks at the money near expiry, where small moves decide whether the option ends up worth something.' },
  },
  {
    nav: 'Buying vs selling', title: 'Long vs short: same option, opposite feelings', hook: ['Short', 'every Greek flips'],
    body: [
      ['When you ', b('sell'), ' (go short) an option, you receive the premium upfront and every effect reverses:'],
      ['• If the index and IV stay still, time passing now ', b('pays you'), ' (theta works for you).'],
      ['• A big move now ', b('hurts you'), ', and gamma makes it hurt faster.'],
      ['• A jump in IV now ', b('hurts you'), ' (vega works against you).'],
      ['Buyers can lose at most what they paid. Sellers earn at most the premium but can lose much more. That is why brokers block margin from sellers.'],
    ],
    tryIt: 'Switch Buy to Sell at the top of the playground. Watch every card flip: time now earns money, while a big move or a rise in IV now costs it.',
    focus: 'side', chart: 'spot', setup: () => atm({ side: 'SELL' }),
    obs: (g) => {
      const s = sign(), now = g.price;
      const worst = Math.min(...[-200, 200].map((m) => (val({ spot: p.spot + m }).price - now) * s));
      const vegaHit = (val({ iv: p.iv + 5 }).price - now) * s;
      return `As a ${p.side === 'BUY' ? 'buyer' : 'seller'}: each quiet day ${g.theta * s >= 0 ? 'earns' : 'costs'} you about ${perLot(g.theta)} per lot. A 200-point move the wrong way would ${gainLose(worst)} you about ${perLot(worst)} per lot today. IV rising 5 points would ${gainLose(vegaHit)} you ${perLot(vegaHit)}.`;
    },
    quiz: { q: 'You sold an option. Which of these helps you?', opts: ['Time passing with no big move', 'A big move in the index', 'IV rising'], a: 0, why: 'Sellers collect time decay. Big moves (gamma) and rising IV (vega) work against them.' },
  },
];

export function init(sec) {
  root = sec;
  const nav = el('ol', { class: 'lnav', id: 'lnNav' });
  const content = el('div', { class: 'lcontent', id: 'lnBody' });
  root.append(
    el('div', { class: 'panel learn' }, nav, content),
    playground(),
    cheatSheet(),
  );
  on('symbol', () => { if (S.tab === 'learn') { resetBase(); openLesson(lesson); } else base = 0; });
}

export function show() { if (!base) resetBase(); openLesson(lesson); }
export function hide() {}

function resetBase() {
  base = quote()?.last || 23000;
  baseIv = Math.round(S.quotes?.vix?.last || 14);
}

function openLesson(i) {
  lesson = Math.max(0, Math.min(LESSONS.length - 1, i)); store.set('learnLessonV2', lesson);
  const L = LESSONS[lesson];
  Object.assign(p, L.setup()); chartMode = L.chart; answered = null;
  entryPrice = val().price;
  renderNav(); renderLesson(); syncControls(); update();
}

function renderNav() {
  $('#lnNav').replaceChildren(...LESSONS.map((L, i) => el('li', {}, el('button', { type: 'button', class: i === lesson ? 'on' : '', 'aria-current': i === lesson ? 'step' : null, onclick: () => openLesson(i) },
    el('span', { class: 'num' + (done.has(i) ? ' done' : ''), text: done.has(i) ? '✓' : String(i + 1) }), L.nav))),
    el('li', { class: 'lprog', text: `${done.size} of ${LESSONS.length} checks passed` }));
}

function renderLesson() {
  const L = LESSONS[lesson];
  const quiz = el('div', { class: 'quiz' }, el('p', { class: 'qq' }, b('Quick check: '), L.quiz.q),
    el('div', { class: 'opts' }, L.quiz.opts.map((o, i) => el('button', { type: 'button', class: 'opt' + (answered == null ? '' : i === L.quiz.a ? ' right' : i === answered ? ' wrong' : ''), disabled: answered != null && i !== L.quiz.a && i !== answered, text: o, onclick: () => answer(i) }))),
    answered == null ? null : el('p', { class: 'why ' + (answered === L.quiz.a ? 'up' : 'down') }, b(answered === L.quiz.a ? 'Right. ' : 'Not quite. '), L.quiz.why));
  $('#lnBody').replaceChildren(
    el('div', { class: 'note', text: `Lesson ${lesson + 1} of ${LESSONS.length}` }),
    el('h2', { class: 'ltitle', text: L.title }),
    el('div', { class: 'hook' }, 'Remember: ', b(L.hook[0]), ' = ', L.hook[1]),
    ...L.body.map((parts) => el('p', {}, ...parts)),
    el('div', { class: 'try' }, b('Try this: '), L.tryIt),
    el('p', { class: 'obs', id: 'lnObs' }),
    quiz,
    el('div', { class: 'lfoot' },
      el('button', { class: 'btn ghost sm', type: 'button', text: '← Previous', disabled: lesson === 0, onclick: () => openLesson(lesson - 1) }),
      el('button', { class: 'btn ghost sm', type: 'button', text: 'Reset this experiment', onclick: () => openLesson(lesson) }),
      lesson < LESSONS.length - 1 ? el('button', { class: 'btn sm', type: 'button', text: 'Next lesson →', onclick: () => openLesson(lesson + 1) }) : el('button', { class: 'btn sm', type: 'button', text: 'See the cheat sheet ↓', onclick: () => $('#lnCheat').scrollIntoView({ behavior: 'smooth' }) })));
}

function answer(i) {
  answered = i;
  if (i === LESSONS[lesson].quiz.a) { done.add(lesson); store.set('learnDoneV2', [...done]); }
  renderNav(); renderLesson(); update();
}

// ---- Playground ----

function slider(key, label, help) {
  const out = el('output', { class: 'sv' });
  const input = el('input', { type: 'range', 'aria-label': label, oninput: (e) => { p[key] = +e.target.value; if (key === 'strike') entryPrice = val().price; update(); } });
  ctl[key] = { input, out, wrap: el('label', { class: 'sl' }, el('span', { class: 'slh' }, el('span', { text: label }), out), input, el('span', { class: 'note', text: help })) };
  return ctl[key].wrap;
}

function seg(key, opts) {
  const box = el('div', { class: 'seg', role: 'group' }, opts.map(([v, t]) => el('button', { type: 'button', 'data-v': v, text: t, onclick: () => { p[key] = v; if (key === 'type') entryPrice = val().price; syncControls(); update(); } })));
  ctl[key] = { box };
  return box;
}

function playground() {
  return el('div', { class: 'panel', id: 'lnPlay' },
    el('div', { class: 'panel-h' }, el('h2', { text: 'Playground' }), el('span', { class: 'note', id: 'lnName' }), el('span', { class: 'sp' }),
      seg('type', [['CE', 'Call'], ['PE', 'Put']]), seg('side', [['BUY', 'Buy (long)'], ['SELL', 'Sell (short)']]),
      el('button', { class: 'btn ghost sm', type: 'button', text: 'Use live price', title: 'Start from the current index level and India VIX', onclick: () => { resetBase(); openLesson(lesson); } })),
    el('div', { class: 'pg' },
      el('div', { class: 'sliders' },
        slider('spot', 'Index level', 'Where the index is'),
        slider('strike', 'Strike', 'The level your option is tied to'),
        slider('days', 'Days to expiry', 'How long until the option ends'),
        slider('iv', 'Implied volatility', 'How big a move the market expects')),
      el('div', { class: 'pgout' },
        el('div', { class: 'pricebox', id: 'lnPrice' }),
        el('div', { class: 'grid gcards', id: 'lnGreeks' }))),
    el('div', { class: 'panel-h', style: { marginTop: '14px', marginBottom: '4px' } }, el('h2', { id: 'lnChartTitle', style: { fontSize: '1rem' } }), el('span', { class: 'sp' }),
      el('div', { class: 'seg', id: 'lnChartSeg' }, [['spot', 'Price vs index level'], ['time', 'Price vs days left']].map(([k, t]) => el('button', { type: 'button', 'data-v': k, text: t, onclick: () => { chartMode = k; update(); } })))),
    el('div', { class: 'svgchart', id: 'lnChart' }),
    el('div', { class: 'legend', id: 'lnLegend', style: { marginTop: '6px' } }));
}

function syncControls() {
  const st = step(), lo = near(base * 0.94), hi = near(base * 1.06);
  const set = (k, min, max, s) => { const i = ctl[k].input; i.min = min; i.max = max; i.step = s; i.value = p[k]; };
  set('spot', lo, hi, 1); set('strike', lo, hi, st); set('days', 0, 60, 1); set('iv', 5, 60, 0.5);
  for (const k of ['type', 'side']) ctl[k].box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === p[k]));
  const f = LESSONS[lesson].focus;
  for (const k of ['spot', 'strike', 'days', 'iv']) ctl[k].wrap.classList.toggle('focus', k === f);
  for (const k of ['type', 'side']) ctl[k].box.classList.toggle('focus', k === f);
}

function update() {
  const g = val(); const L = LESSONS[lesson]; const s = sign(); const n = lot();
  ctl.spot.out.textContent = inr0.format(p.spot); ctl.strike.out.textContent = inr0.format(p.strike);
  ctl.days.out.textContent = p.days === 0 ? 'expiry' : `${p.days} day${p.days === 1 ? '' : 's'}`; ctl.iv.out.textContent = p.iv + '%';
  const iv = intrinsic(), tv = Math.max(g.price - iv, 0);
  const money = iv > 0 ? ['In the money', 'itm'] : Math.abs(p.spot - p.strike) < step() / 2 ? ['At the money', 'atm strike'] : ['Out of the money', null];
  $('#lnName').textContent = `${idx()} ${inr0.format(p.strike)} ${kind()} · lot of ${n}`;
  $('#lnPrice').replaceChildren(
    el('div', { class: 'k' }, term('Premium'), ' per unit · ', money[1] ? term(money[0], money[1]) : money[0]),
    el('div', { class: 'big', text: u(g.price) }),
    el('div', { class: 'note', text: `${rs(g.price * n)} per lot · you ${p.side === 'BUY' ? 'pay' : 'receive'} this` }),
    el('div', { class: 'vbar', role: 'img', 'aria-label': `Intrinsic ${u(iv)}, time value ${u(tv)}` },
      el('span', { class: 'iv', style: { width: `${g.price > 0 ? (iv / g.price) * 100 : 0}%` } }), el('span', { class: 'tv', style: { width: `${g.price > 0 ? (tv / g.price) * 100 : 0}%` } })),
    el('div', { class: 'vlab' }, el('span', {}, el('i', { class: 'sw ivs' }), `Intrinsic ${u(iv)}`), el('span', {}, el('i', { class: 'sw tvs' }), `Time value ${u(tv)}`)),
    el('div', { class: 'expiry-result' }, el('b', { text: `Net at expiry if index ends at ${inr0.format(p.spot)}` }), el('span', { class: gainLose((intrinsic() - entryPrice) * s), text: `${(intrinsic() - entryPrice) * s >= 0 ? '+' : '−'}${perLot((intrinsic() - entryPrice) * s)} per lot` }), el('small', { class: 'note', text: `Payoff minus entry premium (${u(entryPrice)} per unit); before fees and taxes.` })));
  const card = (key, name, hook, value, line) => el('div', { class: 'stat gcard' + (L.greek === key ? ' hl' : '') }, el('div', { class: 'k' }, term(name, key), el('span', { class: 'hk', text: hook })), el('div', { class: 'v', text: value }), el('div', { class: 's', text: line }));
  const dl = g.delta * s, th = g.theta * s, vg = g.vega * s;
  $('#lnGreeks').replaceChildren(
    card('delta', 'Delta', 'direction', (dl >= 0 ? '+' : '−') + Math.abs(dl).toFixed(2), `${idx()} +100 points → you ${gainLose(dl)} about ${perLot(dl * 100)} per lot`),
    card('theta', 'Theta', 'time', `${th >= 0 ? '+' : '−'}${perLot(th)} / day`, p.days <= 0 ? 'Expired: no time value left' : `Each quiet day ${th >= 0 ? 'earns' : 'costs'} you this, per lot`),
    card('vega', 'Vega', 'volatility', `${vg >= 0 ? '+' : '−'}${perLot(vg)}`, `IV +1 point → you ${gainLose(vg)} this, per lot`),
    card('gamma', 'Gamma', 'gas pedal', `${(g.gamma * 100).toFixed(3)}`, `Delta shifts by about this for every 100-point move`));
  $('#lnObs').textContent = L.obs(g);
  $('#lnChartSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === chartMode));
  drawChart();
}

// ---- Chart: option value per unit, against index level or against days left ----

const NS = 'http://www.w3.org/2000/svg';
const mk = (t, a, txt) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };

function drawChart() {
  const box = $('#lnChart'); const W = Math.max(320, box.clientWidth || 800), H = 260, m = { l: 58, r: 14, t: 14, b: 30 };
  const time = chartMode === 'time';
  const x0 = time ? Math.max(30, p.days) : near(base * 0.94), x1 = time ? 0 : near(base * 1.06);
  const N = 160, xs = Array.from({ length: N }, (_, i) => x0 + (x1 - x0) * i / (N - 1));
  const now = xs.map((x) => (time ? val({ days: x }) : val({ spot: x })).price);
  const exp = xs.map((x) => (time ? intrinsic() : intrinsic({ ...p, spot: x })));
  const ymax = Math.max(1, ...now, ...exp) * 1.08;
  const X = (x) => m.l + (x - x0) / (x1 - x0) * (W - m.l - m.r), Y = (y) => m.t + (1 - y / ymax) * (H - m.t - m.b);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': time ? 'Option price as days pass' : 'Option price across index levels' });
  const yst = niceStep(ymax / 4);
  for (let y = 0; y <= ymax; y += yst) svg.append(mk('line', { x1: m.l, x2: W - m.r, y1: Y(y), y2: Y(y), stroke: 'var(--grid)' }), mk('text', { x: m.l - 6, y: Y(y) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, '₹' + inr0.format(y)));
  const xst = time ? niceStep(x0 / 6) : niceStep((x1 - x0) / 6);
  for (let x = Math.ceil(Math.min(x0, x1) / xst) * xst; x <= Math.max(x0, x1); x += xst) svg.append(mk('text', { x: X(x), y: H - 9, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, time ? (x === 0 ? 'expiry' : `${x}d`) : inr0.format(x)));
  if (!time) svg.append(mk('line', { x1: X(p.strike), x2: X(p.strike), y1: m.t, y2: H - m.b, stroke: 'var(--muted)', 'stroke-dasharray': '2 3' }), mk('text', { x: X(p.strike) + 4, y: m.t + 10, 'font-size': 11, fill: 'var(--muted)' }, 'Strike'));
  const path = (ys) => xs.map((x, i) => (i ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(ys[i]).toFixed(1)).join('');
  svg.append(mk('path', { d: path(exp), fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }));
  svg.append(mk('path', { d: path(now), fill: 'none', stroke: 'var(--fg)', 'stroke-width': 2.4 }));
  const cx = X(time ? p.days : p.spot), cy = Y(val().price);
  svg.append(mk('line', { x1: cx, x2: cx, y1: m.t, y2: H - m.b, stroke: 'var(--line)' }), mk('circle', { cx, cy, r: 5.5, fill: 'var(--fg)', stroke: 'var(--panel)', 'stroke-width': 2 }));
  svg.append(mk('text', { x: Math.min(cx + 8, W - 70), y: Math.max(cy - 8, m.t + 10), 'font-size': 12, 'font-weight': 600, fill: 'var(--fg)' }, u(val().price)));
  box.replaceChildren(svg);
  $('#lnChartTitle').textContent = time ? `How this ${kind()}'s price melts as expiry gets closer (index stays at ${inr0.format(p.spot)})` : `This ${kind()}'s price at different index levels`;
  $('#lnLegend').replaceChildren(
    el('span', {}, el('i', { class: 'sw', style: { background: 'var(--fg)' } }), time ? 'Price as days pass' : `Price with ${p.days} day${p.days === 1 ? '' : 's'} left`),
    el('span', {}, el('i', { class: 'sw', style: { background: 'var(--muted)' } }), time ? 'Intrinsic value (the floor at expiry)' : 'Value at expiry (intrinsic only)'),
    el('span', {}, el('i', { class: 'sw', style: { background: 'var(--fg)', borderRadius: '50%' } }), 'You are here'),
    el('span', { text: 'The gap between the two lines is time value.' }));
}

function niceStep(raw) { const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9))); return [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) || raw; }

// ---- Cheat sheet ----

function cheatSheet() {
  const rows = [
    ['Delta', 'delta', 'Direction', 'If the index moves 1 point, how much does my option move?', 'Calls +, puts −. Near 0.5 at the money.', 'Flips sign'],
    ['Theta', 'theta', 'Time', 'How much do I lose (or earn) per day if nothing happens?', 'Costs you every day', 'Pays you every day'],
    ['Vega', 'vega', 'Volatility', 'How much does fear (IV) change my price?', 'Gains when IV rises', 'Loses when IV rises'],
    ['Gamma', 'gamma', 'Gas pedal', 'How fast does my delta change as the index moves?', 'Good moves snowball for you', 'Bad moves snowball against you'],
  ];
  return el('div', { class: 'panel', id: 'lnCheat' },
    el('div', { class: 'panel-h' }, el('h2', { text: 'Cheat sheet: the Greeks in one table' }), el('span', { class: 'note', text: 'Each Greek answers one question about your option.' })),
    el('div', { class: 'tw' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Greek', 'Remember it as', 'The question it answers', 'If you bought (long)', 'If you sold (short)'].map((h) => el('th', { class: 'l', text: h })))),
      el('tbody', {}, rows.map(([n, k, hook, q, buy, sell]) => el('tr', {}, el('td', { class: 'l t' }, el('b', {}, term(n, k))), el('td', { class: 'l t', text: hook }), el('td', { class: 'l t wrap', text: q }), el('td', { class: 'l t wrap', text: buy }), el('td', { class: 'l t wrap', text: sell })))))));
}
