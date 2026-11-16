// Send one founder-approved message to one person. Emails only go to addresses that came from a
// named source (never guessed), must carry an opt-out line, and are capped per day. LinkedIn
// messages are not here on purpose: LinkedIn offers no messaging API, so they stay copy-and-open.
import { HttpError, type Env } from "../env";
import { getJson, usable } from "../providers";
import { appendLog, bumpDaily } from "../store";

type Fetch = typeof fetch;

export type MessageRequest = {
  channel: "gmail" | "outlook" | "x_dm";
  to: string;                 // email address, or @handle for X
  subject?: string;
  text: string;
  recipient_source?: string;  // where the email address came from (file name or source URL)
};

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
export const OPT_OUT = /unsubscribe|opt[\s-]?out|(not|no longer)\s+(to\s+)?(hear|receive|be contacted)|reply\s+["“]?stop/i;

export function validateMessage(m: MessageRequest): string | null {
  if (!m || !["gmail", "outlook", "x_dm"].includes(m.channel)) return "Choose Gmail, Outlook, or X.";
  if (typeof m.text !== "string" || !m.text.trim()) return "Message text is required.";
  if (/\[[^\]]+\]/.test(m.text) || /\[[^\]]+\]/.test(m.subject ?? "")) return "Fill in the [bracketed] parts before sending.";
  if (m.channel === "x_dm") {
    if (!/^@?[A-Za-z0-9_]{1,15}$/.test(m.to)) return "Enter the investor's X handle, like @name.";
    if ([...m.text].length > 10000) return "X messages can be up to 10,000 characters.";
    return null;
  }
  if (!EMAIL.test(m.to)) return "That email address doesn't look valid.";
  if (!m.recipient_source?.trim()) return "Emails can only go to addresses with a recorded source (your file or a source link).";
  if (!m.subject?.trim()) return "Add a subject line.";
  if (/[\r\n]/.test(m.subject) || /[\r\n]/.test(m.to)) return "Subject and address must be a single line.";
  if (!OPT_OUT.test(m.text)) return "Add an opt-out line (for example: \"If you'd rather not hear from me, reply and I won't follow up.\").";
  return null;
}

const utf8b64 = (s: string) => { let b = ""; for (const c of new TextEncoder().encode(s)) b += String.fromCharCode(c); return btoa(b); };

/** RFC 5322 message for the Gmail API, base64url encoded. */
export function rfc822(from: string, to: string, subject: string, text: string): string {
  const raw = [`From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${utf8b64(subject)}?=`, "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", utf8b64(text.replace(/\r?\n/g, "\r\n"))].join("\r\n");
  return utf8b64(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendMessage(env: Env, m: MessageRequest, f: Fetch = fetch): Promise<{ ok: true; ref: string | null; channel: string }> {
  const problem = validateMessage(m);
  if (problem) throw new HttpError(400, problem);
  const isEmail = m.channel !== "x_dm";
  const limit = Number(isEmail ? env.DAILY_EMAIL_LIMIT || 40 : env.DAILY_DM_LIMIT || 20);
  if ((await bumpDaily(env, isEmail ? "email" : "dm", limit)) < 0) throw new HttpError(429, `Daily limit of ${limit} ${isEmail ? "emails" : "X messages"} reached. This protects your accounts from spam flags.`);
  let ref: string | null = null;
  try {
    if (m.channel === "gmail") {
      const c = await usable(env, "google", f);
      const res = await f("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST",
        headers: { Authorization: `Bearer ${c.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rfc822(c.account.email || "me", m.to, m.subject!, m.text) }) });
      const j = await res.json() as any;
      if (!res.ok) throw new HttpError(502, `Gmail: ${j.error?.message || res.status}`);
      ref = j.id ?? null;
    } else if (m.channel === "outlook") {
      const c = await usable(env, "microsoft", f);
      const res = await f("https://graph.microsoft.com/v1.0/me/sendMail", { method: "POST",
        headers: { Authorization: `Bearer ${c.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { subject: m.subject, body: { contentType: "Text", content: m.text }, toRecipients: [{ emailAddress: { address: m.to } }] }, saveToSentItems: true }) });
      if (!res.ok) throw new HttpError(502, `Outlook: ${(await res.json().catch(() => ({})) as any).error?.message || res.status}`);
    } else {
      const c = await usable(env, "x", f);
      const handle = m.to.replace(/^@/, "");
      const u = await getJson(f, `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`, c.access_token);
      if (!u.data?.id) throw new HttpError(404, `X account @${handle} wasn't found.`);
      const res = await f(`https://api.x.com/2/dm_conversations/with/${u.data.id}/messages`, { method: "POST",
        headers: { Authorization: `Bearer ${c.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: m.text }) });
      const j = await res.json() as any;
      if (!res.ok) throw new HttpError(502, `X: ${j.detail || j.title || res.status}. They may not accept messages from accounts they don't follow.`);
      ref = j.data?.dm_event_id ?? null;
    }
  } catch (e) {
    await appendLog(env, { at: new Date().toISOString(), kind: "message", channel: m.channel, target: m.to, ok: false, error: (e as Error).message });
    throw e;
  }
  await appendLog(env, { at: new Date().toISOString(), kind: "message", channel: m.channel, target: m.to, ok: true, ref: ref ?? undefined });
  return { ok: true, ref, channel: m.channel };
}
