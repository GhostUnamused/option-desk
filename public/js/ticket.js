// Order ticket: single option or a basket of legs. Previews fills, charges and margin before placing.
import { api, el, $, inr2, rs, srs, instrument, toast, fmtLeft } from './util.js';
import { term } from './glossary.js';
import { S, emit, cfg, refreshAccount } from './state.js';

let dlg, legs = [], basket = false, tag = '', note = '', pvTimer = null, liveTimer = null, seq = 0, placing = false;

export function init() {
  dlg = $('#ticket');
  dlg.addEventListener('close', () => { clearInterval(liveTimer); legs = []; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

export function open(leg) { basket = false; tag = ''; note = ''; legs = [{ lots: 1, ...leg }]; show(); }
export function openBasket(ls, t = 'Strategy') { basket = true; tag = t; note = ''; legs = ls.map((l) => ({ ...l })); show(); }

function show() {
  render();
  if (!dlg.open) dlg.showModal();
  preview();
  clearInterval(liveTimer); liveTimer = setInterval(() => !document.hidden && preview(), 5000);
}

function render() {
  const L = legs[0]; const lot = cfg(L.symbol).lot;
  const close = el('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: () => dlg.close() });
  const body = el('div', { class: 'tk-b' });
  if (!basket) {
    const side = el('div', { class: 'tk-side', role: 'group', 'aria-label': 'Buy or sell' },
      el('button', { type: 'button', class: 'buy' + (L.side === 'BUY' ? ' on' : ''), text: 'Buy', onclick: () => { L.side = 'BUY'; render(); preview(); } }),
      el('button', { type: 'button', class: 'sell' + (L.side === 'SELL' ? ' on' : ''), text: 'Sell', onclick: () => { L.side = 'SELL'; render(); preview(); } }));
    const inp = el('input', { type: 'number', min: '1', step: '1', value: String(L.lots), id: 'tkLots', 'aria-label': 'Lots', oninput: (e) => { const v = Math.max(1, Math.round(+e.target.value || 1)); L.lots = v; $('#tkQty').textContent = `${v} lot${v > 1 ? 's' : ''} = ${v * lot} units`; preview(); } });
    const step = (d) => () => { L.lots = Math.max(1, L.lots + d); inp.value = L.lots; inp.dispatchEvent(new Event('input')); };
    body.append(side,
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' } },
        el('div', { class: 'stepper' }, el('button', { type: 'button', 'aria-label': 'One lot fewer', text: '−', onclick: step(-1) }), inp, el('button', { type: 'button', 'aria-label': 'One lot more', text: '+', onclick: step(1) })),
        el('span', { class: 'note', id: 'tkQty', text: `${L.lots} lot${L.lots > 1 ? 's' : ''} = ${L.lots * lot} units` })));
  } else {
    body.append(el('div', { class: 'note', text: `${legs.length} legs, placed together at the live quotes.` }));
  }
  // Replay keeps a trade journal: ask for the reason before the order goes in.
  if (S.meta.replay) body.append(el('label', { class: 'f', for: 'tkNote' }, 'Why are you taking this trade? (goes in your journal)',
    el('textarea', { class: 'inp note-in', id: 'tkNote', rows: '2', maxlength: '1000', placeholder: 'e.g. NIFTY held 24,000 twice this week, so I expect a move up before expiry. I will exit if it closes below 23,900.', oninput: (e) => { note = e.target.value; } }, note)));
  if (S.quotes?.market && !S.quotes.market.open) body.append(el('div', { class: 'warnbox', text: 'The market is closed. Paper orders fill at the last quotes NSE published, which may be stale.' }));
  body.append(el('div', { id: 'tkPv' }, el('p', { class: 'note', text: 'Getting live quotes…' })));
  const placeBtn = el('button', { class: 'btn ' + (basket ? '' : L.side === 'BUY' ? 'buy' : 'sell'), type: 'button', id: 'tkPlace', text: basket ? 'Place all legs' : `${L.side === 'BUY' ? 'Buy' : 'Sell'} ${L.lots} lot${L.lots > 1 ? 's' : ''}`, disabled: true, onclick: place });
  const foot = el('div', { class: 'tk-f' }, el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => dlg.close() }),
    !basket ? el('button', { class: 'btn ghost', type: 'button', text: 'Add to strategy', onclick: () => { emit('addLeg', { ...L }); emit('goto', 'strategy'); dlg.close(); } }) : null, placeBtn);
  const title = basket ? `${tag || 'Strategy'} · ${L.symbol}` : instrument(L);
  dlg.replaceChildren(el('div', { class: 'tk-h' }, el('div', {}, el('h3', { text: title }), el('div', { class: 'note', text: `${S.meta.replay ? 'Replay order at this day\'s close' : 'Paper order'} · ${fmtLeft(L.expiry)}` })), close), body, foot);
}

function preview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(async () => {
    const my = ++seq; const box = $('#tkPv'); if (!box) return;
    try {
      const pv = await api('/api/preview', { legs });
      if (my !== seq || !dlg.open) return;
      const kv = (k, v, cls = '') => [el('span', { class: 'k' }, term(k)), el('span', { class: 'v ' + cls, text: v })];
      const rows = [];
      const how = (f) => (S.meta.replay ? (f.side === 'BUY' ? '(close + slippage)' : '(close − slippage)') : f.side === 'BUY' ? '(ask)' : '(bid)');
      for (const f of pv.fills) rows.push(...kv(`${basket ? `${f.side === 'BUY' ? 'Buy' : 'Sell'} ${f.lots}× ${f.strike} ${f.type}` : 'Fill price'}`, `₹${inr2.format(f.price)} ${how(f)}`));
      rows.push(...kv(pv.netPremium >= 0 ? 'Premium you receive' : 'Premium you pay', rs(Math.abs(pv.netPremium)), pv.netPremium >= 0 ? 'up' : ''));
      rows.push(...kv('Charges (estimate)', rs(pv.charges)));
      const dm = pv.marginAfter - pv.marginBefore;
      rows.push(...kv(dm >= 0 ? 'Margin blocked' : 'Margin released', rs(Math.abs(dm))));
      rows.push(...kv('Available after', rs(pv.availableAfter), pv.availableAfter < 0 ? 'down' : ''));
      if (pv.realized) rows.push(...kv('Realized on this order', srs(pv.realized), pv.realized >= 0 ? 'up' : 'down'));
      const out = [el('div', { class: 'kv' }, rows)];
      if (!basket) {
        const L = legs[0]; const f = pv.fills[0];
        if (L.side === 'BUY') out.push(el('p', { class: 'note', text: `Most you can lose: ${rs(f.premium + f.charges)}. You profit at expiry only if ${L.symbol} ends ${L.type === 'CE' ? 'above' : 'below'} ${inr2.format(L.type === 'CE' ? L.strike + f.price : L.strike - f.price)}.` }));
        else if (pv.marginAfter > pv.marginBefore) out.push(el('div', { class: 'warnbox', text: L.type === 'CE' ? 'Selling a call on its own has no limit on loss if the index rallies. Most you can earn is the premium.' : `Selling a put on its own can lose up to ${rs(L.strike * f.qty)} if the index collapses. Most you can earn is the premium.` }));
      }
      if (!pv.ok) out.push(el('div', { class: 'errbox', text: 'Not enough free funds for this order.' }));
      box.replaceChildren(...out);
      const btn = $('#tkPlace'); if (btn) btn.disabled = !pv.ok || placing;
    } catch (e) {
      if (my !== seq) return;
      box.replaceChildren(el('div', { class: 'errbox', text: e.message }));
      const btn = $('#tkPlace'); if (btn) btn.disabled = true;
    }
  }, 200);
}

async function place() {
  if (placing) return; placing = true; const btn = $('#tkPlace'); btn.disabled = true; btn.textContent = 'Placing…';
  try {
    const r = await api('/api/order', { legs, tag: basket ? tag : '', note });
    S.account = r.account; emit('account', r.account);
    toast(basket ? `Placed ${legs.length} legs. Net ${r.netPremium >= 0 ? 'credit' : 'debit'} ${rs(Math.abs(r.netPremium))}.` : `${legs[0].side === 'BUY' ? 'Bought' : 'Sold'} ${instrument(legs[0])} at ₹${inr2.format(r.fills[0].price)}.`, 'ok');
    dlg.close();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; render(); preview(); }
  finally { placing = false; }
}
