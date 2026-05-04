// Stripe billing — Checkout session creator + webhook listener.
//
// Two endpoints live here:
//
//   POST /createCheckoutSession   — desktop client → relay
//     Verifies the user's Firebase ID token, looks up (or creates) a
//     Stripe customer for them, opens a Checkout session for the
//     requested tier, and returns the hosted-checkout URL. The desktop
//     client opens that URL in the user's default browser; the loopback
//     server catches the post-payment redirect and brings the widget
//     back to focus.
//
//   POST /stripeWebhook           — Stripe → relay
//     Receives subscription lifecycle events from Stripe (signed with
//     a webhook secret). Translates them into Firestore updates on the
//     `users/{uid}` document so the relay's per-request auth check sees
//     the right `subscriptionStatus` + `tokenAllowanceMonthly`.
//
// Test/live mode is decided per-request from the Stripe secret key's
// prefix (sk_test_ vs sk_live_). The catalogue of Stripe price IDs is
// hard-coded for both modes so you swap a single secret to flip the
// product environment.

import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
// Stripe's TypeScript types are split: the ESM .d.ts has the class +
// namespace declaration-merge that lets `Stripe.Event`, `Stripe.Subscription`
// etc. resolve as types, but the CJS .d.ts is a stripped-down constructor
// shim. Adding `"type": "module"` to `functions/package.json` puts us in
// ESM mode, which makes the default import work the canonical way.
import Stripe from 'stripe';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { auth, db } from './admin.js';
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } from './secrets.js';

type Tier = 'starter' | 'pro';

/** Stripe price IDs — hand-rolled for test and live mode separately.
 *  Swap the matching secret key (sk_test_ ↔ sk_live_) and the right
 *  catalog is picked automatically; no code change. */
const PRICE_IDS_TEST: Record<Tier, string> = {
  starter: 'price_1TSsx6H7liiNjDfW3E3pY1Cr',
  pro: 'price_1TSsxKH7liiNjDfWXB1yXqFQ',
};
const PRICE_IDS_LIVE: Record<Tier, string> = {
  starter: 'price_1TSsicH7liiNjDfWUoKm87tI',
  pro: 'price_1TSsiwH7liiNjDfW4R3oWk3V',
};

/** Monthly token cap per tier. Enforced by `relay.ts` on every request:
 *  once the user's running total for the month exceeds this, the relay
 *  returns 429 until the next billing cycle.
 *
 *  Picked from the cost-report data — Starter covers ~85 average Opus
 *  runs/month, Pro ~250. Heavy P99 users still get cut off before the
 *  margin goes underwater. Tunable: just edit and redeploy. */
const TOKEN_ALLOWANCE_MONTHLY: Record<Tier, number> = {
  starter: 5_000_000,
  pro: 15_000_000,
};

function getStripe(): Stripe {
  return new Stripe(STRIPE_SECRET_KEY.value(), {
    // Pin the API version so behavioural changes in newer Stripe APIs
    // can't surprise us mid-deploy. Bump explicitly when we want them.
    apiVersion: '2026-04-22.dahlia',
  });
}

function getPriceIds(): Record<Tier, string> {
  const key = STRIPE_SECRET_KEY.value();
  return key.startsWith('sk_test_') ? PRICE_IDS_TEST : PRICE_IDS_LIVE;
}

// ---------------------------------------------------------------------------
// /createCheckoutSession
// ---------------------------------------------------------------------------

