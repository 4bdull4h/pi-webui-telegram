/**
 * إضافة موافقة الأدوات (المرحلة C2) — تعمل في RPC وTUI معاً.
 *
 * لماذا إضافة pi (لا كود داخل الخادم)؟
 * - لأن قرار المنع يجب أن يقع داخل عملية pi نفسها قبل تنفيذ الأداة،
 *   و`tool_call` هو نقطة المنع الرسمية (`return { block: true, reason }`).
 * - ولأن `ctx.ui.select` يعمل في وضع RPC (عبر جسر حوارات الامتدادات في
 *   الواجهة) وفي وضع TUI (قائمة طرفية) دون أي كود خاص بكل وضع.
 *
 * السلوك:
 * - APPROVAL_MODE = off | dangerous | all (افتراضي dangerous).
 *   dangerous: bash, write, edit، وكل أداة تبدأ بـ mcp__.
 *   all: كل أداة.
 * - الخيارات: "✅ سماح" / "⛔️ رفض" / "🔁 سماح دائماً لهذا الأمر" / "♾️ سماح دائماً لهذه الأداة".
 * - «سماح دائماً لهذا الأمر» يحفظ قاعدة {tool, pattern} في data/approvals.json:
 *     bash      → أول كلمة من الأمر (مثال: git)
 *     write/edit → مجلد الملف
 *     غيرها     → اسم الأداة
 *   و«سماح دائماً لهذه الأداة» يحفظ {tool, pattern:"*"} فيمنع السؤال عنها نهائياً.
 *   تُطبَّق القاعدة في الجلسات التالية أيضاً.
 * - APPROVAL_TIMEOUT_MS (افتراضي 90000) ثم رفض آمن مع تلميح تحديث الصفحة/‏-stop.
 * - عند غياب واجهة المستخدم (print/json) أو فشل الحوار:
 *     APPROVAL_FAIL_OPEN=1 → يُسمح، وإلا يُرفض (الافتراضي الآمن).
 * - لا يستخدم ctx.ui.custom إطلاقاً (غير مدعوم في RPC).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

/* =========================================================================
 * الثوابت
 * ========================================================================= */

const OPTION_ALLOW = "✅ سماح";
const OPTION_DENY = "⛔️ رفض";
const OPTION_ALWAYS_COMMAND = "🔁 سماح دائماً لهذا الأمر";
const OPTION_ALWAYS_TOOL = "♾️ سماح دائماً لهذه الأداة";
const OPTIONS = [OPTION_ALLOW, OPTION_DENY, OPTION_ALWAYS_COMMAND, OPTION_ALWAYS_TOOL];
/** نمط «كل الحالات» لقاعدة على مستوى الأداة. */
export const WILDCARD_PATTERN = "*";

const REJECT_REASON = "رفض المستخدم تنفيذ الأداة";
/** تلميح عند انتهاء المهلة بلا وصول الحوار لأي واجهة (كاش متصفح قديم). */
export const TIMEOUT_HINT =
  "لم تصل الموافقة إلى أي واجهة. حدّث الصفحة (Ctrl+Shift+R) أو أرسل /stop";
const BLOCKED_NO_UI = "موافقة الأداة مطلوبة ولا توجد واجهة مستخدم متاحة";

/** الأدوات الخطرة التي تُطلب الموافقة عليها في الوضع الافتراضي. */
const DANGEROUS_TOOLS = new Set(["bash", "write", "edit"]);
/** بادئة أدوات خوادم MCP. */
const MCP_PREFIX = "mcp__";

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const FILE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES_FILE = resolve(FILE_DIR, "..", "data", "approvals.json");
const MAX_TITLE_CHARS = 700;

/* =========================================================================
 * الأنواع
 * ========================================================================= */

type ApprovalMode = "off" | "dangerous" | "all";

interface ApprovalRule {
  tool: string;
  pattern: string;
  createdAt?: number;
}

interface RulesFile {
  version?: number;
  rules?: unknown;
}

/* =========================================================================
 * الإعدادات (تُقرأ عند كل استدعاء حتى يمكن تغييرها بلا إعادة تشغيل الكود)
 * ========================================================================= */

