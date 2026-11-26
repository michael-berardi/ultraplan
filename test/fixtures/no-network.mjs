/**
 * Preloaded into the CLI child process by test/privacy.test.ts. Any attempt to
 * open a socket or fetch a URL fails loudly; the marker proves the guard ran.
 */
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";

if (process.env.UT_PRIVACY_MARKER) {
  writeFileSync(process.env.UT_PRIVACY_MARKER, "armed");
}

function deny(label) {
  return () => {
    throw new Error(`network attempt blocked: ${label}`);
  };
}

for (const [module, name] of [[http, "http"], [https, "https"]]) {
  for (const key of ["request", "get", "createServer"]) {
    try { module[key] = deny(`${name}.${key}`); } catch { /* read-only binding */ }
  }
}
for (const [module, name] of [[net, "net"], [dns, "dns"]]) {
  for (const key of ["connect", "createConnection", "lookup", "resolve", "resolve4", "resolve6"]) {
    if (typeof module[key] !== "function") continue;
    try { module[key] = deny(`${name}.${key}`); } catch { /* read-only binding */ }
  }
}
globalThis.fetch = deny("fetch");
globalThis.WebSocket = deny("WebSocket");
