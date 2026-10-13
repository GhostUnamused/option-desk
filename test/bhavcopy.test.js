// Bhavcopy parsing: both NSE formats, lot sizes, index closes, zip reading; and the date-aware tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseFo, parseIndexClose, unzipFirst, inferLot, foUrls } from '../lib/replay/bhavcopy.js';
import { lotOn, expiryRule, expiryKind } from '../lib/config.js';

// Header and rows exactly as NSE publishes them (trimmed to a few lines).
const OLD = `INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP,
FUTIDX,BANKNIFTY,31-Jul-2024,0,XX,52998.6,52998.6,52300,52724.1,52724.1,177911,1403441.12,2607810,-185025,05-JUL-2024,
OPTIDX,NIFTY,11-Jul-2024,24300,CE,124.9,167,82.75,141.8,141.8,3921554,23941337.9,3358225,279175,05-JUL-2024,
OPTIDX,NIFTY,11-Jul-2024,21100,CE,0,0,0,1897.1,3248.5,0,0,0,0,05-JUL-2024,
OPTIDX,FINNIFTY,09-Jul-2024,23000,PE,10,12,9,11,11,100,1,500,25,05-JUL-2024,
OPTSTK,RELIANCE,25-Jul-2024,3100,CE,10,12,9,11,11,100,1,500,25,05-JUL-2024,
`;
const UDIFF = `TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4
2025-10-10,2025-10-10,FO,NSE,STO,61457,,ABCAPITAL,,2025-10-28,2025-10-28,300.00,PE,ABCAPITAL25OCT300PE,7.80,10.90,7.80,10.65,10.45,8.10,293.35,10.65,1711200,170500,276,264658470.00,262,F1,3100,,,,,
2025-10-10,2025-10-10,FO,NSE,IDO,42693,,NIFTY,,2025-10-14,2025-10-14,25300.00,CE,NIFTY25O1425300CE,46.50,133.00,38.90,97.15,94.15,46.50,25285.35,97.15,8620575,837600,7336964,13978050367935.00,3427242,F1,75,,,,,
2025-10-10,2025-10-10,FO,NSE,IDO,42762,,NIFTY,,2025-10-14,2025-10-14,26550.00,PE,NIFTY25O1426550PE,0.00,0.00,0.00,1592.70,0.00,1592.70,25285.35,1247.95,0,0,0,0.00,0,F1,75,,,,,
2025-10-10,2025-10-10,FO,NSE,IDF,1,,BANKNIFTY,,2025-10-28,2025-10-28,,,BANKNIFTY25OCTFUT,1,1,1,1,1,1,56609.75,1,1,1,1,1,1,F1,35,,,,,
`;

test('old-format bhavcopy: index options only, ISO dates, contracts as volume', () => {
  const r = parseFo(OLD, '2024-07-05');
  assert.equal(r.format, 'old');
  assert.equal(r.date, '2024-07-05');
  assert.equal(r.options.length, 2); // futures, FINNIFTY and stock options dropped
  const o = r.options[0];
  assert.deepEqual([o.symbol, o.expiry, o.strike, o.type, o.close, o.settle, o.volume, o.oi], ['NIFTY', '2024-07-11', 24300, 'CE', 141.8, 141.8, 3921554, 3358225]);
  assert.equal(o.lot, lotOn('NIFTY', '2024-07-05')); // too few OI figures to infer, so the table: 25
  assert.equal(o.lot, 25);
});

test('UDiFF bhavcopy: index options only, lot from the file, underlying price', () => {
  const r = parseFo(UDIFF, '2025-10-10');
  assert.equal(r.format, 'udiff');
  assert.equal(r.options.length, 2);
  assert.deepEqual(r.options.map((o) => [o.symbol, o.expiry, o.strike, o.type, o.lot, o.volume]), [['NIFTY', '2025-10-14', 25300, 'CE', 75, 7336964], ['NIFTY', '2025-10-14', 26550, 'PE', 75, 0]]);
  assert.equal(r.options[1].settle, 1247.95);
  assert.equal(r.underlying.NIFTY, 25285.35);
  assert.throws(() => parseFo(UDIFF, '2025-10-09'), /expected/);
  assert.throws(() => parseFo('A,B\n1,2', '2025-10-10'), /format/);
});

