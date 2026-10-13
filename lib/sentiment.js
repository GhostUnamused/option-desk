// Headline sentiment and shock tagging for the news panel. A small finance word list, not a model: each headline
// scores from −1 (bearish) to +1 (bullish), and headlines about events that jolt markets get a shock tag.

// Words with weights. A trailing * matches any ending (rall* covers rally / rallies / rallied); other words match exactly,
// so "ban" does not catch "bank". Entries with a space are phrases.
const POS = {
  'rall*': 1, 'surg*': 1.2, 'soar*': 1.3, 'jump*': 1, 'gain*': 0.8, rise: 0.7, rises: 0.7, rising: 0.7, rose: 0.7, 'climb*': 0.8, 'advanc*': 0.6, up: 0.4, higher: 0.5, 'record high': 1.2, 'all-time high': 1.2, 'fresh high': 1,
  'bull*': 1, upbeat: 0.9, 'optimis*': 0.9, 'recover*': 0.8, 'rebound*': 0.9, 'boost*': 0.8, beat: 0.7, beats: 0.7, strong: 0.6, stronger: 0.7, robust: 0.7, growth: 0.4, 'inflow*': 0.7, 'upgrad*': 0.8,
  'rate cut': 0.8, 'rate cuts': 0.8, eases: 0.3, relief: 0.8, ceasefire: 0.9, peace: 0.6, deal: 0.4, stimulus: 0.8, 'outperform*': 0.7, green: 0.5, positive: 0.6, buy: 0.3, buying: 0.4, uptrend: 0.8, breakout: 0.6, 'cheer*': 0.8, 'short covering': 0.6, approves: 0.2,
};
const NEG = {
  fall: 0.9, falls: 0.9, falling: 0.9, fell: 0.9, 'slump*': 1.2, 'plung*': 1.4, 'crash*': 1.6, 'tumbl*': 1.2, sink: 1, sinks: 1, sank: 1, 'drop*': 0.8, 'declin*': 0.8, slide: 0.9, slides: 0.9, slid: 0.9, slips: 0.7, slipped: 0.7, down: 0.6, below: 0.3, lower: 0.4, loss: 0.7, losses: 0.7, 'record low': 1, '52-week low': 0.9,
  'bear*': 1, selloff: 1.2, 'sell-off': 1.2, selling: 0.6, fear: 1, fears: 1, 'worr*': 0.9, concern: 0.7, concerns: 0.7, weak: 0.8, weaker: 0.8, weakness: 0.8, 'outflow*': 0.8, 'downgrad*': 0.9, recession: 1.3, inflation: 0.5, slowdown: 0.9,
  war: 1.4, 'tension*': 0.9, conflict: 1, 'attack*': 1.2, default: 1.1, 'fraud*': 1, scam: 1, probe: 0.6, ban: 0.6, bans: 0.6, curbs: 0.6, 'tariff*': 0.8, 'sanction*': 0.8, 'volatil*': 0.5, panic: 1.4, bloodbath: 1.6, rout: 1.4,
  correction: 0.7, 'rate hike': 0.9, 'rate hikes': 0.9, red: 0.5, negative: 0.6, 'profit booking': 0.6, 'profit-taking': 0.6, 'wipe*': 1.1, 'erod*': 0.9, 'lower circuit': 1.5, 'circuit breaker': 1.5, downtrend: 0.8, 'slash*': 0.6, misses: 0.6, 'uncertain*': 0.7, crisis: 1.3, sheds: 0.9, 'shed': 0.9, 'warn*': 0.6,
};
// "Cut" is negative for profits but positive for rates: the phrase list above is checked first.
const NEGATORS = new Set(['not', 'no', 'never', 'without', "won't", "didn't", "doesn't", 'fails', 'failed', 'despite', 'halts', 'snaps', 'pares', 'erases', 'trims', 'cuts']);

