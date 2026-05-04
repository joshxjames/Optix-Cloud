// Auth triggers — keep the Firestore `users/{uid}` doc in sync with the
// Firebase Auth user lifecycle.
//
//   onCreate: seed the doc with default subscription state on signup.
//   onDelete: tear down the doc + cancel any active Stripe subscription
//             when the user deletes their account, so we don't keep
//             billing a phantom user or leak orphaned billing state.
//
// The Gen 1 auth trigger API (`functions/v1/auth`) is still the simplest
// route for both — Gen 2 "blocking functions" via Identity Platform are
// available if we later need to enforce signup criteria, but blocking
// functions don't replace `onDelete` (which is a post-event trigger).

import { auth as authV1, runWith } from 'firebase-functions/v1';
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import Stripe from 'stripe';
import { db } from './admin.js';
import { STRIPE_SECRET_KEY } from './secrets.js';

export const onUserCreate = authV1.user().onCreate(async (user) => {
  const uid = user.uid;
  // Idempotency safety: if the doc somehow already exists (manual
  // creation during testing, retried trigger), don't clobber subscription
  // state that may have been set by other paths.
  const existing = await db.doc(`users/${uid}`).get();
  if (existing.exists) return;

  await db.doc(`users/${uid}`).set({
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    createdAt: FieldValue.serverTimestamp(),
    // Subscription defaults — the user starts on no plan. Stripe webhook
    // flips these to `active` once they pay. The relay rejects requests
    // when status !== 'active'.
    subscriptionStatus: 'none',
    // Field name matches what the webhook writes (`tier`) so the seed
    // and the eventual update agree on a single key. Previously this
    // was `subscriptionTier`, which left a vestigial null after the
    // webhook wrote `tier` separately.
    tier: null,
    currentPeriodEnd: null,
    stripeCustomerId: null,
    // Hard monthly token cap (set per-tier when subscription activates).
    // 0 = no allowance; the relay denies non-active subscriptions AND
    // any subscription with cap <= 0, so the seed value matches the
    // closed-by-default invariant.
    tokenAllowanceMonthly: 0,
  });
});

/**
 * onDelete — when the user deletes their Firebase Auth account, clean up
 * the artefacts they left behind:
 *
 *   1. Cancel any active Stripe subscription IMMEDIATELY (not at period
 *      end) — they've explicitly walked away, we shouldn't keep billing.
 *   2. Delete the `users/{uid}` Firestore doc + its `usage/{yyyymm}`
 *      subcollection so we're not retaining personal data after the
 *      user has signed out for good.
 *
 * Without this, deleting an Auth user leaves a "zombie" Firestore profile
 * that keeps accruing webhooks (renewals charge the saved card, the relay
 * never gets called because the user can't sign in, but Stripe keeps
 * billing). This trigger ensures the Auth lifecycle and the billing
 * lifecycle stay in lockstep.
 */
export const onUserDelete = runWith({ secrets: [STRIPE_SECRET_KEY] })
  .auth.user()
  .onDelete(async (user) => {
    const uid = user.uid;
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const userData = userSnap.data();

    // Best-effort Stripe cancellation. If the user never subscribed
    // there's nothing to cancel; if the cancel fails (Stripe down,
    // subscription already deleted) we still want to remove the
    // Firestore data, so failures here are logged but non-fatal.
    const subscriptionId = userData?.stripeSubscriptionId as
      | string
      | undefined;
    if (subscriptionId) {
      try {
        const stripe = new Stripe(STRIPE_SECRET_KEY.value(), {
          apiVersion: '2026-04-22.dahlia',
        });
        // `subscriptions.cancel` ends the subscription immediately
        // (no proration). We chose immediate cancel rather than
        // `cancel_at_period_end: true` because the Auth user is gone —
        // there's no one to grant access to until period end anyway.
        await stripe.subscriptions.cancel(subscriptionId);
        logger.info('onUserDelete cancelled Stripe subscription', {
          uid,
          subscriptionId,
        });
      } catch (err) {
        logger.warn('onUserDelete Stripe cancel failed (continuing)', {
          uid,
          subscriptionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Delete the usage subcollection one doc at a time. Volumes are
    // tiny (one doc per month per user); a recursive delete via the
    // Admin SDK's `firestore.recursiveDelete` would also work but
    // requires `firebase-tools`-style auth — the manual loop is enough.
    try {
      const usageDocs = await userRef.collection('usage').listDocuments();
      await Promise.all(usageDocs.map((doc) => doc.delete()));
    } catch (err) {
      logger.warn('onUserDelete usage cleanup failed (continuing)', {
        uid,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Finally, drop the profile doc.
    try {
      await userRef.delete();
      logger.info('onUserDelete cleaned up profile', { uid });
    } catch (err) {
      logger.error('onUserDelete profile delete failed', {
        uid,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