export const createCheckoutSession = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: [STRIPE_SECRET_KEY],
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    // ---- Auth (same Bearer-token pattern the relay uses) -----------
    const header = req.header('authorization') ?? '';
    if (!header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing_bearer_token' });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    let uid: string;
    try {
      const decoded = await auth.verifyIdToken(token);
      uid = decoded.uid;
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    // ---- Body validation -------------------------------------------
    const { tier, successUrl, cancelUrl } = (req.body ?? {}) as {
      tier?: unknown;
      successUrl?: unknown;
      cancelUrl?: unknown;
    };
    if (tier !== 'starter' && tier !== 'pro') {
      res.status(400).json({ error: 'invalid_tier' });
      return;
    }
    if (typeof successUrl !== 'string' || typeof cancelUrl !== 'string') {
      res.status(400).json({ error: 'missing_return_urls' });
      return;
    }
    // Lock return URLs to known-safe destinations. Without this the
    // endpoint would let any signed-in user redirect Stripe traffic
    // wherever they wanted — open-redirect by way of our backend.
    if (!isAllowedReturnUrl(successUrl) || !isAllowedReturnUrl(cancelUrl)) {
      res.status(400).json({ error: 'invalid_return_url' });
      return;
    }

    const stripe = getStripe();

    // ---- Find or create the Stripe customer for this Firebase user
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const userData = userSnap.data() ?? {};
    let stripeCustomerId = userData.stripeCustomerId as string | undefined;

    if (!stripeCustomerId) {
      const userRecord = await auth.getUser(uid);
      const customer = await stripe.customers.create({
        // Echoing uid in metadata makes it easy to look up customers
        // from the Stripe dashboard later, and gives us a fallback
        // mapping if a webhook arrives before we have a chance to
        // persist the customer id.
        metadata: { uid },
        email: userRecord.email ?? undefined,
      });
      stripeCustomerId = customer.id;
      await userRef.set({ stripeCustomerId }, { merge: true });
    }

    // ---- Create the Checkout session -------------------------------
    const priceId = getPriceIds()[tier];
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Stamp the tier on both the Checkout session AND the resulting
      // Subscription so the webhook can map events to tiers without
      // reverse-mapping price IDs. Every event we care about hangs off
      // a Subscription which carries this metadata for its lifetime.
      metadata: { uid, tier },
      subscription_data: { metadata: { uid, tier } },
      // Allow the user to enter promo codes if we ever issue any.
      allow_promotion_codes: true,
    });

    if (!session.url) {
      logger.error('checkout.sessions.create returned no url', { uid, tier });
      res.status(500).json({ error: 'checkout_session_no_url' });
      return;
    }
    res.status(200).json({ checkoutUrl: session.url });
  },
);

// ---------------------------------------------------------------------------
// /createPortalSession
// ---------------------------------------------------------------------------
//
// Opens a Stripe Billing Portal session for the calling user. The
// portal is Stripe-hosted UI that handles:
//   - updating the saved payment method
//   - viewing past invoices + receipts
//   - cancelling / reactivating the subscription (UI duplicates our
//     in-widget controls, but harmless — both paths fire the same
//     webhook events that update Firestore)
//
// Building this in-widget would require PCI compliance work for the
// card form; offloading to Stripe's hosted page sidesteps that
// entirely. The desktop client opens the returned URL via
// `shell.openExternal`; when the user is done in the portal they just
// close the tab — any changes propagate back via webhooks.
//
// Prerequisites: Customer Portal must be CONFIGURED in the Stripe
// Dashboard (Settings → Billing → Customer Portal) — at minimum the
// default settings need a save, and ideally the "Cancel subscription"
// + "Update payment method" features should be turned on. Without
// configuration `billingPortal.sessions.create` returns 400.

