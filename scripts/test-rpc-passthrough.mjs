#!/usr/bin/env node
/**
 * اختبار ذاتي لتمرير RPC العام (المرحلة B1) — لا يلمس الخادم الحيّ.
 *
 * يشغّل نسخة مؤقتة من الخادم على المنفذ 8797 مع:
 *   --no-telegram · DATA_DIR/WORKSPACE في /tmp · FEATURE_RPC=1 · بلا WEB_TOKEN
 * ثم يتحقق عبر WebSocket من:
 *   1) ready للجلسة المؤقتة.
 *   2) رفض الأوامر غير المسموحة بـ rpc_error عربي واضح.
 *   3) get_commands عبر {type:"rpc"} وإرجاع rpc_result.
 *   4) get_session_stats عبر {type:"rpc"}.
 *   5) GET/DELETE /api/approvals (عرض وحذف قاعدة محفوظة).
 *
 * الاستخدام:
 *   node scripts/test-rpc-passthrough.mjs --self-test [--keep] [--verbose]
 * متغيرات اختيارية:
 *   TEST_PORT (افتراضي 8797) · RPC_TEST_TIMEOUT_MS (افتراضي 180000)
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

if (!process.argv.includes("--self-test")) {
  console.error("الاستخدام: node scripts/test-rpc-passthrough.mjs --self-test [--keep] [--verbose]");
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 8797);
const TIMEOUT_MS = Number(process.env.RPC_TEST_TIMEOUT_MS) || 180_000;
const KEEP = process.argv.includes("--keep");
const VERBOSE = process.argv.includes("--verbose");

const log = (...args) => console.log("[test-rpc-passthrough]", ...args);
const debug = (...args) => {
  if (VERBOSE) console.log("[test-rpc-passthrough:debug]", ...args);
};

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* الخادم لم يبدأ بعد */
    }
    await sleep(150);
  }
  throw new Error(`الخادم المؤقت لم يستجب على ${baseUrl}/health خلال ${timeoutMs}ms`);
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

