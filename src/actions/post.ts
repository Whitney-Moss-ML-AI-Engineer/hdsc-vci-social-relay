// Publish a founder-approved post to the founder's own accounts. One request = one approved post,
// sent to the targets the founder ticked. No scheduling, no bulk, no posting on anyone else's behalf.
import { HttpError, graphVersion, linkedinVersion, type Env } from "../env";
import { getJson, usable } from "../providers";
import { appendLog, putMedia } from "../store";
import { exportDesign } from "./canva";

type Fetch = typeof fetch;

export type Target = "linkedin" | "x" | "facebook" | "instagram" | "tiktok";
export type PostRequest = {
  text: string;
  targets: Target[];
  page_id?: string;                  // Facebook Page (and its linked Instagram account) to post as
  media?: { canva_design_id?: string; url?: string; kind: "image" | "video"; alt?: string } | null;
  tiktok?: { mode: "draft" | "direct"; privacy?: string } | null;
};
export type PostResult = { target: Target; ok: boolean; ref?: string; url?: string; note?: string; error?: string };

export const LIMITS: Record<Target, number> = { linkedin: 3000, x: 280, facebook: 63206, instagram: 2200, tiktok: 2200 };

/** LinkedIn "little text" commentary treats these characters as markup unless escaped. */
export function escapeLinkedIn(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, m => "\\" + m);
}

