// Page behaviour outside the demo: device-aware download buttons, copy/share, star count, smooth scroll.

export const SITE_URL = 'https://yaminichandrakj.github.io/optionwise/';
const REPO_API = 'https://api.github.com/repos/yaminichandrakj/optionwise';

// 'phone' (phones and tablets), 'windows', or 'other' (macOS / Linux desktops).
export function detectDevice() {
  const ua = navigator.userAgent || '';
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const coarse = matchMedia('(pointer: coarse)').matches;
  const narrow = Math.min(screen.width || innerWidth, innerWidth) < 900;
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua) || (navigator.userAgentData && navigator.userAgentData.mobile);
  const iPadOS = /Mac/.test(platform) && navigator.maxTouchPoints > 1;
  if (mobileUA || iPadOS || (coarse && narrow)) return 'phone';
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
  return 'other';
}

export const device = detectDevice();
document.documentElement.dataset.device = device;
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Replace each download block with the variant that suits this device.
export function fillCta(el) {
  if (device === 'windows') return;
  const tpl = document.getElementById(device === 'phone' ? 'cta-phone' : 'cta-other');
  el.replaceChildren(tpl.content.cloneNode(true));
  wireCta(el);
}

function wireCta(root) {
  const share = root.querySelector('[data-share]');
  if (share && navigator.share) {
    share.hidden = false;
    share.addEventListener('click', () => navigator.share({ title: 'Optionwise', text: 'Practise NSE index options with no real money. Open on a Windows laptop.', url: SITE_URL }).catch(() => {}));
  }
  const mail = root.querySelector('[data-mail]');
  if (mail) {
    const body = `Try Optionwise on my laptop: ${SITE_URL}\n\nFree Windows app for practising NSE index options with no real money.`;
    mail.href = `mailto:?subject=${encodeURIComponent('Optionwise: open on my laptop')}&body=${encodeURIComponent(body)}`;
  }
  const copy = root.querySelector('[data-copylink]');
  if (copy) copy.addEventListener('click', () => copyText(SITE_URL, copy, 'Link copied'));
}

export async function copyText(text, btn, done = 'Copied') {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    // Fallback for browsers without the async clipboard (or without permission).
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (!btn) return ok;
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  btn.textContent = ok ? done : 'Press Ctrl+C to copy';
  setTimeout(() => { btn.textContent = label; }, 1800);
  return ok;
}

document.querySelectorAll('.cta').forEach(fillCta);

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyText(document.querySelector(btn.dataset.copy).textContent.trim(), btn));
});

// In-page links: smooth unless the visitor asked for less motion; move focus so keyboard users land there too.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const target = document.getElementById(a.getAttribute('href').slice(1));
  if (!target) return;
  e.preventDefault();
  target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  history.replaceState(null, '', a.getAttribute('href'));
});

// Live star count. Any failure (offline, rate limit) leaves the plain "Star on GitHub" label.
async function stars() {
  let n = null;
  try { const c = sessionStorage.getItem('ow:stars'); if (c !== null && c !== '') n = +c; } catch {}
  if (n === null || !Number.isFinite(n)) {
    try {
      const r = await fetch(REPO_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (r.ok) {
        const j = await r.json();
        if (Number.isFinite(j.stargazers_count)) n = j.stargazers_count;
        try { if (n !== null) sessionStorage.setItem('ow:stars', String(n)); } catch {}
      }
    } catch {}
  }
  if (n === null || !Number.isFinite(n)) return;
  document.querySelectorAll('[data-star]').forEach((a) => {
    const c = a.querySelector('.star-count');
    c.textContent = n.toLocaleString('en-IN');
    c.hidden = false;
    a.setAttribute('aria-label', `Star Optionwise on GitHub, ${n.toLocaleString('en-IN')} stars so far`);
  });
}
stars();
