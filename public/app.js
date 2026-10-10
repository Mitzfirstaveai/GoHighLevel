// Installable app: register the service worker, offer "Install" where the browser supports it,
// and clear cached tickets on sign-out.
(function () {
  // Members' and admins' menus: when the big menu buttons scroll off screen, show the slim pinned menu instead.
  const bigMenu = document.querySelector('.member-menu, .admin-menu');
  const slimMenu = document.querySelector('[data-compact-menu]');
  if (bigMenu && slimMenu) {
    const header = document.querySelector('.topbar');
    // Shown only once the big buttons have gone up under the pinned header; it sits just below the
    // header (logo, language, text size, Sign out), whatever its height. Measured on every scroll,
    // so a header that changes height while the page loads (fonts, iPad Safari) can't fool it.
    let queued = false;
    const update = () => {
      queued = false;
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      slimMenu.style.top = `${Math.max(0, Math.round(headerBottom))}px`;
      slimMenu.hidden = bigMenu.getBoundingClientRect().bottom > headerBottom + 1;
    };
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
    window.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
    window.addEventListener('load', later);
    update();
  }

  // Donate: typing an "Other amount" selects "Other"; choosing a preset amount clears the typed one.
  const otherAmount = document.querySelector('input[name="other_amount"]');
  if (otherAmount) {
    const otherChoice = otherAmount.form.querySelector('input[name="amount"][value="other"]');
    otherAmount.addEventListener('input', () => { if (otherAmount.value.trim()) otherChoice.checked = true; });
    otherAmount.form.querySelectorAll('input[name="amount"]').forEach((radio) => radio.addEventListener('change', () => {
      if (radio === otherChoice) otherAmount.focus();
      else otherAmount.value = '';
    }));
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
  // Closing the card hides it for the rest of this visit; it comes back the next time the app is opened, until
  // the app is installed. (Phones keep a tab open for days, so a "visit" also ends after 6 hours.) On More it
  // is always shown (data-always), so the app can be installed any time.
  const always = card.hasAttribute('data-always');
  let closedAt = 0;
  try { localStorage.removeItem('gsa-install-dismissed'); closedAt = Number(sessionStorage.getItem('gsa-install-closed')) || 0; } catch { /* private mode */ }
  const dismissed = !always && Date.now() - closedAt < 6 * 60 * 60 * 1000;
  if (standalone || dismissed) return;
  // iPads (iPadOS 13+) say they are a Mac, so also count a Mac with a touch screen as an iPad.
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const macSafari = !ios && /Macintosh/.test(navigator.userAgent) && /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Firefox/.test(navigator.userAgent);
  const kind = ios ? 'ios' : macSafari ? 'mac' : 'other';
  card.hidden = false;
  const steps = card.querySelector(`[data-steps="${kind}"]`);
  const button = card.querySelector('[data-install]');
  // iPhone/iPad can only install from the Share menu, so show those steps straight away.
  if (ios) { steps.hidden = false; button.hidden = true; }
  let prompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; });
  // "Install" (or tapping the card) opens the browser's own install prompt where there is one
  // (Chrome, Edge, Samsung Internet); otherwise it shows the steps for this device.
  const install = async () => {
    if (!prompt) { steps.hidden = false; return; }
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    prompt = null;
    if (outcome === 'accepted') card.hidden = true;
  };
  button.addEventListener('click', (e) => { e.stopPropagation(); install(); });
  card.addEventListener('click', (e) => { if (!e.target.closest('[data-dismiss]')) install(); });
  window.addEventListener('appinstalled', () => { card.hidden = true; });
  card.querySelector('[data-dismiss]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    card.hidden = true;
    try { sessionStorage.setItem('gsa-install-closed', String(Date.now())); } catch { /* ignore */ }
  });
})();

