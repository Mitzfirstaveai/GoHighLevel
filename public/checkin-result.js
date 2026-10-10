// Quick mode (on by default; can be switched off under the door camera, remembered per device): Cash or Check in
// goes straight back to the camera, with the green confirmation at the top — the volunteer just tapped it, so
// there's nothing to wait for. Off: the ticket page stays open after checking in.
(function () {
  let on = true; // on by default; a device that switched it off stays off
  try { on = localStorage.getItem('gsa-quick-checkin') !== '0'; } catch { /* private window: stays on */ }
  document.querySelectorAll('[data-quick]').forEach((input) => { input.value = on ? '1' : ''; });
})();

// A family paying on their phone at the door: check every 2 seconds, and show PAID as soon as it arrives.
(function () {
  const box = document.getElementById('pay-online');
  if (!box) return;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(box.dataset.dueUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (res.ok && (await res.json()).due === 0) { clearInterval(timer); window.location.reload(); }
    } catch { /* offline for a moment: try again next time */ }
  }, 2000);
})();