export const createPortalSession = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: [STRIPE_SECRET_KEY],
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    // ---- Auth -------------------------------------------------------
    const header = req.header('authorization') ?? '';
    if (!header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing_bearer_token' });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    let uid: string;
    try {
      const decoded = await auth.verifyIdToken(token);
      uid = decoded.uid;
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    // ---- Look up the user's Stripe customer -----------------------
    const userSnap = await db.doc(`users/${uid}`).get();
    const stripeCustomerId = userSnap.data()?.stripeCustomerId as string | undefined;
    if (!stripeCustomerId) {
      // No customer = never went through Checkout. Sending them to the
      // portal would 400 from Stripe; we surface a cleaner error so
      // the renderer can tell the user to subscribe first.
      res.status(404).json({ error: 'no_stripe_customer' });
      return;
    }

    // ---- Optional return URL --------------------------------------
    // If the renderer supplies a return_url it must be on the same
    // safelist as Checkout's success/cancel URLs. Without one Stripe
    // shows a "Return to merchant" button that does nothing — fine
    // because the desktop user just closes the tab.
    const returnUrl = (req.body ?? {}).returnUrl;
    if (returnUrl !== undefined) {
      if (typeof returnUrl !== 'string' || !isAllowedReturnUrl(returnUrl)) {
        res.status(400).json({ error: 'invalid_return_url' });
        return;
      }
    }

    const stripe = getStripe();
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        ...(typeof returnUrl === 'string' ? { return_url: returnUrl } : {}),
      });
      res.status(200).json({ portalUrl: session.url });
    } catch (err) {
      // Most common failure mode: portal not configured in dashboard.
      // We log the underlying error server-side and surface a generic
      // message so a leaked Stripe error string doesn't end up in a
      // user-facing toast.
      logger.error('billingPortal.sessions.create failed', {
        uid,
        err: String(err),
      });
      res.status(500).json({ error: 'portal_unavailable' });
    }
  },
);

// ---------------------------------------------------------------------------
// /updateSubscription
// ---------------------------------------------------------------------------
//
// Single endpoint that handles every post-checkout subscription mutation
// the desktop client can trigger:
//   { action: 'switchPlan', tier }  — change tier mid-cycle (Stripe
//                                     prorates automatically)
//   { action: 'cancel' }            — schedule cancellation at period end
//   { action: 'reactivate' }        — undo a scheduled cancellation
//
// All three are idempotent updates against the user's existing
// Subscription, so they share auth / lookup / response shape. Stripe
// fires `customer.subscription.updated` after each, which our webhook
// handler reflects to Firestore — the renderer's onSnapshot listener
// picks up the change without polling.

export const updateSubscription = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: [STRIPE_SECRET_KEY],
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    // Auth — same Bearer pattern as createCheckoutSession + relay.
    const header = req.header('authorization') ?? '';
    if (!header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing_bearer_token' });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    let uid: string;
    try {
      const decoded = await auth.verifyIdToken(token);
      uid = decoded.uid;
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action;

    // Pull the user's current subscription id from their profile doc —
    // this is the trust boundary: the user can only mutate the sub
    // we put on their own doc when Checkout finished, never an
    // arbitrary Stripe sub id they pass in.
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    const userData = userSnap.data() ?? {};
    const subscriptionId = userData.stripeSubscriptionId as string | undefined;
    if (!subscriptionId) {
      res.status(404).json({ error: 'no_active_subscription' });
      return;
    }

    const stripe = getStripe();
    try {
      if (action === 'switchPlan') {
        const tier = body.tier;
        if (tier !== 'starter' && tier !== 'pro') {
          res.status(400).json({ error: 'invalid_tier' });
          return;
        }
        // Pull the existing subscription so we know which line item
        // to mutate. Subscriptions in this product have exactly one
        // item — the recurring price — so we update item[0].
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const itemId = subscription.items.data[0]?.id;
        if (!itemId) {
          res.status(500).json({ error: 'subscription_has_no_items' });
          return;
        }
        const newPriceId = getPriceIds()[tier];
        await stripe.subscriptions.update(subscriptionId, {
          items: [{ id: itemId, price: newPriceId }],
          // Charge / credit the prorated difference immediately so the
          // user is billed cleanly on the next period boundary. This
          // also matches the on-screen pricing — no surprise bill.
          proration_behavior: 'create_prorations',
          // Keep tier metadata in sync with the new price so future
          // webhook events carry the right tier.
          metadata: { uid, tier },
        });
        // Update subscription metadata too — Stripe stores them
        // separately and webhook handlers read from the subscription
        // metadata, not the customer's.
        // (already covered by the metadata field above on subscriptions.update)
        res.status(200).json({ success: true });
        return;
      }

      if (action === 'cancel') {
        // Don't actually delete the subscription — schedule
        // cancellation at the end of the current period so the user
        // keeps access for what they've already paid. Stripe fires
        // subscription.updated immediately AND subscription.deleted
        // when the period ends; both update Firestore via the webhook.
        await stripe.subscriptions.update(subscriptionId, {
          cancel_at_period_end: true,
        });
        res.status(200).json({ success: true });
        return;
      }

      if (action === 'reactivate') {
        // Undo a pending cancellation. No-op if it wasn't scheduled —
        // Stripe accepts the call regardless.
        await stripe.subscriptions.update(subscriptionId, {
          cancel_at_period_end: false,
        });
        res.status(200).json({ success: true });
        return;
      }

      res.status(400).json({ error: 'invalid_action' });
    } catch (err) {
      logger.error('updateSubscription failed', {
        uid,
        action: String(action),
        err: String(err),
      });
      res.status(500).json({ error: 'stripe_update_failed' });
    }
  },
);

