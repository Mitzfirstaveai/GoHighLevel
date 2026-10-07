// Payment gateway: Stripe Checkout when STRIPE_SECRET_KEY is set, otherwise a demo
// checkout (for trying the app locally) when ALLOW_DEMO_PAYMENTS is enabled.
const Stripe = require('stripe');

// Checkout pages close after about half an hour, so an old browser tab can't be paid later.
// Stripe's minimum is 30 minutes after creation; one extra minute covers request time and clock drift.
const CHECKOUT_MINUTES = 31;

/**
 * `onSession(paymentId, sessionId)` is called when a Stripe checkout page is created, so the app
 * can remember it (and close it again if the member starts a newer checkout).
 */
function createGateway(config, { onSession } = {}) {
  const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;
  const mode = stripe ? 'stripe' : config.allowDemoPayments ? 'demo' : 'disabled';

  async function startCheckout(payment, user) {
    if (mode === 'demo') return `/pay/${payment.id}/demo`;
    if (mode !== 'stripe') return null;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: user.email,
      client_reference_id: String(payment.id),
      metadata: { payment_id: String(payment.id) },
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: config.currency,
          unit_amount: payment.amount_cents,
          product_data: { name: payment.description },
        },
      }],
      success_url: `${config.baseUrl}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.baseUrl}/pay/${payment.id}/cancelled`,
    });
    onSession?.(payment.id, session.id);
    return session.url;
  }

  // Returns { paymentId, providerRef } if the checkout session has been paid.
  async function verifyCheckoutSession(sessionId) {
    if (mode !== 'stripe') return null;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') return null;
    return { paymentId: Number(session.metadata.payment_id), providerRef: session.payment_intent || session.id };
  }

  // Closes checkout pages that were replaced by a newer one (already closed/paid ones are skipped).
  async function expireCheckouts(sessionIds) {
    if (mode !== 'stripe') return;
    for (const id of sessionIds.filter((s) => s?.startsWith('cs_'))) {
      await stripe.checkout.sessions.expire(id).catch(() => {});
    }
  }

  // Gives the money back for a payment the app couldn't accept. Returns true if refunded.
  async function refund(providerRef) {
    if (mode !== 'stripe' || !providerRef?.startsWith('pi_')) return mode === 'demo';
    try {
      await stripe.refunds.create({ payment_intent: providerRef });
      return true;
    } catch (err) {
      return err?.code === 'charge_already_refunded';
    }
  }

  function parseWebhook(rawBody, signature) {
    if (mode !== 'stripe' || !config.stripeWebhookSecret) return null;
    return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  }

  return { mode, startCheckout, verifyCheckoutSession, expireCheckouts, refund, parseWebhook };
}

module.exports = { createGateway };
