/**
 * جسر RPC: يشغّل `pi --mode rpc` كعملية فرعية ويتخاطب معها بـJSONL.
 * - تقسيم صارم على "\n" فقط (لا readline، لا U+2028/U+2029) مع تجريد "\r".
 * - ربط الردود بالطلبات عبر id + مهل + رفض عند خروج العملية.
 * - إعادة تشغيل تلقائية محدودة عند الخروج غير المتوقع.
 */
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

import config from "../config.js";
import logger from "../logger.js";

const HERE_DIR = dirname(fileURLToPath(import.meta.url));
/** مجلد إضافات المشروع التي تُحمَّل في كل جلسة RPC (موافقة الأدوات، التفويض…). */
export const PROJECT_EXTENSIONS_DIR = resolve(HERE_DIR, "..", "..", "extensions");

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
/** أوامر تحتاج مهلة أطول من الافتراضية. */
const LONG_COMMANDS = new Set(["abort", "compact"]);

export const DEFAULT_TIMEOUT_MS = 30_000;
export const LONG_TIMEOUT_MS = 120_000;

function readPackageRoot(entryFile) {
  let dir = dirname(entryFile);
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg?.name === PACKAGE_NAME) return dir;
    } catch {
      /* لا يوجد package.json هنا */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function pickCli(packageRoot) {
  if (!packageRoot) return null;
  const candidates = [
    join(packageRoot, "dist", "cli.js"),
    join(packageRoot, "dist", "bundle", "cli.js"),
  ];
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
    if (bin) candidates.push(join(packageRoot, bin));
  } catch {
    /* تجاهل */
  }
  return candidates.find((file) => existsSync(file)) || null;
}

/** حلّ مسار CLI الخاص بـpi ديناميكياً (بدون مسارات مثبّتة في الشيفرة). */
export function resolvePiCli() {
  if (process.env.PI_CLI_PATH && existsSync(process.env.PI_CLI_PATH)) {
    return resolve(process.env.PI_CLI_PATH);
  }

  // 1) عبر ESM: import.meta.resolve
  try {
    const url = import.meta.resolve?.(PACKAGE_NAME);
    if (url) {
      const viaRoot = pickCli(readPackageRoot(fileURLToPath(url)));
      if (viaRoot) return viaRoot;
    }
  } catch {
    /* لا يوجد في node_modules */
  }

  // 2) عبر createRequire
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve(PACKAGE_NAME);
    const viaRequire = pickCli(readPackageRoot(entry));
    if (viaRequire) return viaRequire;
  } catch {
    /* تجاهل */
  }

  // 3) احتياطي: مجلد التثبيت المحلي تحت agentDir
  const releases = join(config.agentDir, "install", "releases");
  try {
    const versions = readdirSync(releases).sort().reverse();
    for (const version of versions) {
      const cli = pickCli(join(releases, version, "node_modules", PACKAGE_NAME));
      if (cli) return cli;
    }
  } catch {
    /* تجاهل */
  }

  const fallback = join(releases, "1.3.0", "node_modules", PACKAGE_NAME, "dist", "cli.js");
  if (existsSync(fallback)) return fallback;
  throw new Error(
    `تعذّر العثور على pi CLI. ثبّت ${PACKAGE_NAME} أو اضبط PI_CLI_PATH. (${releases})`,
  );
}

