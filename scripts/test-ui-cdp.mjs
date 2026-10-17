#!/usr/bin/env node
/**
 * اختبار متصفح حقيقي عبر CDP للواجهة (B1 تبويبات + B3 لوحة /).
 *
 * - يشغّل خادماً مؤقتاً على 8797 (بلا تيليجرام، DATA_DIR/WORKSPACE في /tmp).
 * - يشغّل Chrome headless بمقطع CDP (بلا أي تبعيات playwright/puppeteer).
 * - يلتقط لقطات في docs/: b1-tabs.png · b3-commands.png · b3-commands-light.png
 *
 * الاستخدام:
 *   node scripts/test-ui-cdp.mjs --self-test [--keep] [--verbose]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCS = join(ROOT, "docs");

if (!process.argv.includes("--self-test")) {
  console.error("الاستخدام: node scripts/test-ui-cdp.mjs --self-test [--keep] [--verbose]");
  process.exit(2);
}

const SERVER_PORT = Number(process.env.TEST_PORT || 8797);
const TIMEOUT_MS = Number(process.env.UI_TEST_TIMEOUT_MS) || 180_000;
const KEEP = process.argv.includes("--keep");
const VERBOSE = process.argv.includes("--verbose");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

const log = (...args) => console.log("[test-ui-cdp]", ...args);
const debug = (...args) => {
  if (VERBOSE) console.log("[test-ui-cdp:debug]", ...args);
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

async function getJson(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data };
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

/* ===== عميل CDP مصغّر ===== */

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
      const text = readFileSync(file, "utf8").split("\n");
      const port = Number(text[0]);
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

