// Quick mode (switched on under the door camera, remembered per device): after a successful
// check-in, count down and go back to the camera. Any tap, or "Stay on this page", stops it.
(function () {
  const box = document.getElementById('auto-return');
  if (!box) return;
  let on = false;
  try { on = localStorage.getItem('gsa-quick-checkin') === '1'; } catch { /* private window: off */ }
  if (!on) return;
  const text = document.getElementById('auto-return-text');
  let left = 3;
  const show = () => { text.textContent = box.dataset.template.replace('{n}', left); };
  box.hidden = false;
  show();
  const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(timer); window.location.href = box.dataset.url; return; }
    show();
  }, 1000);
  const stop = () => { clearInterval(timer); box.hidden = true; };
  document.getElementById('auto-return-stay').addEventListener('click', stop);
  document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target)) stop(); }, { once: true });
})();
