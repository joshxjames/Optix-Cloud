// Anthropic relay — the single endpoint the Optix desktop client calls
// when running in "Optix Cloud" provider mode.
//
// Responsibilities, in order:
//   1. Verify the renderer's Bearer token via Firebase Admin (extract uid).
//   2. Look up the user's Firestore profile, reject if subscription is not
//      `active` or the monthly token cap has been exceeded.
//   3. Forward the JSON body to `https://api.anthropic.com/v1/messages` with
//      our admin-side API key + the same `anthropic-beta` and `anthropic-
//      version` headers the client sent.
//   4. Stream the upstream response body back to the client byte-for-byte.
//      For SSE responses we snoop the `message_delta` / `message_stop`
//      events to capture final usage and increment Firestore counters.
//   5. NEVER log request bodies or response contents. Privacy promise:
//      requests pass through but are not stored.

import { onRequest, type Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { logger } from 'firebase-functions/v2';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { auth, db } from './admin.js';
import { ANTHROPIC_API_KEY } from './secrets.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Server-side model whitelist for the Optix Cloud subscription tier.
// The desktop UI catalog (`optix/desktop/src/shared/models.ts` →
// `optixCloud`) is the soft policy; this is the hard gate. Sonnet,
// Haiku, and any other Anthropic model are NOT served on the
// subscription path — those users must use BYO key.
//
// Prefix-matched so dated snapshots (e.g. `claude-opus-4-7-20250115`)
// automatically pass when Anthropic publishes them, without requiring
// a relay redeploy. Keep entries to base IDs only.
const ALLOWED_MODEL_PREFIXES = ['claude-opus-4-7'] as const;

function isAllowedModel(model: unknown): model is string {
  if (typeof model !== 'string' || model.length === 0) return false;
  return ALLOWED_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

/** Cloud Functions Gen 2 HTTPS handler. Public route — auth happens
 *  inside via Bearer-token verification. */
export const relay = onRequest(
  {
    region: 'us-central1',
    timeoutSeconds: 540, // Gen 2 max; rarely hit, but Anthropic streams can run long
    memory: '512MiB',
    cors: false,
    secrets: [ANTHROPIC_API_KEY],
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      // Cross-origin handling kept minimal — the desktop app has its own
      // origin (`file://` in packaged builds, `localhost:5174` in dev),
      // and we want to allow both without auto-allowing arbitrary
      // browsers from hitting the relay.
      const origin = req.header('origin') ?? '';
      if (isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'authorization, content-type, anthropic-beta, anthropic-version, x-api-key',
        );
        res.setHeader('Access-Control-Max-Age', '600');
      }
      res.status(204).end();
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    if (req.path !== '/v1/messages') {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // ---- M3. Body size guard ----------------------------------------
    // Anthropic itself rejects oversized prompts, but by then we've
    // already buffered and re-serialised the body and burned CPU on
    // upstream TLS. Reject at the door for anything claiming >5MB —
    // a generous upper bound for legitimate Computer Use payloads
    // (screenshots are sent inline as base64).
    const contentLength = Number(req.header('content-length') ?? '0');
    if (contentLength > 5_000_000) {
      res.status(413).json({ error: 'request_too_large' });
      return;
    }

    // ---- Model whitelist --------------------------------------------
    // Optix Cloud sells a single model — Claude Opus 4.7. Reject any
    // other model BEFORE any Firestore round-trips, both to save quota
    // and to give the client a fast, clear error. Anthropic itself
    // would happily serve any of their models with our admin key, so
    // this check is the only thing keeping subscription users on
    // Opus 4.7. (The desktop UI also restricts the choice — see
    // `optix/desktop/src/shared/models.ts` `optixCloud`.)
    const requestedModel = (req.body as { model?: unknown })?.model;
    if (!isAllowedModel(requestedModel)) {
      res.status(400).json({
        error: 'model_not_allowed',
        message:
          'Optix Cloud only relays Claude Opus 4.7. Switch to Opus, ' +
          'or use BYO key for other models.',
        allowed: ALLOWED_MODEL_PREFIXES,
        requested: typeof requestedModel === 'string' ? requestedModel : null,
      });
      return;
    }

    // ---- 1. Auth -----------------------------------------------------
    const uid = await verifyBearer(req, res);
    if (!uid) return;

    // ---- 2. Subscription + cap check --------------------------------
    const userSnap = await db.doc(`users/${uid}`).get();
    const userData = userSnap.data();
    if (!userData) {
      res.status(403).json({ error: 'no_user_record' });
      return;
    }
    if (userData.subscriptionStatus !== 'active') {
      res.status(402).json({
        error: 'subscription_inactive',
        status: userData.subscriptionStatus ?? 'none',
      });
      return;
    }
    const cap = (userData.tokenAllowanceMonthly as number | undefined) ?? 0;
    const yyyymm = monthKey(new Date());

    // ---- H3. Cap-required gate --------------------------------------
    // An `active` subscription with no allowance is a billing-state bug
    // (e.g. webhook landed mid-mutation) — fail closed rather than
    // letting the user burn unmetered tokens. A real bypass would have
    // to be done by an operator deliberately setting the allowance.
    if (cap <= 0) {
      res.status(402).json({
        error: 'subscription_incomplete',
        reason: 'no_token_allowance',
      });
      return;
    }

    // ---- H1. Atomic cap check + reservation -------------------------
    // The previous read-then-increment was racy: two concurrent requests
    // both observed `usedThisMonth < cap` and both passed the gate.
    // Solve it by reserving an estimated 50k tokens up-front inside a
    // transaction — the recordUsage write at stream end then reconciles
    // with the actual usage minus the reservation. Reservations are
    // refunded on every abnormal exit (see refundReservation below), so
    // crashed requests no longer leak budget — the only residual is the
    // narrow window between the transaction commit and the refund.
    const RESERVATION = 50_000;
    const usageRef = db.doc(`users/${uid}/usage/${yyyymm}`);
    try {
      await db.runTransaction(async (tx) => {
        const usageSnap = await tx.get(usageRef);
        const usage = usageSnap.data() ?? {};
        const usedThisMonth =
          (usage.inputTokens ?? 0) +
          (usage.outputTokens ?? 0) +
          (usage.cacheCreateTokens ?? 0) +
          (usage.cacheReadTokens ?? 0);
        // Why `+ RESERVATION` rather than `>=`: each in-flight request
        // reserves RESERVATION tokens up-front. Without this guard, N
        // concurrent requests each see "cap not yet hit", reserve, and
        // collectively exceed cap by N×RESERVATION. The trade-off is
        // that we may reject the last few hundred kilo-tokens of
        // legitimate budget when the user is near their cap —
        // acceptable to enforce the contract.
        if (usedThisMonth + RESERVATION > cap) {
          throw new CapExceededError(usedThisMonth, cap);
        }
        // Reserve against the input-token bucket; the post-stream
        // recordUsage subtracts RESERVATION from the actual input
        // delta to net it out.
        tx.set(
          usageRef,
          {
            inputTokens: FieldValue.increment(RESERVATION),
            reservedTokens: FieldValue.increment(RESERVATION),
          },
          { merge: true },
        );
      });
    } catch (err) {
      if (err instanceof CapExceededError) {
        res.status(429).json({
          error: 'monthly_allowance_exceeded',
          used: err.used,
          cap: err.cap,
        });
        return;
      }
      logger.error('relay cap-check transaction failed', { uid, err: String(err) });
      res.status(500).json({ error: 'cap_check_failed' });
      return;
    }

    // Reservation invariant — every code path past this point MUST end
    // with either recordUsage (which nets out the reservation against
    // real usage) or refundReservation (which fully unwinds it). The
    // `reservationRefunded` flag is the single source of truth so the
    // catch/finally and the success path don't double-refund.
    let reservationRefunded = false;
    try {
      // ---- 3. Forward to Anthropic ----------------------------------
      const upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY.value(),
          'anthropic-version':
            (req.header('anthropic-version') as string | undefined) ??
            '2023-06-01',
          ...(req.header('anthropic-beta')
            ? { 'anthropic-beta': req.header('anthropic-beta') as string }
            : {}),
        },
        body: JSON.stringify(req.body),
      });

      // Forward status + safe headers.
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        // Drop hop-by-hop, Cloud-Run-specific, and (critically) the
        // `content-encoding` header. Node's fetch() auto-decompresses
        // upstream gzip/br bodies before handing us the byte stream, so
        // we're forwarding plaintext — leaving the original gzip header
        // attached makes the client's SDK try to gunzip plain JSON and
        // fail with a Z_DATA_ERROR ("incorrect header check"). Same goes
        // for `content-length`: it'd be wrong after decompression.
        if (
          lower === 'transfer-encoding' ||
          lower === 'connection' ||
          lower === 'content-length' ||
          lower === 'content-encoding' ||
          lower.startsWith('cf-') ||
          lower.startsWith('x-served-by')
        ) {
          return;
        }
        res.setHeader(key, value);
      });

      if (!upstream.body) {
        res.end();
        // Empty-body upstreams (errors, 204s) never produce a usage
        // event, so the reservation needs an explicit refund here —
        // the finally block handles it via reservationRefunded.
        return;
      }

      const isStream =
        upstream.headers.get('content-type')?.includes('text/event-stream') ??
        false;

      // ---- 4. Pipe response, snoop final usage on SSE ---------------
      let finalUsage: AnthropicUsage | null = null;
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          // Forward the bytes verbatim — we don't transform anything.
          res.write(Buffer.from(value));

          if (isStream) {
            sseBuffer += decoder.decode(value, { stream: true });
            // Walk completed SSE events (`data: {...}\n\n`) and pull usage
            // out of `message_start` (initial) + `message_delta` (final).
            let sep: number;
            while ((sep = sseBuffer.indexOf('\n\n')) !== -1) {
              const event = sseBuffer.slice(0, sep);
              sseBuffer = sseBuffer.slice(sep + 2);
              const payload = extractDataPayload(event);
              if (!payload) continue;
              if (payload.type === 'message_start' && payload.message?.usage) {
                finalUsage = mergeUsage(finalUsage, payload.message.usage);
              } else if (payload.type === 'message_delta' && payload.usage) {
                finalUsage = mergeUsage(finalUsage, payload.usage);
              }
            }
          }
        }
      } catch (err) {
        // Reader errors are logged but not rethrown — we've already
        // forwarded a partial response and want the finally block to
        // refund the reservation rather than leaving the client hung.
        logger.warn('relay stream error', { uid, err: String(err) });
      }

      res.end();

      // Non-streaming responses carry usage directly in the JSON body. The
      // pass-through above means we've already forwarded it to the client;
      // for billing we re-fetch by buffering. Skipped here for v1 — almost
      // all Anthropic Computer Use traffic is streaming.
      if (finalUsage) {
        // recordUsage nets out the reservation against real usage in a
        // single Firestore write — mark it refunded synchronously so the
        // finally block doesn't double-refund. The await on the promise
        // would block the response (already sent), so we fire-and-forget
        // and accept that a write failure leaves the reservation stuck;
        // the reservedTokens counter surfaces those for ops to clean up.
        reservationRefunded = true;
        void recordUsage(uid, yyyymm, finalUsage, RESERVATION).catch((err) => {
          logger.error('relay usage write failed', { uid, err: String(err) });
        });
      }
      // No-usage path falls through to the finally block, which will
      // refund the reservation since reservationRefunded is still false.
    } catch (err) {
      // Any error after the reservation — fetch failure, header write
      // crash, anything not caught by the inner reader try/catch — must
      // not leak the reservation. Log, refund (in finally), respond if
      // we haven't already.
      logger.error('relay post-reservation error', { uid, err: String(err) });
      if (!res.headersSent) {
        res.status(502).json({ error: 'upstream_failed' });
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      if (!reservationRefunded) {
        await refundReservation(uid, yyyymm, RESERVATION).catch((err) => {
          logger.error('relay reservation refund failed', { uid, err: String(err) });
        });
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify the `Authorization: Bearer <Firebase ID token>` header. Writes
 *  a 401 to `res` and returns null on failure. Returns the verified uid
 *  on success. */
async function verifyBearer(req: Request, res: Response): Promise<string | null> {
  const header = req.header('authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_bearer_token' });
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'empty_bearer_token' });
    return null;
  }
  try {
    const decoded = await auth.verifyIdToken(token);
    return decoded.uid;
  } catch {
    res.status(401).json({ error: 'invalid_token' });
    return null;
  }
}

