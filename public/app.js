// Installable app: register the service worker, offer "Install" where the browser supports it,
// and clear cached tickets on sign-out.
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    document.querySelectorAll('form[action="/logout"]').forEach((f) => f.addEventListener('submit', () => {
      navigator.serviceWorker.controller?.postMessage('clear-tickets');
    }));
  }
  const card = document.getElementById('install-card');
  if (!card) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let dismissed = false;
  try { dismissed = localStorage.getItem('gsa-install-dismissed') === '1'; } catch { /* private mode */ }
  if (standalone || dismissed) return;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  card.hidden = false;
  card.querySelector('[data-ios]').hidden = !isIos;
  const button = card.querySelector('[data-install]');
  let prompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; button.hidden = false; });
  button.addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice;
    card.hidden = true;
  });
  card.querySelector('[data-dismiss]').addEventListener('click', () => {
    card.hidden = true;
    try { localStorage.setItem('gsa-install-dismissed', '1'); } catch { /* ignore */ }
  });
})();

// Public website: "Install the GSA app" button where the browser offers it, and the install
// steps for this kind of phone shown first.
(function () {
  const box = document.querySelector('[data-site-install]');
  if (!box) return;
  const ua = navigator.userAgent;
  const platform = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ? 'ios'
    : /android/i.test(ua) ? 'android' : null;
  const step = platform && box.querySelector(`[data-platform="${platform}"]`);
  if (step) {
    step.classList.add('yours');
    step.querySelector('[data-yours]').hidden = false;
  }
  const button = box.querySelector('[data-install]');
  const installed = () => {
    button.hidden = true;
    box.querySelector('[data-installed]').hidden = false;
  };
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) installed();
  let prompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; button.hidden = false; });
  window.addEventListener('appinstalled', installed);
  button.addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    const choice = await prompt.userChoice;
    prompt = null;
    if (choice.outcome === 'accepted') installed();
    else button.hidden = true;
  });
})();
