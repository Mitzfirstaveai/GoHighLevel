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
  const update = () => {
    const family = Number(form.party_size.value) || 1;
    const guests = form.guests ? Number(form.guests.value) || 0 : 0;
    const total = p.self + (family - 1) * p.member + guests * p.guest;
    out.textContent = total ? `Estimated total: ${fmt(total)}` + (form.coupon && form.coupon.value ? ' (before coupon)' : '') : 'Free';
  };
  form.addEventListener('change', update);
  form.addEventListener('input', update);
  update();
})();
