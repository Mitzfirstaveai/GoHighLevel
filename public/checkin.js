(function () {
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

  function start() {
    button.hidden = true;
    status.textContent = msgs.starting;
    scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 250, height: 250 } }, onScan, () => {})
      .then(() => { status.textContent = msgs.ready; })
      .catch((err) => {
        status.textContent = msgs.noCamera;
        console.warn('Camera error', err);
        button.hidden = false;
      });
  }

  button.addEventListener('click', start);
  start();
})();
