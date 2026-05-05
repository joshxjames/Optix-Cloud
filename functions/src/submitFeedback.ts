// In-app support form receiver. The desktop widget POSTs feedback
// payloads here; we send them by email to admin@covetable.com.au via
// nodemailer using SMTP credentials stored in Firebase Functions secrets.
//
// Auth: optional. Optix Cloud users include a Firebase ID token via
// `Authorization: Bearer <token>` so we can correlate the message with
// their account; BYO-key users submit anonymously. Anonymous submissions
// are accepted but rate-limited per source IP.
//
// Endpoint URL is hardcoded in the desktop client at
// `optix/desktop/src/main/ipc/feedback.ipc.ts:18` so the deployed
// function must keep this exact name.

import { onRequest, type Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { logger } from 'firebase-functions/v2';
import nodemailer from 'nodemailer';
import { auth } from './admin.js';
import { SMTP_PASSWORD } from './secrets.js';

const SMTP_HOST = 'secure.emailsrvr.com';
const SMTP_PORT = 465;
const SMTP_USER = 'admin@covetable.com.au';
const SUPPORT_TO = 'admin@covetable.com.au';

const FEEDBACK_CATEGORIES = [
  'Bug report',
  'Feature request',
  'Billing / Optix Cloud',
  'Question',
  'Other',
] as const;
type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

type Diagnostics = {
  appVersion: string;
  userAgent: string;
  locale: string;
  activeProvider?: string;
  signedInEmail?: string;
  submittedAt: string;
};

type FeedbackPayload = {
  name: string;
  email?: string;
  category: FeedbackCategory;
  subject: string;
  message: string;
  diagnostics: Diagnostics;
};

// Lightweight per-IP rate limiter. In-memory is fine for our scale; a
// Cloud Function instance gets recycled occasionally which resets the
// counter, but that's an acceptable tradeoff vs adding Firestore round-
// trips on every submission. If abuse becomes an issue, move to
// Firestore or redis.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_PER_IP = 5;
const recentSubmissions = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (recentSubmissions.get(ip) ?? []).filter((t) => t > cutoff);
  if (recent.length >= RATE_LIMIT_MAX_PER_IP) return true;
  recent.push(now);
  recentSubmissions.set(ip, recent);
  return false;
}

/** Validate the incoming JSON body. Returns the typed payload on
 *  success, `'honeypot'` if the bot trap fired, or `null` on any other
 *  malformation. We don't surface the specific error to the client
 *  (could leak internals); `null` -> caller returns 400. The honeypot
 *  case is silent: the CF returns 200 like a successful submit so bots
 *  don't adapt their field names looking for one we accept. */
function parsePayload(body: unknown): FeedbackPayload | 'honeypot' | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;

  // Honeypot — silent reject. Real human submissions either omit this
  // field or send an empty string; bots that auto-fill every input
  // populate it with their default text. See the website's contact
  // form (and the desktop SupportForm), both of which include an
  // off-screen "website" input named to attract bot autofill.
  if (typeof b.honeypot === 'string' && b.honeypot.length > 0) {
    return 'honeypot';
  }

  if (typeof b.name !== 'string' || b.name.length > 120) return null;
  if (
    b.email !== undefined &&
    b.email !== '' &&
    (typeof b.email !== 'string' || b.email.length > 320 || !b.email.includes('@'))
  ) {
    return null;
  }
  if (
    typeof b.category !== 'string' ||
    !FEEDBACK_CATEGORIES.includes(b.category as FeedbackCategory)
  ) {
    return null;
  }
  if (typeof b.subject !== 'string' || b.subject.length === 0 || b.subject.length > 140) {
    return null;
  }
  if (typeof b.message !== 'string' || b.message.length === 0 || b.message.length > 4000) {
    return null;
  }
  if (typeof b.diagnostics !== 'object' || b.diagnostics === null) return null;
  const d = b.diagnostics as Record<string, unknown>;
  if (typeof d.appVersion !== 'string' || d.appVersion.length > 40) return null;
  if (typeof d.userAgent !== 'string' || d.userAgent.length > 500) return null;
  if (typeof d.locale !== 'string' || d.locale.length > 20) return null;
  if (typeof d.submittedAt !== 'string' || d.submittedAt.length > 40) return null;

  const diagnostics: Diagnostics = {
    appVersion: d.appVersion,
    userAgent: d.userAgent,
    locale: d.locale,
    submittedAt: d.submittedAt,
  };
  if (typeof d.activeProvider === 'string' && d.activeProvider.length <= 40) {
    diagnostics.activeProvider = d.activeProvider;
  }
  if (typeof d.signedInEmail === 'string' && d.signedInEmail.length <= 320) {
    diagnostics.signedInEmail = d.signedInEmail;
  }

  const payload: FeedbackPayload = {
    name: b.name,
    category: b.category as FeedbackCategory,
    subject: b.subject,
    message: b.message,
    diagnostics,
  };
  if (typeof b.email === 'string' && b.email.length > 0) {
    payload.email = b.email;
  }
  return payload;
}