// ---------------------------------------------------------------------------
// /stripeWebhook
// ---------------------------------------------------------------------------

export const stripeWebhook = onRequest(
  {
    region: 'us-central1',
    cors: false,
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET],
  },
  async (req, res) => {
    const signature = req.header('stripe-signature');
    if (!signature) {
      res.status(400).send('missing signature');
      return;
    }

    const stripe = getStripe();
    let event: Stripe.Event;
    try {
      // Stripe REQUIRES the raw, unparsed body for signature verification.
      // firebase-functions exposes it on `req.rawBody` — using the parsed
      // `req.body` here would silently fail signature checks.
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET.value(),
      );
    } catch (err) {
      logger.warn('stripe webhook signature verification failed', {
        err: String(err),
      });
      res.status(400).send('invalid signature');
      return;
    }

    // ---- H5. Transactional idempotency dedup ------------------------
    // Stripe retries on 5xx and on missed ACKs; without dedup, two
    // racing webhook deliveries can both pass the "is this new?" check
    // and both run the handler. firestore.rules already reserves a
    // `stripeEvents` collection — claim the event id atomically inside
    // a transaction (read-then-write in the same tx), and bail with
    // 200 if it already exists. Doc stays after success so subsequent
    // retries also short-circuit.
    const eventRef = db.doc(`stripeEvents/${event.id}`);
    try {
      const isDuplicate = await db.runTransaction(async (tx) => {
        const existing = await tx.get(eventRef);
        if (existing.exists) return true;
        tx.set(eventRef, {
          type: event.type,
          processedAt: FieldValue.serverTimestamp(),
        });
        return false;
      });
      if (isDuplicate) {
        logger.info('stripe webhook: already processed', {
          eventId: event.id,
          eventType: event.type,
        });
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
    } catch (err) {
      // Transaction failure here is itself transient; respond 500 so
      // Stripe retries — the next attempt will either claim the doc
      // cleanly or hit the duplicate branch.
      logger.error('stripe webhook idempotency claim failed', {
        eventId: event.id,
        err: String(err),
      });
      res.status(500).json({ error: 'idempotency_claim_failed' });
      return;
    }

    // Stripe retries on 5xx, and the dedup guard above means a retry
    // after a successful run is short-circuited. Handlers are still
    // written idempotently (just set the latest known state) as a
    // belt-and-braces measure.
    try {
      await handleStripeEvent(stripe, event);
      res.status(200).json({ received: true });
    } catch (err) {
      logger.error('stripe webhook handler failed', {
        err: String(err),
        eventType: event.type,
        eventId: event.id,
      });
      // Roll back the idempotency claim so Stripe's retry can actually
      // re-run the handler — otherwise the dedup branch would
      // short-circuit every future attempt and leave us stuck. Best-
      // effort: if this delete fails the user might end up with a
      // stuck event, which we'd notice via the past_due / mismatch
      // alerting on the user doc.
      eventRef.delete().catch((delErr) => {
        logger.error('stripe webhook idempotency rollback failed', {
          eventId: event.id,
          err: String(delErr),
        });
      });
      // 500 prompts Stripe to retry; this is the right behaviour for
      // transient Firestore failures. The error response is generic —
      // we never echo Stripe API error bodies back to the caller, since
      // those can include account/customer ids.
      res.status(500).json({ error: 'handler_failed' });
    }
  },
);

