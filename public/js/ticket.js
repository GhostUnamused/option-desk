// Order ticket: single option or a basket of legs. Previews fills, charges and margin before placing.
import { api, el, $, inr2, rs, rs2, srs, instrument, toast, fmtLeft } from './util.js';
import { term } from './glossary.js';
import { S, emit, cfg, refreshAccount } from './state.js';

let dlg, legs = [], basket = false, tag = '', note = '', plan = '', pvTimer = null, liveTimer = null, seq = 0, placing = false, latestPreviewOk = false, onPlaced = null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function init() {
  dlg = $('#ticket');
  dlg.addEventListener('close', () => { clearInterval(liveTimer); legs = []; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

export function open(leg) { basket = false; tag = ''; note = ''; plan = ''; onPlaced = null; legs = [{ lots: 1, ...leg }]; show(); }
// done(result) runs after the basket is placed (the strategy builder clears itself then).
export function openBasket(ls, t = 'Strategy', done = null) { basket = true; tag = t; note = ''; plan = ''; onPlaced = done; legs = ls.map((l) => ({ ...l })); show(); }

const lotsText = (n, lot) => `${n} lot${n > 1 ? 's' : ''} = ${(n * lot).toLocaleString('en-IN')} units`;
const actionText = (L) => `${L.side === 'BUY' ? 'Buy' : 'Sell'} ${L.lots} lot${L.lots > 1 ? 's' : ''}`;

function show() {
  latestPreviewOk = false;
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
    // Every change of lots goes through setLots, so the quantity line, the quick picks and the button never disagree.
    const setLots = (v, fromInput = false) => {
      L.lots = Math.min(999, Math.max(1, Math.round(+v || 1)));
      if (!fromInput) inp.value = L.lots;
      $('#tkQty').textContent = lotsText(L.lots, lot);
      quick.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.n === L.lots));
      const btn = $('#tkPlace'); if (btn && !placing) btn.textContent = actionText(L);
      preview();
    };
    const inp = el('input', { type: 'number', min: '1', max: '999', step: '1', value: String(L.lots), id: 'tkLots', 'aria-label': 'Lots', inputmode: 'numeric',
      oninput: (e) => { if (e.target.value !== '') setLots(e.target.value, true); }, onblur: (e) => { e.target.value = L.lots; } });
    const quick = el('div', { class: 'tk-quick', role: 'group', 'aria-label': 'Quick lot sizes' },
      [1, 2, 5, 10].map((n) => el('button', { type: 'button', class: n === L.lots ? 'on' : '', 'data-n': String(n), text: String(n), onclick: () => setLots(n) })));
    body.append(side,
      el('div', { class: 'tk-lots' },
        el('div', { class: 'stepper' }, el('button', { type: 'button', 'aria-label': 'One lot fewer', text: '−', onclick: () => setLots(L.lots - 1) }), inp, el('button', { type: 'button', 'aria-label': 'One lot more', text: '+', onclick: () => setLots(L.lots + 1) })),
        quick),
      el('span', { class: 'note', id: 'tkQty', text: lotsText(L.lots, lot) }));
  } else {
    body.append(el('div', { class: 'note', text: `${legs.length} legs, placed together at the live quotes.` }));
  }
  body.append(el('label', { class: 'f', for: 'tkNote' }, 'Journal entry (required)',
    el('textarea', { class: 'inp note-in', id: 'tkNote', rows: '2', minlength: '1', maxlength: '1000', 'aria-required': 'true', placeholder: S.meta.replay ? 'What do you expect the index or volatility to do?' : 'Why are you taking this trade? What are you practicing?', oninput: (e) => { note = e.target.value; syncPlaceButton(); } }, note),
    el('span', { class: 'note', text: 'Enter at least one non-space character. Your entry is saved with the order.' })));
  if (S.meta.replay) body.append(
    el('label', { class: 'f', for: 'tkPlan' }, 'What would prove your idea wrong? (exit plan)',
      el('textarea', { class: 'inp note-in', id: 'tkPlan', rows: '2', maxlength: '1000', placeholder: 'Set a price, time, or event that would make you close the trade.', oninput: (e) => { plan = e.target.value; } }, plan)));
  if (S.quotes?.market && !S.quotes.market.open) body.append(el('div', { class: 'warnbox', text: 'The market is closed. Paper orders fill at the last quotes NSE published, which may be stale.' }));
  body.append(el('div', { id: 'tkPv' }, el('p', { class: 'note', text: 'Getting live quotes…' })));
  const placeBtn = el('button', { class: 'btn ' + (basket ? '' : L.side === 'BUY' ? 'buy' : 'sell'), type: 'button', id: 'tkPlace', text: basket ? `Place all ${legs.length} legs` : actionText(L), disabled: true, onclick: place });
  const foot = el('div', { class: 'tk-f' }, el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => dlg.close() }),
    !basket ? el('button', { class: 'btn ghost', type: 'button', text: 'Add to strategy', onclick: () => { emit('addLeg', { ...L }); emit('goto', 'strategy'); dlg.close(); } }) : null, placeBtn);
  const title = basket ? `${tag || 'Strategy'} · ${L.symbol}` : instrument(L);
  dlg.replaceChildren(el('div', { class: 'tk-h' }, el('div', {}, el('h3', { text: title }), el('div', { class: 'note', text: `${S.meta.replay ? 'Replay order at this day\'s close' : 'Paper order'} · ${fmtLeft(L.expiry)}` })), close), body, foot);
}

