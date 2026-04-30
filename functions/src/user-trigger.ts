// Auth trigger — when a new Firebase Auth user is created (email magic
// link, OAuth, etc.) we immediately seed their Firestore profile doc
// with default subscription state. This is the only place a `users/{uid}`
// document gets created; clients can never write it directly.
//
// The Gen 1 auth trigger (`functions/v1/auth`) is still the simplest API
// for this. Gen 2 "blocking functions" via Identity Platform are an option
// later if we want to enforce signup criteria (e.g. email allow-list)
// before the account is even created.

import { auth as authV1 } from 'firebase-functions/v1';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin.js';

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
    subscriptionTier: null,
    subscriptionCurrentPeriodEnd: null,
    stripeCustomerId: null,
    // Hard monthly token cap (set per-tier when subscription activates).
    // 0 = unlimited; we never use 0 in practice — a finite cap is the
    // backstop against runaway costs from a leaked token.
    tokenAllowanceMonthly: 0,
  });
});
