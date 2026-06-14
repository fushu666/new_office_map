import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const qencryptPath = path.join(__dirname, "vendor", "qencrypt", "qencrypt.10qp6xk5p.js");
const qencryptWasmPath = path.join(__dirname, "vendor", "qencrypt", "qencrypt.10qp6xk5p.wasm");

let modulePromise;

function md5(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

function originUrl(rawUrl) {
  return rawUrl.replace(/\/?[\?#].*/, "");
}

function urlHost(rawUrl) {
  return rawUrl.replace(/(https?:\/\/)?([\w.]*).*/, "$1$2");
}

function urlPath(rawUrl) {
  return rawUrl.replace(/(https?:\/\/)?([\w.]*)\/(.*)/, "$3");
}

async function getModule() {
  if (!modulePromise) {
    const QEncrypt = require(qencryptPath);
    modulePromise = QEncrypt({ wasmBinary: fs.readFileSync(qencryptWasmPath) });
  }
  return modulePromise;
}

export async function signCmaptileUrl(rawUrl) {
  if (!rawUrl.includes("cmaptile2.allhistory.com")) return rawUrl;

  const clean = originUrl(rawUrl);
  const host = urlHost(clean);
  const p = urlPath(clean);
  const rand = String(Math.floor(1e8 * Math.random()));
  const digest = md5(host + p + rand);
  const mod = await getModule();
  return mod.ccall("qEncrypt", "string", new Array(5).fill("string"), [host, p, "3600", rand, digest]);
}

export async function signTemplateUrl(templateUrl, params = {}) {
  let url = templateUrl;
  for (const [key, value] of Object.entries(params)) {
    url = url.replaceAll(`{${key}}`, String(value));
  }
  return signCmaptileUrl(url);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node allhistory_tools/allhistory_signer.mjs <cmaptile2-url>");
    process.exit(1);
  }
  console.log(await signCmaptileUrl(input));
}
