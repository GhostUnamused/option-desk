// Black–Scholes pricing and Greeks, shared by the server and the browser.

// "Now" for time-to-expiry. The browser points it at the replay date's close in replay mode.
let clock = () => Date.now();
export const setClock = (fn) => { clock = fn; };
export const now = () => clock();

const SQ2PI = Math.sqrt(2 * Math.PI);
export const npdf = (x) => Math.exp(-x * x / 2) / SQ2PI;

export function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = npdf(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// type: 'CE' or 'PE'. S spot, K strike, T years, r rate, v volatility (decimals).
// Returns price, delta, gamma, theta (per day), vega (per 1 vol point).
export function bs(type, S, K, T, r, v) {
  if (!(T > 1e-8) || !(v > 0)) {
    const itm = type === 'CE' ? S > K : S < K;
    return { price: Math.max(type === 'CE' ? S - K : K - S, 0), delta: itm ? (type === 'CE' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * sq);
  const d2 = d1 - v * sq;
  const df = Math.exp(-r * T);
  const gamma = npdf(d1) / (S * v * sq);
  const vega = S * npdf(d1) * sq / 100;
  const th = -S * npdf(d1) * v / (2 * sq);
  const out = type === 'CE'
    ? { price: S * ncdf(d1) - K * df * ncdf(d2), delta: ncdf(d1), gamma, theta: (th - r * K * df * ncdf(d2)) / 365, vega }
    : { price: K * df * ncdf(-d2) - S * ncdf(-d1), delta: ncdf(d1) - 1, gamma, theta: (th + r * K * df * ncdf(-d2)) / 365, vega };
  // With under a day left, a "per day" decay can't exceed the time value that remains.
  if (T < 1 / 365) out.theta = Math.max(out.theta, -(out.price - Math.max(type === 'CE' ? S - K : K - S, 0)));
  return out;
}

// Solve for implied volatility from a market price (bisection, robust).
export function impliedVol(type, S, K, T, r, price) {
  const intrinsic = Math.max(type === 'CE' ? S - K : K - S, 0);
  if (!(price > intrinsic) || !(T > 0)) return 0;
  let lo = 0.001, hi = 3;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (bs(type, S, K, T, r, mid).price > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// Payoff of one option at expiry, per unit.
export const intrinsic = (type, S, K) => Math.max(type === 'CE' ? S - K : K - S, 0);

// Years until expiry (expiry at 15:30 IST on the given YYYY-MM-DD).
export function yearsTo(expiryISO, t = now()) {
  const end = Date.parse(expiryISO + 'T15:30:00+05:30');
  return Math.max((end - t) / (365 * 864e5), 0);
}
