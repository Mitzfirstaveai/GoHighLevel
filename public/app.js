// Installable app: register the service worker, offer "Install" where the browser supports it,
// and clear cached tickets on sign-out.
(function () {
  // Members' menu: when the big menu buttons scroll off screen, show the slim pinned menu instead.
  const bigMenu = document.querySelector('.member-menu');
  const slimMenu = document.querySelector('[data-compact-menu]');
  if (bigMenu && slimMenu && 'IntersectionObserver' in window) {
    const header = document.querySelector('.topbar');
    // Sits just under the pinned header (logo, language, text size, Sign out), whatever its height.
    new IntersectionObserver(([entry]) => {
      slimMenu.style.top = `${header ? header.offsetHeight : 0}px`;
      slimMenu.hidden = entry.isIntersecting;
    }, { rootMargin: `-${header ? header.offsetHeight : 0}px 0px 0px 0px` }).observe(bigMenu);
  }

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
