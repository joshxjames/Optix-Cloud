# Optix Cloud

The managed-service backend for the [Optix](https://github.com/joshxjames/Optix)
desktop app. A thin Anthropic relay + Firebase Auth / Firestore integration
that powers the paid "Optix Cloud" provider mode in the desktop client.

This is the **private** half of the project. The desktop client stays open
source; this repo ships the relay, auth triggers, billing webhook (later),
and Firestore rules.

---

## Architecture

```
                 ┌─────────────────────────────┐
                 │   Optix desktop (open source)│
                 │   "Optix Cloud" provider     │
                 └────────────┬────────────────┘
                              │  Bearer <Firebase ID token>
                              ▼
                 ┌─────────────────────────────┐
                 │   Cloud Function: relay     │
                 │   • Verify ID token         │
                 │   • Check subscription      │
                 │   • Check monthly token cap │
                 │   • Forward to Anthropic    │
                 │   • Stream response back    │
                 │   • Increment usage in FS   │
                 └────────────┬────────────────┘
                              │  x-api-key (admin Anthropic key)
                              ▼
                 ┌─────────────────────────────┐
                 │      api.anthropic.com      │
                 └─────────────────────────────┘
```

User data — prompts, screenshots, automations, audit logs — never reaches
this backend. The relay forwards bytes; it does not log or store request
contents. Only token-count aggregates are persisted (for billing).

---

## Prerequisites

- Node.js 22+
- pnpm 9+
- [Firebase CLI](https://firebase.google.com/docs/cli) — `npm install -g firebase-tools`
- Logged in: `firebase login`
- Project linked: `firebase use --add` (pick `optix-22473`)

---

## First-time setup

```bash
pnpm install

# Set the Anthropic API key as a Firebase secret (not committed to repo)
firebase functions:secrets:set ANTHROPIC_API_KEY
# Stripe webhook secret comes later when billing lands
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
```

For local emulator dev, also create `functions/.env.local`:

```bash
# functions/.env.local — gitignored, never commit
ANTHROPIC_API_KEY=sk-ant-...
```

The emulator reads this at boot; deployed functions read from Secret Manager.

---

## Local development

```bash
pnpm build      # one-shot compile to functions/lib/
pnpm watch      # tsc --watch
pnpm emu        # firebase emulators:start (auth + functions + firestore)
```

The Emulator UI is at <http://localhost:4000>. Use it to:

- Auth (port 9099) — create test users, copy their ID tokens
- Firestore (port 8080) — flip `subscriptionStatus` to `active` on a test
  user so the relay accepts them
- Functions (port 5001) — see structured logs as the relay handles requests

Smoke-test the relay end-to-end with an ID token:

```bash
chmod +x scripts/test-relay.sh
./scripts/test-relay.sh <ID_TOKEN>
```

Expect a streamed Anthropic response. The corresponding usage counter
should appear under `users/<uid>/usage/<yyyy-mm>` in the Firestore emulator.

---

## Deploy

```bash
pnpm deploy              # functions + firestore rules
pnpm deploy:functions    # functions only
pnpm deploy:rules        # firestore rules only
```

The first deploy takes ~3–5 minutes (Cloud Functions Gen 2 provisions the
underlying Cloud Run service). Subsequent deploys are faster.

---

## Schema

### `users/{uid}`

Profile + subscription state. Created by the `onUserCreate` auth trigger
when a user signs up; written by Stripe webhooks (later); read-only for
the user.

| Field | Type | Source |
|---|---|---|
| `email` | string \| null | Firebase Auth |
| `displayName` | string \| null | Firebase Auth |
| `createdAt` | Timestamp | trigger |
| `subscriptionStatus` | `'none' \| 'active' \| 'past_due' \| 'cancelled'` | Stripe webhook |
| `subscriptionTier` | `'starter' \| 'pro' \| null` | Stripe webhook |
| `subscriptionCurrentPeriodEnd` | Timestamp \| null | Stripe webhook |
| `stripeCustomerId` | string \| null | Stripe webhook |
| `tokenAllowanceMonthly` | number | Stripe webhook (per tier) |

### `users/{uid}/usage/{yyyy-mm}`

Per-user, per-month token counters. Incremented by the relay.

| Field | Type |
|---|---|
| `inputTokens` | number |
| `outputTokens` | number |
| `cacheCreateTokens` | number |
| `cacheReadTokens` | number |
| `requestCount` | number |
| `lastRequestAt` | Timestamp |

### `stripeEvents/{eventId}`

Idempotency log for Stripe webhook handling. Server-only, never read by
clients.

---

## Layout

```
optix-cloud/
├── firebase.json           # Functions + Firestore + emulator config
├── .firebaserc             # Project alias
├── firestore.rules         # Deny-by-default; user reads own data only
├── firestore.indexes.json  # No composite indexes yet
├── functions/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts        # Re-exports the deployable functions
│       ├── admin.ts        # Single Firebase Admin init
│       ├── secrets.ts      # ANTHROPIC_API_KEY / STRIPE_WEBHOOK_SECRET
│       ├── relay.ts        # The streaming Anthropic proxy
│       └── user-trigger.ts # Auth onCreate → seed user profile doc
├── scripts/
│   └── test-relay.sh       # Smoke test against the emulator
└── README.md
```

---

## What's NOT in this repo

- The desktop app — it lives at <https://github.com/joshxjames/Optix>
  (public, MIT).
- The marketing site — separate, deployed to Firebase Hosting.
- Anthropic / Stripe API keys — Secret Manager only, never committed.
