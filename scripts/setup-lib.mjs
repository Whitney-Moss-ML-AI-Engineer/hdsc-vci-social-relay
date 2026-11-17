// Setup wizard for hdsc-vci-social-relay. `npm run setup` walks the founder through Cloudflare sign-in,
// storage, keys and deployment, then prints a connection code to paste into the apps.
// Every step is skipped when it is already done, so the wizard can be re-run safely.
import { randomBytes } from "node:crypto";

export const STATE_FILE = ".relay-setup.json";
export const CODE_PREFIX = "hdscrelay:";

export function parseKvId(output) {
  const m = output.match(/id\s*=\s*"([0-9a-f]{32})"/i) || output.match(/"id"\s*:\s*"([0-9a-f]{32})"/i) || output.match(/\b([0-9a-f]{32})\b/i);
  return m ? m[1] : null;
}

export function parseWorkersUrl(output) {
  const m = output.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\b/i);
  return m ? m[0] : null;
}

export const tomlKvId = toml => (toml.match(/binding\s*=\s*"STORE"\s*\n\s*id\s*=\s*"([^"]+)"/) || [])[1] ?? null;
export const kvIdMissing = toml => { const id = tomlKvId(toml); return !id || id.startsWith("REPLACE"); };
export const setTomlKvId = (toml, id) => toml.replace(/(binding\s*=\s*"STORE"\s*\n\s*id\s*=\s*")[^"]*(")/, `$1${id}$2`);
export function setTomlVar(toml, key, value) {
  const re = new RegExp(`^(${key}\\s*=\\s*)"[^"]*"`, "m");
  return re.test(toml) ? toml.replace(re, `$1"${value}"`) : toml.replace(/\[vars\]\n/, `[vars]\n${key} = "${value}"\n`);
}
export const tomlVar = (toml, key) => (toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m")) || [])[1] ?? null;

export const newOwnerToken = () => randomBytes(32).toString("base64url");
export const newTokenKey = () => randomBytes(32).toString("base64");

export function connectionCode(url, key) {
  return CODE_PREFIX + Buffer.from(JSON.stringify({ u: url, k: key })).toString("base64url");
}
export function readConnectionCode(code) {
  if (!code.startsWith(CODE_PREFIX)) return null;
  try { const j = JSON.parse(Buffer.from(code.slice(CODE_PREFIX.length), "base64url").toString()); return j.u && j.k ? { url: j.u, key: j.k } : null; }
  catch { return null; }
}

const line = "─".repeat(60);

/**
 * Runs the wizard. Everything with side effects is injected so it can be tested:
 *   run(args, { input?, interactive? }) → { code, out }   (runs `npx wrangler ...args`)
 *   ask(question, { secret? }) → string, log(text), fs { read, write, exists }, fetch, sleep
 */
export async function runSetup({ run, ask, log, fs, fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), argv = [] }) {
  const state = fs.exists(STATE_FILE) ? JSON.parse(fs.read(STATE_FILE)) : {};
  const save = () => fs.write(STATE_FILE, JSON.stringify(state, null, 2), 0o600);
  const step = (n, title) => log(`\n${line}\n Step ${n} of 5 · ${title}\n${line}`);

  if (argv.includes("--show")) {
    if (!state.url || !state.owner_token) { log("Nothing to show yet. Run `npm run setup` first."); return { ok: false }; }
    printResult(log, state); return { ok: true, state };
  }

  log("\nHDSC VC Intelligence · Relay setup wizard\n");
  log("This sets up your private relay on your own free Cloudflare account. It takes about 5 minutes.");
  log("You can stop at any time and run `npm run setup` again; finished steps are skipped.");

  // 1. Cloudflare sign-in
  step(1, "Sign in to Cloudflare");
  let who = await run(["whoami"]);
  if (/not authenticated|login/i.test(who.out) && !/associated with the email/i.test(who.out)) {
    log("A browser window will open. Sign in (or create a free account) and click Allow.");
    await ask("Press Enter to open Cloudflare…");
    const login = await run(["login"], { interactive: true });
    if (login.code !== 0) throw new Error("Cloudflare sign-in didn't finish. Run `npm run setup` to try again.");
    who = await run(["whoami"]);
  }
  log(`✓ Signed in to Cloudflare${(who.out.match(/associated with the email ([^\s]+)/) || [])[1] ? " as " + who.out.match(/associated with the email ([^\s]+)/)[1].replace(/\.$/, "") : ""}.`);

  // 2. Storage
  step(2, "Create private storage");
  let toml = fs.read("wrangler.toml");
  if (kvIdMissing(toml)) {
    const r = await run(["kv", "namespace", "create", "STORE"]);
    const id = parseKvId(r.out);
    if (!id) throw new Error("Couldn't read the storage ID from Cloudflare's reply:\n" + r.out);
    toml = setTomlKvId(toml, id); fs.write("wrangler.toml", toml);
    log(`✓ Storage created (${id.slice(0, 8)}…).`);
  } else log("✓ Storage already set up.");

  // 3. Deploy
  step(3, "Put your relay online");
  if (!state.url || tomlVar(toml, "PUBLIC_URL")?.includes("REPLACE")) {
    log("Uploading… If Cloudflare asks you to pick a workers.dev name, type something like hdsc and press Enter.");
    const d = await run(["deploy"], { interactive: true });
    const url = parseWorkersUrl(d.out);
    if (d.code !== 0 || !url) throw new Error("The upload didn't finish. Run `npm run setup` to try again.");
    state.url = url; save();
    toml = setTomlVar(toml, "PUBLIC_URL", url); fs.write("wrangler.toml", toml);
    const d2 = await run(["deploy"]);
    if (d2.code !== 0) throw new Error("The second upload failed. Run `npm run setup` to try again.");
  }
  log(`✓ Your relay is at ${state.url}`);

  // 4. Keys
  step(4, "Create your private keys");
  const listed = (await run(["secret", "list"])).out;
  const hasOwner = /RELAY_OWNER_TOKEN/.test(listed), hasKey = /TOKEN_KEY/.test(listed);
  let rotate = argv.includes("--new-key");
  if (hasOwner && !state.owner_token && !rotate) {
    const a = (await ask("Your relay already has a key, but this computer doesn't know it. Make a new one? Your apps will need the new connection code. (y/N) ")).trim().toLowerCase();
    rotate = a === "y" || a === "yes";
    if (!rotate) { log("OK, keeping the existing key. Use the connection code you saved earlier."); return { ok: true, state }; }
  }
  if (!hasOwner || rotate) {
    state.owner_token = newOwnerToken(); save();
    const r = await run(["secret", "put", "RELAY_OWNER_TOKEN"], { input: state.owner_token + "\n" });
    if (r.code !== 0) throw new Error("Couldn't save the relay key to Cloudflare.");
  }
  if (!hasKey) {
    const r = await run(["secret", "put", "TOKEN_KEY"], { input: newTokenKey() + "\n" });
    if (r.code !== 0) throw new Error("Couldn't save the encryption key to Cloudflare.");
  }
  log("✓ Keys created and stored in Cloudflare.");

  // 5. Check
  step(5, "Check it works");
  let healthy = false;
  for (let i = 0; i < 10 && !healthy; i++) {
    try { const res = await fetch(`${state.url}/v1/health`); healthy = res.ok; } catch { /* still starting */ }
    if (!healthy) await sleep(3000);
  }
  if (!healthy) log("! Couldn't reach the relay yet. New relays can take a minute; try the connection code in the app anyway.");
  else {
    try {
      const res = await fetch(`${state.url}/v1/accounts`, { headers: { Authorization: `Bearer ${state.owner_token}` } });
      log(res.ok ? "✓ Relay is online and your key works." : `! Relay answered ${res.status}. If you just made a new key, wait 30 seconds and try again.`);
    } catch { log("! Relay is online but the key check failed; try again in a minute."); }
  }
  state.done_at = new Date().toISOString(); save();
  printResult(log, state);
  return { ok: true, state };
}

function printResult(log, state) {
  const code = connectionCode(state.url, state.owner_token);
  log(`\n${line}\n Done! Copy this connection code into the app:\n${line}\n`);
  log(code);
  log(`\nIn the app: Connections → Your relay → paste the code → Save & test.`);
  log(`Then tap "Set up" next to each app (Canva, LinkedIn, Gmail…) and follow the steps.`);
  log(`\n(Address: ${state.url})`);
  log(`Keep this code private: it works like a password. Run \`npm run setup -- --show\` to see it again,`);
  log(`or \`npm run setup -- --new-key\` to replace it.\n`);
}
