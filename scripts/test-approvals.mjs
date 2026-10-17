#!/usr/bin/env node
/**
 * اختبار ذاتي لإضافة موافقة الأدوات (المرحلة C2).
 *
 * يشغّل `pi --mode rpc` مع:
 *   -e extensions/approvals.ts
 *   --tools bash
 *   --no-session --no-extensions --no-skills
 *   model = deepseek/deepseek-flash (رخيص، قابل للتغيير عبر APPROVAL_TEST_MODEL)
 *
 * ثم يطلب من النموذج تشغيل أمر bash بسيط، ويتحقق من:
 *   1) وصول extension_ui_request بالطريقة "select" وخيارات الموافقة الثلاثة.
 *   2) أن العنوان يشرح الأمر المطلوب.
 *   3) إرسال اختيار "✅ سماح" ثم نجاح تنفيذ bash ومخرجات echo.
 *   4) اكتمال الجلسة بحدث agent_settled.
 *   5) أن "سماح مرة واحدة" لا يكتب أي قاعدة في approvals.json.
 *
 * الاستخدام:
 *   node scripts/test-approvals.mjs --self-test [--verbose]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { resolvePiCli } from "../src/rpc/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const EXTENSION_FILE = join(ROOT, "extensions", "approvals.ts");

const PROVIDER = (process.env.APPROVAL_TEST_PROVIDER || "deepseek").trim();
const MODEL = (process.env.APPROVAL_TEST_MODEL || "deepseek-flash").trim();
const SETTLE_TIMEOUT_MS = Number(process.env.APPROVAL_TEST_TIMEOUT_MS) || 180_000;
const REPLY_TIMEOUT_MS = 30_000;

const MARKER = "approvals-ok";
const PROMPT = `استخدم أداة bash لتشغيل هذا الأمر حرفياً ثم أجب بمخرجته فقط، دون أي خطوة أخرى:\necho ${MARKER}`;
const RETRY_PROMPT = `شغّل الأمر التالي الآن باستخدام أداة bash فقط:\necho ${MARKER}`;

const OPTIONS = [
  "✅ سماح",
  "⛔️ رفض",
  "🔁 سماح دائماً لهذا الأمر",
  "♾️ سماح دائماً لهذه الأداة",
];
const SCENARIO = (() => {
  const raw = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1] || "allow";
  if (raw === "always" || raw === "always-tool") return raw;
  return "allow";
})();
/** الاختيار الذي يرسله الاختبار: سماح مرة واحدة، قاعدة أمر، أو قاعدة أداة. */
const RESPONSE =
  SCENARIO === "always" ? OPTIONS[2] : SCENARIO === "always-tool" ? OPTIONS[3] : OPTIONS[0];

const verbose = process.argv.includes("--verbose");
const log = (...args) => console.log("[test-approvals]", ...args);
const debug = (...args) => {
  if (verbose) console.log("[test-approvals:debug]", ...args);
};

function fail(message, extra) {
  console.error(`\n❌ FAIL: ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function pass(message) {
  console.log(`\n✅ PASS: ${message}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class RpcChild {
  constructor({ cliPath, cwd, env }) {
    this.pending = new Map();
    this.seq = 0;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.stderr = [];
    this.events = [];
    this.onEvent = null;
    this.exited = false;

    this.child = spawn(
      process.execPath,
      [
        cliPath,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--provider",
        PROVIDER,
        "--model",
        MODEL,
        "--tools",
        "bash",
        "--extension",
        EXTENSION_FILE,
      ],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk) =>
      this.stderr.push(this.decoder.write(chunk).trimEnd()),
    );
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`خرج pi (code=${code}, signal=${signal || "-"})`));
      }
      this.pending.clear();
    });
  }

  #onStdout(chunk) {
    this.buffer += this.decoder.write(chunk);
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        debug("سطر غير JSON:", line.slice(0, 160));
        continue;
      }
      this.#onRecord(record);
    }
  }

  #onRecord(record) {
    if (record.type === "response" && record.id && this.pending.has(record.id)) {
      const entry = this.pending.get(record.id);
      this.pending.delete(record.id);
      clearTimeout(entry.timer);
      if (record.success) entry.resolve(record.data ?? null);
      else entry.reject(new Error(record.error || `فشل ${record.command || "الأمر"}`));
      return;
    }
    this.events.push(record);
    debug("event:", record.type, record.method || record.toolName || "");
    try {
      this.onEvent?.(record);
    } catch (err) {
      console.error("[test-approvals] onEvent error:", err?.message || err);
    }
  }

  request(command, timeoutMs = 30_000) {
    if (this.exited) return Promise.reject(new Error("العملية خرجت"));
    const id = `approval-test-${++this.seq}`;
    const payload = { ...command, id };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`انتهت مهلة ${command.type} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    });
  }

  respond(id, payload) {
    this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...payload })}\n`, "utf8");
  }

  async dispose() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      /* تجاهل */
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* تجاهل */
    }
    for (let i = 0; i < 40 && !this.exited; i++) await sleep(50);
    if (!this.exited) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* تجاهل */
      }
    }
  }
}