function extractDataPayload(event: string): any | null {
  // Anthropic SSE events look like:
  //   event: message_delta
  //   data: {"type": "message_delta", "usage": {...}}
  // We only care about the `data:` line for parsing, AND we only ever
  // return payloads whose type is on our usage-snoop whitelist
  // (message_start / message_delta). Defence-in-depth — if a future
  // caller forgets to type-check the result, content blocks from other
  // event kinds still won't leak out of this helper.
  for (const line of event.split('\n')) {
    if (line.startsWith('data: ')) {
      const json = line.slice('data: '.length);
      try {
        const parsed = JSON.parse(json);
        if (parsed?.type === 'message_start' || parsed?.type === 'message_delta') {
          return parsed;
        }
        return null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function mergeUsage(
  prev: AnthropicUsage | null,
  next: AnthropicUsage,
): AnthropicUsage {
  return {
    input_tokens: max(prev?.input_tokens, next.input_tokens),
    output_tokens: max(prev?.output_tokens, next.output_tokens),
    cache_creation_input_tokens: max(
      prev?.cache_creation_input_tokens,
      next.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: max(
      prev?.cache_read_input_tokens,
      next.cache_read_input_tokens,
    ),
  };
}

function max(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

async function recordUsage(
  uid: string,
  yyyymm: string,
  usage: AnthropicUsage,
  reservation: number,
): Promise<void> {
  // We pre-incremented `inputTokens` by `reservation` at the gate, so
  // the actual delta to write here is the real input tokens MINUS the
  // reservation. The reservedTokens counter is decremented in lock-step
  // so it stays at zero in steady state — non-zero values flag stuck
  // reservations from crashed requests.
  await db.doc(`users/${uid}/usage/${yyyymm}`).set(
    {
      inputTokens: FieldValue.increment((usage.input_tokens ?? 0) - reservation),
      reservedTokens: FieldValue.increment(-reservation),
      outputTokens: FieldValue.increment(usage.output_tokens ?? 0),
      cacheCreateTokens: FieldValue.increment(
        usage.cache_creation_input_tokens ?? 0,
      ),
      cacheReadTokens: FieldValue.increment(
        usage.cache_read_input_tokens ?? 0,
      ),
      requestCount: FieldValue.increment(1),
      lastRequestAt: Timestamp.now(),
    },
    { merge: true },
  );
}

/** Fully unwind a reservation made at the gate. Used on every abnormal
 *  exit path between the reservation transaction and recordUsage —
 *  network failures, missing upstream body, header crashes, anything
 *  that prevents the normal nets-out write. Idempotency is enforced by
 *  the caller via a `reservationRefunded` flag rather than here, since
 *  Firestore increments are not naturally idempotent. */
async function refundReservation(
  uid: string,
  yyyymm: string,
  reservation: number,
): Promise<void> {
  await db.doc(`users/${uid}/usage/${yyyymm}`).set(
    {
      inputTokens: FieldValue.increment(-reservation),
      reservedTokens: FieldValue.increment(-reservation),
    },
    { merge: true },
  );
}

/** Sentinel error thrown from the cap-check transaction so we can map
 *  it back to a 429 outside without conflating with Firestore failures. */
class CapExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly cap: number,
  ) {
    super('cap_exceeded');
  }
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isAllowedOrigin(origin: string): boolean {
  // Electron in packaged form has origin `file://` (or empty in some
  // versions), dev has `http://localhost:5174`. We deliberately do NOT
  // allow `*.firebaseapp.com` / `*.web.app` here — those cover every
  // Firebase Hosting project on the planet, and a leaked Bearer token
  // would be spendable from any of them. When we have a specific
  // marketing-site origin to ship, add it here by exact host.
  if (!origin) return true; // Some Electron versions send empty origin
  if (origin === 'file://') return true;
  if (origin.startsWith('http://localhost:')) return true;
  if (origin.startsWith('http://127.0.0.1:')) return true;
  return false;
}
