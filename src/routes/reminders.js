// Event reminders: a device turns them on (or off), and a member can send themselves a test.
const express = require('express');
const { requireAuth } = require('../middleware');
const reminders = require('../reminders');

const router = express.Router();

router.get('/reminders/key', (req, res) => res.json({ key: req.app.locals.vapidPublicKey }));

router.post('/reminders/subscribe', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  reminders.saveSubscription(db, req.user.id, req.body);
  // Already the day of an event? Its reminder goes out now rather than at the next check.
  reminders.sendDue(db).catch((err) => console.error('Reminders:', err.message));
  res.json({ ok: true });
});

// No sign-in needed: a signed-out phone can still stop its reminders.
router.post('/reminders/unsubscribe', (req, res) => {
  reminders.removeSubscription(req.app.locals.db, req.body.endpoint);
  res.json({ ok: true });
});

router.post('/reminders/test', requireAuth, async (req, res) => {
  const sent = await reminders.sendTest(req.app.locals.db, req.user.id, req.lang);
  res.json({ sent });
});

module.exports = router;
