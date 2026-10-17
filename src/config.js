import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");

/** محمّل بسيط لملف .env بدون أي تبعيات خارجية. */
export function loadEnvFile(path = join(ROOT, ".env")) {
  if (!existsSync(path)) return;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

const bool = (v, fallback = false) => {
  if (v === undefined || v === null || v === "") return fallback;
  return /^(1|true|yes|on|نعم|صح)$/i.test(String(v));
};
const int = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
};
// وضع إشعارات تيليجرام (المرحلة D1): final | compact | live — الافتراضي final.
const notifyMode = (() => {
  const raw = String(process.env.TELEGRAM_NOTIFY_MODE ?? "").trim().toLowerCase();
  return ["final", "compact", "live"].includes(raw) ? raw : "final";
})();
const sharedSessionId = process.env.SHARED_SESSION_ID ?? "shared:main";
const syncWebTelegram = bool(process.env.SYNC_WEB_TELEGRAM, true) && !!sharedSessionId;

const list = (v) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);

export const config = {
  host: process.env.HOST || "0.0.0.0",
  port: int(process.env.PORT, 8787),
  workspace: resolve(process.env.WORKSPACE || os.homedir()),
  agentDir: resolve(process.env.PI_AGENT_DIR || join(os.homedir(), ".pi", "agent")),
  dataDir: resolve(process.env.DATA_DIR || join(ROOT, "data")),
  publicDir: join(ROOT, "public"),
  language: process.env.BOT_LANGUAGE === "en" ? "en" : "ar",
  sharedSessionId,
  syncWebTelegram,

  defaultProvider: process.env.DEFAULT_PROVIDER || process.env.PI_PROVIDER || "deepseek",
  defaultModel: process.env.DEFAULT_MODEL || process.env.PI_MODEL || "deepseek-flash",
  defaultThinking: process.env.DEFAULT_THINKING || process.env.PI_REASONING_LEVEL || "medium",

  web: {
    enabled: !hasFlag("--no-web"),
    token: process.env.WEB_TOKEN || "",
  },

  telegram: {
    enabled: !hasFlag("--no-telegram"),
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    allowedUsers: list(process.env.TELEGRAM_ALLOWED_USERS),
    allowedChats: list(process.env.TELEGRAM_ALLOWED_CHATS),
    streamThrottleMs: int(process.env.TELEGRAM_STREAM_THROTTLE_MS, 1200),
    // D1: final = رسالة واحدة تُستبدل بالنتيجة النهائية، compact = سطر تقدّم قصير، live = السلوك القديم.
    notifyMode,
    maxMessageLength: 3900,
    pollTimeout: 30,
  },

  pi: {
    noExtensions: bool(process.env.PI_NO_EXTENSIONS, false),
    noSkills: bool(process.env.PI_NO_SKILLS, false),
    tools: list(process.env.PI_TOOLS),
    systemPromptExtra: process.env.PI_SYSTEM_PROMPT_EXTRA || "",
    // أداة تفويض الوكلاء: تمكين/تعطيل + مهلة (5 دقائق افتراضياً).
    delegateEnabled: bool(process.env.DELEGATE_ENABLED, true),
    delegateTimeoutMs: int(process.env.DELEGATE_TIMEOUT_MS, 5 * 60 * 1000),
  },

  // جسر RPC (المرحلة A): معطّل افتراضياً. FEATURE_RPC=1 يفعّله.
  featureRpc: bool(process.env.FEATURE_RPC, false),
  rpc: {
    // معاملات إضافية تُمرّر إلى `pi --mode rpc` (مفصولة بمسافات).
    extraArgs: String(process.env.PI_RPC_EXTRA_ARGS || "")
      .split(/\s+/)
      .filter(Boolean),
  },

  maxSessions: int(process.env.MAX_SESSIONS, 60),
  sessionIdleDisposeMs: int(process.env.SESSION_IDLE_DISPOSE_MS, 1000 * 60 * 60),

  // يشغّلها المشرف في server.sh، وتسمح بإعادة التشغيل من الواجهة/تيليجرام
  supervised: process.env.PI_SUPERVISED === "1",
};

// وحّد مجلد الوكيل مع SDK: بعض مكوّنات Pi الداخلية (MCP) تقرأ PI_CODING_AGENT_DIR.
process.env.PI_CODING_AGENT_DIR = config.agentDir;

export default config;
