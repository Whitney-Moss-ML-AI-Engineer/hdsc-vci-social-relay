// Optional: tighten a generated script with Claude. Only runs if ANTHROPIC_API_KEY is set.
// The model is told to keep every fact, name, number and [placeholder] and to add none.
import { HttpError, type Env } from "../env";

type Fetch = typeof fetch;

export const POLISH_RULES = `You edit outreach and social copy for a founder. Rewrite the text to be clearer and more engaging in the requested tone.
Rules: Do not add any facts, numbers, names, customers, traction, quotes, awards, links or claims that are not already in the text.
Keep every [bracketed placeholder] exactly as written. Stay under the character limit. Return only the rewritten text.`;

export async function polish(env: Env, body: { text: string; tone?: string; limit?: number; kind?: string }, f: Fetch = fetch) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(501, "AI polishing isn't set up on your relay (no ANTHROPIC_API_KEY). The built-in scripts still work.");
  const text = String(body?.text ?? "").slice(0, 8000);
  if (!text.trim()) throw new HttpError(400, "Nothing to polish.");
  const limit = Math.min(Math.max(Number(body.limit) || 3000, 50), 8000);
  const res = await f("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 1500, system: POLISH_RULES,
      messages: [{ role: "user", content: `Kind: ${body.kind || "message"}\nTone: ${body.tone || "warm, confident, concise"}\nCharacter limit: ${limit}\n\nText:\n${text}` }],
    }),
  });
  const j = await res.json() as any;
  if (!res.ok) throw new HttpError(502, `Polishing failed: ${j.error?.message || res.status}`);
  const out = (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
  const before = new Set(text.match(/\[[^\]]+\]/g) ?? []);
  const after = new Set(out.match(/\[[^\]]+\]/g) ?? []);
  const lost = [...before].filter(p => !after.has(p));
  return { text: out.slice(0, limit), warnings: lost.length ? [`Placeholders removed by the rewrite: ${lost.join(", ")}. Check before sending.`] : [] };
}
