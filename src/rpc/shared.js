/** ثوابت وم helper مشتركة بين محادثة SDK ومحادثة RPC (بدون اعتماد دائري). */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const SYSTEM_APPEND = `قواعد عامة للمحادثة:
- أجب دائماً بنفس لغة رسالة المستخدم الأخيرة (العربية هي الافتراضية).
- كن موجزاً وواضحاً، واستخدم التنسيق (عناوين، قوائم، كتل كود) لتسهيل القراءة.
- قبل إجراء تغييرات كبيرة على الملفات، اشرح باختصار ما ستفعله ولماذا.
- عند إكمال المهمة، لخّص النتيجة في سطر أو سطرين.
- أنت تتحدث عبر واجهة محادثة (ويب/تيليجرام)، فاجعل الردود مناسبة للقراءة السريعة.`;

export function normalizeThinking(level) {
  return THINKING_LEVELS.includes(level) ? level : "medium";
}

export function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "conversation";
}

export default { THINKING_LEVELS, SYSTEM_APPEND, normalizeThinking, safeId };