function toolOutputText(record) {
  const result = record?.result;
  if (!result) return "";
  if (typeof result === "string") return result;
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n");
  }
  if (typeof result.output === "string") return result.output;
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

async function waitForSettled(rpc, { since = 0, timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rpc.exited) throw new Error("خرجت عملية pi قبل استقرار الجلسة");
    const settled = rpc.events.slice(since).find((record) => record.type === "agent_settled");
    if (settled) return settled;
    await sleep(100);
  }
  throw new Error(`لم يصل agent_settled خلال ${timeoutMs}ms`);
}

async function main() {
  if (!process.argv.includes("--self-test")) {
    console.log("الاستخدام: node scripts/test-approvals.mjs --self-test [--scenario=allow|always] [--verbose]");
    process.exit(2);
  }
  if (!existsSync(EXTENSION_FILE)) fail(`ملف الإضافة غير موجود: ${EXTENSION_FILE}`);

  const cliPath = resolvePiCli();
  const tmpRoot = mkdtempSync(join(os.tmpdir(), "pi-approvals-"));
  const cwd = join(tmpRoot, "workspace");
  const rulesFile = join(tmpRoot, "approvals.json");
  mkdirSync(cwd, { recursive: true });

  console.log("");
  log(`cli      = ${cliPath}`);
  log(`model    = ${PROVIDER}/${MODEL}`);
  log(`extension= ${EXTENSION_FILE}`);
  log(`cwd      = ${cwd}`);
  log(`rules    = ${rulesFile}`);
  console.log("");

  const rpc = new RpcChild({
    cliPath,
    cwd,
    env: {
      ...process.env,
      APPROVAL_MODE: "dangerous",
      APPROVAL_TIMEOUT_MS: "60000",
      PI_APPROVALS_FILE: rulesFile,
      APPROVAL_FAIL_OPEN: "",
    },
  });

  const seenDialogs = [];
  const toolStarts = [];
  const toolEnds = [];
  const notified = [];

  rpc.onEvent = (record) => {
    if (record.type === "extension_ui_request") {
      if (record.method === "notify") {
        notified.push(record.message || "");
        log(`notify: ${record.message || ""}`);
        return;
      }
      if (record.method !== "select") {
        // أي حوار غير متوقع: رفض آمن حتى لا تتعلّق العملية.
        log(`⚠️ حوار غير متوقع (${record.method}) → إلغاء`);
        rpc.respond(record.id, { cancelled: true });
        return;
      }
      seenDialogs.push(record);
      log("extension_ui_request ← method=select");
      log(`  title   : ${String(record.title || "").replace(/\n/g, " | ")}`);
      log(`  options : ${JSON.stringify(record.options)}`);
      log(`  timeout : ${record.timeout ?? "-"}ms`);
      rpc.respond(record.id, { value: RESPONSE });
      log(`→ extension_ui_response: value="${RESPONSE}"`);
      return;
    }
    if (record.type === "tool_execution_start") {
      toolStarts.push(record);
      log(`tool_execution_start: ${record.toolName}`);
    }
    if (record.type === "tool_execution_end") {
      toolEnds.push(record);
      const output = toolOutputText(record).trim().split("\n").slice(0, 4).join(" | ");
      log(`tool_execution_end: ${record.toolName} isError=${record.isError} output=${JSON.stringify(output)}`);
    }
  };

  try {
    const startedAt = Date.now();
    const state = await rpc.request({ type: "get_state" }, REPLY_TIMEOUT_MS);
    log(`ready: model=${state?.model ? `${state.model.provider}/${state.model.id}` : "-"} streaming=${state?.isStreaming}`);

    let attempt = 0;
    while (attempt < 2 && seenDialogs.length === 0) {
      attempt += 1;
      const prompt = attempt === 1 ? PROMPT : RETRY_PROMPT;
      const since = rpc.events.length;
      const start = Date.now();
      log(`prompt (محاولة ${attempt}): ${prompt.replace(/\n/g, " ⏎ ")}`);
      await rpc.request({ type: "prompt", message: prompt }, REPLY_TIMEOUT_MS);
      try {
        await waitForSettled(rpc, { since, timeoutMs: SETTLE_TIMEOUT_MS });
        log(`settled: attempt=${attempt} elapsed=${Date.now() - start}ms`);
      } catch (err) {
        log(`⚠️ ${err.message}`);
      }
      if (seenDialogs.length > 0) break;
      log("⚠️ لم يطلب النموذج bash في هذه المحاولة.");
    }

    if (seenDialogs.length === 0) {
      const assistantTexts = rpc.events
        .filter((record) => record.type === "message_end" && record.message?.role === "assistant")
        .map((record) => toolOutputText({ result: record.message }))
        .filter(Boolean)
        .slice(-3);
      fail(
        "لم يصل أي extension_ui_request بالطريقة select (ربما لم يستدعِ النموذج bash).",
        [
          `stderr (آخر الأسطر):\n${rpc.stderr.slice(-8).join("\n")}`,
          `آخر ردود النموذج:\n${assistantTexts.join("\n---\n").slice(0, 2000) || "(لا شيء)"}`,
        ].join("\n\n"),
      );
    }

    const dialog = seenDialogs[0];
    if (JSON.stringify(dialog.options) !== JSON.stringify(OPTIONS)) {
      fail(`خيارات الحوار غير متوقعة: ${JSON.stringify(dialog.options)}`);
    }
    log("✔ الخيارات الأربعة وصلت بالترتيب المتوقع.");

    if (!/bash/i.test(dialog.title || "") || !dialog.title.includes(MARKER)) {
      fail(`عنوان الحوار لا يشرح الأمر/الأداة: ${JSON.stringify(dialog.title)}`);
    }
    log("✔ عنوان الحوار يذكر الأداة والأمر.");

    const bashStart = toolStarts.find((record) => record.toolName === "bash");
    if (!bashStart) fail("لم يبدأ تنفيذ bash بعد الموافقة.");
    log("✔ بدأ تنفيذ bash بعد الموافقة.");

    const bashEnd = toolEnds.find((record) => record.toolName === "bash");
    if (!bashEnd) fail("لم يصل tool_execution_end لأداة bash.");
    if (bashEnd.isError) fail(`بش خرج بخطأ: ${toolOutputText(bashEnd).slice(0, 500)}`);
    if (!toolOutputText(bashEnd).includes(MARKER)) {
      fail(`مخرجات bash لا تحتوي العلامة ${MARKER}: ${toolOutputText(bashEnd).slice(0, 500)}`);
    }
    log(`✔ bash نجح والمخرجات تحتوي "${MARKER}".`);

    const settledRecords = rpc.events.filter((record) => record.type === "agent_settled");
    const settled = settledRecords.length
      ? settledRecords[settledRecords.length - 1]
      : await waitForSettled(rpc, { since: 0, timeoutMs: SETTLE_TIMEOUT_MS });
    log(`✔ agent_settled وصل (aborted=${settled.aborted}).`);

    // سماح مرة واحدة يجب ألا يحفظ قاعدة؛ وسماح دائم يجب أن يحفظ {tool, pattern}.
    let rules = [];
    if (existsSync(rulesFile)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(rulesFile, "utf8"));
      } catch {
        fail(`ملف القواعد تالف بعد السيناريو ${SCENARIO}.`);
      }
      rules = Array.isArray(parsed) ? parsed : parsed?.rules || [];
    }
    if (SCENARIO === "always") {
      const saved = rules.find((rule) => rule.tool === "bash" && rule.pattern === "echo");
      if (!saved) fail(`لم تُحفظ قاعدة السماح الدائم: ${JSON.stringify(rules)}`);
      log("✔ حُفظت قاعدة {tool: bash, pattern: echo} في ملف القواعد.");
    } else if (SCENARIO === "always-tool") {
      const saved = rules.find((rule) => rule.tool === "bash" && rule.pattern === "*");
      if (!saved) fail(`لم تُحفظ قاعدة السماح الدائم للأداة: ${JSON.stringify(rules)}`);
      log("✔ حُفظت قاعدة {tool: bash, pattern: '*'} في ملف القواعد.");
    } else {
      if (rules.length > 0) fail(`السماح مرة واحدة كتب قواعد: ${JSON.stringify(rules)}`);
      log("✔ لم تُحفظ أي قاعدة (سماح مرة واحدة فقط).");
    }
    if (notified.length) log(`✔ إشعارات الإضافة: ${notified.join(" ، ")}`);

    const elapsed = Date.now() - startedAt;
    pass(`C2 approvals: select → ${SCENARIO} → bash → settled (${elapsed}ms)`);
    console.log(
      JSON.stringify(
        {
          method: dialog.method,
          options: dialog.options,
          scenario: SCENARIO,
          response: { value: RESPONSE },
          tool: bashEnd.toolName,
          isError: !!bashEnd.isError,
          output: toolOutputText(bashEnd).trim(),
          settled: true,
          rulesPersisted: rules,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    fail(err?.message || String(err), rpc.stderr.slice(-12).join("\n"));
  } finally {
    await rpc.dispose();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
