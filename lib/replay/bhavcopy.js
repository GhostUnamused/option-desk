// NSE daily archives: F&O bhavcopy (old format until July 2024, UDiFF after) and the all-indices close file.
// Parsers keep only index options for REPLAY.symbols and return one normalized shape for both formats.
import zlib from 'node:zlib';
import { REPLAY, KNOWN_LOTS, lotOn } from '../config.js';

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (n) => String(n).padStart(2, '0');
export const UDIFF_FROM = '2024-07-08'; // first day NSE published the UDiFF bhavcopy

// Both archive URLs for a date, the likely format first.
export function foUrls(date) {
  const [y, m, d] = date.split('-');
  const udiff = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${y}${m}${d}_F_0000.csv.zip`;
  const old = `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${y}/${MON[+m - 1]}/fo${d}${MON[+m - 1]}${y}bhav.csv.zip`;
  return date >= UDIFF_FROM ? [udiff, old] : [old, udiff];
}
export const indexUrl = (date) => { const [y, m, d] = date.split('-'); return `https://nsearchives.nseindia.com/content/indices/ind_close_all_${d}${m}${y}.csv`; };

// First file of a zip archive. Reads the central directory, because local headers may leave sizes blank.
export function unzipFirst(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a zip file');
  const cd = buf.readUInt32LE(e + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('Bad zip directory');
  const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), off = buf.readUInt32LE(cd + 42);
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  const data = buf.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported zip compression ${method}`);
}

function rows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift().split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return { head, rows: lines.map((l) => { const c = l.split(','); const o = {}; head.forEach((h, i) => { o[h] = (c[i] ?? '').trim().replace(/^"|"$/g, ''); }); return o; }) };
}
// "11-Jul-2024" / "05-JUL-2024" -> "2024-07-11"
function monDate(s) { const [d, m, y] = s.split('-'); const i = MON.indexOf(m.toUpperCase()); if (i < 0) throw new Error(`Bad date ${s}`); return `${y}-${pad(i + 1)}-${pad(d)}`; }
const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : 0; };
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));

// Old-format files carry no lot size. Open interest is always a whole number of lots, so the greatest common
// divisor of a contract's OI figures is its lot, unless the contract mixes old and new lots (then the gcd is a
// divisor of the table lot) or there are too few figures to trust.
export function inferLot(symbol, date, oiValues) {
  const table = lotOn(symbol, date);
  const vals = oiValues.filter((v) => v);
  if (vals.length < 20) return table;
  const g = vals.reduce(gcd, 0);
  return KNOWN_LOTS[symbol]?.includes(g) && table % g !== 0 ? g : table;
}

// -> { date, format, options: [{ symbol, expiry, strike, type, open, high, low, close, settle, volume, oi, chgOi, lot }], underlying: { NIFTY: 25285.35 } }
// volume is in contracts in both formats; oi and chgOi are in units.
export function parseFo(text, wantDate, symbols = REPLAY.symbols) {
  const { head, rows: list } = rows(text);
  const want = new Set(symbols);
  const options = []; const underlying = {};
  let format, date = null;
  if (head.includes('TckrSymb')) {
    format = 'udiff';
    for (const r of list) {
      if (r.FinInstrmTp !== 'IDO' || !want.has(r.TckrSymb)) continue;
      date ??= r.TradDt;
      if (num(r.UndrlygPric)) underlying[r.TckrSymb] = num(r.UndrlygPric);
      options.push({ symbol: r.TckrSymb, expiry: r.FininstrmActlXpryDt || r.XpryDt, strike: num(r.StrkPric), type: r.OptnTp,
        open: num(r.OpnPric), high: num(r.HghPric), low: num(r.LwPric), close: num(r.ClsPric), settle: num(r.SttlmPric),
        volume: Math.round(num(r.TtlTradgVol)), oi: Math.round(num(r.OpnIntrst)), chgOi: Math.round(num(r.ChngInOpnIntrst)), lot: Math.round(num(r.NewBrdLotQty)) || null });
    }
  } else if (head.includes('INSTRUMENT')) {
    format = 'old';
    for (const r of list) {
      if (r.INSTRUMENT !== 'OPTIDX' || !want.has(r.SYMBOL)) continue;
      date ??= monDate(r.TIMESTAMP);
      options.push({ symbol: r.SYMBOL, expiry: monDate(r.EXPIRY_DT), strike: num(r.STRIKE_PR), type: r.OPTION_TYP,
        open: num(r.OPEN), high: num(r.HIGH), low: num(r.LOW), close: num(r.CLOSE), settle: num(r.SETTLE_PR),
        volume: Math.round(num(r.CONTRACTS)), oi: Math.round(num(r.OPEN_INT)), chgOi: Math.round(num(r.CHG_IN_OI)), lot: null });
    }
    date ??= wantDate;
    const byContract = new Map();
    for (const o of options) { const k = `${o.symbol}|${o.expiry}`; if (!byContract.has(k)) byContract.set(k, []); byContract.get(k).push(o.oi, o.chgOi); }
    const lots = new Map([...byContract].map(([k, v]) => [k, inferLot(k.split('|')[0], date, v)]));
    for (const o of options) o.lot = lots.get(`${o.symbol}|${o.expiry}`);
  } else throw new Error('Unrecognised bhavcopy format');
  if (wantDate && date && date !== wantDate) throw new Error(`File is for ${date}, expected ${wantDate}`);
  return { date: date || wantDate, format, options: options.filter((o) => (o.type === 'CE' || o.type === 'PE') && o.strike > 0), underlying };
}

const INDEX_NAMES = { 'nifty 50': 'NIFTY', 'nifty bank': 'BANKNIFTY', 'india vix': 'INDIAVIX' };
// ind_close_all_DDMMYYYY.csv -> { NIFTY: { open, high, low, close }, BANKNIFTY: …, INDIAVIX: … }
export function parseIndexClose(text) {
  const out = {};
  for (const r of rows(text).rows) {
    const sym = INDEX_NAMES[(r['Index Name'] || '').toLowerCase()];
    if (!sym) continue;
    const close = num(r['Closing Index Value']); if (!close) continue;
    const v = (k) => num(r[k]) || close;
    out[sym] = { open: v('Open Index Value'), high: v('High Index Value'), low: v('Low Index Value'), close };
  }
  return out;
}