function approvalMode(): ApprovalMode {
  const raw = String(process.env.APPROVAL_MODE ?? "dangerous").trim().toLowerCase();
  if (raw === "off" || raw === "none" || raw === "0" || raw === "false") return "off";
  if (raw === "all" || raw === "everything" || raw === "1" || raw === "true") return "all";
  return "dangerous";
}

function approvalTimeoutMs(): number {
  const raw = Number(process.env.APPROVAL_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
}

function failOpen(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.APPROVAL_FAIL_OPEN ?? "").trim());
}

function rulesFile(): string {
  const explicit = process.env.PI_APPROVALS_FILE || process.env.APPROVALS_FILE;
  if (explicit && explicit.trim()) return resolve(explicit.trim());
  // نفس منطق الخادم: DATA_DIR/approvals.json إن ضُبط، وإلا data المشروع.
  const dataDir = process.env.DATA_DIR?.trim();
  if (dataDir) return resolve(dataDir, "approvals.json");
  return DEFAULT_RULES_FILE;
}

/* =========================================================================
 * القواعد: قراءة/كتابة/مطابقة
 * ========================================================================= */

function normalizeRule(value: unknown): ApprovalRule | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.tool !== "string" || typeof record.pattern !== "string") return null;
  const tool = record.tool.trim();
  const pattern = record.pattern.trim();
  if (!tool || !pattern) return null;
  const createdAt = Number(record.createdAt);
  return {
    tool,
    pattern,
    ...(Number.isFinite(createdAt) ? { createdAt } : {}),
  };
}

function loadRules(): ApprovalRule[] {
  const file = rulesFile();
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const raw = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as RulesFile)?.rules)
        ? (parsed as RulesFile).rules
        : [];
    const seen = new Set<string>();
    const rules: ApprovalRule[] = [];
    for (const item of raw as unknown[]) {
      const rule = normalizeRule(item);
      if (!rule) continue;
      const key = `${rule.tool}\u0000${rule.pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push(rule);
    }
    return rules;
  } catch {
    // ملف تالف أو غير مقروء: نعيد قائمة فارغة (سلوك آمن = طلب الموافقة).
    return [];
  }
}

/** كاتب متسلسل يمنع تسابق كتابات الأدوات المتوازية على نفس الملف. */
let writeChain: Promise<void> = Promise.resolve();

function persistRule(rule: ApprovalRule): Promise<boolean> {
  const task = writeChain.then(() => {
    const rules = loadRules();
    if (rules.some((item) => item.tool === rule.tool && item.pattern === rule.pattern)) {
      return false;
    }
    rules.push(rule);
    const file = rulesFile();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify({ version: 1, rules }, null, 2)}\n`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, file);
    return true;
  });
  // نحافظ على السلسلة حيّة حتى لو فشلت كتابة واحدة.
  writeChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function matchesRule(rules: ApprovalRule[], tool: string, pattern: string | null): boolean {
  return rules.some(
    (rule) =>
      rule.tool === tool &&
      (rule.pattern === WILDCARD_PATTERN || (!!pattern && rule.pattern === pattern)),
  );
}

/* =========================================================================
 * استخراج النمط ووصف الاستدعاء
 * ========================================================================= */