async function main() {
  const tmpRoot = mkdtempSync(join(os.tmpdir(), "pi-ui-test-"));
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

  let serverExited = false;
  server.once("exit", () => {
    serverExited = true;
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
  let chromeExited = false;
  chrome.once("exit", () => {
    chromeExited = true;
  });

  const screenshot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = join(DOCS, name);
    writeFileSync(file, Buffer.from(data, "base64"));
    log(`   📸 ${file}`);
    return file;
  };

  try {
    console.log(`\n[test-ui-cdp]\n1) تشغيل الخادم وChrome`);
    await waitForHealth(baseUrl, 60_000);
    check(true, "الخادم المؤقت يعمل");

    const devtoolsPort = await findDevToolsPort(profileDir);
    check(Number.isFinite(devtoolsPort), `CDP متاح على المنفذ ${devtoolsPort}`);
    const target = await createPageTarget(devtoolsPort);
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    check(true, "اتصال CDP بالصفحة مفتوح");

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const evalJs = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "JS exception");
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

    const loaded = new Promise((resolvePromise) => {
      cdp.on("Page.loadEventFired", resolvePromise);
    });
    await cdp.send("Page.navigate", { url: `${baseUrl}/` });
    await Promise.race([loaded, sleep(15_000)]);
    await waitFor("document.querySelector('#conn')?.classList.contains('online') === true", {
      label: "اتصال الواجهة بالخادم",
    });
    check(true, "الواجهة متصلة (ready وصل)");

    console.log(`\n[test-ui-cdp]\n2) تبويبات الجلسات (B1)`);
    let tabCount = await evalJs("document.querySelectorAll('#tabsBar .tab').length");
    check(tabCount === 1, "البداية بتبويب واحد", `count=${tabCount}`);
    const firstIcon = await evalJs("document.querySelector('#tabsBar .tab .tab-icon')?.textContent || ''");
    check(firstIcon === "🔗", "التبويب الأول معلَّم 🔗 (مشترك مع تيليجرام)", firstIcon);
    const firstId = await evalJs("document.querySelector('#tabsBar .tab')?.dataset.id || ''");
    check(firstId === "shared:main", "التبويب الأول هو shared:main", firstId);

    await evalJs("document.querySelector('#newTabBtn').click()");
    await waitFor("document.querySelectorAll('#tabsBar .tab').length === 2", { label: "إضافة تبويب" });
    const secondId = await evalJs("document.querySelectorAll('#tabsBar .tab')[1]?.dataset.id || ''");
    check(secondId.startsWith("tab:"), "التبويب الجديد معرّفه tab:<uuid>", secondId);
    check(
      await evalJs("document.querySelectorAll('#tabsBar .tab')[1]?.classList.contains('active') === true"),
      "التبويب الجديد صار نشطاً",
    );
    await waitFor("document.querySelector('#conn')?.classList.contains('online') === true", {
      label: "إعادة الربط بعد إضافة التبويب",
    });

    await evalJs(`(() => {
      const el = document.querySelector('#input');
      el.focus();
      el.value = 'مسودة التبويب الثاني';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(
      "JSON.parse(localStorage.getItem('pi.tabs.v1') || '{}').tabs?.some(t => t.draft === 'مسودة التبويب الثاني') === true",
      { label: "حفظ مسودة التبويب في localStorage" },
    );
    check(true, "مسودة التبويب محفوظة في localStorage");

    await evalJs("document.querySelectorAll('#tabsBar .tab-title')[0].click()");
    await waitFor("document.querySelectorAll('#tabsBar .tab')[0]?.classList.contains('active') === true", {
      label: "العودة للتبويب المشترك",
    });
    await waitFor("document.querySelector('#conn')?.classList.contains('online') === true");
    check(
      (await evalJs("document.querySelector('#input').value")) === "",
      "مسودة التبويب المشترك مستقلة (فارغة)",
    );

    await evalJs("document.querySelectorAll('#tabsBar .tab-title')[1].click()");
    await waitFor("document.querySelectorAll('#tabsBar .tab')[1]?.classList.contains('active') === true");
    await waitFor("document.querySelector('#input').value === 'مسودة التبويب الثاني'", {
      label: "استعادة مسودة التبويب الثاني",
    });
    check(true, "التبديل يستعيد مسودة النص لكل تبويب");

    await screenshot("b1-tabs.png");

    console.log(`\n[test-ui-cdp]\n3) لوحة أوامر / (B3)`);
    await evalJs(`(() => {
      const el = document.querySelector('#input');
      el.focus();
      el.value = '/';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.querySelector('#cmdPanel')?.classList.contains('hidden') === false", {
      label: "ظهور لوحة الأوامر",
    });
    // ننتظر أوامر pi نفسها (لا الأوامر المحلية الستة فقط) حتى تظهر المجموعات.
    await waitFor(
      "[...document.querySelectorAll('#cmdPanel .cmd-group')].some(node => node.textContent.includes('مهارات') || node.textContent.includes('قوالب'))",
      {
        label: "تحميل الأوامر عبر rpc get_commands",
        timeout: TIMEOUT_MS,
      },
    );
    const commandCount = await evalJs("document.querySelectorAll('#cmdPanel .cmd-item').length");
    check(commandCount > 0, `لوحة الأوامر تعرض ${commandCount} أمراً`);
    const groups = await evalJs(
      "[...document.querySelectorAll('#cmdPanel .cmd-group')].map(node => node.textContent)",
    );
    check(groups.some((text) => text.includes("أوامر النظام")), "مجموعة أوامر النظام ظاهرة", JSON.stringify(groups));
    check(
      groups.some((text) => text.includes("مهارات") || text.includes("قوالب")),
      "مجموعة المهارات/القوالب ظاهرة (من get_commands)",
      JSON.stringify(groups),
    );
    const names = await evalJs(
      "[...document.querySelectorAll('#cmdPanel .cmd-name')].slice(0, 8).map(node => node.textContent)",
    );
    check(names.some((name) => name === "/model"), "الأوامر المحلية (/model) داخل اللوحة", JSON.stringify(names));
    // لقطة تُظهر مجموعة المهارات (البحث الفوري يرشّح /skill:)
    await evalJs(`(() => {
      const el = document.querySelector('#input');
      el.value = '/skill:';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.querySelectorAll('#cmdPanel .cmd-item').length > 0");
    await waitFor(
      "[...document.querySelectorAll('#cmdPanel .cmd-group')].some(node => node.textContent.includes('مهارات'))",
      { label: "مجموعة المهارات بعد البحث" },
    );
    await screenshot("b3-commands.png");
    const beforeIndex = await evalJs(
      "document.querySelector('#cmdPanel .cmd-item.active')?.dataset.index || ''",
    );
    await evalJs(`(() => {
      const el = document.querySelector('#input');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      return true;
    })()`);
    const afterIndex = await evalJs(
      "document.querySelector('#cmdPanel .cmd-item.active')?.dataset.index || ''",
    );
    check(afterIndex !== beforeIndex, "↑↓ يغيّر الأمر المحدد", `${beforeIndex} → ${afterIndex}`);

    await evalJs(`(() => {
      const el = document.querySelector('#input');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    })()`);
    check(
      await evalJs("document.querySelector('#cmdPanel').classList.contains('hidden') === true"),
      "Esc يغلق لوحة الأوامر",
    );

    // Enter يختار أمر مهارة ويدرجه في المحرر
    await evalJs(`(() => {
      const el = document.querySelector('#input');
      el.value = '/skill:';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.querySelectorAll('#cmdPanel .cmd-item').length > 0");
    await evalJs(
      "document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))",
    );
    const chosen = await evalJs("document.querySelector('#input').value");
    check(chosen.startsWith("/skill:"), "Enter يدرج الأمر المختار في المحرر", chosen);

    // إعادة تسمية التبويب + استعادة القائمة بعد التحديث
    console.log(`\n[test-ui-cdp]\n4) إعادة التسمية والاستعادة بعد التحديث`);
    await evalJs(`(() => {
      window.prompt = () => 'تبويب الاختبار';
      document.querySelectorAll('#tabsBar .tab-title')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`);
    await waitFor(
      "document.querySelectorAll('#tabsBar .tab-label')[1]?.textContent === 'تبويب الاختبار'",
      { label: "إعادة تسمية التبويب" },
    );
    check(true, "النقر المزدوج يعيد تسمية التبويب");

    // علامة على window تكشف أن سياق الصفحة الجديد هو الذي نقرأ منه (لا صفحة ما قبل التحديث).
    await evalJs("window.__piTestMarker = 'before-reload'; true");
    const reloaded = new Promise((resolvePromise) => cdp.on("Page.loadEventFired", resolvePromise));
    await cdp.send("Page.reload", { ignoreCache: true });
    await Promise.race([reloaded, sleep(15_000)]);
    await waitFor("typeof window.__piTestMarker === 'undefined'", {
      label: "اكتمال إعادة تحميل الصفحة",
    });
    await waitFor("document.querySelector('#conn')?.classList.contains('online') === true", {
      label: "إعادة الاتصال بعد التحديث",
    });
    await waitFor("document.querySelectorAll('#tabsBar .tab').length === 2", {
      label: "استعادة التبويبات بعد التحديث",
    });
    const restoredLabel = await evalJs("document.querySelectorAll('#tabsBar .tab-label')[1]?.textContent");
    check(restoredLabel === "تبويب الاختبار", "القائمة والاسم محفوظان في localStorage", restoredLabel);
    const reloadDebug = await evalJs(`(() => {
      const raw = JSON.parse(localStorage.getItem('pi.tabs.v1') || 'null');
      return {
        activeId: raw?.activeId || null,
        classes: [...document.querySelectorAll('#tabsBar .tab')].map(n => n.className),
        ids: [...document.querySelectorAll('#tabsBar .tab')].map(n => n.dataset.id),
        badge: document.querySelector('#sessionBadge')?.textContent || '',
      };
    })()`);
    const activeRestored = await evalJs(
      "document.querySelectorAll('#tabsBar .tab')[1]?.classList.contains('active') === true",
    );
    check(activeRestored, "التبويب النشط محفوظ بعد التحديث", JSON.stringify(reloadDebug));

    // الثيم الفاتح + لقطة ثالثة للوحة
    await evalJs("document.querySelector('#themeBtn').click()");
    await evalJs(`(() => {
      const el = document.querySelector('#input');
      el.value = '/skill:';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor("document.querySelectorAll('#cmdPanel .cmd-item').length > 0", {
      timeout: TIMEOUT_MS,
      label: "أوامر pi في الثيم الفاتح",
    });
    await waitFor(
      "[...document.querySelectorAll('#cmdPanel .cmd-group')].some(node => node.textContent.includes('مهارات'))",
      { label: "مجموعة المهارات في الثيم الفاتح" },
    );
    await screenshot("b3-commands-light.png");
    check(
      (await evalJs("document.documentElement.dataset.theme")) === "light",
      "لوحة الأوامر تعمل في الثيم الفاتح أيضاً",
    );

    // إغلاق التبويب الثاني والعودة للتبويب المشترك
    await evalJs("document.querySelectorAll('#tabsBar .tab-close')[0].click()");
    await waitFor("document.querySelectorAll('#tabsBar .tab').length === 1", { label: "إغلاق التبويب" });
    check(
      (await evalJs("document.querySelector('#tabsBar .tab')?.dataset.id")) === "shared:main",
      "إغلاق التبويب يعيدنا للتبويب المشترك shared:main",
    );
    check(
      (await evalJs("document.querySelectorAll('#tabsBar .tab-close').length")) === 0,
      "التبويب المشترك بلا زر إغلاق",
    );

    console.log(`\n[test-ui-cdp]\nالنتيجة`);
    if (failures > 0) {
      console.error(`❌ فشل ${failures} فحصاً.`);
      process.exitCode = 1;
    } else {
      console.log("✅ PASS: تبويبات الجلسات ولوحة / تعملان في متصفح حقيقي (CDP).");
    }
  } catch (err) {
    failures += 1;
    console.error(`\n❌ FAIL: ${err?.message || err}`);
    if (serverLog.length) {
      console.error("--- آخر سجل الخادم ---");
      console.error(serverLog.join("").split("\n").slice(-30).join("\n"));
    }
    if (chromeLog.length) {
      console.error("--- آخر سجل Chrome ---");
      console.error(chromeLog.join("").split("\n").slice(-20).join("\n"));
    }
    process.exitCode = 1;
  } finally {
    cdp?.close();
    try {
      chrome.kill("SIGTERM");
    } catch {
      /* تجاهل */
    }
    try {
      server.kill("SIGTERM");
    } catch {
      /* تجاهل */
    }
    const deadline = Date.now() + 6000;
    while ((!chromeExited || !serverExited) && Date.now() < deadline) await sleep(100);
    if (!chromeExited) {
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* تجاهل */
      }
    }
    if (!serverExited) {
      try {
        server.kill("SIGKILL");
      } catch {
        /* تجاهل */
      }
    }
    if (KEEP) log(`(--keep) أُبقيت الملفات المؤقتة: ${tmpRoot}`);
    else rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`❌ FAIL: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
