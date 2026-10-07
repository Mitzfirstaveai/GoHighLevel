const express = require('express');
const { requireAuth } = require('../middleware');
const { markPaymentPaid } = require('../services');

const router = express.Router();

function redirectAfterPayment(db, payment) {
  if (payment.kind === 'event') return `/tickets/${payment.reference_id}`;
  if (payment.kind === 'membership' || payment.kind === 'membership_upgrade') return '/membership';
  return '/payments';
}

router.get('/success', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  const verified = await gateway.verifyCheckoutSession(String(req.query.session_id || ''));
  if (!verified) {
    req.flash('info', 'We are still confirming your payment. Please refresh in a minute.');
    return res.redirect('/dashboard');
  }
  markPaymentPaid(db, verified.paymentId, { method: 'stripe', providerRef: verified.providerRef });
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(verified.paymentId);
  req.flash('success', 'Payment received — thank you!');
  res.redirect(redirectAfterPayment(db, payment));
});

function ownPendingPayment(req) {
  return req.app.locals.db.prepare(`SELECT * FROM payments WHERE id = ? AND user_id = ?`)
    .get(req.params.id, req.user.id);
}

router.get('/:id/demo', requireAuth, (req, res) => {
  if (req.app.locals.gateway.mode !== 'demo') return res.sendStatus(404);
  const payment = ownPendingPayment(req);
  if (!payment) return res.sendStatus(404);
  if (payment.status === 'paid') return res.redirect(redirectAfterPayment(req.app.locals.db, payment));
  res.render('payments/demo', { title: 'Checkout', payment });
});

router.post('/:id/demo', requireAuth, (req, res) => {
  const { db, gateway } = req.app.locals;
  if (gateway.mode !== 'demo') return res.sendStatus(404);
  const payment = ownPendingPayment(req);
  if (!payment || payment.status === 'cancelled') {
    req.flash('error', 'This checkout has expired. Please start again.');
    return res.redirect('/dashboard');
  }
  markPaymentPaid(db, payment.id, { method: 'demo', providerRef: `demo_${payment.id}` });
  req.flash('success', 'Payment received — thank you!');
  res.redirect(redirectAfterPayment(db, payment));
});

router.get('/:id/cancelled', requireAuth, (req, res) => {
  const payment = ownPendingPayment(req);
  req.flash('info', 'Payment was cancelled. You can try again any time.');
  if (payment?.kind === 'event') {
    const rsvp = req.app.locals.db.prepare('SELECT event_id FROM rsvps WHERE id = ?').get(payment.reference_id);
    if (rsvp) return res.redirect(`/events/${rsvp.event_id}`);
  }
  res.redirect(payment?.kind?.startsWith('membership') ? '/membership' : '/dashboard');
});

module.exports = router;
