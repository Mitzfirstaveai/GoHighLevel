(function () {
  // Quick mode (remembered on this device): after a check-in, the result page returns to the camera.
  const quick = document.getElementById('quick-mode');
  if (quick) {
    try { quick.checked = localStorage.getItem('gsa-quick-checkin') === '1'; } catch { /* private window */ }
    quick.addEventListener('change', () => {
      try { localStorage.setItem('gsa-quick-checkin', quick.checked ? '1' : '0'); } catch { /* not saved */ }
    });
  }

  const msgs = JSON.parse(document.currentScript.dataset.msgs || '{}');
  const status = document.getElementById('scan-status');
  const button = document.getElementById('start-btn');
  if (typeof Html5Qrcode === 'undefined') {
    status.textContent = msgs.unavailable;
    button.hidden = true;
    return;
  }
  const scanner = new Html5Qrcode('reader');
  let handled = false;

  function tokenFrom(text) {
    const parts = String(text).trim().split('/').filter(Boolean);
    const token = parts[parts.length - 1] || '';
    return /^[A-Za-z0-9_-]{10,64}$/.test(token) ? token : null;
  }

  function onScan(text) {
    if (handled) return;
    const token = tokenFrom(text);
    if (!token) { status.textContent = msgs.notTicket; return; }
    handled = true;
    status.textContent = msgs.opening;
    scanner.stop().finally(() => { window.location.href = '/admin/checkin/' + encodeURIComponent(token); });
  }

  // Keep the whole camera view on screen, centred, so the volunteer never has to scroll.
  const card = document.getElementById('scanner');
  function centre() {
    const r = card.getBoundingClientRect();
    if (r.top < 70 || r.bottom > window.innerHeight) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function start() {
    button.hidden = true;
    status.textContent = msgs.starting;
    // Square video; the scan box is 70% of it, whatever the screen size.
    const qrbox = (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; };
    scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox, aspectRatio: 1 }, onScan, () => {})
      .then(() => { status.textContent = msgs.ready; centre(); })
      .catch((err) => {
        status.textContent = msgs.noCamera;
        console.warn('Camera error', err);
        button.hidden = false;
      });
  }

  button.addEventListener('click', start);
  start();
})();