class WsHarness {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.messages = [];
    this.waiters = new Set();
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
      debug("WS ←", message.type, message.id || message.conversationId || "");
      this.messages.push(message);
      for (const waiter of [...this.waiters]) waiter(message);
    });
    return new Promise((resolvePromise, rejectPromise) => {
      this.ws.once("open", resolvePromise);
      this.ws.once("error", rejectPromise);
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  waitFor(predicate, { timeoutMs = TIMEOUT_MS, label = "رسالة" } = {}) {
    const existing = this.messages.findIndex(predicate);
    if (existing !== -1) return Promise.resolve(this.messages.splice(existing, 1)[0]);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.waiters.delete(handler);
        rejectPromise(new Error(`انتهت مهلة انتظار ${label} (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();
      const handler = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.waiters.delete(handler);
        const index = this.messages.indexOf(message);
        if (index !== -1) this.messages.splice(index, 1);
        resolvePromise(message);
      };
      this.waiters.add(handler);
    });
  }

  async rpc(id, command, data = {}, timeoutMs = TIMEOUT_MS) {
    this.send({ type: "rpc", id, command, data });
    return this.waitFor(
      (message) => (message.type === "rpc_result" || message.type === "rpc_error") && message.id === id,
      { timeoutMs, label: `رد RPC للأمر ${command}` },
    );
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* تجاهل */
    }
  }
}

async function main() {
  const tmpRoot = mkdtempSync(join(os.tmpdir(), "pi-rpc-test-"));
  const dataDir = join(tmpRoot, "data");
  const workspace = join(tmpRoot, "ws");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const approvalsFile = join(dataDir, "approvals.json");
  writeFileSync(
    approvalsFile,
    `${JSON.stringify(
      { version: 1, rules: [{ tool: "bash", pattern: "echo", createdAt: Date.now() }] },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    WORKSPACE: workspace,
    PI_APPROVALS_FILE: approvalsFile,
    FEATURE_RPC: "1",
    WEB_TOKEN: "",
    PI_SUPERVISED: "",
    TELEGRAM_BOT_TOKEN: "",
    SHARED_SESSION_ID: "shared:main",
  };

  const baseUrl = `http://127.0.0.1:${PORT}`;
  log(`مساحة عمل مؤقتة: ${workspace}`);
  log(`بيانات مؤقتة   : ${dataDir}`);
  log(`الخادم المؤقت  : ${baseUrl} (بلا تيليجرام)`);

  const child = spawn(process.execPath, [join(ROOT, "src", "index.js"), "--no-telegram"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const serverLog = [];
  const collect = (chunk) => {
    const text = chunk.toString();
    serverLog.push(text);
    if (VERBOSE) process.stdout.write(text);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  let exited = false;
  child.once("exit", (code, signal) => {
    exited = true;
    debug(`الخادم المؤقت خرج: code=${code} signal=${signal || "-"}`);
  });

  const harness = new WsHarness(`ws://127.0.0.1:${PORT}/ws?conversation=test:rpc-passthrough`);
  let ready = null;

  try {
    console.log(`\n[test-rpc-passthrough]\n1) تشغيل الخادم المؤقت والاتصال`);
    await waitForHealth(baseUrl, 60_000);
    check(true, `الخادم المؤقت يستجيب على ${baseUrl}/health`);
    check(!exited, "الخادم المؤقت ما زال يعمل");

    await harness.open();
    check(true, "اتصال WebSocket مفتوح");

    ready = await harness.waitFor((message) => message.type === "ready", {
      timeoutMs: TIMEOUT_MS,
      label: "ready من الجلسة المؤقتة",
    });
    check(ready.conversationId === "test:rpc-passthrough", "ready يحمل conversationId الصحيح", ready.conversationId);
    check(!!ready.state && typeof ready.state === "object", "ready يحمل state (النموذج/التفكير/الانشغال)");

    console.log(`\n[test-rpc-passthrough]\n2) رفض الأوامر غير المسموحة`);
    const denied = await harness.rpc("denied-1", "prompt", { message: "must not run" }, 30_000);
    check(denied.type === "rpc_error", "الأمر prompt غير المسموح يُرفض بـ rpc_error");
    check(/غير مسموح/.test(denied.message || ""), "رسالة الرفض عربية وواضحة", denied.message);

    console.log(`\n[test-rpc-passthrough]\n3) get_commands عبر rpc`);
    const commands = await harness.rpc("cmds-1", "get_commands", {});
    check(commands.type === "rpc_result", "وصل rpc_result لـ get_commands", commands.type);
    check(commands.ok === true, "ok=true لـ get_commands");
    const commandList = commands.data?.commands;
    check(Array.isArray(commandList), "data.commands مصفوفة", JSON.stringify(commands.data)?.slice(0, 300));
    if (Array.isArray(commandList)) {
      check(commandList.every((item) => item && typeof item.name === "string" && item.name), "كل أمر يحمل name");
      log(`   عدد الأوامر المكتشفة: ${commandList.length}`);
      const sources = commandList.reduce((acc, item) => {
        acc[item.source] = (acc[item.source] || 0) + 1;
        return acc;
      }, {});
      log(`   التوزيع: ${JSON.stringify(sources)}`);
      const sample = commandList.slice(0, 6).map((item) => `/${item.name}`).join(" · ");
      if (sample) log(`   أمثلة: ${sample}`);
      const hasApprovals = commandList.some((item) => item.name === "approvals" && item.source === "extension");
      if (hasApprovals) log("   ✓ أمر الإضافة /approvals ظاهر في القائمة");
    }

    console.log(`\n[test-rpc-passthrough]\n4) get_session_stats عبر rpc`);
    const stats = await harness.rpc("stats-1", "get_session_stats", {});
    check(stats.type === "rpc_result", "وصل rpc_result لـ get_session_stats", stats.type);
    check(stats.ok === true, "ok=true لـ get_session_stats");
    const data = stats.data || {};
    check(typeof data.totalMessages === "number", "totalMessages رقم", JSON.stringify(data).slice(0, 300));
    check(!!data.tokens && typeof data.tokens === "object", "tokens كائن (input/output/total)");
    check(typeof data.sessionId === "string" && data.sessionId.length > 0, "sessionId موجود");
    log(`   الرسائل: ${data.totalMessages} · التوكنز: ${data.tokens?.total ?? 0} · التكلفة: ${data.cost ?? 0}`);

    console.log(`\n[test-rpc-passthrough]\n5) GET/DELETE /api/approvals`);
    const listed = await getJson(`${baseUrl}/api/approvals`);
    check(listed.status === 200 && listed.data?.ok === true, "GET /api/approvals يعيد 200 و ok:true");
    check(Array.isArray(listed.data?.rules) && listed.data.rules.length === 1, "قاعدة ما قبل الاختبار ظاهرة");
    check(listed.data?.rules?.[0]?.tool === "bash" && listed.data?.rules?.[0]?.pattern === "echo", "محتوى القاعدة صحيح");
    const removed = await getJson(`${baseUrl}/api/approvals`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "bash", pattern: "echo" }),
    });
    check(removed.status === 200 && removed.data?.removed === 1, "DELETE يحذف قاعدة محددة");
    check(Array.isArray(removed.data?.rules) && removed.data.rules.length === 0, "لا قواعد متبقية بعد الحذف");
    const after = await getJson(`${baseUrl}/api/approvals`);
    check(after.data?.rules?.length === 0, "GET بعد الحذف يعيد قائمة فارغة");

    console.log(`\n[test-rpc-passthrough]\nالنتيجة`);
    if (failures > 0) {
      console.error(`❌ فشل ${failures} فحصاً.`);
      process.exitCode = 1;
    } else {
      console.log("✅ PASS: تمرير RPC العام يعمل (get_commands + get_session_stats + approvals API).");
    }
  } catch (err) {
    failures += 1;
    console.error(`\n❌ FAIL: ${err?.message || err}`);
    if (serverLog.length) {
      console.error("--- آخر سجل الخادم ---");
      console.error(serverLog.join("").split("\n").slice(-40).join("\n"));
    }
    process.exitCode = 1;
  } finally {
    harness.close();
    try {
      child.kill("SIGTERM");
    } catch {
      /* تجاهل */
    }
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(100);
    if (!exited) {
      try {
        child.kill("SIGKILL");
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
