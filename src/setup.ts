// Guided setup: step-by-step instructions per app (served to the apps' Connections screen) and
// owner-only storage of each app's client ID and secret, sealed in KV, so the founder can paste
// keys in the app instead of running `wrangler secret put`. Worker secrets, when set, take priority.
import { open, seal } from "./crypto";
import { HttpError, type Env } from "./env";
import type { ProviderId } from "./store";

export type CredentialTarget = ProviderId | "anthropic";

const ENV_KEYS: Record<CredentialTarget, [keyof Env, keyof Env | null]> = {
  linkedin: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  microsoft: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  x: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
  meta: ["META_APP_ID", "META_APP_SECRET"],
  tiktok: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  canva: ["CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET"],
  anthropic: ["ANTHROPIC_API_KEY", null],
};

type Stored = Partial<Record<CredentialTarget, { id: string; secret?: string; saved_at: string }>>;

async function readStored(env: Env): Promise<Stored> {
  const v = await env.STORE.get("creds");
  return v ? open<Stored>(env.TOKEN_KEY, v) : {};
}

/** Env with any stored credentials filled in where no Worker secret is set. */
export async function effectiveEnv(env: Env): Promise<Env> {
  const stored = await readStored(env).catch(() => ({} as Stored));
  const out = { ...env } as Record<string, unknown>;
  for (const [t, c] of Object.entries(stored) as [CredentialTarget, NonNullable<Stored[CredentialTarget]>][]) {
    const [idKey, secretKey] = ENV_KEYS[t];
    if (!out[idKey]) out[idKey] = c.id;
    if (secretKey && !out[secretKey] && c.secret) out[secretKey] = c.secret;
  }
  return out as unknown as Env;
}

export function credentialSource(env: Env, stored: Stored, t: CredentialTarget): "worker_secret" | "app" | null {
  const [idKey] = ENV_KEYS[t];
  if (env[idKey]) return "worker_secret";
  return stored[t] ? "app" : null;
}

const CLEAN = /^[\x21-\x7e]{4,512}$/; // printable, no spaces or newlines

export async function saveCredentials(env: Env, t: string, body: { client_id?: string; client_secret?: string }) {
  if (!(t in ENV_KEYS)) throw new HttpError(404, "Unknown app.");
  const target = t as CredentialTarget;
  const id = String(body?.client_id ?? "").trim();
  const secret = String(body?.client_secret ?? "").trim();
  if (!CLEAN.test(id)) throw new HttpError(400, target === "anthropic" ? "Paste the API key." : "Paste the client ID (it has no spaces).");
  if (ENV_KEYS[target][1] && !CLEAN.test(secret)) throw new HttpError(400, "Paste the client secret (it has no spaces).");
  if (target === "anthropic" && !id.startsWith("sk-ant-")) throw new HttpError(400, "Anthropic API keys start with sk-ant-.");
  const stored = await readStored(env);
  stored[target] = { id, secret: secret || undefined, saved_at: new Date().toISOString() };
  await env.STORE.put("creds", await seal(env.TOKEN_KEY, stored));
  return { ok: true, saved: target };
}

export async function deleteCredentials(env: Env, t: string) {
  if (!(t in ENV_KEYS)) throw new HttpError(404, "Unknown app.");
  const stored = await readStored(env);
  delete stored[t as CredentialTarget];
  await env.STORE.put("creds", await seal(env.TOKEN_KEY, stored));
  return { ok: true };
}

export type Guide = {
  id: CredentialTarget; label: string; portal: string; minutes: number; cost: string;
  steps: string[]; id_label: string; secret_label: string | null; notes: string[];
};

