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
    const family = Number(form.party_size.value) || 1;
    const guests = form.guests ? Number(form.guests.value) || 0 : 0;
    const total = p.self + (family - 1) * p.member + guests * p.guest;
    out.textContent = total
      ? L.estimate.replace('{amount}', fmt(total)) + (form.coupon && form.coupon.value ? ` ${L.beforeCoupon}` : '')
      : L.free;
  };
  form.addEventListener('change', update);
  form.addEventListener('input', update);
  update();
})();