/** X counts every URL as 23 characters. */
export function xLength(text: string): number {
  return [...text.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
}

export function validatePost(r: PostRequest): string | null {
  if (!r || typeof r.text !== "string") return "Post text is required.";
  if (!Array.isArray(r.targets) || !r.targets.length) return "Choose at least one place to post.";
  for (const t of r.targets) {
    if (!(t in LIMITS)) return `Unknown target ${t}.`;
    const len = t === "x" ? xLength(r.text) : [...r.text].length;
    if (len > LIMITS[t]) return `Text is ${len} characters; ${t} allows ${LIMITS[t]}.`;
  }
  if (!r.text.trim() && !r.media) return "Add text or a design.";
  if ((r.targets.includes("instagram") || r.targets.includes("tiktok")) && !r.media) return "Instagram and TikTok posts need an image or video.";
  if (r.media?.url && !/^https:\/\//.test(r.media.url)) return "Media links must be https.";
  if (r.media?.kind === "video" && r.targets.includes("linkedin")) return "Video posting to LinkedIn isn't supported here yet. Post the video to the other apps or share an image.";
  return null;
}

type Media = { bytes: Uint8Array<ArrayBuffer>; type: string; url: string };

async function loadMedia(env: Env, m: NonNullable<PostRequest["media"]>, format: "png" | "jpg" | "mp4", f: Fetch): Promise<Media> {
  const url = m.canva_design_id ? (await exportDesign(env, m.canva_design_id, format, f))[0] : m.url!;
  const res = await f(url);
  if (!res.ok) throw new HttpError(502, "Couldn't download the design for posting.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 64 * 1024 * 1024) throw new HttpError(413, "Media is larger than 64 MB.");
  return { bytes, type: res.headers.get("content-type") || (format === "mp4" ? "video/mp4" : `image/${format === "jpg" ? "jpeg" : "png"}`), url };
}

async function postLinkedIn(env: Env, r: PostRequest, media: Media | null, f: Fetch): Promise<PostResult> {
  const c = await usable(env, "linkedin", f);
  const author = env.LINKEDIN_ORG_ID ? `urn:li:organization:${env.LINKEDIN_ORG_ID}` : `urn:li:person:${c.account.id}`;
  const h = { Authorization: `Bearer ${c.access_token}`, "LinkedIn-Version": linkedinVersion(env), "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" };
  let content: unknown;
  if (media) {
    const init = await f("https://api.linkedin.com/rest/images?action=initializeUpload", { method: "POST", headers: h, body: JSON.stringify({ initializeUploadRequest: { owner: author } }) });
    const ij = await init.json() as any;
    if (!init.ok) throw new HttpError(502, "LinkedIn didn't accept the image upload.", ij);
    const up = await f(ij.value.uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${c.access_token}`, "Content-Type": media.type }, body: media.bytes });
    if (!up.ok) throw new HttpError(502, "LinkedIn image upload failed.");
    content = { media: { id: ij.value.image, altText: (r.media?.alt || "").slice(0, 4086) } };
  }
  const res = await f("https://api.linkedin.com/rest/posts", { method: "POST", headers: h, body: JSON.stringify({
    author, commentary: escapeLinkedIn(r.text), visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false, ...(content ? { content } : {}),
  }) });
  if (!res.ok) throw new HttpError(502, `LinkedIn rejected the post (${res.status}).`, await res.text());
  const id = res.headers.get("x-restli-id") || "";
  return { target: "linkedin", ok: true, ref: id, url: id ? `https://www.linkedin.com/feed/update/${id}/` : undefined };
}

async function postX(r: PostRequest, media: Media | null, env: Env, f: Fetch): Promise<PostResult> {
  const c = await usable(env, "x", f);
  let mediaIds: string[] | undefined;
  if (media) {
    if (media.bytes.length > 5 * 1024 * 1024) throw new HttpError(413, "X images must be under 5 MB.");
    const form = new FormData();
    form.set("media", new Blob([media.bytes], { type: media.type }), "post");
    form.set("media_category", media.type.startsWith("video") ? "tweet_video" : "tweet_image");
    const up = await f("https://api.x.com/2/media/upload", { method: "POST", headers: { Authorization: `Bearer ${c.access_token}` }, body: form });
    const uj = await up.json() as any;
    if (!up.ok || !uj.data?.id) throw new HttpError(502, "X didn't accept the media.", uj);
    mediaIds = [uj.data.id];
  }
  const res = await f("https://api.x.com/2/tweets", { method: "POST", headers: { Authorization: `Bearer ${c.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: r.text, ...(mediaIds ? { media: { media_ids: mediaIds } } : {}) }) });
  const j = await res.json() as any;
  if (!res.ok) throw new HttpError(502, `X rejected the post: ${j.detail || j.title || res.status}`, j);
  return { target: "x", ok: true, ref: j.data.id, url: `https://x.com/${c.account.name.replace(/^@/, "")}/status/${j.data.id}` };
}

async function metaPage(env: Env, pageId: string | undefined, f: Fetch) {
  const c = await usable(env, "meta", f);
  const pages = c.pages ?? [];
  const page = pageId ? pages.find(p => p.id === pageId) : pages[0];
  if (!page) throw new HttpError(409, pages.length ? "That Facebook Page isn't connected." : "No Facebook Page was shared when you connected. Reconnect and tick your HDSC Page.");
  return page;
}

async function graph(env: Env, f: Fetch, path: string, params: Record<string, string>) {
  const res = await f(`https://graph.facebook.com/${graphVersion(env)}/${path}`, { method: "POST", body: new URLSearchParams(params) });
  const j = await res.json() as any;
  if (!res.ok || j.error) throw new HttpError(502, `Meta: ${j.error?.message || res.status}`, j);
  return j;
}

async function postFacebook(env: Env, r: PostRequest, media: Media | null, f: Fetch): Promise<PostResult> {
  const page = await metaPage(env, r.page_id, f);
  const tok = page.access_token;
  let j: any;
  if (media?.type.startsWith("video")) j = await graph(env, f, `${page.id}/videos`, { file_url: media.url, description: r.text, access_token: tok });
  else if (media) j = await graph(env, f, `${page.id}/photos`, { url: media.url, caption: r.text, access_token: tok });
  else j = await graph(env, f, `${page.id}/feed`, { message: r.text, access_token: tok });
  const id = j.post_id || j.id;
  return { target: "facebook", ok: true, ref: id, url: `https://www.facebook.com/${id}` };
}

async function postInstagram(env: Env, r: PostRequest, media: Media, f: Fetch, pollMs: number): Promise<PostResult> {
  const page = await metaPage(env, r.page_id, f);
  if (!page.instagram) throw new HttpError(409, `The Page "${page.name}" has no Instagram professional account linked.`);
  const ig = page.instagram.id, tok = page.access_token;
  const isVideo = media.type.startsWith("video");
  const container = await graph(env, f, `${ig}/media`, isVideo
    ? { media_type: "REELS", video_url: media.url, caption: r.text, access_token: tok }
    : { image_url: media.url, caption: r.text, access_token: tok });
  for (let i = 0; i < 30; i++) {
    const s = await getJson(f, `https://graph.facebook.com/${graphVersion(env)}/${container.id}?fields=status_code&access_token=${encodeURIComponent(tok)}`, tok);
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR") throw new HttpError(502, "Instagram couldn't process the media.");
    await new Promise(res => setTimeout(res, pollMs));
  }
  const pub = await graph(env, f, `${ig}/media_publish`, { creation_id: container.id, access_token: tok });
  return { target: "instagram", ok: true, ref: pub.id, note: page.instagram.username ? `@${page.instagram.username}` : undefined };
}

async function postTikTok(env: Env, r: PostRequest, media: Media, f: Fetch): Promise<PostResult> {
  const c = await usable(env, "tiktok", f);
  const h = { Authorization: `Bearer ${c.access_token}`, "Content-Type": "application/json; charset=UTF-8" };
  const mode = r.tiktok?.mode ?? "draft";
  const tt = async (path: string, body: unknown) => {
    const res = await f(`https://open.tiktokapis.com/v2/post/publish/${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
    const j = await res.json() as any;
    if (!res.ok || (j.error?.code && j.error.code !== "ok")) throw new HttpError(502, `TikTok: ${j.error?.message || res.status}`, j);
    return j.data;
  };
  let privacy = r.tiktok?.privacy || "SELF_ONLY";
  if (mode === "direct") {
    const info = await tt("creator_info/query/", {});
    const allowed: string[] = info.privacy_level_options ?? [];
    if (!allowed.includes(privacy)) privacy = allowed.includes("SELF_ONLY") ? "SELF_ONLY" : allowed[0];
  }
  const caption = r.text.slice(0, 2200);
  if (media.type.startsWith("video")) {
    const size = media.bytes.length;
    const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 };
    const d = mode === "draft" ? await tt("inbox/video/init/", { source_info })
      : await tt("video/init/", { post_info: { title: caption, privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false }, source_info });
    const up = await f(d.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${size - 1}/${size}` }, body: media.bytes });
    if (!up.ok) throw new HttpError(502, "TikTok video upload failed.");
    return { target: "tiktok", ok: true, ref: d.publish_id, note: mode === "draft" ? "Sent to your TikTok inbox. Open TikTok to finish and post it." : `Posted (${privacy}).` };
  }
  // Photo posts: TikTok pulls the image from this relay's address, which must be verified in the TikTok developer portal.
  const id = await putMedia(env, media.bytes, media.type);
  const photoUrl = `${env.PUBLIC_URL.replace(/\/$/, "")}/v1/media/${id}`;
  const d = await tt("content/init/", {
    post_info: { title: caption.slice(0, 90), description: caption, privacy_level: privacy, disable_comment: false },
    source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: [photoUrl] },
    post_mode: mode === "draft" ? "MEDIA_UPLOAD" : "DIRECT_POST", media_type: "PHOTO",
  });
  return { target: "tiktok", ok: true, ref: d.publish_id, note: mode === "draft" ? "Sent to your TikTok inbox. Open TikTok to finish and post it." : `Posted (${privacy}).` };
}

export async function publish(env: Env, r: PostRequest, f: Fetch = fetch, pollMs = 2000): Promise<PostResult[]> {
  const problem = validatePost(r);
  if (problem) throw new HttpError(400, problem);
  const cache = new Map<string, Promise<Media>>();
  const media = (format: "png" | "jpg" | "mp4") => {
    if (!r.media) return Promise.resolve(null);
    const fm = r.media.kind === "video" ? "mp4" : format;
    if (!cache.has(fm)) cache.set(fm, loadMedia(env, r.media, fm, f));
    return cache.get(fm)!;
  };
  const results: PostResult[] = [];
  for (const t of r.targets) {
    try {
      let out: PostResult;
      if (t === "linkedin") out = await postLinkedIn(env, r, await media("png"), f);
      else if (t === "x") out = await postX(r, await media("png"), env, f);
      else if (t === "facebook") out = await postFacebook(env, r, await media("png"), f);
      else if (t === "instagram") out = await postInstagram(env, r, (await media("jpg"))!, f, pollMs);
      else out = await postTikTok(env, r, (await media("jpg"))!, f);
      results.push(out);
      await appendLog(env, { at: new Date().toISOString(), kind: "post", channel: t, target: "own account", ok: true, ref: out.ref });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ target: t, ok: false, error: msg });
      await appendLog(env, { at: new Date().toISOString(), kind: "post", channel: t, target: "own account", ok: false, error: msg });
    }
  }
  return results;
}
