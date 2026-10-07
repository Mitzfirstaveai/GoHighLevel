const express = require('express');
const { markPaymentPaid } = require('../services');

const router = express.Router();

router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const { gateway, db } = req.app.locals;
  let event;
  try {
    event = gateway.parseWebhook(req.body, req.get('stripe-signature'));
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (!event) return res.status(404).send('Webhooks not configured');

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const paymentId = Number(session.metadata?.payment_id);
    if (paymentId && session.payment_status === 'paid') {
      markPaymentPaid(db, paymentId, { method: 'stripe', providerRef: session.payment_intent || session.id });
    }
  }
  res.json({ received: true });
});

module.exports = router;
