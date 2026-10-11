// Admin sign-in. Production: Firebase phone sign-in (same identity system as the app; admin
// accounts are claimed by their verified phone number). Development (AUTH_MODE=dev): a user id.
const cfg = window.HW_CONFIG ?? { authMode: 'dev', firebase: {} };
const DEV_KEY = 'hw.admin.devUserId';
const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2';

let firebaseAuth = null;
let unauthorizedHandler = () => {};

export const mode = cfg.authMode === 'dev' ? 'dev' : 'firebase';

export function onUnauthorized() {
  unauthorizedHandler();
}
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

async function loadFirebase() {
  if (firebaseAuth) return firebaseAuth;
  if (!cfg.firebase?.apiKey) throw new Error('Firebase web config is missing (FIREBASE_WEB_API_KEY / FIREBASE_AUTH_DOMAIN).');
  const { initializeApp } = await import(`${FIREBASE}/firebase-app.js`);
  const auth = await import(`${FIREBASE}/firebase-auth.js`);
  const app = initializeApp({ apiKey: cfg.firebase.apiKey, authDomain: cfg.firebase.authDomain, projectId: cfg.firebase.projectId });
  firebaseAuth = { ...auth, instance: auth.getAuth(app) };
  await auth.setPersistence(firebaseAuth.instance, auth.browserSessionPersistence);
  return firebaseAuth;
}

export async function authHeaders() {
  if (mode === 'dev') {
    const id = localStorage.getItem(DEV_KEY);
    return id ? { 'x-dev-user-id': id } : {};
  }
  const fb = await loadFirebase().catch(() => null);
  const user = fb?.instance.currentUser;
  return user ? { Authorization: `Bearer ${await user.getIdToken()}` } : {};
}

/** Resolves once the persisted session (if any) is known. */
export async function ready() {
  if (mode === 'dev') return !!localStorage.getItem(DEV_KEY);
  const fb = await loadFirebase().catch(() => null);
  if (!fb) return false;
  await fb.instance.authStateReady();
  return !!fb.instance.currentUser;
}

export function devSignIn(userId) {
  localStorage.setItem(DEV_KEY, userId);
}

/** Starts phone sign-in with an invisible reCAPTCHA; returns a function that confirms the SMS code. */
export async function startPhoneSignIn(phone, recaptchaContainerId) {
  const fb = await loadFirebase();
  const verifier = new fb.RecaptchaVerifier(fb.instance, recaptchaContainerId, { size: 'invisible' });
  const confirmation = await fb.signInWithPhoneNumber(fb.instance, phone, verifier);
  return (code) => confirmation.confirm(code);
}

export async function signOut() {
  if (mode === 'dev') localStorage.removeItem(DEV_KEY);
  else {
    const fb = await loadFirebase().catch(() => null);
    if (fb) await fb.signOut(fb.instance);
  }
}