// Tables that would need sideways scrolling become stacked cards instead (see table.stack in styles.css).
// Each value is labelled with its column name; checked again when the screen turns or is resized.
(function () {
  const tables = [...document.querySelectorAll('.table-wrap table')].filter((t) => t.tHead && !t.classList.contains('donation-table'));
  if (!tables.length) return;
  for (const table of tables) {
    const heads = [...table.tHead.rows[0].cells].map((th) => th.textContent.trim());
    for (const row of table.querySelectorAll('tbody tr, tfoot tr')) {
      let col = 0;
      for (const cell of row.cells) {
        // Shown only when stacked: "AMOUNT  $101.00". Wrapping the value keeps label and value side by side.
        if (heads[col] && cell !== row.cells[0] && !cell.querySelector(':scope > .cell-label')) {
          const value = document.createElement('div');
          value.className = 'cell-value';
          value.append(...cell.childNodes);
          const label = document.createElement('span');
          label.className = 'cell-label';
          label.textContent = heads[col];
          cell.append(label, value);
          cell.classList.add('labelled');
        }
        col += cell.colSpan || 1;
      }
    }
  }
  const fit = () => {
    for (const table of tables) {
      table.classList.remove('stack');
      // Measure the box, not just the table: a long value can spill past the table's own edge.
      const wrap = table.parentElement;
      if (Math.max(table.scrollWidth, wrap.scrollWidth) > wrap.clientWidth + 1) table.classList.add('stack');
    }
  };
  fit();
  // Measure again once the fonts and images have loaded (they change the table's width).
  window.addEventListener('load', fit);
  if (document.fonts) document.fonts.ready.then(fit);
  let timer;
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(fit, 150); });
})();

// Fields with a format rule (names letters only, ZIP numbers only…): when the browser stops the form,
// show that field's own message (its title, in the reader's language) instead of "Please match the requested format".
(function () {
  document.querySelectorAll('input[pattern][title]').forEach((input) => {
    input.addEventListener('invalid', () => {
      if (input.validity.patternMismatch) input.setCustomValidity(input.title);
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
  });
})();

// Event-day pop-up: shown once a day per ticket on this device ("Later" or showing the ticket ends it).
(function () {
  const popup = document.getElementById('today-popup');
  if (!popup || typeof popup.showModal !== 'function') return;
  const key = popup.dataset.key;
  try { if (localStorage.getItem(key)) return; } catch { /* private window: show it */ }
  const done = () => { try { localStorage.setItem(key, '1'); } catch { /* private window */ } };
  popup.querySelector('[data-close]').addEventListener('click', () => { done(); popup.close(); });
  popup.querySelector('a').addEventListener('click', done);
  popup.addEventListener('cancel', done); // Esc / back
  popup.showModal();
})();

// Event reminders stay working on their own: when this device has reminders allowed, it re-registers with the
// server now and then (at most every 30 minutes), signing up again with the server's current key if it
// changed (e.g. the server's data was replaced). Nothing is asked of the member.
(function () {
  if (!document.body.classList.contains('signed-in') || document.body.classList.contains('staff-mode')) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const csrf = document.body.dataset.csrf || document.querySelector('input[name=_csrf]')?.value;
  if (!csrf) return;
  // Right away after signing in (a new session, e.g. after the server started over), else every 30 minutes.
  const session = csrf.slice(0, 8);
  try {
    const [was, at] = (localStorage.getItem('gsa-push-sync') || '').split('|');
    if (was === session && Date.now() - Number(at) < 30 * 60 * 1000) return;
  } catch { /* no storage: sync */ }
  const bytes = (b64) => Uint8Array.from(atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const same = (a, b) => a && b && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === b[i]);
  (async () => {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) return; // reminders were never turned on (or were turned off) on this device
    const { key } = await (await fetch('/reminders/key', { credentials: 'same-origin' })).json();
    const serverKey = bytes(key);
    if (!same(sub.options && sub.options.applicationServerKey, serverKey)) {
      await sub.unsubscribe();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
    }
    const j = sub.toJSON();
    const res = await fetch('/reminders/subscribe', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, _csrf: csrf }),
    });
    if (res.ok) { try { localStorage.setItem('gsa-push-sync', `${session}|${Date.now()}`); } catch { /* no storage */ } }
  })().catch(() => {});
})();

