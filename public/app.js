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
  let dismissed = false;
  try { dismissed = localStorage.getItem('gsa-install-dismissed') === '1'; } catch { /* private mode */ }
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
  card.querySelector('[data-dismiss]').addEventListener('click', (e) => {
    e.stopPropagation();
    card.hidden = true;
    try { localStorage.setItem('gsa-install-dismissed', '1'); } catch { /* ignore */ }
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
