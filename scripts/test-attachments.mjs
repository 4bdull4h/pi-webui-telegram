#!/usr/bin/env node
/**
 * اختبار ذاتي للمرحلة B2: رفع الصور/الملفات + المعاينة الآمنة + إكمال المسارات + WS prompt بالصور.
 *
 * ما يفعله:
 *   1) يشغّل خادماً مؤقتاً على PORT=8799 مع --no-telegram وبمساحة عمل وبيانات معزولة (tmp).
 *   2) يرفع PNG صغيراً + ملفاً نصياً عبر POST /api/upload (multipart) ويتحقق من الاستجابة.
 *   3) يقرأ الصورة عبر GET /files/<id> ويتحقق من النوع والحجم والبايتات.
 *   4) يجرّب GET /files/..%2F..%2Fetc%2Fpasswd ويتوقع الرفض.
 *   5) يتحقق من GET /api/files?q=... (مسار نسبي، تجاهل node_modules، رفض ..).
 *   6) يرفض ملفاً بحجم 26MB برسالة عربية (413).
 *   7) يتصل بـWS ويرسل prompt بصورة (base64) + مسار مرفق نصي، ويتحقق من:
 *      - رفض صيغة صورة غير مدعومة برسالة عربية.
 *      - وصول user_message مع سطر "📎 مرفقات:" و run_start ثم settled بلا خطأ
 *        (أو بلا خطأ mime مع --no-model-required).
 *
 * الاستخدام:
 *   node scripts/test-attachments.mjs --self-test [--no-model-required] [--model=provider/id] [--verbose]
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import WebSocket from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PORT = Number(process.env.ATTACH_TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const NO_MODEL = process.argv.includes("--no-model-required");
const MODEL_OVERRIDE =
  process.argv.find((a) => a.startsWith("--model="))?.split("=").slice(1).join("=") ||
  process.env.ATTACH_TEST_MODEL ||
  "";
const verbose = process.argv.includes("--verbose");
const SETTLE_TIMEOUT_MS = Number(process.env.ATTACH_TEST_TIMEOUT_MS) || 240_000;

const log = (...args) => console.log("[test-attachments]", ...args);
const debug = (...args) => {
  if (verbose) console.log("[test-attachments:debug]", ...args);
};

let failures = 0;
function check(condition, label, extra) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  ❌ ${label}${extra ? `\n     ↳ ${extra}` : ""}`);
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===== PNG صغير حقيقي (RGB) ===== */
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function makePng(width = 16, height = 16, rgb = [220, 30, 60]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) rows.push(...rgb);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ===== خادم مؤقت ===== */
function startServer(tmp) {
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DATA_DIR: join(tmp, "data"),
    WORKSPACE: join(tmp, "ws"),
    TELEGRAM_BOT_TOKEN: "",
    WEB_TOKEN: "",
    FEATURE_RPC: "",
    PI_SUPERVISED: "",
  };
  const child = spawn(process.execPath, [join(ROOT, "src", "index.js"), "--no-telegram"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const push = (chunk) => {
    const text = chunk.toString();
    output.push(text);
    if (verbose) process.stdout.write(`[server] ${text}`);
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  return { child, output };
}

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* لم يبدأ بعد */
    }
    await sleep(400);
  }
  return false;
}