export const GUIDES: Guide[] = [
  { id: "canva", label: "Canva", portal: "https://www.canva.com/developers/integrations/connect-api", minutes: 5, cost: "Free",
    steps: ["Sign in to Canva and open the Developer Portal → Your integrations → Create an integration.",
      "Give it a name like \"HDSC VC Intelligence\" and accept the terms.",
      "Under Scopes, turn on: design:meta (read), design:content (read and write), profile (read), asset (read).",
      "Under Authentication, add the redirect URL shown below.",
      "Copy the Client ID, then click Generate secret and copy the secret."],
    id_label: "Client ID", secret_label: "Client secret", notes: ["Works for your own Canva account without Canva's review."] },
  { id: "linkedin", label: "LinkedIn", portal: "https://www.linkedin.com/developers/apps/new", minutes: 10, cost: "Free",
    steps: ["Create an app. LinkedIn asks you to pick a Company Page; choose your HDSC page.",
      "Products tab: request \"Sign In with LinkedIn using OpenID Connect\" and \"Share on LinkedIn\" (both are approved instantly).",
      "Auth tab: under Authorized redirect URLs, add the redirect URL shown below.",
      "Auth tab: copy the Client ID and the Primary Client Secret."],
    id_label: "Client ID", secret_label: "Primary client secret", notes: ["This lets the app post to your profile. LinkedIn does not allow apps to send messages, so those stay copy-and-open."] },
  { id: "google", label: "Gmail", portal: "https://console.cloud.google.com/projectcreate", minutes: 15, cost: "Free",
    steps: ["Create a project (any name).",
      "APIs & Services → Library: search for Gmail API and click Enable.",
      "APIs & Services → OAuth consent screen: choose External, fill in the app name and your email, and add yourself as a Test user.",
      "Data access (scopes): add …/auth/gmail.send.",
      "Credentials → Create credentials → OAuth client ID → Web application. Under Authorized redirect URIs, add the redirect URL shown below.",
      "Copy the Client ID and Client secret."],
    id_label: "Client ID", secret_label: "Client secret",
    notes: ["While the Google app is in Testing, Google asks you to sign in again every 7 days. Publishing the consent screen removes that."] },
  { id: "microsoft", label: "Outlook", portal: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", minutes: 10, cost: "Free",
    steps: ["New registration. Supported account types: \"Any organizational directory and personal Microsoft accounts\".",
      "Redirect URI: choose Web and paste the redirect URL shown below. Click Register.",
      "Copy the Application (client) ID from the Overview page.",
      "Certificates & secrets → New client secret. Copy the Value (not the Secret ID) right away; it is shown once.",
      "API permissions → Add → Microsoft Graph → Delegated: Mail.Send, User.Read, offline_access."],
    id_label: "Application (client) ID", secret_label: "Client secret value", notes: [] },
  { id: "x", label: "X", portal: "https://developer.x.com/en/portal/dashboard", minutes: 10, cost: "Posting and DMs need one of X's paid API plans",
    steps: ["Sign up for X API access and open your Project → App.",
      "User authentication settings → Set up. App permissions: Read and write and Direct message.",
      "Type of App: Web App, Automated App or Bot (confidential client).",
      "Callback URI: paste the redirect URL shown below. Website URL: your company website.",
      "Keys and tokens → OAuth 2.0 Client ID and Client Secret: copy both."],
    id_label: "OAuth 2.0 Client ID", secret_label: "OAuth 2.0 Client Secret", notes: [] },
  { id: "meta", label: "Facebook + Instagram", portal: "https://developers.facebook.com/apps/creation/", minutes: 20, cost: "Free",
    steps: ["Create app → use case \"Other\" → app type Business.",
      "Add the products Facebook Login for Business and Instagram (API setup with Facebook login).",
      "Facebook Login settings → Valid OAuth Redirect URIs: paste the redirect URL shown below.",
      "Make sure your Instagram is a Professional (Business or Creator) account linked to your Facebook Page.",
      "App settings → Basic: copy the App ID and App Secret."],
    id_label: "App ID", secret_label: "App secret",
    notes: ["In Development mode the app works for you as its admin, which is all you need. When you connect, tick your HDSC Page."] },
  { id: "tiktok", label: "TikTok", portal: "https://developers.tiktok.com/apps/", minutes: 15, cost: "Free",
    steps: ["Connect an app and fill in the basic details.",
      "Add products: Login Kit and Content Posting API.",
      "Login Kit → Redirect URI: paste the redirect URL shown below.",
      "Scopes: user.info.basic, video.upload, video.publish.",
      "For photo posts: URL properties → verify the media address shown below.",
      "Copy the Client key and Client secret."],
    id_label: "Client key", secret_label: "Client secret",
    notes: ["Until TikTok reviews your app, direct posts are private. Sending to your TikTok inbox works right away."] },
  { id: "anthropic", label: "AI polish (optional)", portal: "https://console.anthropic.com/settings/keys", minutes: 3, cost: "Pay as you go",
    steps: ["Create an API key.", "Copy it (it starts with sk-ant-)."],
    id_label: "API key", secret_label: null, notes: ["Turns on the Polish with AI button in Scripts. It rewrites tone only and never adds facts."] },
];

export async function setupInfo(env: Env) {
  const stored = await readStored(env).catch(() => ({} as Stored));
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  return {
    relay: base,
    media_prefix: `${base}/v1/media/`,
    guides: GUIDES.map(g => ({ ...g,
      redirect_uri: g.id === "anthropic" ? null : `${base}/v1/callback/${g.id}`,
      keys_saved: credentialSource(env, stored, g.id) })),
  };
}
