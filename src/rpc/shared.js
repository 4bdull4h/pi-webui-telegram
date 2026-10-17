/** ثوابت وم helper مشتركة بين محادثة SDK ومحادثة RPC (بدون اعتماد دائري). */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const SYSTEM_APPEND = `قواعد عامة للمحادثة:
- أجب دائماً بنفس لغة رسالة المستخدم الأخيرة (العربية هي الافتراضية).
- كن موجزاً وواضحاً، واستخدم التنسيق (عناوين، قوائم، كتل كود) لتسهيل القراءة.
- قبل إجراء تغييرات كبيرة على الملفات، اشرح باختصار ما ستفعله ولماذا.
- عند إكمال المهمة، لخّص النتيجة في سطر أو سطرين.
- أنت تتحدث عبر واجهة محادثة (ويب/تيليجرام)، فاجعل الردود مناسبة للقراءة السريعة.`;

/**
 * أوامر RPC المسموح للواجهة تمريرها عبر الرسالة `{type:"rpc"}` (المرحلة B1).
 * `compact` مضافة لأن لوحة الأوامر ترسل /compact مع تعليمات (B3).
 */
export const RPC_PASSTHROUGH_COMMANDS = Object.freeze([
  "get_commands",
  "get_tree",
  "get_entries",
  "get_session_stats",
  "fork",
  "clone",
  "switch_session",
  "set_session_name",
  "export_html",
  "get_last_assistant_text",
  "bash",
  "abort_bash",
  "steer",
  "follow_up",
  "clear_queue",
  "set_steering_mode",
  "set_follow_up_mode",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "get_messages",
  "cycle_model",
  "cycle_thinking_level",
  "set_thinking_level",
  "compact",
]);

/** مهل خاصة للأوامر البطيئة (الباقي 60 ثانية). */
export const RPC_PASSTHROUGH_TIMEOUTS = Object.freeze({
  bash: 10 * 60_000,
  compact: 10 * 60_000,
  export_html: 120_000,
  get_commands: 60_000,
  get_session_stats: 60_000,
  get_messages: 120_000,
  abort_bash: 30_000,
  abort_retry: 30_000,
});

export function normalizeThinking(level) {
  return THINKING_LEVELS.includes(level) ? level : "medium";
}

export function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "conversation";
}

export default {
  THINKING_LEVELS,
  SYSTEM_APPEND,
  RPC_PASSTHROUGH_COMMANDS,
  RPC_PASSTHROUGH_TIMEOUTS,
  normalizeThinking,
  safeId,
};
