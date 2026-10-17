#!/usr/bin/env node
/**
 * اختبار ذاتي لمرحلة B4a — فتح جلسات الطرفية الموجودة على القرص من الواجهة.
 *
 * المراحل:
 *   1) اختبار مباشر لوحدة `src/rpc/sessions.js` على مجلد الجلسات الحقيقي
 *      (`<PI_AGENT_DIR|~/.pi/agent>/sessions`): يرتّب تنازلياً، يطبع أول 3
 *      (مسار + اسم + عدد رسائل)، ويتحقق من أن الملفات موجودة فعلاً على القرص.
 *   2) خادم مؤقت على 8790 (بيانات/workspace في /tmp، بلا تيليجرام) + Chrome headless
 *      عبر CDP: يفتح الواجهة، يبدّل إلى تبويب «الطرفية»، يبحث، يفتح قائمة ⋯،
 *      ويلتقط لقطتين في docs/.
 *
 * لا يلمس الخادم الحيّ ولا يحذف أي جلسة على القرص.
 *
 * الاستخدام:
 *   node scripts/test-disk-sessions.mjs --self-test [--keep] [--verbose] [--no-browser]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

import { listDiskSessions, decodeProjectDir, sessionIdFromFileName, MAX_SCAN_LINES } from "../src/rpc/sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCS = join(ROOT, "docs");

if (!process.argv.includes("--self-test")) {
  console.error("الاستخدام: node scripts/test-disk-sessions.mjs --self-test [--keep] [--verbose] [--no-browser]");
  process.exit(2);
}

const SERVER_PORT = Number(process.env.TEST_PORT || 8790);
const TIMEOUT_MS = Number(process.env.DISK_TEST_TIMEOUT_MS) || 180_000;
const KEEP = process.argv.includes("--keep");
const VERBOSE = process.argv.includes("--verbose");
const NO_BROWSER = process.argv.includes("--no-browser");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

const log = (...args) => console.log("[test-disk-sessions]", ...args);
const debug = (...args) => {
  if (VERBOSE) console.log("[test-disk-sessions:debug]", ...args);
};
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

/* ===== 1) اختبار الوحدة على القرص الحقيقي ===== */

async function unitPhase() {
  console.log("\n[test-disk-sessions]\n1) قراءة جلسات القرص الحقيقية");
  const agentDir = process.env.PI_AGENT_DIR || join(os.homedir(), ".pi", "agent");
  const result = await listDiskSessions({ agentDir, limit: 3 });
  log(`مجلد الجلسات: ${result.sessionsDir}`);
  log(`الإجمالي: ${result.total} · المعروض: ${result.sessions.length} · أقصى أسطر: ${MAX_SCAN_LINES}`);

  check(result.total > 0, "وُجدت جلسات على القرص", `total=${result.total}`);
  check(Array.isArray(result.sessions) && result.sessions.length > 0, "القائمة غير فارغة");

  for (const [index, session] of result.sessions.slice(0, 3).entries()) {
    console.log(
      `   ${index + 1}. ${session.title || "(بلا اسم)"} — ${session.projectName} — ${session.messageCount} رسالة` +
        `${session.partial ? " (جزئي)" : ""}\n      ${session.sessionFile}`,
    );
  }

  const sample = result.sessions[0];
  if (sample) {
    check(existsSync(sample.sessionFile), "ملف الجلسة الأول موجود فعلاً على القرص", sample.sessionFile);
    const lines = readFileSync(sample.sessionFile, "utf8").split("\n").filter(Boolean);
    const header = JSON.parse(lines[0]);
    check(header.type === "session", "أول سطر في الملف هو ترويسة session", header.type);
    check(sample.id === header.id || /^[0-9a-f-]{8,}$/i.test(sample.id), "المعرّف مشتق من ترويسة/اسم الملف", sample.id);
    check(
      lines.filter((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.type === "message" && ["user", "assistant"].includes(entry.message?.role);
        } catch {
          return false;
        }
      }).length === sample.messageCount || sample.partial,
      "عدد الرسائل مطابق لعدّ الملف",
      `counted=${sample.messageCount}`,
    );
    check(sample.updatedAt > 0 && sample.size > 0, "وقت آخر تعديل وحجم الملف معروفان");
    const sorted = [...result.sessions].every(
      (item, i, arr) => i === 0 || (arr[i - 1].updatedAt || 0) >= (item.updatedAt || 0),
    );
    check(sorted, "الترتيب تنازلي حسب آخر تعديل");
  }

  // البحث
  const needle = String(sample?.projectName || "").slice(0, 3);
  if (needle) {
    const searched = await listDiskSessions({ agentDir, query: needle, limit: 5 });
    check(
      searched.sessions.every((s) =>
        [s.title, s.firstMessage, s.projectName, s.projectPath, s.id]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle.toLowerCase())),
      ),
      "البحث يفلتر النتائج فعلاً",
      `q=${needle} matched=${searched.matched}/${searched.total}`,
    );
  }

  // فكّ ترميز اسم مجلد المشروع
  check(decodeProjectDir("--home--asus--") === "/home/asus", "فكّ ترميز --home--asus-- ← /home/asus");
  check(
    sessionIdFromFileName("2026-10-17T00-56-13-405Z_01a1475b-fd5c.jsonl") ===
      "01a1475b-fd5c",
    "استخراج المعرّف من اسم الملف",
  );
}

