import { describe, expect, it } from "vitest";
declare const Buffer: { from(s: string, enc: string): { length: number } };
// @ts-expect-error plain JS module
import * as W from "../scripts/setup-lib.mjs";

const TOML = `name = "hdsc-vci-social-relay"
[[kv_namespaces]]
binding = "STORE"
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"

[vars]
PUBLIC_URL = "https://hdsc-vci-social-relay.REPLACE.workers.dev"
`;

function harness(opts: { loggedIn?: boolean; secrets?: string; answers?: string[]; state?: object } = {}) {
  const files: Record<string, string> = { "wrangler.toml": TOML };
  if (opts.state) files[W.STATE_FILE] = JSON.stringify(opts.state);
  const calls: { args: string[]; input?: string }[] = [];
  let loggedIn = opts.loggedIn ?? false;
  const run = async (args: string[], o: { input?: string } = {}) => {
    calls.push({ args, input: o.input });
    const a = args.join(" ");
    if (a === "whoami") return { code: 0, out: loggedIn ? "You are logged in with an OAuth Token, associated with the email demo@demo.example." : "You are not authenticated. Please run `wrangler login`." };
    if (a === "login") { loggedIn = true; return { code: 0, out: "Successfully logged in." }; }
    if (a.startsWith("kv namespace create")) return { code: 0, out: '[[kv_namespaces]]\nbinding = "STORE"\nid = "0123456789abcdef0123456789abcdef"' };
    if (a === "deploy") return { code: 0, out: "Uploaded hdsc-vci-social-relay\nDeployed hdsc-vci-social-relay triggers\n  https://hdsc-vci-social-relay.demo.workers.dev\n" };
    if (a === "secret list") return { code: 0, out: opts.secrets ?? "[]" };
    if (a.startsWith("secret put")) return { code: 0, out: "✨ Success!" };
    return { code: 1, out: "unexpected " + a };
  };
  const answers = [...(opts.answers ?? [])];
  const logs: string[] = [];
  const fetched: { url: string; auth?: string }[] = [];
  return {
    files, calls, logs, fetched,
    deps: {
      run, ask: async () => answers.shift() ?? "", log: (s: string) => logs.push(s), sleep: async () => {},
      fs: { read: (p: string) => files[p], write: (p: string, s: string) => { files[p] = s; }, exists: (p: string) => p in files },
      fetch: (async (url: string, init?: RequestInit) => { fetched.push({ url, auth: (init?.headers as any)?.Authorization }); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch,
    },
  };
}

describe("setup wizard", () => {
  it("parses Cloudflare output", () => {
    expect(W.parseKvId('{ binding = "STORE", id = "0123456789abcdef0123456789abcdef" }')).toBe("0123456789abcdef0123456789abcdef");
    expect(W.parseWorkersUrl("Published x\n  https://hdsc-vci-social-relay.whitney.workers.dev\nCurrent Version")).toBe("https://hdsc-vci-social-relay.whitney.workers.dev");
    expect(W.setTomlVar(TOML, "PUBLIC_URL", "https://a.workers.dev")).toContain('PUBLIC_URL = "https://a.workers.dev"');
    expect(W.kvIdMissing(TOML)).toBe(true);
    expect(W.kvIdMissing(W.setTomlKvId(TOML, "abc"))).toBe(false);
  });
  it("round-trips the connection code", () => {
    const code = W.connectionCode("https://r.workers.dev", "k".repeat(43));
    expect(code.startsWith("hdscrelay:")).toBe(true);
    expect(W.readConnectionCode(code)).toEqual({ url: "https://r.workers.dev", key: "k".repeat(43) });
    expect(W.readConnectionCode("nope")).toBeNull();
  });
  it("runs every step on a fresh setup and prints a working connection code", async () => {
    const h = harness();
    const r = await W.runSetup(h.deps);
    expect(r.ok).toBe(true);
    const cmds = h.calls.map(c => c.args.join(" "));
    expect(cmds).toEqual(["whoami", "login", "whoami", "kv namespace create STORE", "deploy", "deploy", "secret list", "secret put RELAY_OWNER_TOKEN", "secret put TOKEN_KEY"]);
    expect(h.files["wrangler.toml"]).toContain('id = "0123456789abcdef0123456789abcdef"');
    expect(h.files["wrangler.toml"]).toContain('PUBLIC_URL = "https://hdsc-vci-social-relay.demo.workers.dev"');
    const owner = h.calls.find(c => c.args.join(" ") === "secret put RELAY_OWNER_TOKEN")!.input!.trim();
    expect(owner.length).toBeGreaterThanOrEqual(43);
    const tokenKey = Buffer.from(h.calls.find(c => c.args.join(" ") === "secret put TOKEN_KEY")!.input!.trim(), "base64");
    expect(tokenKey.length).toBe(32);
    const code = h.logs.find(l => l.startsWith("hdscrelay:"))!;
    expect(W.readConnectionCode(code)).toEqual({ url: "https://hdsc-vci-social-relay.demo.workers.dev", key: owner });
    expect(h.fetched[1]).toEqual({ url: "https://hdsc-vci-social-relay.demo.workers.dev/v1/accounts", auth: `Bearer ${owner}` });
  });
  it("skips finished steps when run again", async () => {
    const h = harness();
    await W.runSetup(h.deps);
    const again = harness({ loggedIn: true, secrets: '[{"name":"RELAY_OWNER_TOKEN"},{"name":"TOKEN_KEY"}]', state: JSON.parse(h.files[W.STATE_FILE]) });
    again.files["wrangler.toml"] = h.files["wrangler.toml"];
    await W.runSetup(again.deps);
    expect(again.calls.map(c => c.args.join(" "))).toEqual(["whoami", "secret list"]);
    expect(again.logs.some(l => l.startsWith("hdscrelay:"))).toBe(true);
  });
  it("won't silently replace a key it doesn't know", async () => {
    const h = harness({ loggedIn: true, secrets: "RELAY_OWNER_TOKEN TOKEN_KEY", answers: ["n"], state: { url: "https://x.workers.dev" } });
    h.files["wrangler.toml"] = W.setTomlVar(W.setTomlKvId(TOML, "0123456789abcdef0123456789abcdef"), "PUBLIC_URL", "https://x.workers.dev");
    await W.runSetup(h.deps);
    expect(h.calls.some(c => c.args[0] === "secret" && c.args[1] === "put")).toBe(false);
  });
  it("shows the code again with --show", async () => {
    const h = harness({ state: { url: "https://x.workers.dev", owner_token: "t".repeat(43) } });
    await W.runSetup({ ...h.deps, argv: ["--show"] });
    expect(h.calls).toHaveLength(0);
    expect(W.readConnectionCode(h.logs.find(l => l.startsWith("hdscrelay:"))!)).toEqual({ url: "https://x.workers.dev", key: "t".repeat(43) });
  });
});
