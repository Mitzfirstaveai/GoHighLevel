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
      const wrap = table.parentElement;
      if (table.scrollWidth > wrap.clientWidth + 1) table.classList.add('stack');
    }
  };
  fit();
  // Measure again once the fonts and images have loaded (they change the table's width).
  window.addEventListener('load', fit);
  if (document.fonts) document.fonts.ready.then(fit);
  let timer;
  window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(fit, 150); });
})();