export const submitFeedback = onRequest(
  {
    region: 'us-central1',
    secrets: [SMTP_PASSWORD],
    cors: true,
    // Feedback is rare — no need to scale wide. Caps spend if anyone
    // tries to abuse the endpoint.
    maxInstances: 5,
  },
  async (req: Request, res: Response) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }

    // --- Rate limit ---
    const ip =
      req.ip ??
      (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || 'unknown');
    if (isRateLimited(ip)) {
      logger.warn(`[submitFeedback] rate-limited ip=${ip}`);
      res.status(429).json({ ok: false, error: 'rate_limit' });
      return;
    }

    // --- Validate body ---
    const payload = parsePayload(req.body);
    if (payload === 'honeypot') {
      // Silent reject — log internally but pretend success so bots
      // don't iterate their honeypot-evasion strategy.
      logger.info(`[submitFeedback] honeypot caught a bot ip=${ip}`);
      res.status(200).json({ ok: true });
      return;
    }
    if (!payload) {
      logger.warn(`[submitFeedback] invalid payload from ip=${ip}`);
      res.status(400).json({ ok: false, error: 'invalid_payload' });
      return;
    }

    // --- Optionally verify auth ---
    let verifiedUser: { uid: string; email: string | undefined } | null = null;
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length);
      try {
        const decoded = await auth.verifyIdToken(token);
        verifiedUser = { uid: decoded.uid, email: decoded.email };
      } catch {
        // Bad token → treat as anonymous, don't reject. Don't log
        // the token contents.
        logger.warn('[submitFeedback] invalid auth token; treating as anonymous');
      }
    }

    // --- Compose email body ---
    const replyTo = payload.email || verifiedUser?.email || SMTP_USER;

    const diagText = [
      `App version: ${payload.diagnostics.appVersion}`,
      `Platform: ${payload.diagnostics.userAgent}`,
      `Locale: ${payload.diagnostics.locale}`,
      payload.diagnostics.activeProvider
        ? `Active provider: ${payload.diagnostics.activeProvider}`
        : null,
      payload.diagnostics.signedInEmail
        ? `Optix Cloud account: ${payload.diagnostics.signedInEmail}`
        : null,
      verifiedUser
        ? `Verified user: ${verifiedUser.email ?? '(no email)'} (uid ${verifiedUser.uid})`
        : 'Anonymous submission',
      `Submitted: ${payload.diagnostics.submittedAt}`,
      `Source IP: ${ip}`,
    ]
      .filter((l): l is string => l !== null)
      .join('\n');

    const fromHeader = `${payload.name || 'Optix user'}${
      payload.email ? ` <${payload.email}>` : ''
    }`;

    const emailBody = [
      `From: ${fromHeader}`,
      `Category: ${payload.category}`,
      '',
      payload.message,
      '',
      '---',
      'Diagnostics:',
      diagText,
    ].join('\n');

    // --- Send via nodemailer ---
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: true, // SSL on port 465
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASSWORD.value(),
      },
    });

    try {
      await transporter.sendMail({
        from: `"Optix Support Form" <${SMTP_USER}>`,
        to: SUPPORT_TO,
        subject: `[Optix ${payload.category}] ${payload.subject}`,
        text: emailBody,
        ...(replyTo !== SMTP_USER ? { replyTo } : {}),
      });
      logger.info(
        `[submitFeedback] delivered category=${payload.category} authenticated=${
          verifiedUser !== null
        }`,
      );
      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error('[submitFeedback] nodemailer error', err);
      res.status(500).json({ ok: false, error: 'send_failed' });
    }
  },
);