// ---------------------------------------------------------------------------
// Event dispatcher
// ---------------------------------------------------------------------------

async function handleStripeEvent(stripe: Stripe, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      // Fires once per successful checkout. The Subscription it created
      // is referenced by id; we retrieve it for the canonical state.
      const session = event.data.object as Stripe.Checkout.Session;
      const subId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;
      if (!subId) {
        logger.warn('checkout.session.completed without subscription', {
          sessionId: session.id,
        });
        return;
      }
      const subscription = await stripe.subscriptions.retrieve(subId);
      await applySubscriptionState(subscription);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      // Fires on plan upgrades/downgrades, status changes, payment
      // recovery, etc. The Subscription IS the event payload — no
      // extra retrieval needed.
      const subscription = event.data.object as Stripe.Subscription;
      await applySubscriptionState(subscription);
      return;
    }
    case 'customer.subscription.deleted': {
      // User cancelled (or Stripe ended the subscription after a long
      // payment failure). Mark canceled but keep the existing
      // `currentPeriodEnd` — the relay continues to grant access until
      // that timestamp passes.
      const subscription = event.data.object as Stripe.Subscription;
      const uid = subscription.metadata?.uid;
      if (!uid) {
        logger.warn('subscription.deleted without uid metadata', {
          subscriptionId: subscription.id,
        });
        return;
      }
      await db.doc(`users/${uid}`).set(
        {
          subscriptionStatus: 'canceled',
          canceledAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }
    case 'invoice.payment_succeeded': {
      // Monthly renewal — refreshes currentPeriodEnd and clears any
      // past_due flag set by a previous failure.
      const invoice = event.data.object as Stripe.Invoice;
      const subId =
        typeof (invoice as any).subscription === 'string'
          ? ((invoice as any).subscription as string)
          : ((invoice as any).subscription as Stripe.Subscription | undefined)?.id;
      if (!subId) return;
      const subscription = await stripe.subscriptions.retrieve(subId);
      await applySubscriptionState(subscription);
      return;
    }
    case 'invoice.payment_failed': {
      // Card declined / insufficient funds. Stripe will retry per its
      // default smart-retry schedule; until then the user is past_due.
      // We could cut off access immediately, but the standard SaaS
      // pattern is to give the grace period and only revoke when
      // Stripe finally cancels (handled by subscription.deleted).
      const invoice = event.data.object as Stripe.Invoice;
      const subId =
        typeof (invoice as any).subscription === 'string'
          ? ((invoice as any).subscription as string)
          : ((invoice as any).subscription as Stripe.Subscription | undefined)?.id;
      if (!subId) return;
      const subscription = await stripe.subscriptions.retrieve(subId);
      const uid = subscription.metadata?.uid;
      if (!uid) return;
      await db.doc(`users/${uid}`).set(
        { subscriptionStatus: 'past_due' },
        { merge: true },
      );
      return;
    }
    default:
      // Anything else is harmless — log so we know what we ignored,
      // and we can decide later whether to handle it.
      logger.info('stripe webhook: unhandled event type', { type: event.type });
  }
}

/** Write the canonical subscription state derived from a Stripe.Subscription
 *  to the corresponding user doc. Idempotent — same input always produces
 *  the same on-disk state, which is what we want for retried webhooks. */
