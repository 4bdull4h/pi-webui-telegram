#!/usr/bin/env node
/**
 * اختبار «أول رد يفوز» لحوارات الامتدادات بين الويب وتيليجرام.
 *
 * يتحقق من:
 *  1. RpcConversation لا يمرّر رداً ثانياً إلى pi بعد حسم الحوار من قناة أخرى.
 *  2. TelegramBot يُغلق رسالة الحوار ويُزيل أزرارها عندما يحسمه الويب.
 *  3. TelegramBot لا يلمس رسالته عندما يكون هو من حسم الحوار.
 *
 * التشغيل: node scripts/test-ui-first-wins.mjs --self-test
 */
import { RpcConversation } from "../src/rpc/conversation.js";
import TelegramBot from "../src/telegram-bot.js";

const checks = [];
const ok = (label) => checks.push({ label, pass: true });
const fail = (label, detail) => checks.push({ label, pass: false, detail });
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));

function fakeManager() {
  return {
    getOrCreate: () => null,
    getUsage: () => ({}),
    usage: { limits: {} },
    store: { get: () => null, set: () => undefined },
    agents: { toolsFor: () => undefined, list: () => [], defaultId: () => null },
    conversations: new Map(),
  };
}

async function partConversation() {
  console.log("\n[1] RpcConversation — منع الرد المزدوج");
  const conv = new RpcConversation("test-conv", fakeManager());
  const sent = [];
  conv.client = {
    respond: async (id, payload) => {
      sent.push({ id, payload });
    },
  };

  // حوار حُسم مسبقاً من تيليجرام.
  conv.resolvedUI.set("req-1", { at: Date.now(), source: "telegram" });
  const second = await conv.respondExtensionUI("req-1", { value: "سماح" }, { source: "web" });

  expect(second === false, "الرد الثاني يُرفض (يعيد false)");
  expect(sent.length === 0, "لا يُرسل رد ثانٍ إلى جسر pi");

  // حوار غير معروف أصلاً: يبقى مسار الاحتياط كما هو.
  const unknown = await conv.respondExtensionUI("req-unknown", { confirmed: true }, { source: "web" });
  expect(unknown === true, "مسار الاحتياط ما زال يعمل للحوارات القديمة");
  expect(sent.length === 1 && sent[0].id === "req-unknown", "الاحتياط يمرّر الرد إلى pi");
}

async function partTelegram() {
  console.log("\n[2] TelegramBot — إغلاق الرسالة عند الحسم من الويب");
  const bot = new TelegramBot(fakeManager());
  bot.primaryChatId = "555";
  const edits = [];
  bot.api = {
    editMessageText: async (chatId, messageId, text, opts) => {
      edits.push({ chatId, messageId, text, opts });
    },
    sendMessage: async () => ({}),
  };

  bot.pendingUI.set("req-2", {
    requestId: "req-2",
    chatId: "555",
    messageId: 77,
    method: "select",
    header: "🔐 الموافقة على تنفيذ أداة",
    options: ["✅ سماح", "⛔️ رفض"],
    conv: { respondExtensionUI: async () => true },
  });
  await bot.handleUiResolved({ requestId: "req-2", source: "web", decision: "سماح" });

  expect(!bot.pendingUI.has("req-2"), "الحوار المعلّق يُحرَّر بعد الحسم");
  expect(edits.length === 1, "تُعدَّل رسالة تيليجرام مرة واحدة");
  const edit = edits[0] || {};
  expect(edit.chatId === "555" && edit.messageId === 77, "التعديل يستهدف نفس الرسالة");
  expect(String(edit.text).includes("الويب"), "النص يذكر أن الرد جاء من الويب", String(edit.text));
  expect(String(edit.text).includes("سماح"), "النص يعرض القرار نفسه", String(edit.text));
  expect(
    Array.isArray(edit.opts?.reply_markup?.inline_keyboard) &&
      edit.opts.reply_markup.inline_keyboard.length === 0,
    "الأزرار تُزال بعد الحسم",
  );

  // حسم من تيليجرام: لا تعديل من هذا المسار (المرسل عدّل الرسالة بنفسه).
  const before = edits.length;
  bot.pendingUI.set("req-3", {
    requestId: "req-3",
    chatId: "555",
    messageId: 88,
    method: "select",
    header: "x",
    options: [],
  });
  await bot.handleUiResolved({ requestId: "req-3", source: "telegram", decision: "سماح" });
  expect(edits.length === before, "حسم تيليجرام لا يُعدّل الرسالة مرتين");
  expect(!bot.pendingUI.has("req-3"), "الحوار يُحرَّر في كل الحالات");
}

async function main() {
  await partConversation();
  await partTelegram();

  const failed = checks.filter((c) => !c.pass);
  console.log("\n— النتيجة —");
  for (const c of checks) {
    console.log(c.pass ? `✅ ${c.label}` : `❌ ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(`\n${failed.length ? "❌ فشل" : "✅ نجح"}: ${checks.length - failed.length}/${checks.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("❌ خطأ غير متوقع:", err);
  process.exit(1);
});