function firstCommandWord(command: string): string | null {
  const tokens = String(command ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  // تجاوز إسنادات البيئة في البداية مثل FOO=1 BAR=2 command
  const meaningful = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) || tokens[0];
  return meaningful.replace(/^['"]|['"]$/g, "") || null;
}

/** مجلد الملف (مطلق) لأدوات write/edit. */
function fileDirectory(rawPath: unknown, cwd: string): string | null {
  const value = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!value) return null;
  const absolute = isAbsolute(value) ? value : join(cwd, value);
  const dir = dirname(resolve(absolute));
  return dir || null;
}

function callPath(event: ToolCallEvent): string | null {
  const input = (event as { input?: Record<string, unknown> }).input;
  if (!input) return null;
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function callCommand(event: ToolCallEvent): string | null {
  const input = (event as { input?: Record<string, unknown> }).input;
  if (!input) return null;
  for (const key of ["command", "cmd"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** النمط الذي تُحفظ به قاعدة «سماح دائماً» لهذه الأداة. */
function patternFor(event: ToolCallEvent, cwd: string): string | null {
  if (event.toolName === "bash" || event.toolName === "powershell") {
    return firstCommandWord(callCommand(event) ?? "");
  }
  if (event.toolName === "write" || event.toolName === "edit") {
    return fileDirectory(callPath(event), cwd);
  }
  return event.toolName || null;
}

function truncate(text: string, max = MAX_TITLE_CHARS): string {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildTitle(event: ToolCallEvent, pattern: string | null, cwd: string): string {
  const lines = ["🔐 الموافقة على تنفيذ أداة"];
  const tool = event.toolName || "أداة";
  const command = callCommand(event);
  const path = callPath(event);

  if (command) {
    lines.push(`الأداة: ${tool}`);
    lines.push(`الأمر: ${command}`);
    if (pattern) lines.push(`النمط: ${pattern}`);
  } else if (path) {
    lines.push(`الأداة: ${tool}`);
    lines.push(`المسار: ${path}`);
    if (pattern) lines.push(`المجلد: ${pattern}`);
  } else {
    lines.push(`الأداة: ${tool}`);
    const input = (event as { input?: Record<string, unknown> }).input;
    if (input && Object.keys(input).length) {
      let serialized = "";
      try {
        serialized = JSON.stringify(input);
      } catch {
        serialized = String(input);
      }
      if (serialized) lines.push(`المدخل: ${serialized}`);
    }
  }
  lines.push(`المجلد الحالي: ${cwd}`);
  return truncate(lines.join("\n"));
}

/* =========================================================================
 * المنطق الأساسي (مُصدَّر للاختبار)
 * ========================================================================= */

/** هل تحتاج هذه الأداة موافقة في الوضع الحالي؟ */
export function needsApproval(toolName: string, mode: ApprovalMode = approvalMode()): boolean {
  if (mode === "off") return false;
  if (mode === "all") return true;
  const name = String(toolName || "");
  if (DANGEROUS_TOOLS.has(name)) return true;
  return name.startsWith(MCP_PREFIX);
}

export interface ApprovalDecision {
  allow: boolean;
  reason?: string;
  remember: boolean;
  pattern: string | null;
  /** level = قاعدة على مستوى الأداة كلها (pattern "*"). */
  level: "none" | "command" | "tool";
}

/**
 * قرار نقي (قابل للاختبار) بناءً على اختيار المستخدم.
 * undefined = إلغاء أو مهلة → رفض آمن دائماً (حتى مع FAIL_OPEN، لأن
 * FAIL_OPEN مخصّص لغياب الواجهة لا لرفض المستخدم).
 */
export function decide(choice: string | undefined, pattern: string | null): ApprovalDecision {
  if (choice === OPTION_ALLOW) return { allow: true, remember: false, pattern, level: "none" };
  if (choice === OPTION_ALWAYS_COMMAND) {
    return { allow: true, remember: !!pattern, pattern, level: "command" };
  }
  if (choice === OPTION_ALWAYS_TOOL) {
    return { allow: true, remember: true, pattern: WILDCARD_PATTERN, level: "tool" };
  }
  return { allow: false, reason: REJECT_REASON, remember: false, pattern, level: "none" };
}

function safeNotify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
  try {
    ctx.ui?.notify?.(message, type);
  } catch {
    /* الإشعارات ليست حرجة */
  }
}

/* =========================================================================
 * الربط بـ pi
 * ========================================================================= */

export default function approvals(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    try {
      const mode = approvalMode();
      if (!needsApproval(event.toolName, mode)) return undefined;

      const cwd = ctx.cwd || process.cwd();
      const pattern = patternFor(event, cwd);

      // قاعدة محفوظة مسبقاً → سماح صامت.
      if (matchesRule(loadRules(), event.toolName, pattern)) return undefined;

      if (!ctx.hasUI) {
        safeNotify(ctx, `${BLOCKED_NO_UI}: ${event.toolName}`, "warning");
        if (failOpen()) return undefined;
        return { block: true, reason: `${REJECT_REASON} (${BLOCKED_NO_UI})` };
      }

      const title = buildTitle(event, pattern, cwd);
      let choice: string | undefined;
      const timeoutMs = approvalTimeoutMs();
      const startedAt = Date.now();
      try {
        choice = await ctx.ui.select(title, OPTIONS, { timeout: timeoutMs });
      } catch (err) {
        const detail = (err as Error)?.message || String(err);
        safeNotify(ctx, `تعذّر عرض حوار الموافقة: ${detail}`, "error");
        if (failOpen()) return undefined;
        return { block: true, reason: `${REJECT_REASON} (تعذّر عرض حوار الموافقة)` };
      }

      const decision = decide(choice, pattern);

      if (decision.allow && decision.remember) {
        const rulePattern = decision.pattern;
        if (rulePattern) {
          try {
            const saved = await persistRule({
              tool: event.toolName,
              pattern: rulePattern,
              createdAt: Date.now(),
            });
            const label = decision.level === "tool" ? "لهذه الأداة (كل الحالات)" : `→ ${rulePattern}`;
            safeNotify(
              ctx,
              saved
                ? `♾️ حُفظت قاعدة السماح: ${event.toolName} ${label}`
                : `♾️ القاعدة موجودة مسبقاً: ${event.toolName} ${label}`,
              "info",
            );
          } catch (err) {
            // فشل الحفظ لا يمنع هذه المرة، لكنه يُبلَّغ للمستخدم.
            safeNotify(ctx, `تعذّر حفظ قاعدة السماح: ${(err as Error)?.message || err}`, "error");
          }
        }
      }

      if (decision.allow) {
        if (choice === OPTION_ALLOW) safeNotify(ctx, `✅ تم السماح: ${event.toolName}`, "info");
        return undefined;
      }

      const reason =
        choice === OPTION_DENY
          ? REJECT_REASON
          : choice === undefined && Date.now() - startedAt >= timeoutMs - 500
            ? `${REJECT_REASON} (انتهت المهلة) — ${TIMEOUT_HINT}`
            : `${REJECT_REASON} (أُلغي الحوار)`;
      safeNotify(ctx, `⛔️ ${reason} — ${event.toolName}`, "warning");
      return { block: true, reason };
    } catch (err) {
      // أي خطأ غير متوقع: fail-safe = منع الأداة (إلا مع FAIL_OPEN).
      const detail = (err as Error)?.message || String(err);
      loggerlessWarn(`[approvals] خطأ غير متوقع: ${detail}`);
      if (failOpen()) return undefined;
      return { block: true, reason: `${REJECT_REASON} (خطأ داخلي في إضافة الموافقة)` };
    }
  });

  // أدوات مساعدة للمستخدم/الاختبار: مسح القواعد عبر أمر صريح (لا حوار).
  pi.registerCommand?.("approvals", {
    description: "عرض قواعد موافقة الأدوات المحفوظة",
    handler: async (_args, ctx) => {
      const rules = loadRules();
      const lines = rules.length
        ? rules.map((rule) =>
            rule.pattern === WILDCARD_PATTERN
              ? `${rule.tool} → كل الأوامر (سماح دائم للأداة)`
              : `${rule.tool} → ${rule.pattern}`,
          )
        : ["لا توجد قواعد محفوظة."];
      ctx.ui.notify(`قواعد الموافقة (${rulesFile()}):\n${lines.join("\n")}`, "info");
    },
  });
}

function loggerlessWarn(message: string): void {
  // لا نستورد logger الخادم داخل عملية pi؛ نكتب إلى stderr فقط.
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* تجاهل */
  }
}

export {
  OPTIONS,
  OPTION_ALLOW,
  OPTION_DENY,
  OPTION_ALWAYS_COMMAND,
  OPTION_ALWAYS_TOOL,
  REJECT_REASON,
};
