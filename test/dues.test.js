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