test('lot inference from open interest handles revisions', () => {
  const many = (lot, n = 30, k = 7) => Array.from({ length: n }, (_, i) => lot * (i * k + 3));
  assert.equal(inferLot('NIFTY', '2021-07-15', many(50)), 50); // new contracts already at 50 while the table still says 75
  assert.equal(inferLot('NIFTY', '2023-12-14', many(25)), 50); // long-dated contract with leftover 75-lot positions: gcd 25 divides 50
  assert.equal(inferLot('BANKNIFTY', '2023-07-13', many(25)), 25); // near contracts keep 25 after the switch to 15
  assert.equal(inferLot('NIFTY', '2020-03-26', many(150)), 75); // 150 is not a real lot size
  assert.equal(inferLot('NIFTY', '2020-03-26', many(75, 5)), 75); // too few figures: table
});

test('index close file', () => {
  const csv = `Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield
Nifty 50,10-10-2025,25167.65,25330.75,25156.85,25285.35,103.55,0.41,232943306,21749.23,22.36,3.46,1.31
Nifty Bank,10-10-2025,56168.60,56760.25,56152.45,56609.75,417.70,0.74,162952571,6722.44,15.63,2.13,1.03
India VIX,10-10-2025,10.12,10.34,9.71,10.10,-0.02,-0.17,-,-,-,-,-
Nifty 50 Futures Index,10-10-2025,-,-,-,6569.03,35.47,0.54,-,-,-,-,-`;
  assert.deepEqual(parseIndexClose(csv), {
    NIFTY: { open: 25167.65, high: 25330.75, low: 25156.85, close: 25285.35 },
    BANKNIFTY: { open: 56168.6, high: 56760.25, low: 56152.45, close: 56609.75 },
    INDIAVIX: { open: 10.12, high: 10.34, low: 9.71, close: 10.1 },
  });
});

test('zip reader copes with sizes missing from the local header (as in NSE archives)', () => {
  const name = Buffer.from('fo.csv'); const data = Buffer.from(UDIFF); const comp = zlib.deflateRawSync(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + name.length + comp.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cdOff, 16);
  const zip = Buffer.concat([local, name, comp, cd, name, eocd]);
  assert.equal(unzipFirst(zip).toString(), UDIFF);
});

test('archive URLs by format', () => {
  assert.match(foUrls('2024-07-05')[0], /DERIVATIVES\/2024\/JUL\/fo05JUL2024bhav\.csv\.zip$/);
  assert.match(foUrls('2025-10-10')[0], /BhavCopy_NSE_FO_0_0_0_20251010_F_0000\.csv\.zip$/);
});

test('date-aware lot sizes and expiry weekdays', () => {
  assert.deepEqual(['2020-01-01', '2022-01-01', '2024-06-01', '2025-03-01', '2026-02-01'].map((d) => lotOn('NIFTY', d)), [75, 50, 25, 75, 65]);
  assert.deepEqual(['2020-01-01', '2021-01-01', '2024-01-01', '2025-01-01', '2025-08-01', '2026-02-01'].map((d) => lotOn('BANKNIFTY', d)), [20, 25, 15, 30, 35, 30]);
  assert.equal(expiryRule('NIFTY', '2024-06-01').weekly, 'Thu');
  assert.equal(expiryRule('NIFTY', '2025-10-01').weekly, 'Tue');
  assert.equal(expiryRule('BANKNIFTY', '2023-10-01').weekly, 'Wed');
  assert.equal(expiryRule('BANKNIFTY', '2025-02-01').weekly, null);
  assert.equal(expiryKind('2024-07-25', ['2024-07-04', '2024-07-11', '2024-07-25', '2024-08-29']), 'monthly');
  assert.equal(expiryKind('2024-07-11', ['2024-07-04', '2024-07-11', '2024-07-25']), 'weekly');
});
