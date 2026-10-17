/**
 * نصوص الواجهة (عربي/إنجليزي) المستخدمة على الخادم لبوت تيليجرام
 * ورسائل الأخطاء المشتركة.
 */

const STRINGS = {
  ar: {
    dir: "rtl",
    appName: "مساعد Pi",
    appTagline: "وكيل برمجي ذكي بين يديك",
    welcome:
      "🤖 <b>مرحباً بك في مساعد Pi</b>\n\n" +
      "وكيل برمجي ذكي يستطيع قراءة الملفات، تشغيل الأوامر، وتحرير الكود.\n\n" +
      "اكتب رسالتك مباشرةً وسأبدأ العمل، أو استخدم الأزرار أدناه.",
    help:
      "📚 <b>الأوامر المتاحة</b>\n\n" +
      "/start — بدء محادثة جديدة\n" +
      "/new — جلسة جديدة (مسح السياق)\n" +
      "/model — اختيار النموذج الذكي\n" +
      "/think — مستوى التفكير\n" +
      "/status — حالة الجلسة الحالية\n" +
      "/stop — إيقاف التوليد الجاري\n" +
      "/compact — ضغط سياق المحادثة\n" +
      "/help — عرض هذه المساعدة\n\n" +
      "💡 <b>نصائح</b>\n" +
      "• اكتب طلبك بلغة واضحة، وسأرد بنفس لغتك.\n" +
      "• يمكنك إرسال عدة رسائل أثناء العمل لإعادة التوجيه.",
    newSession: "✨ <b>بدأنا جلسة جديدة.</b>\nالسياق السابق تم مسحه — تفضّل بطلبك.",
    processing: "⏳ جارٍ العمل…",
    // ===== المرحلة D1: الرسالة النهائية فقط =====
    finalRunning: "⏳ جارٍ العمل…",
    finalRunningElapsed: "⏳ جارٍ العمل… ({duration})",
    finalDone: "✅ انتهت المهمة",
    finalAborted: "⛔️ أُوقفت المهمة",
    finalFailed: "❌ فشلت المهمة",
    finalDuration: "المدة",
    finalSteps: "الخطوات",
    finalErrorLine: "سبب الخطأ",
    finalTruncated: "تم اختصار النص",
    progressStep: "🛠️ الخطوة {n}: {tool}",
    interrupted: "⚠️ توقفت المهمة فجأة (انقطاع الخادم)\n🕒 بدأت في: {time} · 🛠️ الخطوات: {steps}",
    thinking: "🧠 يفكّر…",
    done: "✅ <b>تم</b>",
    aborted: "⛔️ تم إيقاف التوليد.",
    nothingToStop: "لا يوجد توليد جارٍ حالياً.",
    errorGeneric: "❌ حدث خطأ أثناء المعالجة.",
    errorNoModel: "⚠️ لا يوجد نموذج متاح. تحقّق من مفاتيح الـ API.",
    unauthorized: "🔒 عذراً، هذا البوت خاص. لا تملك صلاحية الاستخدام.",
    statusTitle: "📊 <b>حالة الجلسة</b>",
    statusModel: "النموذج",
    statusThinking: "مستوى التفكير",
    statusSession: "الجلسة",
    statusMessages: "الرسائل",
    statusTools: "الأدوات النشطة",
    modelTitle: "🧩 <b>اختر النموذج</b>\nاختر النموذج الأنسب لمهمتك:",
    modelSet: "✅ تم اختيار النموذج",
    thinkingTitle: "🧠 <b>مستوى التفكير</b>\nاختر عمق المعالجة:",
    thinkingSet: "✅ تم ضبط مستوى التفكير على",
    compacting: "🗜️ جارٍ ضغط السياق…",
    compacted: "🗜️ تم ضغط السياق بنجاح.",
    toolRunning: "🛠️ يعمل على",
    stopHint: "لإيقاف التوليد أرسل /stop",
    selectSession: "🗂️ <b>جلساتك</b>\nاختر جلسة للعودة إليها:",
    sessionSwitched: "✅ تم التبديل إلى الجلسة المختارة.",
    newLabel: "جلسة جديدة",
    cancel: "إلغاء",
    backToMenu: "↩️ القائمة",
    page: "صفحة",
    prev: "◀️ السابق",
    next: "التالي ▶️",
    noSessions: "لا توجد جلسات محفوظة بعد.",
    modelPage: "صفحة النماذج",
    restartConfirm: "♻️ <b>إعادة تشغيل الخادم</b>\nهل أنت متأكد؟ ستنقطع الخدمة لثوانٍ ثم يعود البوت.",
    restartYes: "✅ نعم، أعد التشغيل",
    restartNo: "↩️ إلغاء",
    restarting: "♻️ جارٍ إعادة التشغيل… سأعود خلال لحظات.",
    restartUnsupported: "⚠️ الخادم غير مُدار. استخدم الأمر: ./server.sh restart",
    btnRestart: "♻️ إعادة التشغيل",
    thinkingLabels: {
      off: "متوقف",
      minimal: "بسيط جداً",
      low: "منخفض",
      medium: "متوسط",
      high: "مرتفع",
      xhigh: "مرتفع جداً",
      max: "أقصى",
    },
    btnNew: "✨ جلسة جديدة",
    btnMenu: "☰ القائمة",
    btnStop: "⛔️ إيقاف",
    btnStatus: "📊 الحالة",
    btnModel: "🧩 النموذج",
    btnThink: "🧠 التفكير",
    btnSessions: "🗂️ الجلسات",
    btnHelp: "📚 مساعدة",
    // ===== C1: حوارات الامتدادات (موافقة الأدوات) =====
    uiYes: "✅ نعم",
    uiNo: "⛔️ لا",
    uiConfirmTitle: "تأكيد",
    uiAllowed: "✅ سُمح",
    uiRejected: "⛔️ رُفض",
    uiTimedOut: "⌛️ انتهت المهلة",
    uiInputHint: "✍️ أرسل ردك الآن في رسالة.",
  },
  en: {
    dir: "ltr",
    appName: "Pi Assistant",
    appTagline: "A powerful coding agent at your fingertips",
    welcome:
      "🤖 <b>Welcome to Pi Assistant</b>\n\n" +
      "An intelligent coding agent that can read files, run commands, and edit code.\n\n" +
      "Just send your request or use the buttons below.",
    help:
      "📚 <b>Available commands</b>\n\n" +
      "/start — begin a conversation\n" +
      "/new — new session (clear context)\n" +
      "/model — choose the model\n" +
      "/think — reasoning level\n" +
      "/status — current session status\n" +
      "/stop — stop current generation\n" +
      "/compact — compact conversation context\n" +
      "/help — show this help\n\n" +
      "💡 <b>Tips</b>\n" +
      "• Write clearly; I reply in your language.\n" +
      "• You can send follow-ups while I work.",
    newSession: "✨ <b>Started a new session.</b>\nPrevious context cleared — go ahead.",
    processing: "⏳ Working on your request…",
    // ===== Phase D1: final answer only =====
    finalRunning: "⏳ Working…",
    finalRunningElapsed: "⏳ Working… ({duration})",
    finalDone: "✅ Task finished",
    finalAborted: "⛔️ Task aborted",
    finalFailed: "❌ Task failed",
    finalDuration: "Duration",
    finalSteps: "Steps",
    finalErrorLine: "Error",
    finalTruncated: "text truncated",
    progressStep: "🛠️ Step {n}: {tool}",
    interrupted: "⚠️ The task was interrupted (server outage)\n🕒 Started at: {time} · 🛠️ Steps: {steps}",
    thinking: "🧠 Thinking…",
    done: "✅ <b>Done</b>",
    aborted: "⛔️ Generation stopped.",
    nothingToStop: "Nothing is running right now.",
    errorGeneric: "❌ An error occurred while processing.",
    errorNoModel: "⚠️ No model available. Check your API keys.",
    unauthorized: "🔒 Sorry, this bot is private.",
    statusTitle: "📊 <b>Session status</b>",
    statusModel: "Model",
    statusThinking: "Thinking level",
    statusSession: "Session",
    statusMessages: "Messages",
    statusTools: "Active tools",
    modelTitle: "🧩 <b>Choose a model</b>\nPick the best model for your task:",
    modelSet: "✅ Model selected",
    thinkingTitle: "🧠 <b>Reasoning level</b>\nChoose processing depth:",
    thinkingSet: "✅ Thinking level set to",
    compacting: "🗜️ Compacting context…",
    compacted: "🗜️ Context compacted.",
    toolRunning: "🛠️ Running",
    stopHint: "Send /stop to cancel",
    selectSession: "🗂️ <b>Your sessions</b>\nPick a session to resume:",
    sessionSwitched: "✅ Switched to the selected session.",
    newLabel: "New session",
    cancel: "Cancel",
    backToMenu: "↩️ Menu",
    page: "page",
    prev: "◀️ Prev",
    next: "Next ▶️",
    noSessions: "No saved sessions yet.",
    modelPage: "Models page",
    restartConfirm: "♻️ <b>Restart server</b>\nAre you sure? Service will pause briefly.",
    restartYes: "✅ Yes, restart",
    restartNo: "↩️ Cancel",
    restarting: "♻️ Restarting… I'll be back shortly.",
    restartUnsupported: "⚠️ Server is not supervised. Use: ./server.sh restart",
    btnRestart: "♻️ Restart",
    thinkingLabels: {
      off: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Very high",
      max: "Max",
    },
    btnNew: "✨ New",
    btnMenu: "☰ Menu",
    btnStop: "⛔️ Stop",
    btnStatus: "📊 Status",
    btnModel: "🧩 Model",
    btnThink: "🧠 Thinking",
    btnSessions: "🗂️ Sessions",
    btnHelp: "📚 Help",
    // ===== C1: extension dialogs (tool approvals) =====
    uiYes: "✅ Yes",
    uiNo: "⛔️ No",
    uiConfirmTitle: "Confirm",
    uiAllowed: "✅ Allowed",
    uiRejected: "⛔️ Denied",
    uiTimedOut: "⌛️ Timed out",
    uiInputHint: "✍️ Send your answer as a message.",
  },
};

export function t(lang, key, vars = {}) {
  const table = STRINGS[lang] || STRINGS.ar;
  const fallback = STRINGS.ar;
  let value = key.split(".").reduce((o, k) => (o == null ? o : o[k]), table);
  if (value === undefined) value = key.split(".").reduce((o, k) => (o == null ? o : o[k]), fallback);
  if (value === undefined) return key;
  if (typeof value !== "string") return value;
  return value.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "").toString());
}

export function thinkingLabel(lang, level) {
  return t(lang, `thinkingLabels.${level}`) || level;
}

export function isRtl(lang) {
  return (STRINGS[lang] || STRINGS.ar).dir === "rtl";
}

export default { t, thinkingLabel, isRtl };
