#!/usr/bin/env node
/**
 * اختبار ذاتي لحوارات الامتدادات في تيليجرام (المرحلة C1/D-تكامل).
 *
 * لا يلمس الشبكة ولا تيليجرام الحقيقي: نُنشئ TelegramBot حقيقياً بمُدير وهمي،
 * ونستبدل `api.call` / `api.sendMessage` / `api.editMessageText` بمُعترِضات
 * تُسجّل كل شيء. ثم نمرّر أحداث `extension_ui` كما تصل من المحادثة المشتركة.
 *
 * يتحقق من:
 *   1) select → رسالة واحدة بترويسة العنوان وخيارات صحيحة كأزرار inline.
 *   2) نقر زر → respondExtensionUI بالقيمة الصحيحة + تعديل الرسالة بالقرار وإزالة الأزرار.
 *   3) confirm → زرّا نعم/لا بـ callback_data صحيح.
 *   4) notify → يُرسل لغير info، ويُكتَم لـ info في وضع final، ويُرسل في live.
 *   5) setStatus/setWidget/setTitle/set_editor_text → لا رسائل إطلاقاً.
 *   6) input → الرسالة النصية التالية تُستهلك كرد (respondExtensionUI) ولا تُمرَّر كـ prompt.
 *   7) timeout → تعديل الرسالة إلى «انتهت المهلة» وإزالة الأزرار دون رسائل إضافية.
 *   8) stop() → إرسال cancelled لكل حوار معلّق.
 *   9) الحوارات تصل في وضع final المكتوم (لا تُكتَم أبداً).
 *
 * الاستخدام: node scripts/test-telegram-ui.mjs --self-test
 */

import config from "../src/config.js";
import TelegramBot from "../src/telegram-bot.js";

