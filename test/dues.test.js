// Dues can be paid for next year, but never more than one year ahead (fees may change).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { renewalOpensOn } = require('../src/services');
const { today, addMonths } = require('../src/util');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = await t.login('admin@test.org', 'adminpass1');
});
after(() => t.close());

const userId = (email) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

async function pay(m, plan) {
  const res = await m.post('/membership/pay', { plan_id: String(t.planId(plan)) });
  const id = res.location?.match(/\/pay\/(\d+)\/demo/)?.[1];
  if (id) await m.post(`/pay/${id}/demo`);
  return res;
}

test('a member can pay for next year, but not the year after', async () => {
  const m = await t.register('dues@test.org', 'Dev');
  const year = new Date().getFullYear();
  await pay(m, 'Married Couple'); // joins: covers this year
  let res = await m.get('/membership');
  assert.match(res.text, /Renew for next year/);

  await pay(m, 'Married Couple'); // next year
  const until = t.db.prepare('SELECT MAX(end_date) AS d FROM memberships WHERE user_id = ?').get(userId('dues@test.org')).d;
  assert.equal(until, `${year + 1}-12-31`);

  res = await m.get('/membership');
  assert.doesNotMatch(res.text, /Renew for next year/);
  assert.match(res.text, /Dues can be paid at most one year ahead/);
  assert.match(res.text, new RegExp(`Renewal opens on Jan 1, ${year + 1}`));

  const payments = () => t.db.prepare('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?').get(userId('dues@test.org')).n;
  const before = payments();
  res = await m.follow(await m.post('/membership/pay', { plan_id: String(t.planId('Married Couple')) }));
  assert.match(res.text, new RegExp(`already paid through Dec 31, ${year + 1}`));
  assert.equal(payments(), before);

  // The committee can't record dues that far ahead either.
  res = await admin.follow(await admin.post(`/admin/members/${userId('dues@test.org')}/payments`, {
    kind: 'membership', plan_id: String(t.planId('Married Couple')), method: 'cash',
  }));
  assert.match(res.text, /Dues can be paid at most one year ahead/);
  assert.equal(payments(), before);
});

test('upgrading the current level is still allowed after paying ahead', async () => {
  const m = await t.login('dues@test.org', 'secret123');
  const res = await m.get('/membership');
  assert.match(res.text, /Upgrade — pay/);
});

test('renewal opens exactly when the paid-up date is a year away', () => {
  const id = Number(t.db.prepare(`INSERT INTO users (email, first_name, last_name) VALUES ('edge@test.org', 'E', 'Dge')`).run().lastInsertRowid);
  const add = (end) => t.db.prepare(`INSERT INTO memberships (user_id, plan_id, start_date, end_date) VALUES (?, ?, ?, ?)`)
    .run(id, t.planId('Married Couple'), today(), end);
  add(addMonths(today(), 12));
  assert.equal(renewalOpensOn(t.db, id), null); // paid up exactly a year out: can still renew
  t.db.prepare('UPDATE memberships SET end_date = ? WHERE user_id = ?').run('2999-12-31', id);
  assert.equal(renewalOpensOn(t.db, id), '2999-01-01');
});

test('two payment screens open at once: starting the second closes the first', async () => {
  const m = await t.register('twotabs@test.org', 'Tara');
  const year = new Date().getFullYear();
  await pay(m, 'Married Couple'); // this year
  const tabB = await t.login('twotabs@test.org', 'secret123');
  const a = await m.post('/membership/pay', { plan_id: String(t.planId('Married Couple')) });
  const b = await tabB.post('/membership/pay', { plan_id: String(t.planId('Married Couple')) });
  const [idA, idB] = [a, b].map((r) => Number(r.location.match(/\/pay\/(\d+)\/demo/)[1]));
  assert.equal(t.db.prepare('SELECT status FROM payments WHERE id = ?').get(idA).status, 'cancelled');

  let res = await tabB.follow(await tabB.post(`/pay/${idB}/demo`));
  assert.match(res.text, /Payment received/);
  res = await m.follow(await m.post(`/pay/${idA}/demo`));
  assert.match(res.text, /This checkout has expired/);
  const until = t.db.prepare('SELECT MAX(end_date) AS d FROM memberships WHERE user_id = ?').get(userId('twotabs@test.org')).d;
  assert.equal(until, `${year + 1}-12-31`); // one year ahead, not two
});