// Shock topics: events that move the whole market. Severity 1 = worth watching, 2 = can gap the market.
const SHOCKS = [
  ['geopolitical', 2, /\b(war|invasion|invade[sd]?|missile|air ?strikes?|military|terror(ist)? attack|border clash|nuclear|ceasefire|operation sindoor|geopolitic)/i],
  ['policy', 2, /\b(repo rate|monetary policy|mpc (meet|decision|outcome)|fomc|fed (rate|hikes?|cuts?|decision|chair|meeting)|federal reserve|rates? (hikes?|cuts?)|(hikes?|cuts?) (interest )?rates|union budget|budget (day|20\d\d)|ltcg|stt (hike|on (f&o|options))|capital gains tax|demoneti[sz]ation)/i],
  ['election', 2, /\b(election results?|exit polls?|lok sabha|poll outcome|vote count)/i],
  ['market stress', 2, /\b(crash|bloodbath|black (monday|friday)|lower circuit|circuit breaker|biggest (single-day )?(fall|drop|crash)|panic sell|wiped out|lakh crore wiped|rout)/i],
  ['global', 1, /\b(tariffs?|trade war|sanctions?|recession|crude (oil )?(surges?|spikes?|jumps?|soars?)|oil prices? (surge|spike|jump|soar)|dollar index|yen carry|wall street (crash|plunge|tumble)|us inflation|cpi data|bond yields? (surge|spike|jump))/i],
  ['macro', 1, /\b(gdp|inflation data|cpi|wpi|iip|fiscal deficit|rupee (hits|falls to|slumps to) (a )?(record|all-time|fresh) low|record low against|downgrade|credit rating|moody'?s|s&p global|fitch)/i],
  ['flows', 1, /\b(fii|fpi|foreign (institutional )?investors?) .{0,40}(sell|pull|dump|outflow|exodus)/i],
  ['disaster', 2, /\b(pandemic|covid|lockdown|earthquake|tsunami|cyclone)/i],
  ['corporate', 1, /\b(hindenburg|short[- ]seller|accounting fraud|sebi (ban|order|probe|crackdown)|insolvency|bankruptcy)/i],
];

const words = (s) => s.toLowerCase().replace(/[‘’]/g, "'").match(/[a-z0-9'&-]+/g) || [];

export function scoreHeadline(text) {
  const t = ' ' + String(text).toLowerCase() + ' ';
  let score = 0, hits = 0;
  // Phrases first (they contain spaces), then single words with negation looking back three words.
  const used = [];
  for (const [table, sign] of [[POS, 1], [NEG, -1]]) for (const [k, w] of Object.entries(table)) if (k.includes(' ') && t.includes(' ' + k)) { score += sign * w; hits++; used.push(k); }
  const ws = words(text);
  ws.forEach((w, i) => {
    if (used.some((u) => u.split(' ').includes(w))) return;
    let s = 0;
    const hit = (k) => !k.includes(' ') && (k.endsWith('*') ? w.startsWith(k.slice(0, -1)) : w === k);
    for (const [k, v] of Object.entries(POS)) if (hit(k)) s = Math.max(s, v);
    let n = 0;
    for (const [k, v] of Object.entries(NEG)) if (hit(k)) n = Math.max(n, v);
    const v = s - n; if (!v) return;
    const negated = ws.slice(Math.max(0, i - 3), i).some((x) => NEGATORS.has(x));
    score += negated ? -v * 0.7 : v; hits++;
  });
  const val = hits ? Math.max(-1, Math.min(1, score / Math.sqrt(hits + 1))) : 0;
  return { score: Math.round(val * 100) / 100, label: val > 0.15 ? 'positive' : val < -0.15 ? 'negative' : 'neutral' };
}

export function shockOf(text) {
  let best = null;
  for (const [kind, sev, re] of SHOCKS) if (re.test(text) && (!best || sev > best.severity)) best = { kind, severity: sev };
  return best;
}

// Overall mood of a set of scored items, weighting recent ones more (half-life in hours, relative to `at`).
export function mood(items, at = Date.now(), halfLifeH = 12) {
  let w = 0, s = 0; const n = { positive: 0, negative: 0, neutral: 0 };
  for (const it of items) {
    n[it.sentiment.label]++;
    const age = Math.max(0, (at - it.t) / 36e5), k = 0.5 ** (age / halfLifeH) * (it.shock ? 1 + it.shock.severity * 0.5 : 1);
    w += k; s += k * it.sentiment.score;
  }
  const score = w ? Math.round(s / w * 100) / 100 : 0;
  const label = score > 0.25 ? 'Bullish' : score > 0.08 ? 'Leaning bullish' : score < -0.25 ? 'Bearish' : score < -0.08 ? 'Leaning bearish' : 'Mixed';
  return { score, label, ...n, shocks: items.filter((i) => i.shock?.severity > 1).length, watch: items.filter((i) => i.shock?.severity === 1).length, total: items.length };
}
