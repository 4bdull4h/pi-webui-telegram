import config from "./config.js";
import logger from "./logger.js";
import { t, thinkingLabel } from "./i18n.js";
import { escapeHtml, toTelegramMessages } from "./telegram-format.js";
import { toolLabel, toolHint } from "./events.js";

const MODELS_PER_PAGE = 8;
const SESSIONS_PER_PAGE = 8;

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
    this.primaryChatId = config.telegram.allowedChats[0] || config.telegram.allowedUsers[0] || null;
  }

  get enabled() {
    return config.telegram.enabled && !!config.telegram.token;
  }

  #conversationId(chatId) {
    return config.syncWebTelegram && config.sharedSessionId
      ? config.sharedSessionId
      : `tg:${chatId}`;
  }

  #conversation(chatId) {
    return this.manager.getOrCreate(this.#conversationId(chatId));
  }

  #setPrimaryChat(chatId) {
    if (!this.primaryChatId && chatId) this.primaryChatId = String(chatId);
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
      this.handleSharedEvent(event).catch((err) =>
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

  async handleSharedEvent(event) {
    if (!config.syncWebTelegram || !config.sharedSessionId) return;
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

  #isAuthorized(update) {
    const from = update.message?.from || update.callback_query?.from;
    if (!from) return false;
    const userId = String(from.id);
    const chatId = String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? "");
    const { allowedUsers, allowedChats } = config.telegram;
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
      case "/restart":
        return this.cmdRestart(chatId);
      default:
        return this.promptChat(chatId, text);
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
        await this.api
          .sendMessage(chatId, "📨 تم استلام رسالتك وسأتابعها بعد إنهاء المهمة الحالية.")
          .catch(() => undefined);
        return;
      }
      await conv.prompt(text, { source: "telegram" });
    } catch (err) {
      await this.api
        .sendMessage(chatId, `❌ ${escapeHtml(err?.message || String(err))}`, { parse_mode: "HTML" })
        .catch(() => undefined);
    }
  }
}

export default TelegramBot;