export class RpcClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cliPath = options.cliPath || resolvePiCli();
    this.cwd = options.cwd || config.workspace;
    this.sessionPath = options.sessionPath || null;
    this.sessionDir = options.sessionDir || null;
    this.provider = options.provider || null;
    this.model = options.model || null;
    this.thinking = options.thinking || null;
    this.tools = Array.isArray(options.tools) ? options.tools.filter(Boolean) : [];
    this.appendSystemPrompt = Array.isArray(options.appendSystemPrompt)
      ? options.appendSystemPrompt.filter(Boolean)
      : [];
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    this.env = options.env || null;
    this.noExtensions = !!options.noExtensions;
    this.noSkills = !!options.noSkills;
    this.noSession = !!options.noSession;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.longTimeoutMs = options.longTimeoutMs ?? LONG_TIMEOUT_MS;
    this.maxRestarts = options.maxRestarts ?? 3;
    this.restartDelays = options.restartDelays ?? [500, 1500, 3000];

    this.child = null;
    this.starting = null;
    this.disposing = false;
    this.pending = new Map();
    this.seq = 0;
    this.idPrefix = `rpc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.buffer = "";
    this.stderrBuffer = "";
    this.decoder = new StringDecoder("utf8");
    this.stderrDecoder = new StringDecoder("utf8");
    this.restarts = 0;
    this.restartTimer = null;
    this.stableTimer = null;
    this.extensionUI = null;
  }

  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  #args() {
    const args = [this.cliPath, "--mode", "rpc"];
    if (this.noSession) {
      args.push("--no-session");
    } else if (this.sessionPath && existsSync(this.sessionPath)) {
      args.push("--session", this.sessionPath);
    } else if (this.sessionDir) {
      args.push("--session-dir", this.sessionDir);
    }
    if (this.model) {
      if (this.provider) args.push("--provider", String(this.provider));
      args.push("--model", String(this.model));
    }
    if (this.thinking) args.push("--thinking", String(this.thinking));
    if (this.tools.length) args.push("--tools", this.tools.join(","));
    if (this.noExtensions) args.push("--no-extensions");
    if (this.noSkills) args.push("--no-skills");
    // إضافات المشروع تُحمَّل صراحةً (تبقى فعّالة حتى مع --no-extensions).
    // ملاحظة: `-e` يقبل ملفات لا مجلدات، لذا نعدّد الملفات ونمرّر كل واحد.
    if (existsSync(PROJECT_EXTENSIONS_DIR)) {
      const extensionFiles = readdirSync(PROJECT_EXTENSIONS_DIR)
        .filter((f) => /\.(ts|js|mjs|tsx)$/.test(f))
        .sort();
      for (const file of extensionFiles) {
        args.push("--extension", join(PROJECT_EXTENSIONS_DIR, file));
      }
    }
    for (const text of this.appendSystemPrompt) args.push("--append-system-prompt", String(text));
    args.push(...this.extraArgs);
    return args;
  }

  /** يشغّل العملية إن لم تكن تعمل. */
  start() {
    if (this.disposing) return Promise.reject(new Error("الجسر مُغلق"));
    if (this.running) return Promise.resolve(this.child);
    if (this.starting) return this.starting;

    this.starting = new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, this.#args(), {
        cwd: this.cwd,
        env: { ...process.env, ...(this.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      let settled = false;

      child.once("error", (err) => {
        this.child = null;
        if (!settled) {
          settled = true;
          rejectPromise(err);
        } else if (this.listenerCount("error")) {
          this.emit("error", err);
        } else {
          logger.error("RPC: خطأ في العملية الفرعية:", err?.message || err);
        }
      });
      child.once("spawn", () => {
        // حالة تدفّق جديدة لكل عملية.
        this.buffer = "";
        this.stderrBuffer = "";
        this.decoder = new StringDecoder("utf8");
        this.stderrDecoder = new StringDecoder("utf8");
        if (this.stableTimer) clearTimeout(this.stableTimer);
        // بعد استقرار العملية نُصفّر عدّاد المحاولات حتى لا ندخل حلقة إعادة تشغيل.
        this.stableTimer = setTimeout(() => {
          this.restarts = 0;
        }, 30_000);
        this.stableTimer.unref?.();
        this.emit("spawn", { pid: child.pid, argv: this.#args() });
        if (!settled) {
          settled = true;
          resolvePromise(child);
        }
      });
      child.stdout?.on("data", (chunk) => this.#onStdout(chunk));
      child.stderr?.on("data", (chunk) => this.#onStderr(chunk));
      child.once("exit", (code, signal) => this.#onExit(code, signal));
      child.stdin?.on("error", (err) => {
        logger.debug("RPC: خطأ في stdin:", err?.message || err);
      });
    }).finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  #onStdout(chunk) {
    this.buffer += this.decoder.write(chunk);
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this.#handleLine(line);
    }
    // حماية من سطر ضخم بلا فاصل أسطر
    if (this.buffer.length > 8 * 1024 * 1024) {
      logger.warn("RPC: تجاوز مخزن القراءة 8MB، تم إفراغه.");
      this.buffer = "";
    }
  }

  #handleLine(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      logger.warn("RPC: سطر غير صالح:", err?.message || err);
      return;
    }
    this.#handleRecord(record);
  }

  #handleRecord(record) {
    if (!record || typeof record !== "object") return;
    if (record.type === "response") {
      const entry = record.id ? this.pending.get(record.id) : null;
      if (!entry) {
        logger.debug(`RPC: رد بلا طلب مطابق (${record.id || "-"}/${record.command || "?"})`);
        this.emit("record", record);
        return;
      }
      this.pending.delete(record.id);
      clearTimeout(entry.timer);
      if (record.success) entry.resolve(record.data ?? null);
      else entry.reject(new Error(record.error || `فشل الأمر ${record.command || entry.type}`));
      this.emit("record", record);
      return;
    }

    if (record.type === "extension_ui_request") {
      this.#handleExtensionUI(record);
    }
    this.emit("record", record);
    this.emit("event", record);
  }

  #handleExtensionUI(record) {
    this.emit("extensionUiRequest", record);
    if (!DIALOG_METHODS.has(record.method)) return; // notify/setStatus/... لا تنتظر رداً
    if (!this.extensionUI) {
      // لا معالج مسجّل: ألغِ الحوار حتى لا تتعلّق العملية.
      logger.debug(`RPC: حوار ${record.method} بلا معالج، تم الإلغاء.`);
      void this.respond(record.id, { cancelled: true }).catch(() => undefined);
      return;
    }
    const respond = (payload) => this.respond(record.id, payload);
    try {
      const result = this.extensionUI(record, respond);
      if (result && typeof result.then === "function") {
        result.catch((err) => {
          logger.warn(`RPC: فشل معالج ${record.method}:`, err?.message || err);
          void respond({ cancelled: true }).catch(() => undefined);
        });
      }
    } catch (err) {
      logger.warn(`RPC: فشل معالج ${record.method}:`, err?.message || err);
      void respond({ cancelled: true }).catch(() => undefined);
    }
  }

  #onStderr(chunk) {
    this.stderrBuffer += this.stderrDecoder.write(chunk);
    let index;
    while ((index = this.stderrBuffer.indexOf("\n")) !== -1) {
      const line = this.stderrBuffer.slice(0, index).replace(/\r$/, "");
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      const text = line.trim();
      if (!text) continue;
      if (/error|fatal|exception|failed|uncaught/i.test(text)) logger.warn(`[rpc] ${text}`);
      else logger.debug(`[rpc] ${text}`);
      this.emit("stderr", text);
    }
  }

  /** معالج حوارات الإضافة (select/confirm/input/editor). */
  onExtensionUI(handler) {
    this.extensionUI = handler;
    return () => {
      if (this.extensionUI === handler) this.extensionUI = null;
    };
  }

  async respond(id, payload = {}) {
    return this.#write({ type: "extension_ui_response", id, ...payload });
  }

  #nextId() {
    this.seq += 1;
    return `${this.idPrefix}-${this.seq}`;
  }

  #timeoutFor(type, override) {
    if (Number.isFinite(override)) return override;
    return LONG_COMMANDS.has(type) ? this.longTimeoutMs : this.defaultTimeoutMs;
  }

  /**
   * يرسل أمراً وينتظر الرد المطابق بالـid.
   * @param {object} command
   * @param {{timeoutMs?: number}} [options]
   */
  send(command, options = {}) {
    if (!command || typeof command !== "object" || !command.type) {
      return Promise.reject(new Error("أمر RPC غير صالح"));
    }
    if (!this.running && !this.child) {
      return Promise.reject(new Error("جسر RPC غير مُشغّل"));
    }
    const id = command.id || this.#nextId();
    const type = command.type;
    const payload = { ...command, id };
    const timeoutMs = this.#timeoutFor(type, options.timeoutMs);

    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`انتهت مهلة الأمر ${type} (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, type });
      this.#write(payload).catch((err) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(err);
      });
    });
  }

  /** كتابة سطر واحد مع احترام backpressure. */
  async #write(payload) {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("stdin الخاص بعملية pi غير متاح");
    }
    const line = `${JSON.stringify(payload)}\n`;
    let ok;
    try {
      ok = stdin.write(line, "utf8");
    } catch (err) {
      throw new Error(`تعذّرت الكتابة إلى pi: ${err?.message || err}`);
    }
    if (ok) return;
    await Promise.race([
      once(stdin, "drain"),
      once(this.child, "exit").then(() => {
        throw new Error("خرجت عملية pi أثناء الكتابة");
      }),
    ]);
  }

  #rejectPending(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
  }

  #onExit(code, signal) {
    const intentional = this.disposing;
    this.child = null;
    this.buffer = "";
    this.stderrBuffer = "";
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    this.#rejectPending(new Error(`خرجت عملية pi (code=${code ?? "-"}, signal=${signal || "-"})`));
    this.emit("exit", { code, signal, intentional });
    if (intentional) return;

    if (this.restarts >= this.maxRestarts) {
      logger.error(`RPC: خروج غير متوقع وتجاوز حدّ إعادة التشغيل (${this.maxRestarts}).`);
      this.emit("fatal", { code, signal });
      return;
    }
    const delay = this.restartDelays[Math.min(this.restarts, this.restartDelays.length - 1)] ?? 3000;
    this.restarts += 1;
    const attempt = this.restarts;
    logger.warn(`RPC: إعادة تشغيل تلقائية (محاولة ${attempt}/${this.maxRestarts}) بعد ${delay}ms.`);
    this.emit("restarting", { attempt, delay, code, signal });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start()
        .then(() => this.emit("restarted", { attempt }))
        .catch((err) => {
          logger.error("RPC: فشلت إعادة التشغيل:", err?.message || err);
          this.emit("fatal", { error: err });
        });
    }, delay);
    // ملاحظة: لا نستخدم unref هنا، وإلا فقد يخرج المستضيف قبل تنفيذ إعادة التشغيل
    // إن لم يكن هناك أي مقبض آخر يُبقي حلقة الأحداث حيّة.
  }

  /** إغلاق لطيف: SIGTERM ثم SIGKILL بعد 3 ثوانٍ. */
  async dispose({ graceMs = 3000 } = {}) {
    this.disposing = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.#rejectPending(new Error("تم إغلاق جسر RPC"));
    const child = this.child;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      /* تجاهل */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* تجاهل */
    }
    await new Promise((resolvePromise) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolvePromise();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* تجاهل */
        }
        finish();
      }, graceMs);
      killTimer.unref?.();
      if (child.exitCode !== null) finish();
      else child.once("exit", finish);
    });
    this.child = null;
  }
}

/* ===== اختبار ذاتي ===== */
async function selfTest() {
  const client = new RpcClient({ cwd: config.workspace, noSession: true });
  try {
    const started = Date.now();
    await client.start();
    const state = await client.send({ type: "get_state" }, { timeoutMs: 60_000 });
    if (!state || typeof state.isStreaming !== "boolean") {
      throw new Error(`get_state أعاد بيانات غير متوقعة: ${JSON.stringify(state)?.slice(0, 200)}`);
    }
    console.log(
      `self-test: cli=${client.cliPath} session=${state.sessionId || "-"} model=${
        state.model ? `${state.model.provider}/${state.model.id}` : "none"
      } (${Date.now() - started}ms)`,
    );
    return true;
  } finally {
    await client.dispose();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  if (process.argv.includes("--self-test")) {
    selfTest()
      .then(() => {
        console.log("self-test ok");
        process.exit(0);
      })
      .catch((err) => {
        console.error("self-test failed:", err?.stack || err?.message || err);
        process.exit(1);
      });
  } else {
    console.log("الاستخدام: node src/rpc/client.js --self-test");
    process.exit(2);
  }
}

export default RpcClient;
