// Payment gateway: Stripe Checkout when STRIPE_SECRET_KEY is set, otherwise a demo
// checkout (for trying the app locally) when ALLOW_DEMO_PAYMENTS is enabled.
const Stripe = require('stripe');

function createGateway(config) {
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
    return session.url;
  }

  // Returns { paymentId, providerRef } if the checkout session has been paid.
  async function verifyCheckoutSession(sessionId) {
    if (mode !== 'stripe') return null;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') return null;
    return { paymentId: Number(session.metadata.payment_id), providerRef: session.payment_intent || session.id };
  }

  function parseWebhook(rawBody, signature) {
    if (mode !== 'stripe' || !config.stripeWebhookSecret) return null;
    return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  }

  return { mode, startCheckout, verifyCheckoutSession, parseWebhook };
}

module.exports = { createGateway };