/* ===== 2) عميل CDP مصغّر ===== */

class Cdp {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  open() {
    this.ws = new WebSocket(this.url);
    this.ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
        else entry.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params);
      }
    });
    return new Promise((resolvePromise, rejectPromise) => {
      this.ws.once("open", resolvePromise);
      this.ws.once("error", rejectPromise);
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* تجاهل */
    }
  }
}

async function findDevToolsPort(profileDir) {
  const file = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (Number.isFinite(port) && port > 0) return port;
    }
    await sleep(100);
  }
  throw new Error("Chrome لم يكتب DevToolsActivePort");
}

async function createPageTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!res.ok) throw new Error(`تعذّر إنشاء تبويب Chrome (${res.status})`);
  return await res.json();
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* لم يبدأ بعد */
    }
    await sleep(150);
  }
  throw new Error(`الخادم المؤقت لم يستجب على ${baseUrl}/health`);
}

/* ===== 3) الواجهة عبر CDP ===== */

async function browserPhase() {
  console.log("\n[test-disk-sessions]\n2) الواجهة: تبويب «الطرفية» + بحث + قائمة ⋯");
  const tmpRoot = mkdtempSync(join(os.tmpdir(), "pi-disk-test-"));
  const dataDir = join(tmpRoot, "data");
  const workspace = join(tmpRoot, "ws");
  const profileDir = join(tmpRoot, "chrome");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(DOCS, { recursive: true });

  const env = {
    ...process.env,
    PORT: String(SERVER_PORT),
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    WORKSPACE: workspace,
    PI_APPROVALS_FILE: join(dataDir, "approvals.json"),
    FEATURE_RPC: "1",
    WEB_TOKEN: "",
    PI_SUPERVISED: "",
    TELEGRAM_BOT_TOKEN: "",
    SHARED_SESSION_ID: "shared:main",
  };

  const baseUrl = `http://127.0.0.1:${SERVER_PORT}`;
  log(`الخادم المؤقت: ${baseUrl} · Chrome: ${CHROME}`);
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

  if (!existsSync(CHROME)) throw new Error(`Chrome غير موجود: ${CHROME} (اضبط CHROME_PATH)`);

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--window-size=1440,900",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const chromeLog = [];
  chrome.stdout.on("data", (chunk) => chromeLog.push(chunk.toString()));
  chrome.stderr.on("data", (chunk) => chromeLog.push(chunk.toString()));

  let cdp = null;
  try {
    await waitForHealth(baseUrl, 60_000);
    check(true, `الخادم المؤقت يعمل على ${SERVER_PORT}`);

    const devtoolsPort = await findDevToolsPort(profileDir);
    const target = await createPageTarget(devtoolsPort);
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    check(true, "اتصال CDP مفتوح");

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const evalJs = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text || "JS exception",
        );
      }
      return result.result.value;
    };

    const waitFor = async (expression, { timeout = TIMEOUT_MS, label = expression } = {}) => {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await evalJs(expression);
          if (last) return last;
        } catch (err) {
          last = err.message;
        }
        await sleep(150);
      }
      throw new Error(`انتهت مهلة انتظار «${label}» (آخر قيمة: ${JSON.stringify(last)})`);
    };

    const screenshot = async (name) => {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = join(DOCS, name);
      writeFileSync(file, Buffer.from(data, "base64"));
      log(`   📸 ${file}`);
      return file;
    };

    const loaded = new Promise((resolvePromise) => cdp.on("Page.loadEventFired", resolvePromise));
    await cdp.send("Page.navigate", { url: `${baseUrl}/` });
    await Promise.race([loaded, sleep(15_000)]);
    await waitFor("document.querySelector('#conn')?.classList.contains('online') === true", {
      label: "اتصال الواجهة بالخادم",
    });
    check(true, "الواجهة متصلة (ready وصل)");

    check(
      (await evalJs("document.querySelector('#sessScopeUi')?.textContent.trim()")) === "هذه الواجهة",
      "تبويب «هذه الواجهة» موجود",
    );
    check(
      (await evalJs("document.querySelector('#sessScopeDisk')?.textContent.trim()")) === "الطرفية",
      "تبويب «الطرفية» موجود",
    );
    check(
      (await evalJs("document.querySelector('#sessionsDisk').hidden === true")) === true,
      "قائمة الطرفية مخفية قبل التبديل",
    );

    // التبديل إلى «الطرفية»
    await evalJs("document.querySelector('#sessScopeDisk').click()");
    await waitFor("document.querySelectorAll('#sessionsDisk .disk-row').length > 0", {
      label: "وصول جلسات القرص إلى الواجهة",
    });
    const rows = await evalJs("document.querySelectorAll('#sessionsDisk .disk-row').length");
    check(rows > 0, `تبويب الطرفية يعرض ${rows} جلسة`);
    check(
      (await evalJs("document.querySelector('#sessDiskTools').hidden === false")) === true,
      "شريط البحث ظهر مع تبويب الطرفية",
    );
    const counter = await evalJs("document.querySelector('#sessDiskCount').textContent.trim()");
    check(/^\d+$/.test(counter), `عدّاد الجلسات ظاهر (${counter})`);
    check(
      (await evalJs("document.querySelector('#sessScopeDisk').classList.contains('active')")) === true,
      "تبويب الطرفية صار نشطاً",
    );
    check(
      (await evalJs("document.querySelector('#sessions').hidden === true")) === true,
      "قائمة «هذه الواجهة» أُخفيت",
    );
    await screenshot("b4a-disk-sessions.png");

    // بحث بعنوان جلسة حقيقية ثم بحث بلا نتائج
    const totalRows = rows;
    const firstTitle = (await evalJs(
      "document.querySelector('#sessionsDisk .disk-row .s-title')?.textContent.replace('🖥️', '').trim() || ''",
    )).trim();
    const needle = firstTitle.split(/\s+/)[0].slice(0, 12);
    debug("search needle:", needle);
    const typeSearch = async (value) => {
      await evalJs(`(() => {
        const el = document.querySelector('#sessDiskSearch');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(900);
      return await evalJs("document.querySelectorAll('#sessionsDisk .disk-row').length");
    };

    if (needle) {
      const hit = await typeSearch(needle);
      check(hit > 0 && hit <= totalRows, `البحث عن «${needle}» أعاد ${hit} من ${totalRows}`);
      const counterAfter = await evalJs("document.querySelector('#sessDiskCount').textContent.trim()");
      check(counterAfter.includes("/"), `العدّاد يعرض matched/total بعد البحث (${counterAfter})`);
      await screenshot("b4a-disk-search.png");
    }
    const miss = await typeSearch("zzz-لا-نتائج-zzz");
    check(miss === 0, "بحث بلا نتائج يعيد صفر صفوف", `rows=${miss}`);
    check(
      (await evalJs("document.querySelector('#sessionsDisk').textContent.includes('لا نتائج')")) === true,
      "تظهر رسالة «لا نتائج مطابقة»",
    );
    // مسح البحث والعودة للقائمة الكاملة
    const restored = await typeSearch("");
    check(restored === totalRows, `مسح البحث يعيد القائمة كاملة (${restored})`);

    // قائمة ⋯
    await evalJs("document.querySelector('#sessionsDisk .disk-more').click()");
    await waitFor("document.querySelectorAll('.sess-menu button').length === 3", { label: "فتح قائمة ⋯" });
    const menu = await evalJs("Array.from(document.querySelectorAll('.sess-menu button')).map(b => b.dataset.act)");
    check(
      menu.includes("open") && menu.includes("rename") && menu.includes("delete"),
      "قائمة ⋯ تحتوي فتح/إعادة تسمية/حذف",
      JSON.stringify(menu),
    );
    await screenshot("b4a-disk-menu.png");
    await evalJs("document.body.click()");

    // التحقق من وصول رسالة disk_sessions مباشرة عبر WS (عقد الرسالة)
    const direct = await evalJs(`(async () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(proto + '://' + location.host + '/ws');
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
      const payload = await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('timeout')), 15000);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'disk_sessions') { clearTimeout(timer); res(msg); }
        };
        ws.send(JSON.stringify({ type: 'disk_sessions', q: '' }));
      });
      ws.close();
      return { total: payload.total, shown: payload.sessions.length, sample: payload.sessions[0] || null,
               types: payload.sessions.slice(0, 3).map(s => typeof s.sessionFile) };
    })()`);
    check(direct.total > 0, `رسالة disk_sessions تُعيد ${direct.total} جلسة`);
    check(direct.types.every((t) => t === "string"), "كل عنصر يحمل sessionFile نصياً");
    check(
      direct.sample && existsSync(direct.sample.sessionFile),
      "مسار الجلسة المُعاد موجود فعلاً على القرص",
      direct.sample?.sessionFile,
    );

    // لا تكسر «هذه الواجهة»: الرجوع يعرض list_sessions كما هو
    await evalJs("document.querySelector('#sessScopeUi').click()");
    await waitFor("document.querySelector('#sessions').hidden === false", { label: "العودة لقائمة هذه الواجهة" });
    check(true, "الرجوع إلى «هذه الواجهة» يعيد قائمة list_sessions");
    return true;
  } finally {
    cdp?.close();
    try {
      chrome.kill("SIGKILL");
    } catch {
      /* تجاهل */
    }
    server.kill("SIGTERM");
    await sleep(300);
    if (KEEP) {
      log(`أُبقيت الملفات المؤقتة: ${tmpRoot}`);
      if (VERBOSE) log(`سجل الخادم:\n${serverLog.join("")}\nسجل Chrome:\n${chromeLog.join("")}`);
    } else {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

/* ===== التشغيل ===== */

await unitPhase();
if (!NO_BROWSER) {
  try {
    await browserPhase();
  } catch (err) {
    failures += 1;
    console.error(`  ❌ مرحلة المتصفح فشلت: ${err.message}`);
  }
}

console.log("");
if (failures) {
  console.error(`[test-disk-sessions] فشل: ${failures} تحقق/تحققات`);
  process.exit(1);
}
console.log("[test-disk-sessions] نجحت كل التحققات ✅");
