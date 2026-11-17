#!/usr/bin/env node
// `npm run setup` — guided relay setup. See scripts/setup-lib.mjs for the steps.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runSetup } from "./setup-lib.mjs";

const [major] = process.versions.node.split(".").map(Number);
if (major < 18) { console.error(`Node 18 or newer is needed (you have ${process.versions.node}). Install it from https://nodejs.org and try again.`); process.exit(1); }

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args, { input, interactive } = {}) => new Promise(resolve => {
  const child = spawn(npx, ["wrangler", ...args], { stdio: [input !== undefined ? "pipe" : "inherit", "pipe", interactive ? "inherit" : "pipe"], shell: process.platform === "win32" });
  let out = "";
  child.stdout.on("data", d => { out += d; if (interactive) process.stdout.write(d); });
  child.stderr?.on("data", d => { out += d; });
  if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  child.on("close", code => resolve({ code: code ?? 1, out }));
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = q => rl.question(q);
const fs = {
  read: p => readFileSync(p, "utf8"),
  write: (p, s, mode) => { writeFileSync(p, s); if (mode) try { chmodSync(p, mode); } catch { /* Windows */ } },
  exists: p => existsSync(p),
};

runSetup({ run, ask, log: s => console.log(s), fs, fetch, argv: process.argv.slice(2) })
  .then(r => { rl.close(); process.exit(r.ok ? 0 : 1); })
  .catch(e => { rl.close(); console.error(`\n✗ ${e.message}`); process.exit(1); });