function preview() {
  clearTimeout(pvTimer);
  latestPreviewOk = false; syncPlaceButton();
  pvTimer = setTimeout(async () => {
    const my = ++seq; const box = $('#tkPv'); if (!box) return;
    try {
      let pv;
      try { pv = await api('/api/preview', { legs }); }
      catch (e) {
        // Preview is read-only, so retry once if the local server drops this request transiently.
        if (!(e instanceof TypeError)) throw e;
        await wait(350);
        try { pv = await api('/api/preview', { legs }); }
        catch (retryError) {
          if (retryError instanceof TypeError) throw new Error('Optionwise stopped responding while fetching quotes. Reopen the app and try again.');
          throw retryError;
        }
      }
      if (my !== seq || !dlg.open) return;
      const kv = (k, v, cls = '') => [el('span', { class: 'k' }, term(k)), el('span', { class: 'v ' + cls, text: v })];
      const rows = [];
      const how = (f) => (S.meta.replay ? (f.side === 'BUY' ? '(close + slippage)' : '(close − slippage)') : f.side === 'BUY' ? '(ask)' : '(bid)');
      for (const f of pv.fills) rows.push(...kv(`${basket ? `${f.side === 'BUY' ? 'Buy' : 'Sell'} ${f.lots}× ${f.strike} ${f.type}` : 'Fill price'}`, `₹${inr2.format(f.price)} ${how(f)}`));
      rows.push(...kv(pv.netPremium >= 0 ? 'Premium you receive' : 'Premium you pay', rs(Math.abs(pv.netPremium)), pv.netPremium >= 0 ? 'up' : ''));
      rows.push(chargesRow(pv));
      const dm = pv.marginAfter - pv.marginBefore;
      rows.push(...kv(dm >= 0 ? 'Margin blocked' : 'Margin released', rs(Math.abs(dm))));
      rows.push(...kv('Available after', rs(pv.availableAfter), pv.availableAfter < 0 ? 'down' : ''));
      if (pv.realized) rows.push(...kv('Realized on this order', srs(pv.realized), pv.realized >= 0 ? 'up' : 'down'));
      const out = [el('div', { class: 'kv' }, rows.flat())];
      if (!basket) {
        const L = legs[0]; const f = pv.fills[0];
        if (L.side === 'BUY') out.push(el('p', { class: 'note', text: `Most you can lose: ${rs(f.premium + f.charges)}. You profit at expiry only if ${L.symbol} ends ${L.type === 'CE' ? 'above' : 'below'} ${inr2.format(L.type === 'CE' ? L.strike + f.price : L.strike - f.price)}.` }));
        else if (pv.marginAfter > pv.marginBefore) out.push(el('div', { class: 'warnbox', text: L.type === 'CE' ? 'Selling a call on its own has no limit on loss if the index rallies. Most you can earn is the premium.' : `Selling a put on its own can lose up to ${rs(L.strike * f.qty)} if the index collapses. Most you can earn is the premium.` }));
      }
      if (!pv.ok) out.push(el('div', { class: 'errbox', text: 'Not enough free funds for this order.' }));
      box.replaceChildren(...out);
      latestPreviewOk = Boolean(pv.ok); syncPlaceButton();
    } catch (e) {
      if (my !== seq) return;
      box.replaceChildren(el('div', { class: 'errbox', text: e.message }));
      latestPreviewOk = false; syncPlaceButton();
    }
  }, 200);
}

