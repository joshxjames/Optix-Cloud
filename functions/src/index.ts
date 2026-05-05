// Cloud Functions entry — re-exports every function so Firebase's deploy
// can find them. Adding a new function = importing it here.
//
// Layout:
//   - relay                  : HTTPS — the Anthropic streaming proxy
//   - onUserCreate           : Auth trigger — seeds Firestore profile on signup
//   - createCheckoutSession  : HTTPS — desktop client → Stripe Checkout URL
//   - stripeWebhook          : HTTPS — Stripe → subscription state in Firestore
//   - submitFeedback         : HTTPS — desktop client → email via SMTP

export { relay } from './relay.js';
export { onUserCreate, onUserDelete } from './user-trigger.js';
export {
  createCheckoutSession,
  createPortalSession,
  stripeWebhook,
  updateSubscription,
} from './stripe.js';
export { submitFeedback } from './submitFeedback.js';
