// Lazy firebase-admin initialization, modeled on the pilot server file
// ~/workspace/workstreams/pilot-impl/repo/src/Firebase/firebase.ts
// Rules:
// - Nothing is initialized at import time.
// - If FIREBASE_AUTH_EMULATOR_HOST is set, initialize with only a project id
//   and no credential (emulator mode).
// - Else if the FIREBASE_* service account variables are present, initialize
//   with a cert built exactly as the pilot file does.
// - Else Firebase is not configured: verifyIdToken throws NotConfiguredError
//   and callers (notably /admin/accounts) degrade gracefully. The server must
//   never crash at boot because Firebase is unconfigured.
import * as admin from 'firebase-admin';

export class NotConfiguredError extends Error {
  code = 'firebase/not-configured';
  constructor(message = 'Firebase is not configured.') {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export const isFirebaseConfigured = (): boolean => {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) return true;
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_PRIVATE_KEY &&
      process.env.FIREBASE_CLIENT_EMAIL,
  );
};

let app: admin.app.App | undefined;

const getApp = (): admin.app.App => {
  if (app) return app;
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    app = admin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID || 'beerpassport-local',
    });
    return app;
  }
  if (!isFirebaseConfigured()) {
    throw new NotConfiguredError();
  }
  app = admin.initializeApp({
    credential: admin.credential.cert({
      type: process.env.FIREBASE_TYPE,
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: process.env.FIREBASE_AUTH_URI,
      token_uri: process.env.FIREBASE_TOKEN_URI,
      auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
      universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
    } as admin.ServiceAccount),
  });
  return app;
};

export type AuthVerifier = {
  configured: boolean;
  verifyIdToken: (token: string) => Promise<any>;
  listUsers: (
    maxResults?: number,
    pageToken?: string,
  ) => Promise<{ users: any[]; pageToken?: string }>;
  getUserByEmail?: (email: string) => Promise<{ uid: string; disabled: boolean; emailVerified: boolean }>;
};

export const getAuthVerifier = (): AuthVerifier => {
  const configured = isFirebaseConfigured();
  return {
    configured,
    verifyIdToken: async (token: string) => {
      if (!configured) throw new NotConfiguredError();
      return getApp().auth().verifyIdToken(token, true);
    },
    listUsers: async (maxResults = 100, pageToken?: string) => {
      if (!configured) throw new NotConfiguredError();
      const result: any = await getApp().auth().listUsers(maxResults, pageToken);
      return { users: result.users || [], pageToken: result.pageToken };
    },
    getUserByEmail: async (email: string) => {
      if (!configured) throw new NotConfiguredError();
      return getApp().auth().getUserByEmail(email);
    },
  };
};