// Charts: tapping or clicking a bar (or tabbing to it) shows its amount in a label just above it.
// Tapping it again, or anywhere else, hides it.
(function () {
  const charts = document.querySelectorAll('figure.chart');
  if (!charts.length) return;
  const hideAll = () => document.querySelectorAll('.chart-tip').forEach((tip) => {
    tip.hidden = true;
    tip.closest('.chart').querySelectorAll('.mark.active').forEach((m) => m.classList.remove('active'));
  });
  for (const fig of charts) {
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    tip.setAttribute('role', 'status');
    fig.append(tip);
    const show = (mark) => {
      hideAll();
      mark.classList.add('active');
      tip.textContent = mark.dataset.tip;
      tip.hidden = false;
      // Centred above the bar itself (or its tap area when the bar is zero), kept inside the chart.
      const box = (mark.querySelector('path') || mark.querySelector('.hit') || mark).getBoundingClientRect();
      const area = fig.getBoundingClientRect();
      const w = tip.offsetWidth;
      const left = Math.min(Math.max(box.left + box.width / 2 - area.left - w / 2, 0), Math.max(0, area.width - w));
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, box.top - area.top - tip.offsetHeight - 8)}px`;
    };
    fig.addEventListener('click', (e) => {
      const mark = e.target.closest('.mark');
      if (!mark) return;
      e.stopPropagation();
      if (mark.classList.contains('active')) hideAll(); else show(mark);
    });
    fig.addEventListener('keydown', (e) => {
      const mark = e.target.closest('.mark');
      if (mark && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); show(mark); }
      if (e.key === 'Escape') hideAll();
    });
  }
  document.addEventListener('click', hideAll);
  window.addEventListener('resize', hideAll);
})();

// New-password fields: tick each rule as it's met while typing, and a Show/Hide button. The server checks
// the same rules (and also refuses common passwords and the person's own name or email).
(function () {
  const RULES = {
    length: (pw, min) => pw.length >= min,
    upper: (pw) => /\p{Lu}/u.test(pw),
    lower: (pw) => /\p{Ll}/u.test(pw),
    number: (pw) => /\d/.test(pw),
    symbol: (pw) => /[^\p{L}\p{N}\s]/u.test(pw),
  };
  document.querySelectorAll('[data-password-rules]').forEach((box) => {
    const input = box.querySelector('[data-password]');
    const confirm = box.querySelector('[data-password-confirm]');
    const min = Number(input.dataset.min) || 8;
    const check = () => {
      const pw = input.value;
      let all = true;
      box.querySelectorAll('[data-rule]').forEach((li) => {
        const ok = RULES[li.dataset.rule](pw, min);
        li.classList.toggle('ok', ok);
        all = all && ok;
      });
      input.setCustomValidity(pw && !all ? box.querySelector('[data-rule]:not(.ok)').textContent : '');
      if (confirm) confirm.setCustomValidity(confirm.value && confirm.value !== pw ? (document.documentElement.lang === 'gu' ? 'બંને પાસવર્ડ સરખા નથી.' : 'Passwords do not match.') : '');
    };
    input.addEventListener('input', check);
    confirm?.addEventListener('input', check);
    const toggle = box.querySelector('[data-pw-toggle]');
    toggle?.addEventListener('click', () => {
      const show = input.type === 'password';
      for (const el of [input, confirm]) if (el) el.type = show ? 'text' : 'password';
      toggle.textContent = show ? toggle.dataset.hide : toggle.dataset.show;
      toggle.setAttribute('aria-pressed', String(show));
    });
  });
})();

// Committee: "Suggest one" for the shared door login — an everyday word and a number, easy to say out loud to
// volunteers (e.g. "mango47").
(function () {
  const button = document.querySelector('[data-suggest-password]');
  if (!button) return;
  const WORDS = ['Mango', 'Lotus', 'Peacock', 'Saffron', 'Tiger', 'River', 'Kite', 'Lantern', 'Jasmine', 'Monsoon', 'Coconut',
    'Banyan', 'Parrot', 'Marigold', 'Tabla', 'Sitar', 'Cardamom', 'Elephant', 'Rainbow', 'Sunrise', 'Pearl', 'Falcon'];
  const pick = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
  button.addEventListener('click', () => {
    const n = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 89);
    const input = document.querySelector('[data-door-password]');
    input.value = `${pick(WORDS).toLowerCase()}${n}`;
    input.focus();
  });
})();
