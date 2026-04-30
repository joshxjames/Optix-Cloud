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

/** Stripe webhook signing secret. Used to verify the authenticity of
 *  subscription-state events before mutating user records. Wired up
 *  later when Stripe lands. */
export const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
