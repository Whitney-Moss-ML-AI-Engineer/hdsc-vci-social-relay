// OAuth for each connected app: authorize URL, code exchange, refresh, and account identity.
// Every provider uses the founder's own developer app; client secrets live only in Worker secrets.
import { pkceChallenge, randomId } from "./crypto";
import { HttpError, graphVersion, type Env } from "./env";
import { getConnection, saveConnection, type Connection, type MetaPage, type ProviderId } from "./store";

type Fetch = typeof fetch;

type Cfg = {
  id: ProviderId;
  label: string;
  authorize: (env: Env) => string;
  token: (env: Env) => string;
  scopes: (env: Env) => string[];
  scopeSep?: string;
  clientId: (env: Env) => string | undefined;
  clientSecret: (env: Env) => string | undefined;
  clientIdParam?: string;          // TikTok calls it client_key
  basicAuth?: boolean;             // client credentials in Authorization header
  pkce: boolean;
  extraAuth?: Record<string, string>;
};

export const PROVIDERS: Record<ProviderId, Cfg> = {
  linkedin: {
    id: "linkedin", label: "LinkedIn",
    authorize: () => "https://www.linkedin.com/oauth/v2/authorization",
    token: () => "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: env => ["openid", "profile", "w_member_social", ...(env.LINKEDIN_ORG_ID ? ["w_organization_social"] : [])],
    clientId: env => env.LINKEDIN_CLIENT_ID, clientSecret: env => env.LINKEDIN_CLIENT_SECRET, pkce: false,
  },
  google: {
    id: "google", label: "Gmail",
    authorize: () => "https://accounts.google.com/o/oauth2/v2/auth",
    token: () => "https://oauth2.googleapis.com/token",
    scopes: () => ["openid", "email", "https://www.googleapis.com/auth/gmail.send"],
    clientId: env => env.GOOGLE_CLIENT_ID, clientSecret: env => env.GOOGLE_CLIENT_SECRET, pkce: true,
    extraAuth: { access_type: "offline", prompt: "consent" },
  },
  microsoft: {
    id: "microsoft", label: "Outlook",
    authorize: () => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: () => "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: () => ["offline_access", "User.Read", "Mail.Send"],
    clientId: env => env.MICROSOFT_CLIENT_ID, clientSecret: env => env.MICROSOFT_CLIENT_SECRET, pkce: true,
  },
  x: {
    id: "x", label: "X",
    authorize: () => "https://x.com/i/oauth2/authorize",
    token: () => "https://api.x.com/2/oauth2/token",
    scopes: () => ["tweet.read", "tweet.write", "users.read", "dm.read", "dm.write", "media.write", "offline.access"],
    clientId: env => env.X_CLIENT_ID, clientSecret: env => env.X_CLIENT_SECRET, pkce: true, basicAuth: true,
  },
  meta: {
    id: "meta", label: "Facebook + Instagram",
    authorize: env => `https://www.facebook.com/${graphVersion(env)}/dialog/oauth`,
    token: env => `https://graph.facebook.com/${graphVersion(env)}/oauth/access_token`,
    scopes: () => ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish", "business_management"],
    scopeSep: ",", clientId: env => env.META_APP_ID, clientSecret: env => env.META_APP_SECRET, pkce: false,
  },
  tiktok: {
    id: "tiktok", label: "TikTok",
    authorize: () => "https://www.tiktok.com/v2/auth/authorize/",
    token: () => "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: () => ["user.info.basic", "video.upload", "video.publish"],
    scopeSep: ",", clientIdParam: "client_key",
    clientId: env => env.TIKTOK_CLIENT_KEY, clientSecret: env => env.TIKTOK_CLIENT_SECRET, pkce: true,
  },
  canva: {
    id: "canva", label: "Canva",
    authorize: () => "https://www.canva.com/api/oauth/authorize",
    token: () => "https://api.canva.com/rest/v1/oauth/token",
    scopes: () => ["profile:read", "design:meta:read", "design:content:read", "design:content:write", "asset:read"],
    clientId: env => env.CANVA_CLIENT_ID, clientSecret: env => env.CANVA_CLIENT_SECRET, pkce: true, basicAuth: true,
  },
};

export const isProvider = (p: string): p is ProviderId => Object.prototype.hasOwnProperty.call(PROVIDERS, p);
export const configured = (env: Env, p: ProviderId) => !!(PROVIDERS[p].clientId(env) && PROVIDERS[p].clientSecret(env));
export const redirectUri = (env: Env, p: ProviderId) => `${env.PUBLIC_URL.replace(/\/$/, "")}/v1/callback/${p}`;

export async function authorizeUrl(env: Env, p: ProviderId, state: string, verifier: string): Promise<string> {
  const c = PROVIDERS[p];
  const q = new URLSearchParams({
    response_type: "code",
    [c.clientIdParam ?? "client_id"]: c.clientId(env)!,
    redirect_uri: redirectUri(env, p),
    scope: c.scopes(env).join(c.scopeSep ?? " "),
    state,
    ...(c.extraAuth ?? {}),
  });
  if (c.pkce) { q.set("code_challenge", await pkceChallenge(verifier)); q.set("code_challenge_method", "S256"); }
  return `${c.authorize(env)}?${q}`;
}

