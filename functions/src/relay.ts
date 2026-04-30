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
    if (cap > 0) {
      const usageSnap = await db.doc(`users/${uid}/usage/${yyyymm}`).get();
      const usage = usageSnap.data() ?? {};
      const usedThisMonth =
        (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cacheCreateTokens ?? 0) +
        (usage.cacheReadTokens ?? 0);
      if (usedThisMonth >= cap) {
        res.status(429).json({
          error: 'monthly_allowance_exceeded',
          used: usedThisMonth,
          cap,
        });
        return;
      }
    }

    // ---- 3. Forward to Anthropic ------------------------------------
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
      // Drop hop-by-hop and Cloud-Run-specific headers; let Cloud Run
      // add its own back as needed.
      if (
        lower === 'transfer-encoding' ||
        lower === 'connection' ||
        lower === 'content-length' ||
        lower.startsWith('cf-') ||
        lower.startsWith('x-served-by')
      ) {
        return;
      }
      res.setHeader(key, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const isStream =
      upstream.headers.get('content-type')?.includes('text/event-stream') ??
      false;

    // ---- 4. Pipe response, snoop final usage on SSE -----------------
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
      logger.warn('relay stream error', { uid, err: String(err) });
    }

    res.end();

    // Non-streaming responses carry usage directly in the JSON body. The
    // pass-through above means we've already forwarded it to the client;
    // for billing we re-fetch by buffering. Skipped here for v1 — almost
    // all Anthropic Computer Use traffic is streaming.
    if (finalUsage) {
      // Fire-and-forget; failure to log usage doesn't block the response
      // already sent to the client.
      void recordUsage(uid, yyyymm, finalUsage).catch((err) => {
        logger.error('relay usage write failed', { uid, err: String(err) });
      });
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
  // We only care about the `data:` line for parsing.
  for (const line of event.split('\n')) {
    if (line.startsWith('data: ')) {
      const json = line.slice('data: '.length);
      try {
        return JSON.parse(json);
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
): Promise<void> {
  await db.doc(`users/${uid}/usage/${yyyymm}`).set(
    {
      inputTokens: FieldValue.increment(usage.input_tokens ?? 0),
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

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isAllowedOrigin(origin: string): boolean {
  // Electron in packaged form has origin `file://`, dev has
  // `http://localhost:5174`, the future marketing site is on Firebase
  // Hosting. We don't allow arbitrary browsers — that prevents random
  // websites from spending tokens on a leaked Bearer token.
  if (!origin) return true; // Some Electron versions send empty origin
  if (origin === 'file://') return true;
  if (origin.startsWith('http://localhost:')) return true;
  if (origin.startsWith('http://127.0.0.1:')) return true;
  if (origin.endsWith('.firebaseapp.com')) return true;
  if (origin.endsWith('.web.app')) return true;
  return false;
}