async function applySubscriptionState(subscription: Stripe.Subscription): Promise<void> {
  const uid = subscription.metadata?.uid;
  const rawTier = subscription.metadata?.tier;
  if (!uid || !rawTier) {
    logger.warn('subscription event missing uid/tier metadata', {
      subscriptionId: subscription.id,
      uid,
      tier: rawTier,
    });
    return;
  }
  // L2. Validate the tier metadata against the closed set rather than
  // trusting a cast. A malformed tier (typo in dashboard, future tier
  // we don't recognise yet, manual edit) used to silently propagate
  // through and corrupt the user's allowance lookup. Bail without
  // touching Firestore — the previous state is the safest fallback.
  if (rawTier !== 'starter' && rawTier !== 'pro') {
    logger.error('subscription has unrecognised tier metadata', {
      subscriptionId: subscription.id,
      uid,
      tier: rawTier,
    });
    return;
  }
  const tier: Tier = rawTier;
  const allowance = TOKEN_ALLOWANCE_MONTHLY[tier];
  if (!allowance) {
    // Defensive: the type guard above already constrains `tier`, but
    // if we ever add a tier without a TOKEN_ALLOWANCE_MONTHLY entry
    // we'd rather fail closed than write a 0-allowance user doc that
    // the relay would then reject as `subscription_incomplete`.
    logger.error('no token allowance for tier', {
      subscriptionId: subscription.id,
      uid,
      tier,
    });
    return;
  }

  // Map Stripe statuses to our internal vocabulary. We collapse
  // `trialing` → `active` because we don't currently offer trials —
  // future trial logic can split them out without breaking the relay.
  const stripeStatus = subscription.status;
  const subscriptionStatus =
    stripeStatus === 'trialing' || stripeStatus === 'active'
      ? 'active'
      : stripeStatus === 'past_due'
        ? 'past_due'
        : stripeStatus === 'canceled' || stripeStatus === 'unpaid'
          ? 'canceled'
          : stripeStatus;

  // current_period_end on Subscription is a Unix-seconds timestamp.
  // Stored as a Firestore Timestamp so server-side queries can compare
  // it directly to `Timestamp.now()`.
  const periodEndSec = (subscription as any).current_period_end as number | undefined;
  const currentPeriodEnd =
    typeof periodEndSec === 'number'
      ? Timestamp.fromMillis(periodEndSec * 1000)
      : null;

  // `cancel_at_period_end: true` is how a "user clicked cancel"
  // surfaces — the subscription stays active until period end, but
  // we want to show that pending state in the UI so the user can
  // reactivate or know access is ending.
  const cancelAtPeriodEnd = Boolean(
    (subscription as unknown as { cancel_at_period_end?: boolean }).cancel_at_period_end,
  );

  await db.doc(`users/${uid}`).set(
    {
      tier,
      subscriptionStatus,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      tokenAllowanceMonthly: allowance,
      stripeSubscriptionId: subscription.id,
    },
    { merge: true },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Restrict success/cancel URLs to known-safe destinations. Without this,
 *  any signed-in caller could ask the relay to redirect Stripe to an
 *  arbitrary domain — small attack surface but free to close. */
function isAllowedReturnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Reject userinfo-smuggled hosts up-front: `http://evil.com@127.0.0.1`
    // parses with hostname `127.0.0.1` but a real fetch lands at
    // `evil.com`. Disallow any non-empty username/password to close it.
    if (u.username !== '' || u.password !== '') return false;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // Exact hostname equality (not a suffix check) is intentional —
    // `127.0.0.1.evil.com` would slip past `endsWith` matching.
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return true;
    if (u.hostname.endsWith('.firebaseapp.com')) return true;
    if (u.hostname.endsWith('.web.app')) return true;
    return false;
  } catch {
    return false;
  }
}