export const newVerifier = () => randomId(48);

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; open_id?: string };

async function tokenRequest(env: Env, p: ProviderId, params: Record<string, string>, f: Fetch): Promise<TokenResponse> {
  const c = PROVIDERS[p];
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (c.basicAuth) headers.Authorization = "Basic " + btoa(`${c.clientId(env)}:${c.clientSecret(env)}`);
  else { body.set(c.clientIdParam ?? "client_id", c.clientId(env)!); body.set("client_secret", c.clientSecret(env)!); }
  if (c.basicAuth) body.set("client_id", c.clientId(env)!);
  const res = await f(c.token(env), { method: "POST", headers, body });
  const json = await res.json().catch(() => ({})) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new HttpError(502, `${c.label} sign-in failed: ${json.error_description || json.error || res.status}`);
  return json;
}

export async function exchangeCode(env: Env, p: ProviderId, code: string, verifier: string, f: Fetch = fetch): Promise<Connection> {
  const params: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: redirectUri(env, p) };
  if (PROVIDERS[p].pkce) params.code_verifier = verifier;
  let t = await tokenRequest(env, p, params, f);
  if (p === "meta") t = await metaLongLived(env, t.access_token, f);
  const conn: Connection = {
    provider: p, access_token: t.access_token, refresh_token: t.refresh_token, scope: t.scope,
    expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
    account: { id: "", name: "" }, connected_at: new Date().toISOString(),
  };
  await identify(env, conn, f, t.open_id);
  return conn;
}

async function metaLongLived(env: Env, shortToken: string, f: Fetch): Promise<TokenResponse> {
  const q = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: env.META_APP_ID!, client_secret: env.META_APP_SECRET!, fb_exchange_token: shortToken });
  const res = await f(`https://graph.facebook.com/${graphVersion(env)}/oauth/access_token?${q}`);
  const j = await res.json() as TokenResponse;
  return res.ok && j.access_token ? j : { access_token: shortToken };
}

export async function getJson(f: Fetch, url: string, token: string, extra: Record<string, string> = {}) {
  const res = await f(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extra } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Request to ${new URL(url).host} failed (${res.status}).`, j);
  return j as any;
}

async function identify(env: Env, c: Connection, f: Fetch, openId?: string) {
  const t = c.access_token;
  switch (c.provider) {
    case "linkedin": { const u = await getJson(f, "https://api.linkedin.com/v2/userinfo", t); c.account = { id: u.sub, name: u.name ?? "LinkedIn member" }; break; }
    case "google": { const u = await getJson(f, "https://openidconnect.googleapis.com/v1/userinfo", t); c.account = { id: u.sub, name: u.email, email: u.email }; break; }
    case "microsoft": { const u = await getJson(f, "https://graph.microsoft.com/v1.0/me", t); const email = u.mail || u.userPrincipalName; c.account = { id: u.id, name: email, email }; break; }
    case "x": { const u = await getJson(f, "https://api.x.com/2/users/me", t); c.account = { id: u.data.id, name: "@" + u.data.username }; break; }
    case "tiktok": {
      const u = await getJson(f, "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", t);
      c.account = { id: u.data?.user?.open_id ?? openId ?? "", name: u.data?.user?.display_name ?? "TikTok account" }; break;
    }
    case "canva": { const u = await getJson(f, "https://api.canva.com/rest/v1/users/me/profile", t); c.account = { id: "me", name: u.profile?.display_name ?? "Canva" }; break; }
    case "meta": {
      const v = graphVersion(env);
      const me = await getJson(f, `https://graph.facebook.com/${v}/me?fields=id,name`, t);
      const pages = await getJson(f, `https://graph.facebook.com/${v}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=50`, t);
      c.account = { id: me.id, name: me.name };
      c.pages = (pages.data ?? []).map((pg: any): MetaPage => ({ id: pg.id, name: pg.name, access_token: pg.access_token,
        instagram: pg.instagram_business_account ? { id: pg.instagram_business_account.id, username: pg.instagram_business_account.username } : null }));
      break;
    }
  }
}

/** Returns a connection with a fresh access token, refreshing and saving it when it is about to expire. */
export async function usable(env: Env, p: ProviderId, f: Fetch = fetch): Promise<Connection> {
  const c = await getConnection(env, p);
  if (!c) throw new HttpError(409, `${PROVIDERS[p].label} isn't connected. Connect it in the app's Connections screen.`);
  if (!c.expires_at || c.expires_at - Date.now() > 60_000) return c;
  if (!c.refresh_token) throw new HttpError(401, `${PROVIDERS[p].label} sign-in expired. Reconnect it in Connections.`);
  const t = await tokenRequest(env, p, { grant_type: "refresh_token", refresh_token: c.refresh_token }, f);
  c.access_token = t.access_token;
  c.refresh_token = t.refresh_token ?? c.refresh_token;
  c.expires_at = t.expires_in ? Date.now() + t.expires_in * 1000 : undefined;
  await saveConnection(env, c);
  return c;
}
