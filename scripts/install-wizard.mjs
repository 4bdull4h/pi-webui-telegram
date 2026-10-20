#!/usr/bin/env node
/**
 * معالج تثبيت تفاعلي — العربية والإنجليزية.
 * Installer wizard — Arabic and English.
 *
 * الاستخدام / Usage:
 *   node scripts/install-wizard.mjs
 *   node scripts/install-wizard.mjs --lang=en --yes --name="My Assistant" --port=8787
 *   node scripts/install-wizard.mjs --no-service --no-telegram --force
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, execPath, platform } from "node:process";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IN_NODE_MODULES = ROOT.split(/[\\/]/).includes("node_modules");
const SUPPORT = "@coder480";
const SERVICE_NAME = "pi-webui";

const STR = {
  ar: {
    langTitle: "اختر لغة التثبيت / Choose install language:",
    langHint: "1) العربية   2) English",
    welcome: (v) => `\n  ${v}\n  معالج تثبيت واجهة Pi + تيليجرام\n  الدعم: ${SUPPORT}\n`,
    name: "اسم المساعد الذي سيظهر في الواجهة والبوت",
    nameDef: "مساعد Pi",
    workspace: "مجلد العمل الذي سيعمل فيه الوكيل",
    port: "منفذ الواجهة",
    provider: "المزوّد الافتراضي",
    model: "النموذج الافتراضي",
    tokenTitle: "توكن بوت تيليجرام (اتركه فارغاً للتخطي)",
    tokenHelp: "  للحصول عليه: افتح @BotFather في تيليجرام ← /newbot ← انسخ التوكن.",
    tokenInvalid: "التوكن غير صالح أو تعذّر التحقق منه. هل تريد المتابعة بدونه؟",
    tokenOk: (u) => `  ✅ تم التحقق من البوت: @${u}`,
    idTitle: "معرّف تيليجرام (Telegram ID) — غير إلزامي",
    idSteps:
      "  كيف تحصل عليه؟\n" +
      "  1) افتح تيليجرام وابحث عن @userinfobot\n" +
      "  2) أرسل له /start\n" +
      "  3) سيردّ برقمك (Id) — انسخه وألصقه هنا.\n" +
      "  بديل: @RawDataBot ← أرسل أي رسالة ← اقرأ \"from\": { \"id\": ... }",
    idWarn: "  ⚠️ بدون معرّف، البوت سيرفض الجميع (حماية افتراضية)، لكن الواجهة تعمل.",
    webToken: "رمز حماية الواجهة (اختياري — اتركه فارغاً للتعطيل)",
    serviceTitle: "هل تريد إنشاء خدمة systemd لتشغيل تلقائي؟",
    serviceNoLinux: "  (systemd غير متاح على هذا النظام — سيتم التخطي)",
    servicePath: (p) => `  ✅ تم إنشاء الخدمة: ${p}`,
    serviceStart: "هل تريد تفعيلها وتشغيلها الآن؟",
    summary: "ملخص التثبيت",
    envPath: (p) => `  ملف الإعدادات: ${p}`,
    runHint: "للتشغيل:",
    done: "تم التثبيت بنجاح.",
    overwrite: "ملف .env موجود بالفعل. هل تريد استبداله؟",
    cancelled: "أُلغيت العملية.",
    yes: "نعم",
    no: "لا",
  },
  en: {
    langTitle: "Choose install language / اختر لغة التثبيت:",
    langHint: "1) العربية   2) English",
    welcome: (v) => `\n  ${v}\n  Pi Web UI + Telegram installer\n  Support: ${SUPPORT}\n`,
    name: "Assistant name shown in the UI and bot",
    nameDef: "Pi Assistant",
    workspace: "Workspace directory for the agent",
    port: "Web UI port",
    provider: "Default provider",
    model: "Default model",
    tokenTitle: "Telegram bot token (leave empty to skip)",
    tokenHelp: "  Get one: open @BotFather in Telegram → /newbot → copy the token.",
    tokenInvalid: "Token is invalid or could not be verified. Continue without it?",
    tokenOk: (u) => `  ✅ Bot verified: @${u}`,
    idTitle: "Telegram ID — optional",
    idSteps:
      "  How to get it?\n" +
      "  1) Open Telegram and search for @userinfobot\n" +
      "  2) Send /start\n" +
      "  3) It replies with your numeric Id — copy and paste it here.\n" +
      "  Alternative: @RawDataBot → send any message → read \"from\": { \"id\": ... }",
    idWarn: "  ⚠️ Without an ID the bot denies everyone (fail-closed); the web UI still works.",
    webToken: "Web UI access token (optional — empty disables it)",
    serviceTitle: "Create a systemd user service for auto-start?",
    serviceNoLinux: "  (systemd is unavailable on this system — skipping)",
    servicePath: (p) => `  ✅ Service created: ${p}`,
    serviceStart: "Enable and start it now?",
    summary: "Installation summary",
    envPath: (p) => `  Config file: ${p}`,
    runHint: "To start:",
    done: "Installed successfully.",
    overwrite: ".env already exists. Overwrite it?",
    cancelled: "Cancelled.",
    yes: "yes",
    no: "no",
  },
};

// ---------- args ----------
const args = Object.fromEntries(
  argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  }),
);
const flag = (name) => args[name] === true || args[name] === "true";
const val = (name, fallback = "") => (typeof args[name] === "string" ? args[name] : fallback);
const nonInteractive = flag("yes") || flag("y") || !stdin.isTTY;

function detectLang() {
  const forced = val("lang", "").toLowerCase();
  if (forced === "ar" || forced === "en") return forced;
  const env = `${process.env.LC_ALL || ""}${process.env.LC_MESSAGES || ""}${process.env.LANG || ""}`.toLowerCase();
  return env.includes("ar") ? "ar" : "en";
}

let lang = detectLang();
const t = (key) => STR[lang][key];

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (question, def = "") => {
  if (nonInteractive) return def;
  const suffix = def ? ` [${def}]` : "";
  const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
  return answer || def;
};
const confirm = async (question, def = true) => {
  if (nonInteractive) return def;
  const answer = (await rl.question(`  ${question} (${t("yes")}/${t("no")}) [${def ? t("yes") : t("no")}]: `)).trim().toLowerCase();
  if (!answer) return def;
  return ["y", "yes", "ن", "نعم", "true"].includes(answer);
};

async function chooseLanguage() {
  if (val("lang", "") || nonInteractive) return;
  console.log(`\n  ${t("langTitle")}\n  ${t("langHint")}`);
  const answer = (await rl.question("  > ")).trim();
  lang = answer === "1" || answer.toLowerCase().startsWith("ar") ? "ar" : "en";
}

async function verifyToken(token) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    return data?.ok ? data.result?.username || "bot" : null;
  } catch {
    return null;
  }
}

function envLine(key, value) {
  const text = String(value ?? "");
  return `${key}=${text}`;
}

function writeEnv(settings) {
  const envPath = join(settings.home, ".env");
  const lines = [
    "# ===== تم إنشاؤه بواسطة معالج التثبيت =====",
    "# ===== Generated by the installer wizard =====",
    "",
    "# الهوية / Identity",
    envLine("ASSISTANT_NAME", settings.name),
    envLine("SUPPORT_HANDLE", SUPPORT),
    envLine("BOT_LANGUAGE", lang),
    "",
    "# خادم الويب / Web server",
    envLine("HOST", "0.0.0.0"),
    envLine("PORT", settings.port),
    envLine("WEB_TOKEN", settings.webToken),
    "",
    "# مساحة العمل / Workspace",
    envLine("WORKSPACE", settings.workspace),
    envLine("PI_AGENT_DIR", settings.agentDir),
    "",
    "# النموذج / Model",
    envLine("DEFAULT_PROVIDER", settings.provider),
    envLine("DEFAULT_MODEL", settings.model),
    envLine("DEFAULT_THINKING", "medium"),
    "",
    "# تيليجرام / Telegram",
    envLine("TELEGRAM_BOT_TOKEN", settings.token),
    envLine("TELEGRAM_ALLOWED_USERS", settings.telegramId),
    envLine("TELEGRAM_ALLOWED_CHATS", ""),
    "",
    "# الميزات / Features",
    envLine("SYNC_WEB_TELEGRAM", "true"),
    envLine("FEATURE_RPC", "false"),
    envLine("TELEGRAM_NOTIFY_MODE", "final"),
  ];
  writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* ignore */
  }
  return envPath;
}

function serviceDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "systemd", "user");
}

function writeService(settings) {
  if (platform !== "linux") return null;
  if (!existsSync("/run/systemd/system") && !existsSync("/usr/bin/systemctl") && !existsSync("/bin/systemctl")) return null;
  const dir = serviceDir();
  const file = join(dir, `${SERVICE_NAME}.service`);
  const logs = join(settings.home, ".run");
  mkdirSync(dir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const unit = `[Unit]
Description=${settings.name} — Pi Web UI + Telegram bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
Environment=HOME=${homedir()}
Environment=PI_WEBUI_HOME=${settings.home}
Environment=NODE_ENV=production
ExecStart=${execPath} ${join(ROOT, "src", "index.js")}
Restart=on-failure
RestartSec=3
StandardOutput=append:${join(logs, "systemd.log")}
StandardError=append:${join(logs, "systemd.log")}

[Install]
WantedBy=default.target
`;
  writeFileSync(file, unit, { mode: 0o644 });
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } catch {
    /* غير متاح في هذه البيئة */
  }
  return file;
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.error(
      `\n  ❌ Node.js ${process.versions.node} غير مدعوم. تتطلب الحزمة Node.js 22 أو أحدث.\n` +
        `  ❌ Node.js ${process.versions.node} is not supported. This package requires Node.js 22+.\n`,
    );
    process.exit(1);
  }
  await chooseLanguage();
  const brand = lang === "ar" ? "مساعد Pi" : "Pi Assistant";
  console.log(t("welcome")(brand));

  let name = val("name", "") || (await ask(t("name"), t("nameDef")));
  const workspace = resolve(val("workspace", "") || (await ask(t("workspace"), homedir())));
  const port = Number(val("port", "") || (await ask(t("port"), "8787"))) || 8787;
  const provider = val("provider", "") || (await ask(t("provider"), "deepseek"));
  const model = val("model", "") || (await ask(t("model"), "deepseek-flash"));

  let token = val("token", "");
  if (!token && !flag("no-telegram") && !nonInteractive) {
    console.log(`\n  ${t("tokenTitle")}\n${t("tokenHelp")}`);
    token = (await rl.question("  > ")).trim();
  }
  if (token) {
    const username = await verifyToken(token);
    if (username) console.log(t("tokenOk")(username));
    else {
      console.log(`  ⚠️ ${t("tokenInvalid")}`);
      if (!(await confirm(t("tokenInvalid"), false))) {
        console.log(`\n  ${t("cancelled")}\n`);
        rl.close();
        return;
      }
      token = "";
    }
  }

  let telegramId = val("telegram-id", "");
  if (!telegramId && !flag("no-telegram") && !nonInteractive) {
    console.log(`\n  ${t("idTitle")}\n${t("idSteps")}`);
    telegramId = (await rl.question("  > ")).trim().replace(/[^\d-]/g, "");
    if (!telegramId) console.log(t("idWarn"));
  }
  if (telegramId && !/^-?\d+$/.test(telegramId)) {
    console.log(`  ⚠️ ${lang === "ar" ? "المعرّف يجب أن يكون رقماً — تم تجاهله." : "ID must be numeric — ignored."}`);
    telegramId = "";
  }

  const webToken = val("web-token", "") || (nonInteractive ? "" : (await ask(t("webToken"), "")).trim());
  const agentDir = resolve(val("agent-dir", "") || join(homedir(), ".pi", "agent"));
  const home = resolve(
    val("home", "") || process.env.PI_WEBUI_HOME || (IN_NODE_MODULES ? join(homedir(), ".pi-webui") : ROOT),
  );
  mkdirSync(home, { recursive: true });

  const envPath = join(home, ".env");
  if (existsSync(envPath) && !flag("force") && !nonInteractive) {
    if (!(await confirm(t("overwrite"), false))) {
      console.log(`\n  ${t("cancelled")}\n`);
      rl.close();
      return;
    }
  }

  const settings = { name, workspace, port, provider, model, token, telegramId, webToken, agentDir, home };
  writeEnv(settings);

  // ربط حزمة Pi إن كانت مثبتة
  try {
    execFileSync(execPath, [join(ROOT, "scripts", "setup.mjs")], {
      stdio: "inherit",
      env: { ...process.env, PI_WEBUI_HOME: settings.home },
    });
  } catch {
    console.log(
      lang === "ar"
        ? "  ⚠️ لم يتم ربط Pi. ثبّت Pi ثم شغّل: node scripts/setup.mjs"
        : "  ⚠️ Pi was not linked. Install Pi, then run: node scripts/setup.mjs",
    );
  }

  let serviceFile = null;
  const wantsService =
    !flag("no-service") && platform === "linux" && (nonInteractive ? true : await confirm(t("serviceTitle"), true));
  if (wantsService) serviceFile = writeService(settings);
  else if (platform !== "linux") console.log(t("serviceNoLinux"));

  if (serviceFile) {
    console.log(t("servicePath")(serviceFile));
    const startNow = !flag("no-start") && !nonInteractive && (await confirm(t("serviceStart"), true));
    if (startNow) {
      try {
        execFileSync("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`], { stdio: "inherit" });
      } catch {
        console.log(
          lang === "ar"
            ? `  ⚠️ تعذّر التفعيل التلقائي. نفّذ: systemctl --user enable --now ${SERVICE_NAME}`
            : `  ⚠️ Auto-enable failed. Run: systemctl --user enable --now ${SERVICE_NAME}`,
        );
      }
    }
  }

  console.log(`\n  ── ${t("summary")} ──`);
  console.log(`  ${lang === "ar" ? "الاسم" : "Name"}: ${name}`);
  console.log(`  ${lang === "ar" ? "المساحة" : "Workspace"}: ${workspace}`);
  console.log(`  ${lang === "ar" ? "المنفذ" : "Port"}: ${port}`);
  console.log(`  ${lang === "ar" ? "النموذج" : "Model"}: ${provider}/${model}`);
  console.log(`  Telegram ID: ${telegramId || (lang === "ar" ? "غير محدد" : "not set")}`);
  console.log(t("envPath")(envPath));
  console.log(`  ${lang === "ar" ? "مجلد البيانات" : "Runtime home"}: ${home}`);

  console.log(`\n  ${t("runHint")}`);
  console.log(`    npm start            # ${lang === "ar" ? "أو" : "or"}`);
  console.log("    node src/index.js");
  if (serviceFile) console.log(`    systemctl --user start ${SERVICE_NAME}`);
  console.log(`\n  ✅ ${t("done")}`);
  console.log(`  ${lang === "ar" ? "صُنع بواسطة" : "Made by"} ${SUPPORT}\n`);
  rl.close();
}

main().catch((err) => {
  console.error(`\n  ❌ ${err.message}\n`);
  rl.close();
  process.exit(1);
});