function syncPlaceButton() {
  const btn = $('#tkPlace'); if (btn) btn.disabled = placing || !latestPreviewOk || !note.trim();
}

async function place() {
  if (placing) return;
  if (!note.trim()) { toast('Write at least one character in your journal entry before placing the trade.', 'err'); $('#tkNote')?.focus(); return; }
  placing = true; const btn = $('#tkPlace'); btn.disabled = true; btn.textContent = 'Placing…';
  try {
    const r = await api('/api/order', { legs, tag: basket ? tag : '', note, plan });
    S.account = r.account; emit('account', r.account);
    const f = r.fills[0];
    toast(basket ? `Placed ${legs.length} legs. Net ${r.netPremium >= 0 ? 'credit' : 'debit'} ${rs(Math.abs(r.netPremium))}, charges ${rs(r.charges)}.` : `${f.side === 'BUY' ? 'Bought' : 'Sold'} ${f.lots} lot${f.lots > 1 ? 's' : ''} (${f.qty.toLocaleString('en-IN')} units) of ${instrument(f)} at ₹${inr2.format(f.price)}.`, 'ok');
    const done = onPlaced; dlg.close(); done?.(r);
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; render(); preview(); }
  finally { placing = false; }
}

// Charges as one line that opens into the itemised list a broker's contract note shows.
let chargesOpen = false; // stays open across the 5-second refreshes once you expand it
const PART_LABELS = [['brokerage', 'Brokerage'], ['stt', 'STT'], ['exchange', 'Exchange charges'], ['sebi', 'SEBI fee'], ['stamp', 'Stamp duty'], ['gst', 'GST']];
function chargesRow(pv) {
  const parts = pv.chargeParts || {};
  const n = pv.fills.length; const per = S.meta.charges?.perOrder ?? 20;
  return [el('details', { class: 'tk-charges', open: chargesOpen, ontoggle: (e) => { chargesOpen = e.target.open; } },
    el('summary', {}, el('span', { class: 'k' }, term('Charges', 'charges'), el('span', { class: 'chev', 'aria-hidden': 'true' })), el('span', { class: 'v', text: rs2(pv.charges) })),
    el('div', { class: 'kv sub' }, PART_LABELS.filter(([k]) => parts[k] > 0).flatMap(([k, label]) => [el('span', { class: 'k' }, term(label, 'charge ' + k)), el('span', { class: 'v', text: rs2(parts[k]) })])),
    el('p', { class: 'note' }, `₹${per} brokerage per executed order${n > 1 ? `, so ${n} legs pay it ${n} times` : ''}, as at ${S.meta.charges?.brokers || 'discount brokers'}. Taxes and fees are the official rates${S.meta.replay ? ' in force on this day' : ''}.`))];
}
