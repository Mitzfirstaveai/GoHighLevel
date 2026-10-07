(function () {
  const status = document.getElementById('scan-status');
  const button = document.getElementById('start-btn');
  if (typeof Html5Qrcode === 'undefined') {
    status.textContent = 'Camera scanner could not load. Use manual entry below.';
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
    if (!token) { status.textContent = 'That QR code is not a ticket.'; return; }
    handled = true;
    status.textContent = 'Found ticket — opening…';
    scanner.stop().finally(() => { window.location.href = '/admin/checkin/' + encodeURIComponent(token); });
  }

  function start() {
    button.hidden = true;
    status.textContent = 'Starting camera…';
    scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 250, height: 250 } }, onScan, () => {})
      .then(() => { status.textContent = 'Point the camera at a member\'s QR code.'; })
      .catch((err) => {
        status.textContent = 'Could not access camera: ' + err + '. Use manual entry below.';
        button.hidden = false;
      });
  }

  button.addEventListener('click', start);
  start();
})();
