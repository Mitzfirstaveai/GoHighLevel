// Small progressive enhancements for forms (the forms work without this script).
(function () {
  // Checkbox with data-toggle="id": show that section only while checked.
  document.querySelectorAll('[data-toggle]').forEach((box) => {
    const target = document.getElementById(box.dataset.toggle);
    const sync = () => { target.hidden = !box.checked; };
    box.addEventListener('change', sync);
    sync();
  });

  // RSVP price estimate: each person and guest field carries its own price (data-cents).
  const form = document.querySelector('form[data-price]');
  if (!form) return;
  const out = form.querySelector('[data-estimate]');
  if (!out) return; // free events show no price line
  const fmt = (c) => '$' + (c / 100).toFixed(2);
  // Labels come from the page so they're in the reader's language.
  const L = JSON.parse(form.dataset.labels || '{}');
  const update = () => {
    // Each ticked person has their own price (member, non-member, or free for young children);
    // a non-member coming themselves may have picked student / out-of-state; guests are priced by kind.
    const selfChoice = form.querySelector('input[name="self_type"]:checked');
    const family = [...form.querySelectorAll('input[name="people"]:checked')]
      .reduce((sum, box) => sum + Number(box.dataset.self && selfChoice ? selfChoice.dataset.cents : box.dataset.cents || 0), 0);
    const guests = [...form.querySelectorAll('select[name^="guests_"]')]
      .reduce((sum, sel) => sum + (Number(sel.value) || 0) * Number(sel.dataset.cents || 0), 0);
    const total = family + guests;
    out.textContent = total
      ? L.estimate.replace('{amount}', fmt(total)) + (form.coupon && form.coupon.value ? ` ${L.beforeCoupon}` : '')
      : L.free;
    // Money already paid for this event (it's non-refundable, so it counts toward the new total).
    const paid = Number(form.dataset.paid || 0);
    if (paid && total && L.paid) {
      const line = (text, cls) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; out.append(document.createElement('br'), s); };
      line(L.paid.replace('{amount}', fmt(paid)), 'muted small');
      line(total > paid ? L.due.replace('{amount}', fmt(total - paid)) : L.nothingDue, 'estimate-due');
    }
  };
  form.addEventListener('change', update);
  form.addEventListener('input', update);
  update();
})();

// Paid events: the RSVP button says "RSVP & Pay" when paying online, just "RSVP" when paying at the door.
(function () {
  const button = document.querySelector('button[data-label-online]');
  if (!button) return;
  const sync = () => {
    const choice = button.form.querySelector('input[name="pay"]:checked');
    button.textContent = choice && choice.value === 'door' ? button.dataset.labelDoor : button.dataset.labelOnline;
  };
  button.form.querySelectorAll('input[name="pay"]').forEach((r) => r.addEventListener('change', sync));
  sync();
})();
