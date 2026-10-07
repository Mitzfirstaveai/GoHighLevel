const express = require('express');
const { requireAuth } = require('../middleware');
const { markPaymentPaid } = require('../services');

const router = express.Router();

/**
 * Records money that arrived and applies it. If it can't be applied (dues beyond one year ahead —
 * e.g. a second browser tab paid too), the money is given back automatically; if that fails, the
 * payment is flagged for the committee to refund by hand. Returns markPaymentPaid's result.
 */
async function settlePayment(db, gateway, paymentId, opts) {
  const result = markPaymentPaid(db, paymentId, opts);
  if (result === 'refund') {
    const payment = db.prepare('SELECT provider_ref FROM payments WHERE id = ?').get(paymentId);
    if (!(await gateway.refund(payment.provider_ref))) {
      db.prepare(`UPDATE payments SET note = ? WHERE id = ?`)
        .run('REFUND NEEDED — dues were already paid one year ahead and the automatic refund did not go through. Please refund in Stripe.', paymentId);
      console.error(`Payment ${paymentId}: automatic refund failed`);
    }
  }
  return result;
}

const REFUNDED = 'Your membership was already paid one year ahead, so this payment was not applied. It has been refunded to your card.';

function redirectAfterPayment(db, payment) {
  if (payment.kind === 'event') return `/tickets/${payment.reference_id}`;
  if (payment.kind === 'membership' || payment.kind === 'membership_upgrade') return '/membership';
  return `/receipts/${payment.id}`;
}

router.get('/success', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  const verified = await gateway.verifyCheckoutSession(String(req.query.session_id || ''));
  if (!verified) {
    req.flash('info', 'We are still confirming your payment. Please refresh in a minute.');
    return res.redirect('/dashboard');
  }
  const result = await settlePayment(db, gateway, verified.paymentId, { method: 'stripe', providerRef: verified.providerRef });
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(verified.paymentId);
  if (!payment) return res.redirect('/payments');
  if (result === 'refund' || payment.refunded_at) req.flash('error', REFUNDED);
  else req.flash('success', 'Payment received — thank you!');
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

router.post('/:id/demo', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  if (gateway.mode !== 'demo') return res.sendStatus(404);
  const payment = ownPendingPayment(req);
  if (!payment || payment.status === 'cancelled') {
    req.flash('error', 'This checkout has expired. Please start again.');
    return res.redirect(payment?.kind?.startsWith('membership') ? '/membership' : '/dashboard');
  }
  const result = await settlePayment(db, gateway, payment.id, { method: 'demo', providerRef: `demo_${payment.id}` });
  if (result === 'refund') req.flash('error', REFUNDED);
  else req.flash('success', 'Payment received — thank you!');
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
module.exports.settlePayment = settlePayment;