test('if two dues payments still both go through, the second is refunded, not applied', async () => {
  const svc = require('../src/services');
  const m = await t.register('race@test.org', 'Ravi');
  const year = new Date().getFullYear();
  await pay(m, 'Married Couple'); // this year
  // Two checkouts that were both already open when the money arrived (simulated directly).
  const plan = t.planId('Married Couple');
  const mk = () => svc.createPayment(t.db, { userId: userId('race@test.org'), kind: 'membership', referenceId: plan, amountCents: 27500, description: 'Membership — Married Couple' }).id;
  const [first, second] = [mk(), mk()];
  let res = await m.follow(await m.post(`/pay/${first}/demo`));
  assert.match(res.text, /Payment received/);
  res = await m.follow(await m.post(`/pay/${second}/demo`));
  assert.match(res.text, /already paid one year ahead, so this payment was not applied\. It has been refunded/);
  const p = t.db.prepare('SELECT * FROM payments WHERE id = ?').get(second);
  assert.equal(p.status, 'cancelled');
  assert.ok(p.refunded_at);
  assert.equal(t.db.prepare('SELECT MAX(end_date) AS d FROM memberships WHERE user_id = ?').get(userId('race@test.org')).d, `${year + 1}-12-31`);
  // Paying it again (e.g. a Stripe webhook arriving later) does nothing more.
  assert.equal(svc.markPaymentPaid(t.db, second, { method: 'demo' }), false);
  // Not counted as income; listed for the committee.
  res = await admin.get('/admin/payments');
  assert.match(res.text, /Refunded — not applied/);
  assert.match(res.text, /Ravi Member/);
});

test('a duplicate upgrade is refunded, and a failed automatic refund is flagged for the committee', async () => {
  const svc = require('../src/services');
  const { settlePayment } = require('../src/routes/pay');
  const m = await t.register('upgrade2@test.org', 'Uma');
  await pay(m, 'Married Couple');
  const uid = userId('upgrade2@test.org');
  const mk = () => svc.createPayment(t.db, { userId: uid, kind: 'membership_upgrade', referenceId: t.planId('Family'), amountCents: 5500, description: 'Membership upgrade — Family' }).id;
  const [first, second] = [mk(), mk()];
  const failingGateway = { refund: async () => false };
  assert.equal(await settlePayment(t.db, failingGateway, first, { method: 'stripe', providerRef: 'pi_1' }), 'applied');
  assert.equal(await settlePayment(t.db, failingGateway, second, { method: 'stripe', providerRef: 'pi_2' }), 'refund');
  assert.match(t.db.prepare('SELECT note FROM payments WHERE id = ?').get(second).note, /^REFUND NEEDED/);
  assert.match((await admin.get('/admin')).text, /1 payment needs a refund by hand/);
  assert.match((await admin.get('/admin/payments')).text, /Refund by hand in Stripe/);

  // A member can't fake that alert with their own donation note.
  await m.post('/donate', { amount: '500', note: 'REFUND NEEDED — please refund me $500' }); // amounts are in cents
  const donation = t.db.prepare(`SELECT id, note FROM payments WHERE kind = 'donation' AND user_id = ? ORDER BY id DESC LIMIT 1`).get(uid);
  assert.match(donation.note, /^REFUND NEEDED/);
  assert.equal(svc.markPaymentPaid(t.db, donation.id, { method: 'demo' }), 'applied');
  assert.match((await admin.get('/admin')).text, /1 payment needs a refund by hand/);
});
