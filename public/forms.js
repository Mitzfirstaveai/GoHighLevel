// Small progressive enhancements for forms (the forms work without this script).
(function () {
  // Checkbox with data-toggle="id": show that section only while checked.
  document.querySelectorAll('[data-toggle]').forEach((box) => {
    const target = document.getElementById(box.dataset.toggle);
    const sync = () => { target.hidden = !box.checked; };
    box.addEventListener('change', sync);
    sync();
  });

  // RSVP price estimate: form[data-price] carries the event's prices in cents.
  const form = document.querySelector('form[data-price]');
  if (!form) return;
  const p = JSON.parse(form.dataset.price);
  const out = form.querySelector('[data-estimate]');
  if (!out) return; // free events show no price line
  const fmt = (c) => '$' + (c / 100).toFixed(2);
  // Labels come from the page so they're in the reader's language.
  const L = JSON.parse(form.dataset.labels || '{}');
  const update = () => {
    // Each ticked family member pays the member price if the membership covers them, else the guest price.
    const ticked = [...form.querySelectorAll('input[name="people"]:checked')];
    const family = ticked.reduce((sum, box) => sum + (box.dataset.rate === 'member' ? p.member : p.nonmember), 0);
    const guests = form.guests ? Number(form.guests.value) || 0 : 0;
    const total = family + guests * p.guest;
    out.textContent = total
      ? L.estimate.replace('{amount}', fmt(total)) + (form.coupon && form.coupon.value ? ` ${L.beforeCoupon}` : '')
      : L.free;
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
