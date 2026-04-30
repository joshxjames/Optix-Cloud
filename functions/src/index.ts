// Cloud Functions entry — re-exports every function so Firebase's deploy
// can find them. Adding a new function = importing it here.
//
// Layout:
//   - relay         : HTTPS function — the Anthropic streaming proxy
//   - onUserCreate  : Auth trigger — seeds Firestore profile on signup

export { relay } from './relay.js';
export { onUserCreate } from './user-trigger.js';
