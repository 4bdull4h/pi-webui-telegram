import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import config from "./config.js";
import logger from "./logger.js";
import { t, thinkingLabel } from "./i18n.js";
import { escapeHtml, toTelegramMessages } from "./telegram-format.js";
import { toolLabel, toolHint } from "./events.js";

const MODELS_PER_PAGE = 8;
const SESSIONS_PER_PAGE = 8;

// ===== المرحلة D1: كتم الرسائل حتى النتيجة النهائية =====
const QUIET_PROGRESS_MS = 45_000; // حدّ أقصى لتعديل رسالة «جارٍ العمل» في وضع final
const FINAL_TEXT_LIMIT = 3500; // أقصى طول لنص الوكيل في الرسالة النهائية
const COMPACT_MAX_LINES = 6; // أقصى أسطر التقدّم في وضع compact
const ERROR_LINE_LIMIT = 500;

/** تنسيق المدة: 1:23 أو 1:02:03. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** وقت محلي HH:MM:SS لرسالة الانقطاع. */
function formatClock(timestamp) {
  const d = new Date(Number(timestamp) || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** قصّ HTML دون قطع كيان (&lt; …) في المنتصف. */
function truncateHtml(html, max) {
  if (html.length <= max) return html;
  let cut = html.slice(0, max);
  const amp = cut.lastIndexOf("&");
  if (amp > -1 && amp > cut.length - 12 && !cut.slice(amp).includes(";")) cut = cut.slice(0, amp);
  return `${cut}…`;
}

class TelegramError extends Error {
  constructor(description, code, payload) {
    super(description || "Telegram API error");
    this.code = code;
    this.payload = payload;
    this.retryAfter = payload?.parameters?.retry_after;
  }
}

/** عميل مصغّر لواجهة Telegram Bot API عبر fetch. */
class TelegramApi {
  constructor(token) {
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new TelegramError(`رد غير صالح من تيليجرام (${res.status})`, res.status);
    }
    if (!data.ok) throw new TelegramError(data.description, data.error_code, data);
    return data.result;
  }

  getMe() {
    return this.call("getMe");
  }
  getUpdates(params) {
    return this.call("getUpdates", params);
  }
  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", { chat_id: chatId, text, ...extra });
  }
  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
  }
  answerCallbackQuery(id, extra = {}) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...extra });
  }
  sendChatAction(chatId, action = "typing") {
    return this.call("sendChatAction", { chat_id: chatId, action }).catch(() => undefined);
  }
  setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramBot {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.onRestart = options.onRestart || null;
    this.api = new TelegramApi(config.telegram.token);
    this.lang = config.language;
    this.running = false;
    this.offset = 0;
    this.chatState = new Map(); // chatId -> { modelChoices, modelPage, sessionChoices, sessionPage }
    this.sharedUnsubscribe = null;
    this.mirror = {
      active: false,
      chatId: null,
      messageId: null,
      text: "",
      lastEdit: 0,
      editing: false,
      dirty: false,
      finalizeTimer: null,
      typingTimer: null,
      ensuring: null,
    };
    // حالة تشغيل «مكتوم» (وضعا final/compact).
    this.quiet = {
      active: false,
      chatId: null,
      messageId: null,
      startedAt: 0,
      steps: 0,
      lastText: "",
      error: null,
      aborted: false,
      timer: null,
      renderTimer: null,
      lines: [],
      rendered: "",
      rendering: false,
      pendingText: null,
      lastRenderAt: 0,
    };
    this.primaryChatId = config.telegram.allowedChats[0] || config.telegram.allowedUsers[0] || this.#loadTargetChat() || null;
    this.notifyModeOverride = this.#loadNotifyMode();
    // C1: حوارات الامتدادات المعلّقة على رد المستخدم (موافقة الأدوات وغيرها).
    // requestId → { requestId, chatId, messageId, conv, method, header, options, timer }
    this.pendingUI = new Map();
    // chatId → نفس الكائن أعلاه (لحوارات input/editor التي تنتظر رسالة نصية).
    this.pendingInput = new Map();
    // ختم آخر تنبيه «لا محادثة مرتبطة» (تنبيه واحد كل 60 ثانية).
    this.noTargetWarnAt = 0;
  }

  get enabled() {
    return config.telegram.enabled && !!config.telegram.token;
  }

  /** final | compact | live (D1). */
  get notifyMode() {
    if (this.notifyModeOverride) return this.notifyModeOverride;
    return config.telegram.notifyMode || "final";
  }

  /** مسار حفظ وضع الإشعارات المختار من تيليجرام. */
  #modePath() {
    return join(config.dataDir, "telegram-mode.json");
  }

  #loadNotifyMode() {
    try {
      const raw = JSON.parse(readFileSync(this.#modePath(), "utf8"));
      const mode = raw?.mode;
      return ["final", "compact", "live"].includes(mode) ? mode : null;
    } catch {
      return null;
    }
  }

  #saveNotifyMode(mode) {
    this.notifyModeOverride = mode;
    try {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(
        this.#modePath(),
        JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2),
      );
    } catch (err) {
      logger.warn("تيليجرام: تعذّر حفظ وضع الإشعارات:", err?.message || err);
    }
  }

  /** أمر /mode: تغيير درجة متابعة الويب من تيليجرام. */
  async cmdMode(chatId, value) {
    const mode = String(value || "").trim().toLowerCase();
    if (!["final", "compact", "live"].includes(mode)) {
      await this.api.sendMessage(
        chatId,
        [
          `🔔 <b>وضع الإشعارات الحالي:</b> <code>${escapeHtml(this.notifyMode)}</code>`,
          "",
          "<b>final</b> — رسالة واحدة بعد كل مهمة (أقل إزعاجاً)",
          "<b>compact</b> — رسالة تنفيذ + أسطر تقدّم مختصرة + النتيجة",
          "<b>live</b> — مزامنة كاملة حيّة مع الويب",
          "",
          "للتغيير: <code>/mode compact</code>",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }
    this.#saveNotifyMode(mode);
    await this.api.sendMessage(chatId, `✅ وضع الإشعارات: <code>${escapeHtml(mode)}</code>`, {
      parse_mode: "HTML",
    });
  }

  /** هل نحن في وضع مكتوم لا يرسل إلا رسالة نهائية؟ */
  get quietMode() {
    return this.notifyMode === "final" || this.notifyMode === "compact";
  }

  #conversationId(chatId) {
    return config.syncWebTelegram && config.sharedSessionId
      ? config.sharedSessionId
      : `tg:${chatId}`;
  }

  #conversation(chatId) {
    return this.manager.getOrCreate(this.#conversationId(chatId));
  }

  #setPrimaryChat(chatId, chatType = null) {
    if (!chatId) return;
    const id = String(chatId);
    if (this.primaryChatId === id) return;
    // نحافظ على الهدف الأول، وننتقل فقط إلى محادثة خاصة جديدة (المستخدم انتقل).
    if (this.primaryChatId && chatType !== "private") return;
    this.primaryChatId = id;
    this.#saveTargetChat(id);
  }

  /** مسار حفظ محادثة الهدف حتى تنجو من إعادة التشغيل. */
  #targetPath() {
    return join(config.dataDir, "telegram-target.json");
  }

  #loadTargetChat() {
    try {
      const raw = JSON.parse(readFileSync(this.#targetPath(), "utf8"));
      const id = raw?.chatId ? String(raw.chatId) : null;
      if (!id) return null;
      logger.info(`تيليجرام: محادثة هدف محفوظة (${id}).`);
      return id;
    } catch {
      return null;
    }
  }

  #saveTargetChat(chatId) {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(
        this.#targetPath(),
        JSON.stringify({ chatId: String(chatId), updatedAt: new Date().toISOString() }, null, 2),
      );
    } catch (err) {
      logger.warn("تيليجرام: تعذّر حفظ محادثة الهدف:", err?.message || err);
    }
  }

  #state(chatId) {
    let state = this.chatState.get(chatId);
    if (!state) {
      state = { modelChoices: [], modelPage: 0, sessionChoices: [], sessionPage: 0 };
      this.chatState.set(chatId, state);
    }
    return state;
  }

  // ===== مزامنة الجلسة المشتركة مع الويب =====

  bindSharedMirror() {
    if (!config.syncWebTelegram || !config.sharedSessionId) return;
    this.sharedUnsubscribe?.();
    const conversation = this.manager.getOrCreate(config.sharedSessionId);
    this.sharedUnsubscribe = conversation.subscribe((event) => {
      this.handleSharedEvent(event, conversation).catch((err) =>
        logger.warn("تيليجرام مزامنة:", err?.message || err),
      );
    });
    logger.ok(`تيليجرام: مزامنة الجلسة المشتركة (${config.sharedSessionId}).`);
  }

  mirrorTargetChat() {
    return (
      this.primaryChatId ||
      config.telegram.allowedChats[0] ||
      config.telegram.allowedUsers[0] ||
      null
    );
  }

  async ensureMirror(chatId) {
    const target = chatId || this.mirrorTargetChat();
    if (!target) return false;
    const targetId = String(target);
    if (this.mirror.active && this.mirror.chatId === targetId && this.mirror.messageId) return true;
    if (this.mirror.ensuring && this.mirror.ensuring.chatId === targetId) {
      return this.mirror.ensuring.promise;
    }
    const promise = (async () => {
      if (this.mirror.active) {
        this.stopMirrorTyping();
        this.clearMirrorFinalize();
      }
      this.mirror.active = true;
      this.mirror.chatId = targetId;
      this.mirror.messageId = null;
      this.mirror.text = "";
      this.mirror.lastEdit = 0;
      this.mirror.editing = false;
      this.mirror.dirty = false;
      try {
        const placeholder = await this.api.sendMessage(targetId, t(this.lang, "processing"), {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: t(this.lang, "btnStop"), callback_data: "stop" }]],
          },
        });
        this.mirror.messageId = placeholder.message_id;
        this.startMirrorTyping(targetId);
        return true;
      } catch (err) {
        logger.warn("تيليجرام: تعذّر إنشاء رسالة المزامنة:", err?.message || err);
        this.mirror.active = false;
        this.mirror.chatId = null;
        return false;
      }
    })();
    this.mirror.ensuring = { chatId: targetId, promise };
    try {
      return await promise;
    } finally {
      if (this.mirror.ensuring?.promise === promise) this.mirror.ensuring = null;
    }
  }

  startMirrorTyping(chatId) {
    this.stopMirrorTyping();
    this.mirror.typingTimer = setInterval(() => {
      this.api.sendChatAction(chatId, "typing").catch(() => undefined);
    }, 4000);
    this.api.sendChatAction(chatId, "typing").catch(() => undefined);
  }

  stopMirrorTyping() {
    if (this.mirror.typingTimer) clearInterval(this.mirror.typingTimer);
    this.mirror.typingTimer = null;
  }

  clearMirrorFinalize() {
    if (this.mirror.finalizeTimer) clearTimeout(this.mirror.finalizeTimer);
    this.mirror.finalizeTimer = null;
  }

  scheduleMirrorFinalize() {
    this.clearMirrorFinalize();
    this.mirror.finalizeTimer = setTimeout(() => {
      this.finalizeMirror().catch((err) =>
        logger.warn("تيليجرام: إنهاء المزامنة:", err?.message || err),
      );
    }, 1600);
  }

  scheduleMirrorEdit() {
    if (!this.mirror.active || !this.mirror.messageId) return;
    const now = Date.now();
    const elapsed = now - this.mirror.lastEdit;
    const wait = Math.max(0, config.telegram.streamThrottleMs - elapsed);
    setTimeout(() => {
      this.mirror.lastEdit = Date.now();
      this.editMirror(false).catch(() => undefined);
    }, wait);
  }

  async editMirror(final = false) {
    if (!this.mirror.active || !this.mirror.messageId || !this.mirror.chatId) return;
    if (this.mirror.editing) {
      this.mirror.dirty = true;
      return;
    }
    this.mirror.editing = true;
    try {
      do {
        this.mirror.dirty = false;
        const display = this.mirror.text.trim() || t(this.lang, "processing");
        const [first, ...rest] = toTelegramMessages(display, config.telegram.maxMessageLength);
        const keyboard = final
          ? this.mainKeyboard()
          : { inline_keyboard: [[{ text: t(this.lang, "btnStop"), callback_data: "stop" }]] };
        try {
          await this.api.editMessageText(this.mirror.chatId, this.mirror.messageId, first || "…", {
            parse_mode: "HTML",
            reply_markup: keyboard,
            disable_web_page_preview: true,
          });
        } catch (err) {
          if (!/not modified/i.test(err?.message || "")) {
            logger.debug("تيليجرام مزامنة تعديل:", err?.message || err);
          }
        }
        if (final) {
          for (const chunk of rest) {
            await this.api
              .sendMessage(this.mirror.chatId, chunk, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
              })
              .catch(() => undefined);
          }
        }
      } while (this.mirror.dirty);
    } finally {
      this.mirror.editing = false;
    }
  }

  async finalizeMirror() {
    if (!this.mirror.active) return;
    this.clearMirrorFinalize();
    this.mirror.text = this.mirror.text.trim() || t(this.lang, "done");
    await this.editMirror(true);
    this.stopMirrorTyping();
    this.mirror.active = false;
    this.mirror.chatId = null;
    this.mirror.messageId = null;
    this.mirror.text = "";
    this.mirror.editing = false;
    this.mirror.dirty = false;
  }

  async handleSharedEvent(event, conversation = null) {
    if (!config.syncWebTelegram || !config.sharedSessionId) return;
    // C1: حوارات الامتدادات (موافقة الأدوات) لا تُكتَم أبداً — قبل منطق الكتم.
    if (event?.type === "extension_ui") return this.handleExtensionUi(event, conversation);
    // أول رد يفوز: إن حُسم الحوار من الويب نُغلق رسالة تيليجرام بنفس النتيجة.
    if (event?.type === "extension_ui_resolved") return this.handleUiResolved(event);
    // D1: وضعا final/compact يمرّان على المسار المكتوم، وlive يبقى كما هو.
    if (this.quietMode) return this.handleQuietEvent(event);
    const target = this.mirrorTargetChat();
    switch (event.type) {
      case "user_message": {
        this.clearMirrorFinalize();
        const source = event.source || "web";
        if (source === "telegram") {
          if (!this.mirror.active) await this.ensureMirror(target);
          return;
        }
        const label = source === "web" ? "🌐 من الويب" : "🔗 مصدر خارجي";
        if (this.mirror.active) {
          this.mirror.text += `\n\n**${label}:**\n${event.text}\n\n`;
          this.scheduleMirrorEdit();
          return;
        }
        if (!target) return;
        const header = `${label}:\n${event.text}`;
        for (const chunk of toTelegramMessages(header, config.telegram.maxMessageLength)) {
          await this.api
            .sendMessage(target, chunk, { parse_mode: "HTML", disable_web_page_preview: true })
            .catch(() => undefined);
        }
        await this.ensureMirror(target);
        return;
      }
      case "run_start":
        this.clearMirrorFinalize();
        await this.ensureMirror(target);
        return;
      case "text_delta":
        this.clearMirrorFinalize();
        if (await this.ensureMirror(target)) {
          this.mirror.text += event.delta || "";
          this.scheduleMirrorEdit();
        }
        return;
      case "tool_start": {
        this.clearMirrorFinalize();
        if (await this.ensureMirror(target)) {
          const hint = toolHint(event.name, event.args);
          const label = toolLabel(event.name, this.lang);
          this.mirror.text += `\n\n_🛠️ ${label}${hint ? `: \`${hint}\`` : "…"}_\n`;
          this.scheduleMirrorEdit();
        }
        return;
      }
      case "assistant_message":
        this.clearMirrorFinalize();
        if (event.errorMessage) {
          if (await this.ensureMirror(target)) {
            this.mirror.text += `\n\n❌ ${event.errorMessage}`;
            this.scheduleMirrorEdit();
          }
        } else if (event.text && !this.mirror.text.trim()) {
          if (await this.ensureMirror(target)) {
            this.mirror.text = event.text;
            this.scheduleMirrorEdit();
          }
        }
        return;
      case "error":
        this.clearMirrorFinalize();
        if (await this.ensureMirror(target)) {
          this.mirror.text += `\n\n❌ ${event.message}`;
          this.scheduleMirrorEdit();
        }
        return;
      case "compaction_start":
        if (await this.ensureMirror(target)) {
          this.mirror.text += "\n\n_🗜️ جارٍ ضغط السياق…_";
          this.scheduleMirrorEdit();
        }
        return;
      case "compaction_end":
        if (await this.ensureMirror(target)) {
          this.mirror.text += event.aborted ? "\n\n_أُلغي ضغط السياق_" : "\n\n_✅ تم ضغط السياق_";
          this.scheduleMirrorEdit();
        }
        return;
      case "retry":
        if (await this.ensureMirror(target)) {
          this.mirror.text += `\n\n_↻ إعادة المحاولة ${event.attempt}/${event.maxAttempts}…_`;
          this.scheduleMirrorEdit();
        }
        return;
      case "retry_end":
        if (!event.success && (await this.ensureMirror(target))) {
          this.mirror.text += `\n\n❌ ${event.finalError || "فشلت إعادة المحاولة"}`;
          this.scheduleMirrorEdit();
        }
        return;
      case "settled":
        this.scheduleMirrorFinalize();
        return;
      default:
        return;
    }
  }

  // ===== D1: وضع «الرسالة النهائية فقط» / «سطر تقدّم قصير» =====

  runStatePath() {
    return join(config.dataDir, "run-state.json");
  }

  /** حفظ حالة التشغيل لتكتشفها الدورة الجديدة عند انقطاع الخادم. */
  saveRunState() {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(
        this.runStatePath(),
        JSON.stringify(
          { chatId: this.quiet.chatId, startedAt: this.quiet.startedAt, steps: this.quiet.steps },
          null,
          2,
        ),
      );
    } catch (err) {
      logger.warn("تيليجرام: تعذّر حفظ run-state:", err?.message || err);
    }
  }

  clearRunState() {
    try {
      rmSync(this.runStatePath(), { force: true });
    } catch {
      /* تجاهل */
    }
  }

  /** عند الإقلاع: إن وُجدت مهمة معلّقة أبلغ مرة واحدة ثم احذف الملف. */
  async checkInterruptedRun() {
    let raw;
    try {
      raw = readFileSync(this.runStatePath(), "utf8");
    } catch {
      return;
    }
    let state = null;
    try {
      state = JSON.parse(raw);
    } catch {
      this.clearRunState();
      return;
    }
    const chatId = String(state?.chatId || this.mirrorTargetChat() || "");
    this.clearRunState();
    if (!chatId) return;
    const text = t(this.lang, "interrupted", {
      time: formatClock(state?.startedAt),
      steps: Number(state?.steps) || 0,
    });
    await this.api
      .sendMessage(chatId, text, { parse_mode: "HTML", disable_web_page_preview: true })
      .catch(() => undefined);
    logger.warn("تيليجرام: أُبلغ عن مهمة انقطعت سابقاً.");
  }

  resetQuiet() {
    const q = this.quiet;
    if (q.timer) clearInterval(q.timer);
    if (q.renderTimer) clearTimeout(q.renderTimer);
    q.active = false;
    q.chatId = null;
    q.messageId = null;
    q.startedAt = 0;
    q.steps = 0;
    q.lastText = "";
    q.error = null;
    q.aborted = false;
    q.timer = null;
    q.renderTimer = null;
    q.lines = [];
    q.rendered = "";
    q.rendering = false;
    q.pendingText = null;
    q.lastRenderAt = 0;
  }

  /** بدء التشغيل: رسالة واحدة فقط «⏳ جارٍ العمل…» مع زر إيقاف. */
  async startQuietRun(chatId) {
    this.clearMirrorFinalize();
    this.stopMirrorTyping();
    this.resetQuiet();
    if (!chatId) return false;
    const q = this.quiet;
    q.active = true;
    q.chatId = String(chatId);
    q.startedAt = Date.now();
    try {
      const message = await this.api.sendMessage(q.chatId, t(this.lang, "finalRunning"), {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[{ text: t(this.lang, "btnStop"), callback_data: "stop" }]],
        },
      });
      q.messageId = message?.message_id ?? null;
    } catch (err) {
      logger.warn("تيليجرام: تعذّر إنشاء رسالة التشغيل:", err?.message || err);
      q.active = false;
      q.chatId = null;
      return false;
    }
    this.saveRunState();
    // في وضع final: تعديل واحد كل 45 ثانية لإظهار المدة فقط.
    q.timer = setInterval(() => {
      this.quietTick().catch(() => undefined);
    }, QUIET_PROGRESS_MS);
    q.timer.unref?.();
    return true;
  }

  async quietTick() {
    const q = this.quiet;
    if (!q.active || !q.messageId) return;
    if (this.notifyMode !== "final") return;
    const elapsed = formatDuration(Date.now() - q.startedAt);
    await this.renderQuiet(t(this.lang, "finalRunningElapsed", { duration: elapsed }));
  }

  /** تعديل واحد متسلسل (حلقة قصيرة) لرسالة التشغيل. */
  async renderQuiet(text) {
    const q = this.quiet;
    if (!q.active || !q.messageId || !q.chatId) return;
    q.pendingText = text;
    if (q.rendering) return;
    q.rendering = true;
    try {
      while (q.active && q.pendingText) {
        const next = q.pendingText;
        q.pendingText = null;
        if (next === q.rendered) continue;
        q.rendered = next;
        try {
          await this.api.editMessageText(q.chatId, q.messageId, next, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[{ text: t(this.lang, "btnStop"), callback_data: "stop" }]],
            },
          });
        } catch (err) {
          if (!/not modified/i.test(err?.message || "")) {
            logger.debug("تيليجرام تعديل التشغيل:", err?.message || err);
          }
        }
      }
    } finally {
      q.rendering = false;
    }
  }

  compactText() {
    return this.quiet.lines.slice(-COMPACT_MAX_LINES).join("\n") || t(this.lang, "finalRunning");
  }

  scheduleCompactRender() {
    const q = this.quiet;
    if (!q.active) return;
    this.saveRunState();
    // لا نلغي المؤقت المعلّق: عند انتهائه سيقرأ آخر الأسطر (leading + trailing).
    if (q.renderTimer) return;
    const wait = Math.max(0, config.telegram.streamThrottleMs - (Date.now() - q.lastRenderAt));
    q.renderTimer = setTimeout(() => {
      q.renderTimer = null;
      q.lastRenderAt = Date.now();
      this.renderQuiet(this.compactText()).catch(() => undefined);
    }, wait);
    q.renderTimer.unref?.();
  }

  /** معالجة الأحداث في الوضع المكتوم: لا يُرسل شيء حتى settled. */
  async handleQuietEvent(event) {
    const q = this.quiet;
    switch (event.type) {
      case "run_start":
        await this.startQuietRun(this.mirrorTargetChat());
        return;
      case "tool_start":
        if (!q.active) return;
        q.steps += 1;
        if (this.notifyMode === "compact") {
          q.lines.push(t(this.lang, "progressStep", { n: q.steps, tool: event.name }));
          if (q.lines.length > COMPACT_MAX_LINES) q.lines = q.lines.slice(-COMPACT_MAX_LINES);
          this.scheduleCompactRender();
        } else {
          this.saveRunState();
        }
        return;
      case "assistant_message":
        if (!q.active) return;
        if (event.errorMessage) q.error = event.errorMessage;
        else if (event.text) q.lastText = event.text;
        return;
      case "error":
        if (q.active) q.error = event.message || q.error;
        return;
      case "retry_end":
        // خطأ وسيط: يُحتفظ به كسطر واحد فقط يُعرض إن فشلت المهمة.
        if (q.active && !event.success) q.error = event.finalError || q.error;
        return;
      case "settled":
        await this.finishQuiet(!!event.aborted);
        return;
      default:
        // text_delta / tool_update / retry / compaction_* / user_message … مكتومة.
        return;
    }
  }

  /** عند settled: تعديل نفس الرسالة برسالة نهائية واحدة. */
  async finishQuiet(aborted) {
    const q = this.quiet;
    if (!q.active) {
      this.clearRunState();
      return;
    }
    const chatId = q.chatId;
    const messageId = q.messageId;
    const duration = formatDuration(Date.now() - q.startedAt);
    const steps = q.steps;
    const wasAborted = aborted || q.aborted;
    const error = q.error;
    const failed = !wasAborted && !!error;
    const body = (q.lastText || "").trim();

    const header = [
      `<b>${t(this.lang, wasAborted ? "finalAborted" : failed ? "finalFailed" : "finalDone")}</b>`,
      `${t(this.lang, "finalDuration")}: <code>${duration}</code> · ${t(this.lang, "finalSteps")}: <code>${steps}</code>`,
    ];
    if (failed) {
      const errText = String(error);
      const clipped =
        errText.length > ERROR_LINE_LIMIT ? `${errText.slice(0, ERROR_LINE_LIMIT)}…` : errText;
      header.push(`${t(this.lang, "finalErrorLine")}: ${escapeHtml(clipped)}`);
    }
    let text = header.join("\n");
    if (body) {
      const clipped =
        body.length > FINAL_TEXT_LIMIT
          ? `${body.slice(0, FINAL_TEXT_LIMIT)}\n… (${t(this.lang, "finalTruncated")})`
          : body;
      text += `\n\n${escapeHtml(clipped)}`;
    }
    text = truncateHtml(text, config.telegram.maxMessageLength);

    // إعادة تعيين قبل الإرسال: يمنع أي تكرار إن ورد settled آخر.
    if (q.timer) clearInterval(q.timer);
    if (q.renderTimer) clearTimeout(q.renderTimer);
    q.active = false;
    q.pendingText = null;
    this.clearRunState();

    if (chatId && messageId) {
      try {
        await this.api.editMessageText(chatId, messageId, text, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: this.mainKeyboard(),
        });
      } catch (err) {
        if (!/not modified/i.test(err?.message || "")) {
          // فشل التعديل: إرسال الرسالة النهائية مرة واحدة كحل أخير.
          await this.api
            .sendMessage(chatId, text, {
              parse_mode: "HTML",
              disable_web_page_preview: true,
              reply_markup: this.mainKeyboard(),
            })
            .catch(() => undefined);
        }
      }
    }
    this.resetQuiet();
  }

  // ===== C1: حوارات الامتدادات (موافقة الأدوات وغيرها) =====

  /** ترويسة HTML موحّدة لحوار امتداد (title + message). */
  #uiHeader(event) {
    const parts = [];
    if (event.title) parts.push(escapeHtml(String(event.title)));
    if (event.message) parts.push(escapeHtml(String(event.message)));
    return parts.join("\n\n");
  }

  #newPending(event, conversation, chatId, header) {
    const entry = {
      requestId: event.requestId,
      chatId: chatId ? String(chatId) : null,
      messageId: null,
      conv: conversation,
      method: event.method,
      header: header || "",
      options: [],
      timer: null,
    };
    this.pendingUI.set(event.requestId, entry);
    return entry;
  }

  /** تنبيه مشروط: حوار بلا هدف تيليجرام تُرك لقناة أخرى (مرة كل 60 ثانية). */
  #logNoTargetOnce() {
    const now = Date.now();
    if (now - this.noTargetWarnAt < 60_000) return;
    this.noTargetWarnAt = now;
    logger.info("تيليجرام: لا محادثة مرتبطة — تُرك الحوار لقناة أخرى");
  }

  /** سجل تشخيصي لقرار الحوار — مرة واحدة فقط لكل حوار. */
  #logDecision(entry, decision) {
    if (!entry || entry.decisionLogged) return;
    entry.decisionLogged = true;
    logger.info("تيليجرام: قرار حوار", { requestId: entry.requestId, decision });
  }

  /** إزالة حوار معلّق من الخرائط وإيقاف مؤقته. */
  #clearPending(entry) {
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (this.pendingUI.get(entry.requestId) === entry) this.pendingUI.delete(entry.requestId);
    const key = entry.chatId ? String(entry.chatId) : null;
    if (key && this.pendingInput.get(key) === entry) this.pendingInput.delete(key);
  }

  /** إلغاء كل الحوارات المعلّقة (يُنبَّه الخادم كي لا تتعلّق الأداة). */
  cancelPendingDialogs() {
    const entries = [...this.pendingUI.values()];
    for (const entry of entries) {
      this.#logDecision(entry, "cancelled");
      this.#clearPending(entry);
      if (!entry.requestId) continue;
      try {
        Promise.resolve(entry.conv?.respondExtensionUI?.(entry.requestId, { cancelled: true })).catch(
          () => undefined,
        );
      } catch {
        /* تجاهل */
      }
    }
    this.pendingUI.clear();
    this.pendingInput.clear();
  }

  /** تسجيل مؤقت المهلة: يعدّل الرسالة ويمسح الأزرار دون رد إلى الخادم. */
  #armTimeout(event, entry) {
    const timeout = Number(event.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) return;
    entry.timer = setTimeout(() => {
      this.#expireDialog(entry).catch(() => undefined);
    }, Math.min(timeout, 24 * 60 * 60 * 1000));
    entry.timer.unref?.();
  }

  async #expireDialog(entry) {
    if (this.pendingUI.get(entry.requestId) !== entry) return;
    this.#logDecision(entry, "timeout");
    this.#clearPending(entry);
    if (!entry.chatId || !entry.messageId) return;
    const text = truncateHtml(
      `${entry.header}\n\n<i>${t(this.lang, "uiTimedOut")}</i>`,
      config.telegram.maxMessageLength,
    );
    await this.api
      .editMessageText(entry.chatId, entry.messageId, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => undefined);
  }

  /** إرسال رسالة الحوار؛ عند الفشل يُلغى الطلب بدل تعليق الأداة. */
  async #sendDialog(entry, text, keyboard) {
    try {
      const message = await this.api.sendMessage(entry.chatId, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      entry.messageId = message?.message_id ?? null;
      return true;
    } catch (err) {
      logger.warn("تيليجرام: تعذّر إرسال حوار الامتداد:", err?.message || err);
      this.#logDecision(entry, "send-failed");
      this.#clearPending(entry);
      try {
        await Promise.resolve(
          entry.conv?.respondExtensionUI?.(entry.requestId, { cancelled: true }),
        );
      } catch {
        /* تجاهل */
      }
      return false;
    }
  }

  /** حوار select: الترويسة + الخيارات + أزرار inline. */
  async #askSelect(event, conversation, chatId) {
    const options = (Array.isArray(event.options) ? event.options : []).map((opt) => String(opt));
    const entry = this.#newPending(event, conversation, chatId, "");
    if (!options.length) {
      this.#clearPending(entry);
      await Promise.resolve(
        conversation?.respondExtensionUI?.(event.requestId, { cancelled: true }),
      ).catch(() => undefined);
      return;
    }
    entry.options = options;
    const blocks = [this.#uiHeader(event)];
    blocks.push(options.map((opt, i) => `${i + 1}. ${escapeHtml(opt)}`).join("\n"));
    entry.header = truncateHtml(
      blocks.filter(Boolean).join("\n\n"),
      config.telegram.maxMessageLength,
    );
    const rows = options.map((opt, i) => [
      { text: opt.length > 60 ? `${opt.slice(0, 57)}…` : opt, callback_data: `ui:${event.requestId}:${i}` },
    ]);
    entry.method = "select";
    if (!(await this.#sendDialog(entry, entry.header, { inline_keyboard: rows }))) return;
    this.#armTimeout(event, entry);
  }

  /** حوار confirm: زرّا نعم/لا. */
  async #askConfirm(event, conversation, chatId) {
    const entry = this.#newPending(event, conversation, chatId, "");
    entry.header = truncateHtml(
      this.#uiHeader(event) || t(this.lang, "uiConfirmTitle"),
      config.telegram.maxMessageLength,
    );
    entry.method = "confirm";
    const keyboard = {
      inline_keyboard: [
        [
          { text: t(this.lang, "uiYes"), callback_data: `ui:${event.requestId}:y` },
          { text: t(this.lang, "uiNo"), callback_data: `ui:${event.requestId}:n` },
        ],
      ],
    };
    if (!(await this.#sendDialog(entry, entry.header, keyboard))) return;
    this.#armTimeout(event, entry);
  }

  /** حوارا input/editor: ننتظر الرسالة النصية التالية من نفس المحادثة. */
  async #askInput(event, conversation, chatId) {
    const entry = this.#newPending(event, conversation, chatId, "");
    entry.method = event.method;
    const blocks = [this.#uiHeader(event)];
    if (event.prefill) blocks.push(`<pre>${escapeHtml(String(event.prefill))}</pre>`);
    blocks.push(`<i>${t(this.lang, "uiInputHint")}</i>`);
    entry.header = truncateHtml(
      blocks.filter(Boolean).join("\n\n"),
      config.telegram.maxMessageLength,
    );
    this.pendingInput.set(String(chatId), entry);
    if (!(await this.#sendDialog(entry, entry.header, null))) return;
    this.#armTimeout(event, entry);
  }

  /** إغلاق رسالة تيليجرام عندما يحسم الويب (أو قناة أخرى) الحوار. */
  async handleUiResolved(event) {
    const requestId = event?.requestId;
    if (!requestId) return;
    const entry = this.pendingUI.get(requestId);
    if (!entry) return;
    this.#clearPending(entry);
    // تيليجرام نفسه يُعدّل رسالته عند الحسم من أزراره.
    if (event.source === "telegram") return;
    const origin = event.source === "web" ? "الويب" : "قناة أخرى";
    const decision = event.decision ? `✅ ${escapeHtml(String(event.decision))}` : "✅ تم الحسم";
    this.#logDecision(entry, `resolved-by-${event.source || "other"}`);
    if (!entry.messageId || entry.chatId == null) return;
    const body = truncateHtml(
      `${entry.header}\n\n<b>${decision}</b>\n<i>تم الرد من ${origin}</i>`,
      config.telegram.maxMessageLength,
    );
    await this.api
      .editMessageText(entry.chatId, entry.messageId, body, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => undefined);
  }

  /** تشخيص الربط: يعرض معرّفات المحادثة وهل هي هدف المزامنة. */
  async cmdWhoami(message) {
    const chat = message.chat || {};
    const from = message.from || {};
    const isTarget = String(chat.id) === String(this.primaryChatId || "");
    const text = [
      "🪪 <b>بيانات هذه المحادثة</b>",
      `• chat_id: <code>${escapeHtml(String(chat.id ?? "—"))}</code>`,
      `• النوع: <code>${escapeHtml(String(chat.type || "—"))}</code>`,
      `• user_id: <code>${escapeHtml(String(from.id ?? "—"))}</code>`,
      `• هدف مزامنة الويب: <b>${isTarget ? "نعم ✅" : "لا"}</b>`,
      `• مزامنة الجلسة: <b>${config.syncWebTelegram ? "مفعّلة" : "معطّلة"}</b>`,
      `• الجلسة: <code>${escapeHtml(String(config.sharedSessionId || "—"))}</code>`,
      `• وضع الإشعارات: <code>${escapeHtml(this.notifyMode)}</code>`,
    ].join("\n");
    await this.api.sendMessage(chat.id, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: this.mainKeyboard(),
    });
  }

  /** معالج حدث extension_ui القادم من المحادثة. */
  async handleExtensionUi(event, conversation = null) {
    const chatId = this.mirrorTargetChat();
    const conv = conversation || (chatId ? this.#conversation(chatId) : null);

    if (event.method === "notify") {
      // في وضع final تمرّ إشعارات info فقط بصمت؛ غيرها يُرسل دائماً.
      if (event.notifyType === "info" && this.notifyMode === "final") return;
      if (!chatId) return;
      const body = this.#uiHeader(event);
      if (!body) return;
      const icon =
        event.notifyType === "error" ? "❌ " : event.notifyType === "warning" ? "⚠️ " : "ℹ️ ";
      await this.api
        .sendMessage(chatId, truncateHtml(`${icon}${body}`, config.telegram.maxMessageLength), {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        })
        .catch(() => undefined);
      return;
    }

    // setStatus / setWidget / setTitle / set_editor_text: تُتجاهل بصمت.
    if (!["select", "confirm", "input", "editor"].includes(event.method)) return;

    // لا هدف تيليجرام (تشغيل من المتصفح فقط): لا نُلغِ الطلب — نتركه لقناة أخرى.
    if (!chatId) {
      this.#logNoTargetOnce();
      return;
    }

    // هدف موجود لكن لا محادثة: ألغِ الطلب كي لا تتوقف الأداة 120 ثانية.
    if (!conv) {
      try {
        await Promise.resolve(conv?.respondExtensionUI?.(event.requestId, { cancelled: true }));
      } catch {
        /* تجاهل */
      }
      return;
    }

    switch (event.method) {
      case "select":
        return this.#askSelect(event, conv, chatId);
      case "confirm":
        return this.#askConfirm(event, conv, chatId);
      case "input":
      case "editor":
        return this.#askInput(event, conv, chatId);
      default:
        return;
    }
  }

  /** هل هذه الرسالة رد على حوار input/editor معلّق؟ */
  async answerPendingInput(chatId, text) {
    const entry = this.pendingInput.get(String(chatId));
    if (!entry) return false;
    this.#clearPending(entry);
    const conv = entry.conv || this.#conversation(chatId);
    try {
      await conv.respondExtensionUI(entry.requestId, { value: text }, { source: "telegram" });
    } catch (err) {
      logger.warn("تيليجرام: تعذّر إرسال رد الحوار:", err?.message || err);
    }
    this.#logDecision(entry, "input");
    if (entry.messageId && entry.chatId) {
      const suffix = text.length > 200 ? `${text.slice(0, 197)}…` : text;
      const body = truncateHtml(
        `${entry.header}\n\n<b>➡️ ${escapeHtml(suffix)}</b>`,
        config.telegram.maxMessageLength,
      );
      await this.api
        .editMessageText(entry.chatId, entry.messageId, body, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => undefined);
    }
    return true;
  }

  /** أزرار حوارات الامتدادات (ui:<requestId>:<payload>). */
  async handleUiCallback(query) {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const data = query.data || "";
    const parts = data.split(":");
    const requestId = parts[1];
    const raw = parts.slice(2).join(":");
    try {
      const entry = this.pendingUI.get(requestId);
      if (!entry) return; // نقر مكرّر أو حوار منتهٍ/منتهي المهلة.
      const conv = entry.conv || (chatId ? this.#conversation(chatId) : null);
      let payload;
      let decision;
      if (entry.method === "confirm") {
        const confirmed = raw === "y";
        payload = { confirmed };
        decision = t(this.lang, confirmed ? "uiAllowed" : "uiRejected");
      } else {
        const index = Number.parseInt(raw, 10);
        const choice = Number.isInteger(index) ? entry.options[index] : undefined;
        if (choice === undefined) return;
        payload = { value: choice };
        decision = escapeHtml(choice);
      }
      this.#clearPending(entry);
      this.#logDecision(
        entry,
        entry.method === "confirm" ? (payload.confirmed ? "allowed" : "rejected") : "selected",
      );
      await conv.respondExtensionUI(requestId, payload, { source: "telegram" });
      const targetChat = chatId ?? entry.chatId;
      if (messageId && targetChat != null) {
        const body = truncateHtml(
          `${entry.header}\n\n<b>${decision}</b>`,
          config.telegram.maxMessageLength,
        );
        await this.api
          .editMessageText(targetChat, messageId, body, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => undefined);
      }
    } finally {
      await this.api.answerCallbackQuery(query.id).catch(() => undefined);
    }
  }

  #isAuthorized(update) {
    const from = update.message?.from || update.callback_query?.from;
    if (!from) return false;
    const userId = String(from.id);
    const chatId = String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? "");
    const { allowedUsers, allowedChats } = config.telegram;
    // fail-closed: قوائم فارغة = رفض الجميع (السلوك السابق كان يسمح للجميع بلا قيد)
    if (!allowedUsers.length && !allowedChats.length) {
      logger.warn("تيليجرام: لا توجد قوائم تفويض — رفض الطلب (fail-closed). اضبط TELEGRAM_ALLOWED_USERS في .env");
      return false;
    }
    if (allowedUsers.length && !allowedUsers.includes(userId)) return false;
    if (allowedChats.length && !allowedChats.includes(chatId)) return false;
    return true;
  }

  async start() {
    if (!this.enabled) {
      logger.info("تيليجرام: معطّل أو لا يوجد توكن.");
      return;
    }
    await this.api.getMe().then((me) => logger.ok(`تيليجرام: متصل كـ @${me.username}`));
    this.bindSharedMirror();
    if (config.syncWebTelegram && !this.mirrorTargetChat()) {
      logger.warn(
        "تيليجرام: لا توجد محادثة هدف بعد — أرسل /start أو /whoami إلى البوت مرة واحدة لتثبيت المزامنة.",
      );
    }
    // D1: watchdog — إن كانت هناك مهمة معلّقة من دورة سابقة أبلغ ثم امسح الملف.
    await this.checkInterruptedRun().catch(() => undefined);
    await this.api
      .setMyCommands([
        { command: "start", description: "بدء المحادثة" },
        { command: "new", description: "جلسة جديدة" },
        { command: "model", description: "اختيار النموذج" },
        { command: "think", description: "مستوى التفكير" },
        { command: "status", description: "حالة الجلسة" },
        { command: "stop", description: "إيقاف التوليد" },
        { command: "compact", description: "ضغط السياق" },
        { command: "restart", description: "إعادة تشغيل الخادم" },
        { command: "help", description: "المساعدة" },
      ])
      .catch(() => undefined);
    this.running = true;
    this.pollLoop();
    logger.ok("تيليجرام: بدأ الاستقبال.");
  }

  stop() {
    this.running = false;
    this.sharedUnsubscribe?.();
    this.sharedUnsubscribe = null;
    this.clearMirrorFinalize();
    this.stopMirrorTyping();
    this.mirror.active = false;
    // C1: تيليجرام بلا WS — نلغي الحوارات المعلّقة بأنفسنا عند الإيقاف.
    this.cancelPendingDialogs();
    // D1: إيقاف مؤقتات الوضع المكتوم.
    if (this.quiet.timer) clearInterval(this.quiet.timer);
    if (this.quiet.renderTimer) clearTimeout(this.quiet.renderTimer);
    this.quiet.timer = null;
    this.quiet.renderTimer = null;
    this.quiet.active = false;
  }

  async pollLoop() {
    while (this.running) {
      try {
        const updates = await this.api.getUpdates({
          offset: this.offset,
          timeout: config.telegram.pollTimeout,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update).catch((err) =>
            logger.error("تيليجرام: خطأ في معالجة التحديث:", err?.message || err),
          );
        }
      } catch (err) {
        if (err instanceof TelegramError && err.retryAfter) {
          await sleep((err.retryAfter + 1) * 1000);
        } else {
          logger.warn("تيليجرام: انقطاع مؤقت، إعادة المحاولة:", err?.message || err);
          await sleep(3000);
        }
      }
    }
  }

  async handleUpdate(update) {
    if (!this.#isAuthorized(update)) {
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (chatId) await this.api.sendMessage(chatId, t(this.lang, "unauthorized")).catch(() => undefined);
      if (update.callback_query) {
        await this.api.answerCallbackQuery(update.callback_query.id).catch(() => undefined);
      }
      return;
    }
    this.#setPrimaryChat(
      update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? null,
      update.message?.chat?.type ?? update.callback_query?.message?.chat?.type ?? null,
    );
    if (update.callback_query) return this.handleCallback(update.callback_query);
    if (update.message) return this.handleMessage(update.message);
  }

  // ===== الرسائل النصية =====

  async handleMessage(message) {
    const chatId = message.chat.id;
    const text = (message.text || message.caption || "").trim();
    if (!text) return;

    const command = text.split(/\s+/)[0].toLowerCase().split("@")[0];
    switch (command) {
      case "/start":
        return this.sendMenu(chatId, t(this.lang, "welcome"));
      case "/help":
        return this.sendMenu(chatId, t(this.lang, "help"));
      case "/menu":
        return this.sendMenu(chatId);
      case "/new":
        return this.cmdNew(chatId);
      case "/model":
        return this.showModels(chatId);
      case "/think":
        return this.showThinking(chatId);
      case "/status":
        return this.cmdStatus(chatId);
      case "/stop":
        return this.cmdStop(chatId);
      case "/compact":
        return this.cmdCompact(chatId);
      case "/sessions":
        return this.showSessions(chatId);
      case "/whoami":
        return this.cmdWhoami(message);
      case "/mode":
        return this.cmdMode(chatId, text.split(/\s+/)[1]);
      case "/ping":
        return this.api.sendMessage(chatId, "🏓 pong");
      case "/restart":
        return this.cmdRestart(chatId);
      default: {
        // C1: رسالة نصية أثناء حوار input/editor = رد على الحوار، لا prompt جديد.
        if (await this.answerPendingInput(chatId, text)) return;
        return this.promptChat(chatId, text);
      }
    }
  }

  mainKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: t(this.lang, "btnNew"), callback_data: "new" },
          { text: t(this.lang, "btnModel"), callback_data: "model" },
        ],
        [
          { text: t(this.lang, "btnThink"), callback_data: "think" },
          { text: t(this.lang, "btnStatus"), callback_data: "status" },
        ],
        [
          { text: t(this.lang, "btnSessions"), callback_data: "sessions" },
          { text: t(this.lang, "btnHelp"), callback_data: "help" },
        ],
        [{ text: t(this.lang, "btnRestart"), callback_data: "restart" }],
      ],
    };
  }

  async sendMenu(chatId, text) {
    await this.api.sendMessage(chatId, text || t(this.lang, "welcome"), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: this.mainKeyboard(),
    });
  }

  // ===== الأوامر =====

  async cmdNew(chatId) {
    const conv = this.#conversation(chatId);
    if (conv.isBusy) {
      await this.api.sendMessage(chatId, "⏳ انتظر انتهاء المهمة الحالية أو أرسل /stop.");
      return;
    }
    await conv.newSession();
    await this.api.sendMessage(chatId, t(this.lang, "newSession"), {
      parse_mode: "HTML",
      reply_markup: this.mainKeyboard(),
    });
  }

  async cmdStatus(chatId) {
    const conv = this.#conversation(chatId);
    const state = conv.getState();
    const tools = state.toolNames.slice(0, 12).join(", ") || "—";
    const text =
      `${t(this.lang, "statusTitle")}\n\n` +
      `🧩 <b>${t(this.lang, "statusModel")}:</b> <code>${escapeHtml(state.provider)}/${escapeHtml(state.model)}</code>\n` +
      `🧠 <b>${t(this.lang, "statusThinking")}:</b> ${escapeHtml(thinkingLabel(this.lang, state.thinking))}\n` +
      `🤖 <b>الوكيل:</b> ${escapeHtml(state.agent?.name || "—")}\n` +
      `💬 <b>${t(this.lang, "statusMessages")}:</b> ${state.messageCount}\n` +
      `🛠️ <b>${t(this.lang, "statusTools")}:</b> <code>${escapeHtml(tools)}</code>` +
      (config.syncWebTelegram ? `\n🔗 <b>الجلسة:</b> مشتركة مع الويب` : "");
    await this.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: this.mainKeyboard(),
    });
  }

  async cmdStop(chatId) {
    const conv = this.#conversation(chatId);
    const stopped = await conv.abort();
    // في وضع الكتم: الرسالة النهائية وحدها تُعلن الإيقاف (لا رسالة إضافية).
    if (stopped && this.quietMode && this.quiet.active) {
      this.quiet.aborted = true;
      return;
    }
    await this.api.sendMessage(chatId, stopped ? t(this.lang, "aborted") : t(this.lang, "nothingToStop"), {
      parse_mode: "HTML",
    });
  }

  async cmdRestart(chatId) {
    if (!this.onRestart || !config.supervised) {
      await this.api.sendMessage(chatId, t(this.lang, "restartUnsupported"), { parse_mode: "HTML" });
      return;
    }
    await this.api.sendMessage(chatId, t(this.lang, "restartConfirm"), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: t(this.lang, "restartYes"), callback_data: "restart_yes" }],
          [{ text: t(this.lang, "restartNo"), callback_data: "menu" }],
        ],
      },
    });
  }

  async cmdCompact(chatId) {
    const conv = this.#conversation(chatId);
    const status = await this.api.sendMessage(chatId, t(this.lang, "compacting"));
    try {
      await conv.compact();
      await this.api.editMessageText(chatId, status.message_id, t(this.lang, "compacted"), { parse_mode: "HTML" });
    } catch (err) {
      await this.api
        .editMessageText(chatId, status.message_id, `❌ ${escapeHtml(err?.message || String(err))}`, {
          parse_mode: "HTML",
        })
        .catch(() => undefined);
    }
  }

  async showThinking(chatId, editMessageId) {
    const conv = this.#conversation(chatId);
    const levels = conv.session?.getAvailableThinkingLevels?.() || ["off", "low", "medium", "high"];
    const current = conv.getState().thinking;
    const rows = levels.map((level) => [
      {
        text: `${level === current ? "✅ " : ""}${thinkingLabel(this.lang, level)}`,
        callback_data: `st:${level}`,
      },
    ]);
    rows.push([{ text: t(this.lang, "backToMenu"), callback_data: "menu" }]);
    const text = t(this.lang, "thinkingTitle");
    const keyboard = { inline_keyboard: rows };
    if (editMessageId) {
      await this.api.editMessageText(chatId, editMessageId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      await this.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: keyboard });
    }
  }

  async showModels(chatId, page = 0, editMessageId) {
    const state = this.#state(chatId);
    const models = this.manager.listModels();
    if (!models.length) {
      const text = t(this.lang, "errorNoModel");
      if (editMessageId) await this.api.editMessageText(chatId, editMessageId, text, { parse_mode: "HTML" });
      else await this.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      return;
    }
    state.modelChoices = models;
    const pages = Math.ceil(models.length / MODELS_PER_PAGE);
    const clamped = Math.max(0, Math.min(page, pages - 1));
    state.modelPage = clamped;
    const slice = models.slice(clamped * MODELS_PER_PAGE, clamped * MODELS_PER_PAGE + MODELS_PER_PAGE);

    const rows = slice.map((m, i) => {
      const index = clamped * MODELS_PER_PAGE + i;
      const label = `${m.provider} · ${m.name}`;
      return [{ text: label.length > 60 ? `${label.slice(0, 57)}…` : label, callback_data: `sm:${index}` }];
    });
    const nav = [];
    if (pages > 1) {
      nav.push({ text: t(this.lang, "prev"), callback_data: `mp:${Math.max(0, clamped - 1)}` });
      nav.push({ text: `${clamped + 1}/${pages}`, callback_data: "noop" });
      nav.push({ text: t(this.lang, "next"), callback_data: `mp:${Math.min(pages - 1, clamped + 1)}` });
      rows.push(nav);
    }
    rows.push([{ text: t(this.lang, "backToMenu"), callback_data: "menu" }]);

    const text = t(this.lang, "modelTitle");
    const keyboard = { inline_keyboard: rows };
    if (editMessageId) {
      await this.api.editMessageText(chatId, editMessageId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      await this.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: keyboard });
    }
  }

  async showSessions(chatId, page = 0, editMessageId) {
    const state = this.#state(chatId);
    const all = this.manager
      .listConversations()
      .filter((c) => c.sessionFile && (config.syncWebTelegram || c.id.startsWith("tg:")));
    if (!all.length) {
      const text = t(this.lang, "noSessions");
      if (editMessageId) await this.api.editMessageText(chatId, editMessageId, text, { parse_mode: "HTML" });
      else await this.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      return;
    }
    state.sessionChoices = all;
    const pages = Math.ceil(all.length / SESSIONS_PER_PAGE);
    const clamped = Math.max(0, Math.min(page, pages - 1));
    const slice = all.slice(clamped * SESSIONS_PER_PAGE, clamped * SESSIONS_PER_PAGE + SESSIONS_PER_PAGE);
    const rows = slice.map((c, i) => {
      const index = clamped * SESSIONS_PER_PAGE + i;
      const isShared = c.id === config.sharedSessionId;
      const title = c.title || (isShared ? "🔗 الجلسة المشتركة" : c.id);
      const label = title.length > 55 ? `${title.slice(0, 52)}…` : title;
      return [{ text: `🗂️ ${label}`, callback_data: `ss:${index}` }];
    });
    if (pages > 1) {
      rows.push([
        { text: t(this.lang, "prev"), callback_data: `sp:${Math.max(0, clamped - 1)}` },
        { text: `${clamped + 1}/${pages}`, callback_data: "noop" },
        { text: t(this.lang, "next"), callback_data: `sp:${Math.min(pages - 1, clamped + 1)}` },
      ]);
    }
    rows.push([{ text: t(this.lang, "backToMenu"), callback_data: "menu" }]);
    const text = t(this.lang, "selectSession");
    const keyboard = { inline_keyboard: rows };
    if (editMessageId) {
      await this.api.editMessageText(chatId, editMessageId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      await this.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: keyboard });
    }
  }

  // ===== أزرار callback =====

  async handleCallback(query) {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const data = query.data || "";
    // C1: أزرار حوارات الامتدادات لها الأولوية على بقية الحالات.
    if (data.startsWith("ui:")) return this.handleUiCallback(query);
    const [action, arg] = data.split(":");
    try {
      switch (action) {
        case "menu":
          await this.sendMenu(chatId);
          break;
        case "new":
          await this.cmdNew(chatId);
          break;
        case "status":
          await this.cmdStatus(chatId);
          break;
        case "help":
          await this.sendMenu(chatId, t(this.lang, "help"));
          break;
        case "stop":
          await this.cmdStop(chatId);
          break;
        case "restart":
          await this.cmdRestart(chatId);
          break;
        case "restart_yes":
          await this.api
            .sendMessage(chatId, t(this.lang, "restarting"), { parse_mode: "HTML" })
            .catch(() => undefined);
          setTimeout(() => this.onRestart?.("telegram"), 400);
          break;
        case "think":
          await this.showThinking(chatId, messageId);
          break;
        case "st": {
          const conv = this.#conversation(chatId);
          await conv.setThinking(arg);
          await this.api.sendMessage(
            chatId,
            `${t(this.lang, "thinkingSet")} <b>${escapeHtml(thinkingLabel(this.lang, arg))}</b>`,
            { parse_mode: "HTML", reply_markup: this.mainKeyboard() },
          );
          break;
        }
        case "model":
          await this.showModels(chatId, 0, messageId);
          break;
        case "mp":
          await this.showModels(chatId, Number.parseInt(arg, 10) || 0, messageId);
          break;
        case "sm": {
          const state = this.#state(chatId);
          const choice = state.modelChoices[Number.parseInt(arg, 10)];
          if (choice) {
            const conv = this.#conversation(chatId);
            await conv.setModel(choice.provider, choice.id);
            await this.api.sendMessage(
              chatId,
              `${t(this.lang, "modelSet")}: <code>${escapeHtml(choice.provider)}/${escapeHtml(choice.id)}</code>`,
              { parse_mode: "HTML", reply_markup: this.mainKeyboard() },
            );
          }
          break;
        }
        case "sessions":
          await this.showSessions(chatId, 0, messageId);
          break;
        case "sp":
          await this.showSessions(chatId, Number.parseInt(arg, 10) || 0, messageId);
          break;
        case "ss": {
          const state = this.#state(chatId);
          const choice = state.sessionChoices[Number.parseInt(arg, 10)];
          if (choice) {
            const conv = this.#conversation(chatId);
            await conv.switchSession(choice.sessionFile);
            await this.api.sendMessage(chatId, t(this.lang, "sessionSwitched"), {
              parse_mode: "HTML",
              reply_markup: this.mainKeyboard(),
            });
          }
          break;
        }
        case "noop":
        default:
          break;
      }
    } finally {
      await this.api.answerCallbackQuery(query.id).catch(() => undefined);
    }
  }

  // ===== البث المباشر للردود =====

  async promptChat(chatId, text) {
    const conv = this.#conversation(chatId);
    try {
      if (conv.isBusy) {
        await conv.prompt(text, { source: "telegram" });
        // في وضع الكتم لا نرسل إشعار «تم استلام رسالتك».
        if (!this.quietMode) {
          await this.api
            .sendMessage(chatId, "📨 تم استلام رسالتك وسأتابعها بعد إنهاء المهمة الحالية.")
            .catch(() => undefined);
        }
        return;
      }
      await conv.prompt(text, { source: "telegram" });
    } catch (err) {
      const message = err?.message || String(err);
      if (this.quietMode && this.quiet.active) {
        // في وضع الكتم: الخطأ يُذكر في الرسالة النهائية فقط.
        this.quiet.error = message;
        await this.finishQuiet(false);
        return;
      }
      await this.api
        .sendMessage(chatId, `❌ ${escapeHtml(message)}`, { parse_mode: "HTML" })
        .catch(() => undefined);
    }
  }
}

export default TelegramBot;