/* ===== WS مساعد ===== */
function openSocket(conversationId) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?conversation=${encodeURIComponent(conversationId)}`);
  const messages = [];
  const waiters = new Set();
  const push = (message) => {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  };
  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      debug("ws ←", message.type, message.event?.type || "");
      push(message);
    } catch {
      /* تجاهل */
    }
  });
  const waitFor = (predicate, timeoutMs, label) =>
    new Promise((resolvePromise, rejectPromise) => {
      const existing = messages.find(predicate);
      if (existing) return resolvePromise(existing);
      const waiter = {
        predicate,
        resolve: resolvePromise,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          rejectPromise(new Error(`انتهت المهلة منتظراً: ${label}`));
        }, timeoutMs),
      };
      waiters.add(waiter);
    });
  const ready = new Promise((resolvePromise, rejectPromise) => {
    ws.once("open", resolvePromise);
    ws.once("error", rejectPromise);
  });
  return { ws, messages, waitFor, ready, close: () => ws.close() };
}

/* ===== التشغيل ===== */
async function main() {
  if (!process.argv.includes("--self-test")) {
    console.log("استخدم: node scripts/test-attachments.mjs --self-test [--no-model-required]");
    process.exit(2);
  }

  const tmp = mkdtempSync(join(os.tmpdir(), "pi-attach-test-"));
  const workspace = join(tmp, "ws");
  mkdirSync(join(workspace, "src", "docs"), { recursive: true });
  mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(tmp, "data"), { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "ملاحظات الاختبار\n");
  writeFileSync(join(workspace, "src", "app.js"), "export const x = 1;\n");
  writeFileSync(join(workspace, "src", "docs", "readme.md"), "# readme\n");
  writeFileSync(join(workspace, "node_modules", "pkg", "index.js"), "module.exports = {};\n");

  log("مساحة عمل مؤقتة:", workspace);
  const { child, output } = startServer(tmp);
  let socket = null;

  const cleanup = () => {
    try {
      socket?.close();
    } catch {
      /* تجاهل */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* تجاهل */
    }
    if (!process.env.ATTACH_TEST_KEEP) {
      setTimeout(() => rmSync(tmp, { recursive: true, force: true }), 500);
    }
  };
  process.on("exit", cleanup);

  try {
    if (!(await waitForServer())) {
      throw new Error(`الخادم المؤقت لم يستجب على ${BASE}\n${output.join("").slice(-2000)}`);
    }
    log(`الخادم يعمل على ${BASE}`);

    /* -------- 1) رفع PNG + ملف نصي -------- */
    log("\n1) POST /api/upload — PNG + ملف نصي");
    const png = makePng();
    const form = new FormData();
    form.append("files", new Blob([png], { type: "image/png" }), "لقطة-اختبار.png");
    form.append("files", new Blob([Buffer.from("hello attachments\n")], { type: "text/plain" }), "hello.txt");
    const uploadRes = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
    const uploadBody = await uploadRes.json().catch(() => ({}));
    debug("upload:", uploadRes.status, JSON.stringify(uploadBody).slice(0, 400));
    check(uploadRes.status === 200 && uploadBody.ok === true, "استجابة الرفع 200 و ok:true", JSON.stringify(uploadBody));
    const files = Array.isArray(uploadBody.files) ? uploadBody.files : [];
    check(files.length === 2, "ملفان مرفوعان", `العدد: ${files.length}`);
    const image = files.find((f) => f.kind === "image");
    const textFile = files.find((f) => f.kind === "file");
    check(!!image && image.mime === "image/png", "تصنيف الصورة image/png", JSON.stringify(image));
    check(!!textFile && textFile.mime === "text/plain", "تصنيف الملف النصي text/plain", JSON.stringify(textFile));
    check(!!image?.url?.startsWith("/files/"), "url للمعاينة يبدأ بـ/files/", image?.url);
    check(
      !!image?.path?.includes(join("uploads", new Date().toISOString().slice(0, 10), "")),
      "مسار التخزين data/uploads/<yyyy-mm-dd>/…",
      image?.path,
    );
    check(image?.size === png.length, "الحجم الفعلي مطابق", `${image?.size} ≠ ${png.length}`);

    /* -------- 2) المعاينة الآمنة -------- */
    log("\n2) GET /files/<id>");
    const previewRes = await fetch(`${BASE}${image?.url || "/files/missing"}`);
    const previewBytes = Buffer.from(await previewRes.arrayBuffer());
    check(previewRes.status === 200, "معاينة الصورة 200", String(previewRes.status));
    check(
      (previewRes.headers.get("content-type") || "").includes("image/png"),
      "content-type صحيح",
      previewRes.headers.get("content-type"),
    );
    check(previewBytes.equals(png), "بايتات الصورة مطابقة", `${previewBytes.length} ≠ ${png.length}`);

    const textUrl = `${BASE}/files/${encodeURI(textFile?.id || "")}`;
    const textPreview = await fetch(textUrl);
    check(textPreview.status === 404, "ملف غير صورة لا يُقدَّم عبر /files/", String(textPreview.status));

    for (const evil of ["..%2F..%2Fetc%2Fpasswd", "2020-01-01%2F..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd"]) {
      const res = await fetch(`${BASE}/files/${evil}`);
      check(res.status === 400 || res.status === 404, `رفض مسار خطير: ${evil}`, String(res.status));
    }

    /* -------- 3) إكمال المسارات -------- */
    log("\n3) GET /api/files");
    const listAll = await (await fetch(`${BASE}/api/files?q=&limit=20`)).json();
    const paths = (listAll.items || []).map((i) => i.path);
    debug("files:", paths.join(", "));
    check(listAll.ok === true, "ok:true");
    check(paths.includes("notes.txt"), "يظهر notes.txt", paths.join(", "));
    check(paths.includes("src/"), "المجلدات تنتهي بـ /", paths.join(", "));
    check(!paths.some((p) => p.startsWith("node_modules")), "node_modules مستثنى", paths.join(", "));

    const listed = await (await fetch(`${BASE}/api/files?q=src/`)).json();
    const srcPaths = (listed.items || []).map((i) => i.path);
    check(srcPaths.includes("src/app.js") && srcPaths.includes("src/docs/"), "/api/files?q=src/ يسرد المحتوى", srcPaths.join(", "));

    const partial = await (await fetch(`${BASE}/api/files?q=src/ap`)).json();
    check((partial.items || []).some((i) => i.path === "src/app.js"), "البادئة src/ap تُكمل src/app.js", JSON.stringify(partial.items));
    check((partial.items || []).length <= 20, "حد أقصى 20 نتيجة", String((partial.items || []).length));

    const traversal = await fetch(`${BASE}/api/files?q=../../etc`);
    check(traversal.status === 400, "رفض ?q=.. بخطأ 400", String(traversal.status));

    /* -------- 4) حد الحجم -------- */
    log("\n4) حد الحجم (26MB)");
    const big = Buffer.alloc(26 * 1024 * 1024, 0x41);
    const bigForm = new FormData();
    bigForm.append("files", new Blob([big], { type: "application/octet-stream" }), "big.bin");
    const bigRes = await fetch(`${BASE}/api/upload`, { method: "POST", body: bigForm }).catch((err) => ({ error: err }));
    if (bigRes?.error) {
      check(false, "رد واضح على تجاوز الحد", bigRes.error.message);
    } else {
      const bigBody = await bigRes.json().catch(() => ({}));
      check(bigRes.status === 413, "413 عند تجاوز 25MB", String(bigRes.status));
      check(/25MB|40MB|الحد/.test(bigBody.error || ""), "رسالة عربية توضح الحد", bigBody.error);
    }

    /* -------- 5) WS prompt بصورة -------- */
    log("\n5) WS prompt — صورة + مرفق نصي");
    const modelsRes = await (await fetch(`${BASE}/api/models`)).json();
    const models = modelsRes.models || [];
    const chosen =
      (MODEL_OVERRIDE && models.find((m) => `${m.provider}/${m.id}` === MODEL_OVERRIDE)) ||
      models.find((m) => m.vision) ||
      null;
    if (chosen) log(`   النموذج: ${chosen.provider}/${chosen.id} (vision=${!!chosen.vision})`);
    const modelMode = !NO_MODEL && !!chosen;
    if (!modelMode) log("   وضع بلا تشغيل نموذج (--no-model-required أو لا يوجد نموذج يدعم الصور).");

    socket = openSocket(`test:attachments-${Date.now()}`);
    await socket.ready;
    await socket.waitFor((m) => m.type === "ready", 120_000, "ready");
    check(true, "الاتصال جاهز (ready)");

    if (chosen) {
      const state = socket.messages.find((m) => m.type === "ready")?.state;
      const sameModel = state?.provider === chosen.provider && state?.model === chosen.id;
      if (!sameModel) {
        socket.ws.send(JSON.stringify({ type: "set_model", provider: chosen.provider, model: chosen.id }));
        await socket.waitFor((m) => m.type === "state", 60_000, "state بعد set_model").catch(() => null);
      }
    }

    // صيغة غير مدعومة ← خطأ عربي واضح
    socket.ws.send(
      JSON.stringify({
        type: "prompt",
        text: "اختبار صيغة",
        images: [{ data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" }],
      }),
    );
    const badError = await socket.waitFor(
      (m) => m.type === "error" && /صورة|مدعومة|mime/i.test(m.message || ""),
      20_000,
      "خطأ صيغة الصورة",
    ).catch(() => null);
    check(!!badError, "رفض صيغة صورة غير مدعومة برسالة عربية", badError?.message || "لا رسالة");

    // طلب سليم: الصورة base64 + مسار ملف نصي
    const promptText = "ما لون هذه الصورة؟ أجب بكلمة واحدة.";
    socket.ws.send(
      JSON.stringify({
        type: "prompt",
        text: promptText,
        images: [{ data: png.toString("base64"), mimeType: "image/png" }],
        attachments: [{ path: textFile.path, name: textFile.name, mime: textFile.mime }],
      }),
    );

    const userMessage = await socket.waitFor(
      (m) => m.type === "event" && m.event?.type === "user_message",
      30_000,
      "user_message",
    ).catch(() => null);
    check(!!userMessage, "وصل user_message إلى الجلسة");
    check(
      /📎 مرفقات:/.test(userMessage?.event?.text || "") && (userMessage?.event?.text || "").includes(textFile.path),
      "سطر المرفقات يحتوي المسار المطلق",
      userMessage?.event?.text,
    );

    const runStart = await socket.waitFor(
      (m) => m.type === "event" && m.event?.type === "run_start",
      60_000,
      "run_start",
    ).catch(() => null);
    check(!!runStart, "run_start وصل (قُبلت الصورة بلا خطأ mime)");

    if (modelMode) {
      const done = await socket
        .waitFor(
          (m) =>
            m.type === "event" &&
            (m.event?.type === "settled" || m.event?.type === "error" || m.type === "error"),
          SETTLE_TIMEOUT_MS,
          "settled",
        )
        .catch(() => null);
      const settleEvent = done?.event || done;
      check(
        settleEvent?.type === "settled",
        "settled بلا خطأ بعد الصورة",
        settleEvent?.type === "error" ? settleEvent.message : "انتهت المهلة",
      );
      const assistant = socket.messages
        .filter((m) => m.type === "event" && m.event?.type === "assistant_message")
        .pop();
      if (assistant?.event?.text) log(`   رد الوكيل: ${assistant.event.text.trim().slice(0, 160)}`);
    } else {
      // بلا نموذج: نكتفي بإثبات القبول، وقد يأتي خطأ مزوّد لا علاقة له بالصور.
      await sleep(2500);
      const errors = socket.messages
        .filter((m) => m.type === "event" && m.event?.type === "error")
        .map((m) => m.event.message);
      const mimeErrors = errors.filter((message) => /mime|صورة|image/i.test(message || ""));
      check(mimeErrors.length === 0, "لا خطأ متعلق بالصور/mime", mimeErrors.join(" | "));
      socket.ws.send(JSON.stringify({ type: "abort" }));
    }
  } catch (err) {
    failures += 1;
    console.error(`\n❌ خطأ غير متوقع: ${err?.message || err}`);
    if (verbose) console.error(err?.stack || "");
    console.error(output.join("").slice(-3000));
  } finally {
    await sleep(300);
    cleanup();
  }

  console.log("");
  if (failures) {
    console.error(`❌ FAIL — ${failures} فحص/فحوص فاشلة`);
    process.exit(1);
  }
  console.log("✅ PASS — كل فحوصات B2 نجحت");
  process.exit(0);
}

main();
