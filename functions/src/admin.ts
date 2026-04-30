// Single Firebase Admin SDK initialisation. All other modules import the
// already-initialised handles rather than calling `initializeApp` themselves
// — Cloud Functions instances persist across invocations, so doing the init
// once at module load is correct and cheap.

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  initializeApp();
}

export const auth = getAuth();
export const db = getFirestore();
