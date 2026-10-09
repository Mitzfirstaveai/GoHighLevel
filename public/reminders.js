// Event-day reminders card: turn reminders on or off for this device, or send a test.
(function () {
  const card = document.getElementById('reminders');
  if (!card) return;
  const L = JSON.parse(card.dataset.labels || '{}');
  const show = (state) => {
    card.hidden = false;
    card.querySelectorAll('[data-state]').forEach((el) => { el.hidden = el.dataset.state !== state; });
  };
  const say = (text) => { card.querySelector('[data-msg]').textContent = text || ''; };
  const post = (url, data) => fetch(url, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...data, _csrf: card.dataset.csrf }),
  });
  const keyBytes = (b64) => {
    const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  // iPhones and iPads can only show reminders from the app added to the Home Screen.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const subscription = async () => (await navigator.serviceWorker.ready).pushManager.getSubscription();

  async function refresh() {
    if (!supported) return show(ios && !standalone ? 'ios' : 'unsupported');
    if (Notification.permission === 'denied') return show('blocked');
    show((await subscription()) ? 'on' : 'off');
  }

  card.querySelector('[data-on]').addEventListener('click', async () => {
    say(L.wait);
    try {
      if ((await Notification.requestPermission()) !== 'granted') { say(''); return refresh(); }
      const reg = await navigator.serviceWorker.ready;
      const { key } = await (await fetch('/reminders/key', { credentials: 'same-origin' })).json();
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      const j = sub.toJSON();
      const res = await post('/reminders/subscribe', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
      if (!res.ok) throw new Error('not saved');
      say(L.on);
    } catch { say(L.failed); }
    refresh();
  });

  card.querySelector('[data-off]').addEventListener('click', async () => {
    try {
      const sub = await subscription();
      if (sub) { await post('/reminders/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      say(L.off);
    } catch { say(L.failed); }
    refresh();
  });

  card.querySelector('[data-test]').addEventListener('click', async () => {
    try {
      const res = await post('/reminders/test', {});
      say((await res.json()).sent ? L.testSent : L.testNone);
    } catch { say(L.failed); }
  });

  refresh().catch(() => show('unsupported'));
})();
