// Canva Connect: list your designs, start a new design at a social size, export a design for posting.
import { HttpError, type Env } from "../env";
import { getJson, usable } from "../providers";

type Fetch = typeof fetch;
const API = "https://api.canva.com/rest/v1";

export type CanvaDesign = { id: string; title: string; thumbnail: string | null; edit_url: string | null; view_url: string | null; updated_at: number | null };

export async function listDesigns(env: Env, query = "", continuation = "", f: Fetch = fetch) {
  const c = await usable(env, "canva", f);
  const q = new URLSearchParams({ ownership: "any", sort_by: "modified_descending" });
  if (query) q.set("query", query.slice(0, 255));
  if (continuation) q.set("continuation", continuation);
  const j = await getJson(f, `${API}/designs?${q}`, c.access_token);
  const items: CanvaDesign[] = (j.items ?? []).map((d: any) => ({
    id: d.id, title: d.title || "Untitled design", thumbnail: d.thumbnail?.url ?? null,
    edit_url: d.urls?.edit_url ?? null, view_url: d.urls?.view_url ?? null, updated_at: d.updated_at ?? null,
  }));
  return { items, continuation: j.continuation ?? null };
}

export const SIZES: Record<string, { width: number; height: number; label: string }> = {
  square: { width: 1080, height: 1080, label: "Square post 1080×1080 (Instagram, Facebook, LinkedIn)" },
  portrait: { width: 1080, height: 1350, label: "Portrait post 1080×1350 (Instagram, LinkedIn)" },
  story: { width: 1080, height: 1920, label: "Story / Reel / TikTok 1080×1920" },
  landscape: { width: 1200, height: 627, label: "Link image 1200×627 (LinkedIn, X, Facebook)" },
};

export async function createDesign(env: Env, size: string, title: string, f: Fetch = fetch) {
  const s = SIZES[size];
  if (!s) throw new HttpError(400, "Unknown design size.");
  const c = await usable(env, "canva", f);
  const res = await f(`${API}/designs`, {
    method: "POST", headers: { Authorization: `Bearer ${c.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ design_type: { type: "custom", width: s.width, height: s.height }, title: (title || "HDSC post").slice(0, 255) }),
  });
  const j = await res.json() as any;
  if (!res.ok) throw new HttpError(502, "Canva couldn't create the design.", j);
  return { id: j.design.id, edit_url: j.design.urls?.edit_url, view_url: j.design.urls?.view_url };
}

export type ExportFormat = "png" | "jpg" | "pdf" | "mp4";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function exportDesign(env: Env, designId: string, format: ExportFormat, f: Fetch = fetch, pollMs = 1500): Promise<string[]> {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(designId)) throw new HttpError(400, "Invalid design id.");
  const c = await usable(env, "canva", f);
  const fmt = format === "jpg" ? { type: "jpg", quality: 92 } : format === "mp4" ? { type: "mp4", quality: "vertical_1080p" } : { type: format };
  const res = await f(`${API}/exports`, {
    method: "POST", headers: { Authorization: `Bearer ${c.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ design_id: designId, format: fmt }),
  });
  let job = ((await res.json()) as any).job;
  if (!res.ok || !job) throw new HttpError(502, "Canva couldn't start the export.");
  for (let i = 0; i < 40 && job.status === "in_progress"; i++) {
    await sleep(pollMs);
    job = (await getJson(f, `${API}/exports/${job.id}`, c.access_token)).job;
  }
  if (job.status !== "success") throw new HttpError(502, `Canva export ${job.status === "in_progress" ? "is taking too long; try again" : "failed"}.`, job.error);
  return job.urls as string[];
}
