#!/usr/bin/env node
/**
 * إصلاح جلسة Pi مقطوعة: إذا كانت آخر رسالة للمساعد تحتوي استدعاء أداة
 * بلا نتيجة (بسبب إيقاف/إعادة تشغيل الخادم أثناء التنفيذ)، نضيف نتيجة
 * تعويضية عبر SessionManager الرسمي حتى تستطيع الجلسة المتابعة.
 *
 * الاستخدام: node scripts/repair-session.mjs <session.jsonl> [--dry]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const file = process.argv[2];
const dry = process.argv.includes("--dry");

if (!file || !existsSync(file)) {
  console.error("الاستخدام: node scripts/repair-session.mjs <session.jsonl> [--dry]");
  process.exit(1);
}

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const entries = [];
for (const line of lines) {
  try {
    entries.push(JSON.parse(line));
  } catch {
    /* تجاهل سطراً تالفاً */
  }
}

const header = entries.find((e) => e?.type === "session");
const results = new Set();
for (const entry of entries) {
  const msg = entry?.message;
  if (entry?.type === "message" && msg?.role === "toolResult" && msg.toolCallId) {
    results.add(msg.toolCallId);
  }
}

const dangling = [];
for (const entry of entries) {
  const msg = entry?.message;
  if (entry?.type === "message" && msg?.role === "assistant" && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block?.type === "toolCall" && block.id && !results.has(block.id)) {
        dangling.push({ id: block.id, name: block.name, entryId: entry.id });
      }
    }
  }
}

if (!dangling.length) {
  console.log("لا توجد استدعاءات أدوات معلّقة.");
  process.exit(0);
}

const leaf = entries[entries.length - 1];
const leafMessage = leaf?.message;
const leafToolIds = new Set(
  Array.isArray(leafMessage?.content)
    ? leafMessage.content.filter((b) => b?.type === "toolCall").map((b) => b.id)
    : [],
);
const allInLeaf = dangling.every((d) => d.entryId === leaf?.id && leafToolIds.has(d.id));

console.log(`الملف: ${file}`);
console.log(`الاستدعاءات المعلّقة: ${dangling.map((d) => `${d.name || "tool"}(${d.id})`).join(", ")}`);
console.log(`آخر إدخال: ${leaf?.id} (${leafMessage?.role || leaf?.type})`);

if (!allInLeaf) {
  console.log(
    "⚠️ الاستدعاءات المعلّقة ليست في آخر إدخال؛ لن نعدّل تلقائياً. راجع الجلسة يدوياً.",
  );
  process.exit(2);
}

if (dry) {
  console.log("(تجريبي) سيتم إضافة نتيجة تعويضية لكل استدعاء أعلاه.");
  process.exit(0);
}

const manager = SessionManager.open(file, dirname(file), header?.cwd || process.cwd());
console.log("الورقة قبل:", manager.getLeafId());
for (const item of dangling) {
  const id = manager.appendMessage({
    role: "toolResult",
    toolCallId: item.id,
    toolName: item.name || "tool",
    content: [
      {
        type: "text",
        text: "⛔ أُوقف تنفيذ هذه الأداة لأن الخادم أُعيد تشغيله أو أُغلق أثناء التشغيل. هذه نتيجة تعويضية لاستكمال الجلسة.",
      },
    ],
    isError: true,
  });
  console.log(`✅ أُضيفت نتيجة تعويضية للأداة ${item.name || "tool"} (${item.id}) → ${id}`);
}
console.log("الورقة بعد:", manager.getLeafId());
