// Worker bindings. Secrets are set with `wrangler secret put NAME`; never commit them.
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  STORE: KV;
  PUBLIC_URL: string;              // e.g. https://hdsc-vci-social-relay.<you>.workers.dev
  ALLOWED_ORIGINS?: string;        // comma-separated app origins allowed to call the relay from a browser
  RELAY_OWNER_TOKEN: string;       // long random value; the apps send it as a Bearer token
  TOKEN_KEY: string;               // base64 of 32 random bytes; encrypts stored provider tokens
  LINKEDIN_CLIENT_ID?: string; LINKEDIN_CLIENT_SECRET?: string; LINKEDIN_VERSION?: string; LINKEDIN_ORG_ID?: string;
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string; MICROSOFT_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string; X_CLIENT_SECRET?: string;
  META_APP_ID?: string; META_APP_SECRET?: string; META_GRAPH_VERSION?: string;
  TIKTOK_CLIENT_KEY?: string; TIKTOK_CLIENT_SECRET?: string;
  CANVA_CLIENT_ID?: string; CANVA_CLIENT_SECRET?: string;
  ANTHROPIC_API_KEY?: string; ANTHROPIC_MODEL?: string;
  DAILY_EMAIL_LIMIT?: string; DAILY_DM_LIMIT?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message); }
}

export const graphVersion = (env: Env) => env.META_GRAPH_VERSION || "v23.0";
export const linkedinVersion = (env: Env) => env.LINKEDIN_VERSION || "202610";
