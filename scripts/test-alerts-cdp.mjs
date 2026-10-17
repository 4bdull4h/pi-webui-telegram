#!/usr/bin/env node
/**
 * اختبار متصفح حقيقي (CDP) لمنظومة التنبيهات C3.
 *
 * - خادم مؤقت على 8794 (بيانات /tmp، بلا تيليجرام).
 * - Chrome headless + اعتراض Notification داخل الصفحة + خطّاف ?soundtest=1.
 * - يتحقق من: بصمات الأصوات المختلفة، شريط الانقطاع بالسبب الصحيح، العودة،
 *   لقطات لوحة الإشعارات (نهاري/ليلي)، وإشعار «انتهت المهمة».
 *
 * الاستخدام: node scripts/test-alerts-cdp.mjs --self-test [--keep] [--verbose]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCS = join(ROOT, "docs");

if (!process.argv.includes("--self-test")) {
  console.error("الاستخدام: node scripts/test-alerts-cdp.mjs --self-test [--keep] [--verbose]");
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 8794);
const VERBOSE = process.argv.includes("--verbose");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[test-alerts]", ...a);

let failures = 0;
function check(ok, message, extra) {
  if (ok) {
    console.log(`  ✅ ${message}`);
    return true;
  }
  failures += 1;
  console.error(`  ❌ ${message}${extra ? `\n     ${extra}` : ""}`);
  return false;
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  open() {
    this.ws = new WebSocket(this.url);
    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method) for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
    });
    return new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* تجاهل */
    }
  }
}

async function findDevToolsPort(dir) {
  const file = join(dir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const port = Number(String(await import("node:fs").then((fs) => fs.readFileSync(file, "utf8"))).split("\n")[0]);
      if (Number.isFinite(port) && port > 0) return port;
    }
    await sleep(100);
  }
  throw new Error("Chrome لم يكتب DevToolsActivePort");
}

async function waitHealth(base, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* لم يبدأ */
    }
    await sleep(120);
  }
  throw new Error(`لا استجابة على ${base}/health`);
}

const FAKE_NOTIFICATION = `
(() => {
  window.__notifications = [];
  class FakeNotification {
    static permission = "granted";
    static requestPermission() { return Promise.resolve("granted"); }
    constructor(title, opts = {}) {
      this.title = title;
      this.body = opts.body || "";
      this.tag = opts.tag || "";
      window.__notifications.push({
        title, body: opts.body || "", tag: opts.tag || "",
        requireInteraction: !!opts.requireInteraction, at: Date.now(),
      });
    }
    close() {}
  }
  window.Notification = FakeNotification;
})();
`;

