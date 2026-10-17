#!/usr/bin/env node
/**
 * اختبار ذاتي لكسر كاش المتصفح للملفات الثابتة (public/).
 *
 * يشغّل خادماً مؤقتاً على 8796 (بلا تيليجرام، DATA_DIR/WORKSPACE في /tmp)
 * ويتحقق من:
 *   1) index.html يُقدَّم بترويسات Cache-Control: no-store, must-revalidate
 *      و Pragma: no-cache (وكذلك "/" و"/index.html").
 *   2) وسوم index.html تحمل بصمة إصدار: src="/app.js?v=<mtime>"
 *      و href="/styles.css?v=<mtime>".
 *   3) app.js يحمل console.info("[pi-webui] build", "<mtime>") بلا __BUILD__.
 *   4) كل ملف من public/ (مثال: styles.css وfavicon.svg) بلا تخزين.
 *
 * الاستخدام:
 *   node scripts/test-cache-headers.mjs --self-test [--verbose]
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

if (!process.argv.includes("--self-test")) {
  console.error("الاستخدام: node scripts/test-cache-headers.mjs --self-test [--verbose]");
  process.exit(2);
}

const SERVER_PORT = Number(process.env.TEST_PORT || 8796);
const TIMEOUT_MS = Number(process.env.CACHE_TEST_TIMEOUT_MS) || 60_000;
const VERBOSE = process.argv.includes("--verbose");

const log = (...args) => console.log("[test-cache-headers]", ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(condition, message, extra) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    return true;
  }
  failures += 1;
  console.error(`  ❌ ${message}${extra ? `\n     ${extra}` : ""}`);
  return false;
}

function fail(message, extra) {
  console.error(`\n❌ FAIL: ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      /* لم يبدأ بعد */
    }
    await sleep(150);
  }
  throw new Error(`الخادم المؤقت لم يستجب على ${baseUrl}/health`);
}

/** يتحقق من ترويسات منع التخزين ويعيد الجسم نصاً. */
async function fetchNoStore(url, label) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  const cacheControl = String(res.headers.get("cache-control") || "");
  const pragma = String(res.headers.get("pragma") || "");
  check(res.status === 200, `${label}: استجابة 200`, `status=${res.status}`);
  check(
    /no-store/i.test(cacheControl) && /must-revalidate/i.test(cacheControl),
    `${label}: Cache-Control no-store, must-revalidate`,
    cacheControl,
  );
  check(/no-cache/i.test(pragma), `${label}: Pragma no-cache`, pragma);
  return await res.text();
}

async function main() {
  const tmpRoot = mkdtempSync(join(os.tmpdir(), "pi-cache-test-"));
  const dataDir = join(tmpRoot, "data");
  const workspace = join(tmpRoot, "ws");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const env = {
    ...process.env,
    PORT: String(SERVER_PORT),
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    WORKSPACE: workspace,
    PI_APPROVALS_FILE: join(dataDir, "approvals.json"),
    WEB_TOKEN: "",
    PI_SUPERVISED: "",
    TELEGRAM_BOT_TOKEN: "",
    SHARED_SESSION_ID: "shared:main",
  };

  const baseUrl = `http://127.0.0.1:${SERVER_PORT}`;
  log(`الخادم المؤقت: ${baseUrl}`);
  log(`مجلد مؤقت: ${tmpRoot}`);

  const server = spawn(process.execPath, [join(ROOT, "src", "index.js"), "--no-telegram"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  server.stdout.on("data", (chunk) => {
    serverLog.push(chunk.toString());
    if (VERBOSE) process.stdout.write(chunk);
  });
  server.stderr.on("data", (chunk) => {
    serverLog.push(chunk.toString());
    if (VERBOSE) process.stderr.write(chunk);
  });

  let exited = false;
  server.once("exit", () => {
    exited = true;
  });

  const cleanup = () => {
    if (!exited) server.kill("SIGTERM");
    rmSync(tmpRoot, { recursive: true, force: true });
  };

  try {
    await waitForHealth(baseUrl, TIMEOUT_MS);
    console.log(`\n[test-cache-headers]\n1) index.html: ترويسات وبصمة إصدار`);

    const appMtime = String(Math.floor(statSync(join(ROOT, "public", "app.js")).mtimeMs));
    const cssMtime = String(Math.floor(statSync(join(ROOT, "public", "styles.css")).mtimeMs));

    for (const route of ["/", "/index.html"]) {
      const html = await fetchNoStore(`${baseUrl}${route}`, route);
      check(
        html.includes(`src="/app.js?v=${appMtime}"`),
        `${route}: script src يحمل ?v=${appMtime}`,
        (html.match(/src="\/app\.js[^"]*"/) || [""])[0],
      );
      check(
        html.includes(`href="/styles.css?v=${cssMtime}"`),
        `${route}: link styles يحمل ?v=${cssMtime}`,
        (html.match(/href="\/styles\.css[^"]*"/) || [""])[0],
      );
    }

    console.log(`\n[test-cache-headers]\n2) app.js: console.info + بصمة الإصدار`);
    const appJs = await fetchNoStore(`${baseUrl}/app.js`, "/app.js");
    check(appJs.includes('console.info("[pi-webui] build"'), "app.js يحوي console.info build");
    const buildMatch = /\[pi-webui\] build", "([^"]+)"/.exec(appJs);
    check(!!buildMatch, "app.js يحوي بصمة إصدار داخل console.info");
    check(buildMatch?.[1] === appMtime, `بصمة app.js = mtime (${appMtime})`, buildMatch?.[1]);
    check(!appJs.includes("__BUILD__"), "app.js المقدَّم لا يحوي __BUILD__ خامّاً");

    console.log(`\n[test-cache-headers]\n3) بقية ملفات public/ بلا تخزين`);
    await fetchNoStore(`${baseUrl}/styles.css`, "/styles.css");
    await fetchNoStore(`${baseUrl}/favicon.svg`, "/favicon.svg");

    if (failures) {
      fail(`${failures} فحصاً فشل`, serverLog.join("").slice(-2000));
    }
    console.log("\n✅ PASS: ترويسات منع التخزين وبصمة الإصدار تعمل كما هو مطلوب.");
    cleanup();
    process.exit(0);
  } catch (err) {
    cleanup();
    fail(err?.message || String(err), serverLog.join("").slice(-2000));
  }
}

main();