const CHAT = "555";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`✅ ${name}`);
    return true;
  }
  failures += 1;
  console.log(`❌ ${name}`);
  if (detail !== undefined) console.log(`   ↳ ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return false;
}

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return check(name, ok, ok ? undefined : `المتوقع: ${JSON.stringify(expected)} — الفعلي: ${JSON.stringify(actual)}`);
}

/** حدث extension_ui بالشكل الذي ينتجه src/rpc/events.js#describeExtensionUI. */
function uiEvent(method, extra = {}) {
  const base = {
    type: "extension_ui",
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    method,
    title: "",
    message: "",
    placeholder: "",
    prefill: "",
    options: [],
    notifyType: "info",
    statusKey: null,
    statusText: null,
    widgetKey: null,
    widgetLines: null,
    widgetPlacement: null,
    timeout: null,
    text: null,
    expectsResponse: ["select", "confirm", "input", "editor"].includes(method),
  };
  return { ...base, ...extra };
}

/** TelegramBot + مُدير وهمي + اعتراض كامل لواجهة Telegram API. */
function harness({ notifyMode = "final" } = {}) {
  config.telegram.notifyMode = notifyMode;

  const sent = [];
  const edits = [];
  const answers = [];
  const calls = [];
  const ui = [];
  const prompts = [];

  const conv = {
    isBusy: false,
    session: null,
    id: "shared:main",
    async prompt(text, opts) {
      prompts.push({ text, opts });
      return "started";
    },
    async respondExtensionUI(id, payload) {
      ui.push({ id, payload });
      return true;
    },
    async abort() {
      return false;
    },
    getState() {
      return {
        provider: "test",
        model: "test",
        thinking: "off",
        toolNames: [],
        messageCount: 0,
        agent: null,
      };
    },
  };

  const manager = {
    getOrCreate: () => conv,
    listModels: () => [],
    listConversations: () => [],
    agents: { defaultId: () => "default" },
  };

  const bot = new TelegramBot(manager, {});
  bot.primaryChatId = CHAT;
  bot.lang = "ar";

  let messageSeq = 0;
  bot.api = {
    async call(method, payload = {}) {
      calls.push({ method, payload });
      if (method === "sendMessage") {
        messageSeq += 1;
        sent.push({ chatId: String(payload.chat_id), text: payload.text, extra: payload });
        return { message_id: messageSeq };
      }
      if (method === "editMessageText") {
        edits.push({
          chatId: String(payload.chat_id),
          messageId: payload.message_id,
          text: payload.text,
          extra: payload,
        });
        return true;
      }
      if (method === "answerCallbackQuery") {
        answers.push(payload);
        return true;
      }
      return {};
    },
    sendMessage(chatId, text, extra = {}) {
      return this.call("sendMessage", { chat_id: chatId, text, ...extra });
    },
    editMessageText(chatId, messageId, text, extra = {}) {
      return this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...extra,
      });
    },
    answerCallbackQuery(id, extra = {}) {
      return this.call("answerCallbackQuery", { callback_query_id: id, ...extra });
    },
    sendChatAction() {
      return Promise.resolve();
    },
  };

  const reset = () => {
    sent.length = 0;
    edits.length = 0;
    answers.length = 0;
    calls.length = 0;
    prompts.length = 0;
  };

  return { bot, conv, sent, edits, answers, calls, ui, prompts, reset };
}

function callback(query, data, messageId) {
  return {
    id: "cb-1",
    data,
    from: { id: Number(CHAT) },
    message: { message_id: messageId, chat: { id: Number(CHAT) } },
  };
}

async function testSelectAndCallback() {
  const h = harness();
  const event = uiEvent("select", {
    requestId: "req-select-1",
    title: "🔐 الموافقة على تنفيذ أداة\nالأداة: bash\nالأمر: git status",
    options: ["✅ سماح", "⛔️ رفض", "♾️ سماح دائماً"],
    timeout: null,
  });

  await h.bot.handleSharedEvent(event, h.conv);

  check("select: رسالة واحدة فقط", h.sent.length === 1, `العدد: ${h.sent.length}`);
  const msg = h.sent[0];
  check("select: أُرسلت إلى المحادثة الهدف", msg?.chatId === CHAT, msg?.chatId);
  check(
    "select: الترويسة تحمل عنوان الطلب",
    (msg?.text || "").includes("الموافقة على تنفيذ أداة"),
    msg?.text,
  );
  check(
    "select: قائمة الخيارات ظاهرة في النص",
    (msg?.text || "").includes("♾️ سماح دائماً"),
    msg?.text,
  );
  const rows = msg?.extra?.reply_markup?.inline_keyboard || [];
  equal(
    "select: أزرار callback_data صحيحة (ui:<id>:<index>)",
    rows.map((row) => row[0]?.callback_data),
    ["ui:req-select-1:0", "ui:req-select-1:1", "ui:req-select-1:2"],
  );
  equal(
    "select: نصوص الأزرار = الخيارات",
    rows.map((row) => row[0]?.text),
    ["✅ سماح", "⛔️ رفض", "♾️ سماح دائماً"],
  );
  check("select: لا تعليق في طابور الردود", h.ui.length === 0, h.ui);
  check("select: لم يُمرَّر أي prompt", h.prompts.length === 0, h.prompts);

  // محاكاة نقر «⛔️ رفض».
  await h.bot.handleCallback(callback({}, "ui:req-select-1:1", 1));

  equal(
    "callback: respondExtensionUI بالقيمة المختارة",
    h.ui.map((call) => call.payload),
    [{ value: "⛔️ رفض" }],
  );
  check("callback: نفس معرّف الطلب", h.ui[0]?.id === "req-select-1", h.ui[0]);
  check("callback: تم الرد على callback_query", h.answers.length === 1, h.answers);
  check("callback: تعديل رسالة واحدة", h.edits.length === 1, h.edits.length);
  check(
    "callback: الرسالة تُظهر القرار",
    (h.edits[0]?.text || "").includes("⛔️ رفض"),
    h.edits[0]?.text,
  );
  equal(
    "callback: الأزرار أُزيلت",
    h.edits[0]?.extra?.reply_markup?.inline_keyboard,
    [],
  );
  check("callback: لم تُرسل رسالة جديدة", h.sent.length === 1, h.sent.length);

  // نقر مكرّر على نفس الزر لا يرسل رداً ثانياً.
  await h.bot.handleCallback(callback({}, "ui:req-select-1:1", 1));
  check("callback: النقر المكرّر يُتجاهل", h.ui.length === 1, h.ui);
}

async function testConfirm() {
  const h = harness();
  const event = uiEvent("confirm", {
    requestId: "req-confirm-1",
    title: "هل تريد المتابعة؟",
    message: "سيتم حذف الملفات",
  });
  await h.bot.handleSharedEvent(event, h.conv);

  check("confirm: رسالة واحدة", h.sent.length === 1, h.sent.length);
  const rows = h.sent[0]?.extra?.reply_markup?.inline_keyboard || [];
  equal(
    "confirm: زرّا نعم/لا بـ y|n",
    rows.flat().map((b) => b.callback_data),
    ["ui:req-confirm-1:y", "ui:req-confirm-1:n"],
  );
  check(
    "confirm: العنوان والرسالة ظاهران",
    (h.sent[0]?.text || "").includes("المتابعة") && (h.sent[0]?.text || "").includes("حذف الملفات"),
    h.sent[0]?.text,
  );

  await h.bot.handleCallback(callback({}, "ui:req-confirm-1:y", 1));
  equal("confirm: رد {confirmed:true}", h.ui.map((c) => c.payload), [{ confirmed: true }]);
  check(
    "confirm: الرسالة تُظهر «سمح»",
    (h.edits[0]?.text || "").includes("سُمح"),
    h.edits[0]?.text,
  );

  // لا شيء آخر معلّق.
  const h2 = harness();
  await h2.bot.handleSharedEvent(
    uiEvent("confirm", { requestId: "req-confirm-2", title: "؟" }),
    h2.conv,
  );
  await h2.bot.handleCallback(callback({}, "ui:req-confirm-2:n", 1));
  equal("confirm: رد {confirmed:false}", h2.ui.map((c) => c.payload), [{ confirmed: false }]);
  check(
    "confirm: «رفض» في الرسالة",
    (h2.edits[0]?.text || "").includes("رُفض"),
    h2.edits[0]?.text,
  );
}

async function testNotify() {
  // وضع final (الافتراضي): معلوماتي مكتوم، تحذيري يمرّ.
  const h = harness({ notifyMode: "final" });
  await h.bot.handleSharedEvent(
    uiEvent("notify", { message: "معلومة صامتة", notifyType: "info" }),
    h.conv,
  );
  check("notify: info مكتوم في وضع final", h.sent.length === 0, h.sent);

  await h.bot.handleSharedEvent(
    uiEvent("notify", { message: "♾️ حُفظت قاعدة السماح", notifyType: "warning" }),
    h.conv,
  );
  check("notify: warning يمرّ في وضع final", h.sent.length === 1, h.sent.length);
  check(
    "notify: نص الإشعار ظاهر",
    (h.sent[0]?.text || "").includes("حُفظت قاعدة السماح"),
    h.sent[0]?.text,
  );

  // وضع live: كل شيء يمرّ.
  const h2 = harness({ notifyMode: "live" });
  await h2.bot.handleSharedEvent(
    uiEvent("notify", { message: "معلومة", notifyType: "info" }),
    h2.conv,
  );
  check("notify: info يمرّ في وضع live", h2.sent.length === 1, h2.sent.length);
  config.telegram.notifyMode = "final";
}

async function testIgnoredMethods() {
  const h = harness();
  for (const method of ["setStatus", "setWidget", "setTitle", "set_editor_text"]) {
    await h.bot.handleSharedEvent(uiEvent(method, { title: "x", text: "y" }), h.conv);
  }
  check("setStatus/setWidget/setTitle/set_editor_text: لا رسائل", h.sent.length === 0, h.sent);
  check("... ولا تعديلات", h.edits.length === 0, h.edits.length);
  check("... ولا تعليق حوار", h.bot.pendingUI.size === 0, h.bot.pendingUI.size);
}

async function testInput() {
  const h = harness();
  const event = uiEvent("input", {
    requestId: "req-input-1",
    title: "✍️ اسم الملف؟",
    placeholder: "report.md",
  });
  await h.bot.handleSharedEvent(event, h.conv);

  check("input: رسالة سؤال واحدة", h.sent.length === 1, h.sent.length);
  check(
    "input: السؤال ظاهر",
    (h.sent[0]?.text || "").includes("اسم الملف"),
    h.sent[0]?.text,
  );
  check("input: مسجّل في pendingInput", h.bot.pendingInput.has(CHAT), [...h.bot.pendingInput.keys()]);

  // الرسالة النصية التالية يجب أن تُستهلك كردّ، لا كـ prompt.
  await h.bot.handleMessage({
    chat: { id: Number(CHAT) },
    from: { id: Number(CHAT) },
    text: "report.md",
  });

  check("input: لم يُمرَّر النص كـ prompt", h.prompts.length === 0, h.prompts);
  equal("input: respondExtensionUI بالقيمة الصحيحة", h.ui.map((c) => c.payload), [
    { value: "report.md" },
  ]);
  check("input: نفس معرّف الطلب", h.ui[0]?.id === "req-input-1", h.ui[0]);
  check("input: pendingInput نُظِّف", h.bot.pendingInput.size === 0, h.bot.pendingInput.size);
  check("input: لا رسالة إضافية مرسلة", h.sent.length === 1, h.sent.length);

  // بعد الاستهلاك، الرسالة التالية تعود مساراً طبيعياً.
  await h.bot.handleMessage({
    chat: { id: Number(CHAT) },
    from: { id: Number(CHAT) },
    text: "سؤال عادي",
  });
  equal("بعد الرد: الرسائل التالية تعود prompt عادياً", h.prompts.map((p) => p.text), [
    "سؤال عادي",
  ]);
  check("بعد الرد: لا ردود حوار إضافية", h.ui.length === 1, h.ui.length);

  // editor يتبع نفس السلوك.
  const h2 = harness();
  await h2.bot.handleSharedEvent(
    uiEvent("editor", { requestId: "req-editor-1", title: "حرّر النص", prefill: "abc" }),
    h2.conv,
  );
  check("editor: رسالة واحدة", h2.sent.length === 1, h2.sent.length);
  check("editor: prefill ظاهر", (h2.sent[0]?.text || "").includes("abc"), h2.sent[0]?.text);
  await h2.bot.handleMessage({
    chat: { id: Number(CHAT) },
    from: { id: Number(CHAT) },
    text: "نص جديد",
  });
  equal("editor: الرد يُمرَّر كقيمة", h2.ui.map((c) => c.payload), [{ value: "نص جديد" }]);
  check("editor: لم يُمرَّر كـ prompt", h2.prompts.length === 0, h2.prompts);
}

async function testTimeout() {
  const h = harness();
  await h.bot.handleSharedEvent(
    uiEvent("select", {
      requestId: "req-timeout-1",
      title: "🔐 الموافقة",
      options: ["✅ سماح", "⛔️ رفض"],
      timeout: 40,
    }),
    h.conv,
  );
  check("timeout: رسالة أولى فقط", h.sent.length === 1, h.sent.length);
  await sleep(90);
  check("timeout: لا رسائل إضافية", h.sent.length === 1, h.sent.length);
  check("timeout: تعديل واحد", h.edits.length === 1, h.edits.length);
  check(
    "timeout: نص «انتهت المهلة»",
    (h.edits[0]?.text || "").includes("انتهت المهلة"),
    h.edits[0]?.text,
  );
  equal("timeout: الأزرار أُزيلت", h.edits[0]?.extra?.reply_markup?.inline_keyboard, []);
  check("timeout: الحوار نُظِّف", h.bot.pendingUI.size === 0, h.bot.pendingUI.size);
  equal("timeout: لا ردّ إلى الخادم", h.ui.length, 0);

  // نقر متأخر بعد المهلة يُتجاهل.
  await h.bot.handleCallback(callback({}, "ui:req-timeout-1:0", 1));
  check("timeout: النقر المتأخر لا يرسل رداً", h.ui.length === 0, h.ui);
}

async function testStopCancels() {
  const h = harness();
  await h.bot.handleSharedEvent(
    uiEvent("select", { requestId: "req-stop-1", title: "موافقة", options: ["✅ سماح"] }),
    h.conv,
  );
  await h.bot.handleSharedEvent(
    uiEvent("input", { requestId: "req-stop-2", title: "سؤال" }),
    h.conv,
  );
  check("stop: حواران معلّقان", h.bot.pendingUI.size === 2, h.bot.pendingUI.size);

  h.bot.stop();
  await sleep(10);
  equal(
    "stop: cancelled أُرسل لكل حوار معلّق",
    h.ui.map((c) => `${c.id}:${JSON.stringify(c.payload)}`),
    ['req-stop-1:{"cancelled":true}', 'req-stop-2:{"cancelled":true}'],
  );
  check("stop: الخرائط فُرّغت", h.bot.pendingUI.size === 0 && h.bot.pendingInput.size === 0, {
    pendingUI: h.bot.pendingUI.size,
    pendingInput: h.bot.pendingInput.size,
  });
}

async function testNotMutedInFinalMode() {
  // في وضع final الرسائل تُكتَم، لكن حوارات الموافقة يجب أن تصل.
  const h = harness({ notifyMode: "final" });
  check("وضع final مُفعّل", h.bot.notifyMode === "final" && h.bot.quietMode === true, h.bot.notifyMode);

  await h.bot.handleSharedEvent(
    uiEvent("select", {
      requestId: "req-final-1",
      title: "🔐 الموافقة على تنفيذ أداة",
      options: ["✅ سماح", "⛔️ رفض"],
      timeout: 120000,
    }),
    h.conv,
  );
  check("final: حوار select يصل رغم الكتم", h.sent.length === 1, h.sent.length);

  await h.bot.handleSharedEvent({ type: "tool_start", name: "bash", args: { command: "ls" } }, h.conv);
  check("final: أحداث الأدوات تبقى مكتومة", h.sent.length === 1, h.sent.length);

  h.bot.cancelPendingDialogs();
  await sleep(5);
  check("final: الإلغاء لا يرسل رسائل", h.sent.length === 1, h.sent.length);
}

async function selfTest() {
  console.log("— اختبار حوارات الامتدادات في تيليجرام —\n");
  const originalMode = config.telegram.notifyMode;
  try {
    await testSelectAndCallback();
    await testConfirm();
    await testNotify();
    await testIgnoredMethods();
    await testInput();
    await testTimeout();
    await testStopCancels();
    await testNotMutedInFinalMode();
  } finally {
    config.telegram.notifyMode = originalMode;
  }
  console.log(`\n${failures === 0 ? "✅ نجح" : "❌ فشل"}: ${checks - failures}/${checks} تحقّق ناجح.`);
  if (failures > 0) process.exitCode = 1;
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  console.log("الاستخدام: node scripts/test-telegram-ui.mjs --self-test");
}
