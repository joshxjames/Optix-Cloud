// Centralised secret declarations for Cloud Functions.
//
// In Firebase Functions Gen 2, secrets are declared via `defineSecret` and
// attached to a function via the `secrets:` option. The actual value is
// pulled from Google Secret Manager at runtime, never committed to the repo.
//
// To set a secret value (one-time, per-environment):
//   firebase functions:secrets:set ANTHROPIC_API_KEY
//
// For local emulator development, set the value in `functions/.env.local`
// (gitignored) — the emulator reads it at boot.

import { defineSecret } from 'firebase-functions/params';

/** The Anthropic API key the relay attaches to every forwarded request.
 *  Keep this scoped to the lowest-privilege key Anthropic offers; the
 *  relay only calls `/v1/messages`. */
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

/** Stripe secret API key. The mode (`sk_test_...` vs `sk_live_...`) is
 *  inferred from the value's prefix at request time, which selects the
 *  matching price-ID catalog inside `stripe.ts`. Swapping test → live
 *  is a single secret rotation, no code change. */
export const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

/** Stripe webhook signing secret. Stripe gives a separate `whsec_...`
 *  per registered webhook endpoint AND per mode (test/live), so when
 *  flipping modes you need to re-register the endpoint and rotate this
 *  secret too. */
export const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

/** SMTP password for the Rackspace mailbox the support form sends from
 *  (`admin@covetable.com.au`). Used by `submitFeedback.ts` via
 *  nodemailer to deliver in-app feedback messages. */
export const SMTP_PASSWORD = defineSecret('SMTP_PASSWORD');