async function main() {
  const tmp = mkdtempSync(join(os.tmpdir(), "pi-alerts-test-"));
  const dataDir = join(tmp, "data");
  const workspace = join(tmp, "ws");
  const profileDir = join(tmp, "chrome");
  for (const dir of [dataDir, workspace, profileDir, DOCS]) mkdirSync(dir, { recursive: true });

  const base = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    PORT: String(PORT),
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
  const startServer = () => {
    const proc = spawn(process.execPath, [join(ROOT, "src", "index.js"), "--no-telegram"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (c) => VERBOSE && process.stdout.write(c));
    proc.stderr.on("data", (c) => VERBOSE && process.stderr.write(c));
    return proc;
  };

  let server = startServer();
  let chrome;
  let cdp;
  let screenshots = [];

  const screenshot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(DOCS, name), Buffer.from(data, "base64"));
    screenshots.push(name);
    log(`   📸 docs/${name}`);
  };

  try {
    log(`خادم مؤقت: ${base} · بيانات ${tmp}`);
    await waitHealth(base, 60_000);
    check(true, "الخادم المؤقت يعمل على 8794");

    if (!existsSync(CHROME)) throw new Error(`Chrome غير موجود: ${CHROME}`);
    chrome = spawn(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "--window-size=1440,900",
        "--hide-scrollbars",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    chrome.stderr.on("data", (c) => VERBOSE && process.stderr.write(c));

    const devPort = await findDevToolsPort(profileDir);
    const res = await fetch(`http://127.0.0.1:${devPort}/json/new?about:blank`, { method: "PUT" });
    const target = await res.json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const consoleErrors = [];
    cdp.on("Runtime.exceptionThrown", (p) => {
      consoleErrors.push(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "exception");
    });
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p?.type !== "error") return;
      consoleErrors.push((p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" "));
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_NOTIFICATION });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const evalJs = async (expression) => {
      const out = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
      return out.result.value;
    };
    const waitFor = async (expression, { timeout = 30_000, label = expression } = {}) => {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await evalJs(expression);
          if (last) return last;
        } catch (err) {
          last = err.message;
        }
        await sleep(120);
      }
      throw new Error(`انتهت مهلة «${label}» (آخر: ${JSON.stringify(last)})`);
    };

    const loaded = new Promise((r) => cdp.on("Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url: `${base}/?soundtest=1` });
    await Promise.race([loaded, sleep(15_000)]);
    await waitFor("document.querySelector('#conn')?.classList.contains('online') === true", { label: "اتصال الواجهة" });
    check(true, "الواجهة متصلة بالخادم");

    // أول تفاعل: يفتح AudioContext (سياسة المتصفح).
    await evalJs("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true");
    await evalJs("document.body.click(); true");

    console.log("\n[test-alerts]\n1) بصمات الأصوات (SoundBus)");
    const plans = await evalJs(`(() => {
      const ids = window.__soundTypes;
      const out = {};
      for (const id of ids) {
        const plan = window.__soundBus.plan(id);
        out[id] = {
          tones: plan.length,
          freqs: [...new Set(plan.map(t => t.f))],
          waves: [...new Set(plan.map(t => t.w || 'sine'))],
          total: Math.max(...plan.map(t => (t.t || 0) + (t.d || 0))),
          signature: plan.map(t => t.f + '/' + (t.w||'sine') + '/' + (t.d||0)).join('|'),
        };
      }
      return out;
    })()`);
    const ids = Object.keys(plans);
    check(ids.length === 8, `ثمانية أنواع صوت (${ids.join(", ")})`);
    const signatures = new Set(ids.map((id) => plans[id].signature));
    check(signatures.size === ids.length, "لكل نوع بصمة صوتية مختلفة تماماً", `${signatures.size}/${ids.length}`);
    const counts = new Set(ids.map((id) => plans[id].tones));
    check(counts.size >= 4, `عدد النغمات يختلف بين الأنواع (${[...counts].join("/")})`);
    const freqSets = new Set(ids.map((id) => plans[id].freqs.join(",")));
    check(freqSets.size === ids.length, "مجموعات الترددات مختلفة لكل نوع");
    check(plans.approval.tones === 6, `approval = 6 نغمات (نغمتان ×3) — ${plans.approval.tones}`);
    check(
      plans.done.freqs.join(",") === "523,659,784",
      `done = ثلاثية صاعدة 523→659→784 — ${plans.done.freqs.join(",")}`,
    );
    check(plans.error.waves.includes("sawtooth"), "error يستخدم موجة sawtooth");
    check(plans.toolFail.tones === 2 && plans.toolFail.total < 0.25, "toolFail = نقرتان قصيرتان");
    check(plans.disconnected.tones === 4, "disconnected = 4 نبضات");
    check(plans.reconnected.tones === 2, "reconnected = نغمتان (صاعدة ثم هادئة)");
    check(plans.message.tones === 1 && plans.message.total < 0.1, "message = نقرة خفيفة واحدة");
    check(plans.limit.tones === 2, "limit = نغمتان تحذيريتان");

    const playResults = await evalJs(`(() => {
      const out = {};
      for (const id of window.__soundTypes) out[id] = window.__soundBus.play(id);
      return { out, ctx: window.__soundBus.ctx?.state || 'none', history: window.__soundBus.history.length };
    })()`);
    check(playResults.ctx === "running", `AudioContext يعمل بعد أول تفاعل (${playResults.ctx})`);
    check(
      Object.values(playResults.out).every(Boolean),
      "كل الأنواع تُشغّل مساراً صوتياً",
      JSON.stringify(playResults.out),
    );

    console.log("\n[test-alerts]\n2) إعدادات محفوظة + كتم");
    const persisted = await evalJs(`(() => {
      window.__soundBus.setVolume(55);
      window.__soundBus.setTypeEnabled('message', false);
      const raw = localStorage.getItem('piweb.notify.settings');
      return {
        raw,
        parsed: raw ? JSON.parse(raw) : null,
        enabled: window.__soundBus.typeEnabled('message'),
      };
    })()`);
    check(
      !!persisted.parsed && persisted.parsed.volume === 55,
      "مستوى الصوت محفوظ تحت المفتاح الموحّد piweb.notify.settings",
      persisted.raw,
    );
    check(
      persisted.parsed?.types?.message === false && persisted.enabled === false,
      "مفتاح لكل نوع محفوظ في نفس المفتاح الموحّد",
      persisted.raw,
    );
    await evalJs(`(() => { window.__soundBus.setTypeEnabled('message', true); window.__soundBus.setVolume(70); return true; })()`);

    console.log("\n[test-alerts]\n3) إشعار «انتهت المهمة» + الموافقة");
    await evalJs(`(() => { window.__notifications.length = 0; return true; })()`);
    await evalJs(`(() => {
      window.__test.event({ type: 'run_start' });
      window.__test.event({ type: 'assistant_message', text: 'تم إنجاز كل المطلوب: أضفت محرّك الأصوات والاختبارات وكل شيء يعمل كما هو متوقع تماماً.', model: 'test/model-a' });
      return true;
    })()`);
    await sleep(400);
    await evalJs("window.__test.event({ type: 'settled' })");
    await sleep(700);
    const doneNotes = await evalJs("window.__notifications.filter(n => n.tag === 'pi-done')");
    check(doneNotes.length >= 1, `إشعار «انتهت المهمة» أُطلق (${doneNotes.length})`);
    const doneBody = String(doneNotes[0]?.body || "");
    check(/اكتملت|انتهت/.test(doneBody), "جسم الإشعار يذكر الحالة", doneBody);
    check(/المدة/.test(doneBody), "جسم الإشعار يضمّن مدة المهمة", doneBody);
    check(/test\/model-a|القائد|🤖/.test(doneBody), "جسم الإشعار يضمّن الوكيل/النموذج", doneBody);
    check(doneBody.includes("تم إنجاز كل المطلوب"), "جسم الإشعار يضمّن أول 80 حرفاً من آخر رد", doneBody.slice(0, 140));
    const doneSound = await evalJs("window.__soundBus.history.some(h => h.id === 'done')");
    check(doneSound === true, "صوت done شُغّل عند الانتهاء");

    await evalJs(`(() => { window.__notifications.length = 0; window.__test.approve({ id: 'req-42', title: 'تشغيل أمر', message: 'rm -rf build' }); return true; })()`);
    await sleep(400);
    const approvalNotes = await evalJs("window.__notifications.filter(n => n.tag === 'approval:req-42')");
    check(approvalNotes.length === 1, "إشعار الموافقة بـtag ثابت approval:<id>");
    check(approvalNotes[0]?.requireInteraction === true, "إشعار الموافقة requireInteraction: true");
    await evalJs("window.__test.event({ type: 'error', message: 'فشل النموذج: 429 rate limit' })");
    await sleep(300);
    check(
      (await evalJs("window.__notifications.filter(n => n.tag === 'pi-error').length")) === 1,
      "إشعار الخطأ أُطلق",
    );

    console.log("\n[test-alerts]\n4) لوحة الإشعارات (لقطات)");
    await evalJs("document.documentElement.dataset.theme = 'dark'; document.querySelector('#notifyBtn').click(); true");
    await waitFor("document.querySelector('#notifyPanel')?.open === true", { label: "فتح لوحة الإشعارات" });
    await waitFor("document.querySelectorAll('#notifySoundList .c3-sound').length === 8", { label: "جدول الأصوات" });
    check(true, "لوحة الإشعارات تعرض 8 أنواع أصوات");
    check(
      (await evalJs("document.querySelectorAll('#notifySoundList [data-test-sound]').length")) === 8,
      "زر «تجربة» لكل نوع",
    );
    check(
      (await evalJs("document.querySelector('#notifyPermState').textContent.includes('مسموحة')")) === true,
      "حالة صلاحية الإشعارات ظاهرة",
    );
    check(
      (await evalJs("document.querySelectorAll('#notifyConnLog .c3-table tbody tr').length")) >= 1,
      "سجل الاتصال ظاهر في اللوحة",
    );
    await screenshot("c3-notifications-dark.png");
    await evalJs("const b = document.querySelector('#notifyPanel .c3-body'); b.scrollTop = b.scrollHeight; true");
    await sleep(300);
    await screenshot("c3-notifications-log-dark.png");
    await evalJs("document.querySelector('#notifyPanel').close(); document.documentElement.dataset.theme = 'light'; document.querySelector('#notifyBtn').click(); true");
    await waitFor("document.querySelector('#notifyPanel')?.open === true");
    await sleep(250);
    await screenshot("c3-notifications-light.png");
    await evalJs("document.querySelector('#notifyPanel').close(); document.documentElement.dataset.theme = 'dark'; true");

    console.log("\n[test-alerts]\n5) انقطاع الخادم: السبب ثم العودة");
    await evalJs("window.__soundBus.history.length = 0; true");
    server.kill("SIGTERM");
    await waitFor("document.querySelector('#connBanner')?.classList.contains('hidden') === false", {
      timeout: 25_000,
      label: "ظهور شريط الانقطاع",
    });
    const banner = await evalJs(`(() => {
      const b = document.querySelector('#connBanner');
      return {
        reason: b.dataset.reason,
        title: document.querySelector('#connBannerTitle').textContent,
        text: document.querySelector('#connBannerReason').textContent,
        count: document.querySelector('#connBannerCount').textContent,
        hasRetry: !!document.querySelector('#connBannerRetry'),
        hasDiag: !!document.querySelector('#connBannerDiag'),
      };
    })()`);
    check(
      ["unknown", "timeout"].includes(banner.reason),
      `السبب مصنّف (${banner.reason}) — قتل مفاجئ بلا رمز إغلاق من الخادم`,
    );
    check(/غير معروف|لم يستجب/.test(banner.text), "نص عربي واضح للسبب", banner.text);
    const classify = await evalJs(`(() => ({
      s1001: window.__test.classify(1001),
      s1012: window.__test.classify(1012),
      s1013: window.__test.classify(1013),
      a1008: window.__test.classify(1008),
      a4401: window.__test.classify(4401),
      a4403: window.__test.classify(4403),
      x1006: window.__test.classify(1006),
    }))()`);
    check(
      classify.s1001 === "server-restart" && classify.s1012 === "server-restart" && classify.s1013 === "server-restart",
      "تصنيف 1001/1012/1013 ⇒ server-restart",
      JSON.stringify(classify),
    );
    check(
      classify.a1008 === "auth" && classify.a4401 === "auth" && classify.a4403 === "auth",
      "تصنيف 1008/4401/4403 ⇒ auth",
      JSON.stringify(classify),
    );
    check(classify.x1006 === "unknown", "تصنيف 1006 ⇒ unknown مع رمز الإغلاق", JSON.stringify(classify));
    await waitFor("document.querySelector('#connBanner').dataset.reason === 'timeout'", {
      timeout: 20_000,
      label: "ترقية السبب إلى timeout بعد فشل النبضة",
    });
    check(true, "تشخيص تلقائي: رمز 1006 + فشل /health ⇒ timeout");
    check(/إعادة المحاولة خلال \d+s/.test(banner.count), `عدّاد إعادة المحاولة ظاهر (${banner.count})`);
    check(banner.hasRetry && banner.hasDiag, "زر «إعادة المحاولة الآن» + رابط «تشخيص»");
    check(
      (await evalJs("window.__soundBus.history.some(h => h.id === 'disconnected')")) === true,
      "صوت disconnected شُغّل",
    );
    check(
      (await evalJs("window.__notifications.filter(n => n.tag === 'pi-connection').length")) >= 1,
      "إشعار نظام للانقطاع",
    );
    await screenshot("c3-conn-banner.png");

    await evalJs("document.querySelector('#connBannerDiag').click(); true");
    await waitFor("document.querySelector('#connDiagDialog')?.open === true", { label: "نافذة التشخيص" });
    const diagRows = await evalJs("document.querySelectorAll('#connDiagLog .c3-table tbody tr').length");
    check(diagRows >= 1, `نافذة التشخيص تعرض سجل الاتصال (${diagRows} صفاً)`);
    check(
      (await evalJs("document.querySelector('#connDiagState').textContent.includes('انقطع') || document.querySelector('#connDiagState').textContent.includes('الخادم')")) === true,
      "حالة التشخيص توضح الانقطاع",
    );
    await screenshot("c3-conn-diagnosis.png");
    await evalJs("document.querySelector('#connDiagDialog').close(); window.__soundBus.history.length = 0; true");

    log("   … إعادة تشغيل الخادم");
    server = startServer();
    await waitHealth(base, 60_000);
    await waitFor("document.querySelector('#connBanner')?.classList.contains('hidden') === true", {
      timeout: 60_000,
      label: "عودة الاتصال",
    });
    check(true, "شريط الانقطاع اختفى بعد عودة الخادم");
    await waitFor("window.__soundBus.history.some(h => h.id === 'reconnected') === true", {
      timeout: 20_000,
      label: "صوت reconnected",
    });
    check(true, "صوت reconnected شُغّل عند العودة");
    check(
      (await evalJs("window.__notifications.filter(n => n.tag === 'pi-connection' && /عاد الاتصال/.test(n.title)).length")) >= 1,
      "إشعار «عاد الاتصال» أُطلق",
    );
    const recoverRows = await evalJs("window.__conn.history.filter(h => h.kind === 'recover').length");
    check(recoverRows >= 1, "سجل الاتصال يضم حدث استعادة");
    check(
      (await evalJs("document.querySelector('#conn')?.classList.contains('online') === true")) === true,
      "الواجهة متصلة من جديد (#conn.online)",
    );

    console.log("\n[test-alerts]\n6) شريط الإشعارات المعطّلة (صلاحية مرفوضة)");
    await evalJs(`(() => {
      Object.defineProperty(window.Notification, 'permission', { value: 'denied', configurable: true });
      return true;
    })()`);
    await evalJs("document.querySelector('#notifyBtn').click(); true");
    await waitFor("document.querySelector('#notifyPermState').textContent.includes('مرفوضة')", {
      label: "حالة الرفض",
    });
    check(true, "لوحة الإشعارات تُظهر حالة الرفض مع زر إعادة الطلب");

    console.log("\n[test-alerts]\n6b) «تجربة» لكل نوع + مسح السجل");
    await evalJs("window.__soundBus.history.length = 0; true");
    for (const id of ["approval", "done", "error", "toolFail", "disconnected", "reconnected", "message", "limit"]) {
      await evalJs(`(() => { const b = document.querySelector('[data-test-sound="${id}"]'); if (!b) throw new Error('زر مفقود ${id}'); b.click(); return true; })()`);
      const played = await evalJs(`window.__soundBus.history.some(h => h.id === '${id}')`);
      check(played === true, `زر «تجربة» شغّل بصمة ${id}`);
    }
    check(consoleErrors.length === 0, "لا أخطاء console أثناء فتح اللوحة وتجربة كل الأنواع", consoleErrors.join(" | "));
    const beforeClear = await evalJs("document.querySelectorAll('#notifyConnLog .c3-table tbody tr').length");
    await evalJs("document.querySelector('#notifyConnClear').click(); true");
    const clearedRows = await evalJs("document.querySelectorAll('#notifyConnLog .c3-table tbody tr').length");
    check(
      beforeClear >= 1 && clearedRows === 1 && /لا أحداث بعد/.test(await evalJs("document.querySelector('#notifyConnLog').textContent")),
      `زر مسح السجل أفرغ السجل (${beforeClear} → 0)`,
    );
    await screenshot("c3-notifications-cleared-dark.png");
    await evalJs("document.querySelector('#notifyPanel').close(); true");

    console.log("\n[test-alerts]\n7) محاكاة connDown('timeout') من console");
    await evalJs(`(() => { window.__conn.history.length = 0; window.__soundBus.history.length = 0; return true; })()`);
    await evalJs("window.__test.connDown('timeout', { detail: 'محاكاة من console' }); true");
    await waitFor("document.querySelector('#connBanner')?.classList.contains('hidden') === false", {
      label: "شريط الانقطاع بعد المحاكاة",
    });
    const simBanner = await evalJs(`(() => {
      const b = document.querySelector('#connBanner');
      return {
        reason: b.dataset.reason,
        title: document.querySelector('#connBannerTitle').textContent,
        text: document.querySelector('#connBannerReason').textContent,
        disconnectedSound: window.__soundBus.history.some(h => h.id === 'disconnected'),
      };
    })()`);
    check(simBanner.reason === "timeout", `محاكاة timeout ⇒ سبب الشريط timeout (${simBanner.reason})`);
    check(/لم يستجب|لا رد/.test(simBanner.text), "نص الشريط يوضّح سبب المهلة", simBanner.text);
    check(simBanner.disconnectedSound === true, "صوت disconnected شُغّل بعد المحاكاة");
    await screenshot("c3-conn-timeout-simulated.png");
    check(consoleErrors.length === 0, "لا أخطاء console طوال الجلسة", consoleErrors.join(" | "));
    await evalJs("document.querySelector('#notifyPanel').close(); true");

    console.log(`\n[test-alerts] اللقطات: ${screenshots.join(" · ")}`);
    console.log(failures === 0 ? "\n✅ كل الفحوص ناجحة" : `\n❌ فشل ${failures} فحصاً`);
  } finally {
    cdp?.close();
    try {
      chrome?.kill("SIGKILL");
    } catch {
      /* تجاهل */
    }
    try {
      server?.kill("SIGKILL");
    } catch {
      /* تجاهل */
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[test-alerts] 💥", err);
  process.exit(1);
});
