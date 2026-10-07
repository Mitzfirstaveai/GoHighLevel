// Quick mode (on by default; can be switched off under the door camera, remembered per device): after a successful
// check-in, count down and go back to the camera. Any tap, or "Stay on this page", stops it.
(function () {
  const box = document.getElementById('auto-return');
  if (!box) return;
  let on = true; // on by default; a device that switched it off stays off
  try { on = localStorage.getItem('gsa-quick-checkin') !== '0'; } catch { /* private window: stays on */ }
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
