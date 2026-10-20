/**
 * محادثة مبنية على جسر RPC: نفس الواجهة العامة لصنف Conversation في pi-manager.js
 * لكن التوليد يحدث داخل عملية `pi --mode rpc` منفصلة.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import config from "../config.js";
import logger from "../logger.js";
import { transcriptFromMessages } from "../events.js";
import { RpcClient } from "./client.js";
import { EventQueue, normalizeRpcEvent } from "./events.js";
import { SYSTEM_APPEND, THINKING_LEVELS, RPC_PASSTHROUGH_COMMANDS, RPC_PASSTHROUGH_TIMEOUTS, normalizeThinking, safeId } from "./shared.js";

const SOURCES = ["web", "telegram", "api", "system"];

/**
 * رد أمر prompt قد يتأخر حتى ينتهي preflight، وهو ينتظر أوامر الإضافات
 * وحواراتها (موافقة الأدوات مثلاً). مهلة الجسر العامة 30s قصيرة جداً هنا
 * فتُظهر خطأ وهمياً بينما الحوار ما زال مفتوحاً؛ نمنحها 10 دقائق.
 */
const PROMPT_TIMEOUT_MS = 10 * 60_000;

/** نص عربي موجز لقرار الحوار، يُستخدم لإغلاق الواجهة الأخرى بنفس النتيجة. */
function uiDecisionText(method, payload, sent) {
  if (!sent) return "أُغلق الحوار";
  if (payload?.cancelled) return "أُلغي";
  if (method === "confirm") return payload?.confirmed ? "سماح" : "رفض";
  if (payload?.value !== undefined && payload?.value !== null && payload?.value !== "") {
    return String(payload.value);
  }
  return "تم الرد";
}

export class RpcConversation {
  constructor(id, manager) {
    this.id = id;
    this.manager = manager;
    this.client = null;
    this.creating = null;
    this.listeners = new Set();
    this.lastActivity = Date.now();
    this.busy = false;
    this.transcript = [];
    this.queue = new EventQueue();
    // حوارات امتدادات معلّقة: id → { respond(payload), cancel() }.
    this.pendingUI = new Map();
    // معرّفات الحوارات المحسومة (أول رد يفوز) لمنع الرد المزدوج عبر القنوات.
    this.resolvedUI = new Map();
    this.state = { contextUsage: null, thinkingLevels: null, toolNames: [] };
    this.remote = {
      sessionId: null,
      sessionFile: null,
      sessionName: null,
      isStreaming: false,
      messageCount: 0,
      thinkingLevel: null,
      model: null,
    };
    this.meta = manager.store.get(this.id, null) || {
      provider: config.defaultProvider,
      model: config.defaultModel,
      thinking: config.defaultThinking,
      agentId: manager.agents.defaultId(),
      title: null,
      sessionFile: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!this.meta.agentId) this.meta.agentId = manager.agents.defaultId();
  }

  /* ===== معلومات الحالة ===== */

  get title() {
    return this.meta.title;
  }

  get sessionFile() {
    return this.remote.sessionFile || this.meta.sessionFile || null;
  }

  get isBusy() {
    return this.busy || !!this.remote.isStreaming;
  }

  get hasListeners() {
    return this.listeners.size > 0;
  }

  /** واجهة توافق مصغّرة: بعض المستهلكين يقرأون conv.session?.* */
  get session() {
    if (!this.client) return null;
    return {
      isIdle: !this.isBusy,
      isStreaming: this.isBusy,
      getAvailableThinkingLevels: () => this.getThinkingLevels(),
      getContextUsage: () => this.state.contextUsage || null,
    };
  }

  touch() {
    this.lastActivity = Date.now();
  }

  #resolveAgent() {
    return this.manager.agents.get(this.meta.agentId) || this.manager.agents.defaultAgent();
  }

  getAgentState() {
    const agent = this.#resolveAgent();
    if (!agent) return null;
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      emoji: agent.emoji,
      description: agent.description,
      permissions: agent.permissions,
      thinking: agent.thinking,
      model: agent.model,
      tools: this.manager.agents.toolsFor(agent),
      enabled: agent.enabled,
    };
  }

  #save() {
    this.meta.updatedAt = Date.now();
    this.manager.store.set(this.id, this.meta);
  }

  getThinkingLevels() {
    return this.state.thinkingLevels?.length ? this.state.thinkingLevels : THINKING_LEVELS;
  }

  /* ===== تشغيل الجسر ===== */

  async ensure() {
    if (this.client) return this.client;
    if (this.creating) return this.creating;
    this.creating = this.#connect().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  async #connect() {
    const sessionDir = join(config.dataDir, "sessions", safeId(this.id));
    mkdirSync(sessionDir, { recursive: true });

    const agent = this.#resolveAgent();
    const appendSystemPrompt = [SYSTEM_APPEND, config.pi.systemPromptExtra, agent?.systemPrompt].filter(Boolean);
    const tools = agent ? this.manager.agents.toolsFor(agent) : config.pi.tools;

    const client = new RpcClient({
      cwd: config.workspace,
      sessionPath: this.meta.sessionFile && existsSync(this.meta.sessionFile) ? this.meta.sessionFile : null,
      sessionDir,
      provider: this.meta.provider || config.defaultProvider,
      model: this.meta.model || config.defaultModel,
      thinking: normalizeThinking(agent?.thinking || this.meta.thinking),
      tools,
      appendSystemPrompt,
      noExtensions: config.pi.noExtensions,
      noSkills: config.pi.noSkills,
      extraArgs: config.rpc?.extraArgs || [],
    });

    // نربط المستمعين قبل التشغيل حتى لا تضيع أحداث سريعة.
    client.on("event", (record) => this.#onRecord(record));
    // حوارات الامتدادات تُسلَّم للمشتركين (الويب/تيليجرام) عبر حدث extension_ui،
    // وننتظر ردهم عبر respondExtensionUI. بدون هذا المعالج يلغيها الجسر فوراً.
    client.onExtensionUI((request, respond) => this.#awaitExtensionDialog(request, respond));
    client.on("restarting", ({ attempt, delay }) => {
      this.busy = false;
      this.#cancelPendingUI();
      this.#emit({ type: "error", message: `انقطع جسر RPC، إعادة تشغيل (${attempt}) بعد ${delay}ms…` });
    });
    client.on("restarted", () => {
      logger.ok(`[${this.id}] أُعيد تشغيل جسر RPC.`);
      void this.#resync();
    });
    client.on("fatal", (info) => {
      this.busy = false;
      this.remote.isStreaming = false;
      this.#cancelPendingUI();
      const detail = info?.error?.message || `code=${info?.code ?? "-"} signal=${info?.signal || "-"}`;
      this.#emit({ type: "error", message: `توقّف جسر RPC نهائياً: ${detail}` });
    });
    client.on("exit", ({ intentional }) => {
      this.busy = false;
      this.remote.isStreaming = false;
      this.#cancelPendingUI();
      if (!intentional) logger.warn(`[${this.id}] خرجت عملية pi بشكل غير متوقع.`);
    });

    this.client = client;

    try {
      await client.start();
      await this.#resync({ initial: true });
    } catch (err) {
      this.client = null;
      await client.dispose().catch(() => undefined);
      logger.error(`[${this.id}] فشل تشغيل جسر RPC:`, err?.message || err);
      throw err;
    }

    this.#save();
    this.#emit({ type: "session_ready", state: this.getState() });
    this.touch();
    return client;
  }

  /** مزامنة الحالة والسجل من العملية الفرعية. */
  async #resync({ initial = false } = {}) {
    const client = this.client;
    if (!client) return;
    await Promise.allSettled([
      this.#refreshState(client),
      this.#refreshTranscript(client),
      this.#refreshThinkingLevels(client),
      this.#refreshContextUsage(client, false),
    ]);
    if (initial && this.remote.sessionName && !this.meta.title) {
      this.meta.title = this.remote.sessionName;
      this.#save();
    }
  }

  async #refreshState(client = this.client) {
    if (!client) return;
    try {
      const data = await client.send({ type: "get_state" }, { timeoutMs: 30_000 });
      this.#applyState(data);
    } catch (err) {
      logger.debug(`[${this.id}] get_state:`, err?.message || err);
    }
  }

  #applyState(data) {
    if (!data) return;
    if (data.sessionFile) this.meta.sessionFile = data.sessionFile;
    if (data.model) {
      this.meta.provider = data.model.provider;
      this.meta.model = data.model.id;
    }
    if (data.thinkingLevel) this.meta.thinking = data.thinkingLevel;
    this.remote = {
      sessionId: data.sessionId || this.remote.sessionId,
      sessionFile: data.sessionFile || this.remote.sessionFile,
      sessionName: data.sessionName || this.remote.sessionName,
      isStreaming: !!data.isStreaming,
      messageCount: Number.isFinite(data.messageCount) ? data.messageCount : this.remote.messageCount,
      thinkingLevel: data.thinkingLevel || this.remote.thinkingLevel,
      model: data.model || this.remote.model,
      pendingMessageCount: data.pendingMessageCount || 0,
    };
    this.#save();
  }

  async #refreshTranscript(client = this.client, timeoutMs = 30_000) {
    if (!client) return;
    try {
      const data = await client.send({ type: "get_messages" }, { timeoutMs });
      this.transcript = transcriptFromMessages(data?.messages || []);
    } catch (err) {
      logger.debug(`[${this.id}] get_messages:`, err?.message || err);
    }
  }

  async #refreshThinkingLevels(client = this.client) {
    if (!client) return;
    try {
      const data = await client.send({ type: "get_available_thinking_levels" }, { timeoutMs: 15_000 });
      if (Array.isArray(data?.levels) && data.levels.length) this.state.thinkingLevels = data.levels;
    } catch (err) {
      logger.debug(`[${this.id}] get_available_thinking_levels:`, err?.message || err);
    }
  }

  async #refreshContextUsage(client = this.client, emit = true) {
    if (!client) return;
    try {
      const data = await client.send({ type: "get_session_stats" }, { timeoutMs: 30_000 });
      const usage = data?.contextUsage || null;
      this.state.contextUsage = usage;
      if (usage) this.remote.messageCount = data?.totalMessages ?? this.remote.messageCount;
      if (emit) this.#emit({ type: "context_usage", usage });
    } catch (err) {
      logger.debug(`[${this.id}] get_session_stats:`, err?.message || err);
    }
  }

  /* ===== استقبال الأحداث ===== */

  #onRecord(record) {
    const events = normalizeRpcEvent(record);
    if (!events.length) return;
    this.touch();
    for (const evt of events) this.#apply(evt);
  }

  #apply(evt) {
    switch (evt.type) {
      case "title_changed":
        if (evt.name) this.meta.title = evt.name;
        this.#save();
        break;
      case "run_start":
        this.busy = true;
        this.remote.isStreaming = true;
        break;
      case "settled":
        this.busy = false;
        this.remote.isStreaming = false;
        // نؤجّل بثّ settled حتى يتحدّث السجل (get_messages) فيراه المستهلكون فوراً.
        void this.#afterSettle().finally(() => this.#emit(evt));
        return;
      case "assistant_message": {
        if (evt.model) this.meta.model = evt.model;
        if (evt.usage) {
          this.manager.usage.record({
            ts: Date.now(),
            conversationId: this.id,
            agentId: this.meta.agentId,
            provider: this.remote.model?.provider || this.meta.provider,
            model: evt.model || this.remote.model?.id || this.meta.model,
            usage: evt.usage,
            source: "live",
          });
        }
        this.#save();
        void this.#refreshContextUsage(this.client, true);
        break;
      }
      case "thinking_level":
        if (evt.level) {
          this.meta.thinking = evt.level;
          this.remote.thinkingLevel = evt.level;
          this.#save();
        }
        break;
      case "queue": {
        const items = [...(evt.steeringItems || []), ...(evt.followUpItems || [])];
        this.queue.replace(items.map((text) => ({ text })));
        break;
      }
      default:
        break;
    }
    this.#emit(evt);
  }

  /** بعد استقرار الجلسة: نحدّث السجل والعدّادات بهدوء. */
  async #afterSettle() {
    const client = this.client;
    if (!client) return;
    await Promise.allSettled([
      this.#refreshState(client),
      this.#refreshTranscript(client, 8000),
    ]);
  }

  #emit(evt) {
    for (const listener of this.listeners) {
      try {
        listener(evt);
      } catch (err) {
        logger.debug(`[${this.id}] listener error:`, err?.message || err);
      }
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    this.touch();
    return () => this.listeners.delete(listener);
  }

  /* ===== واجهة المحادثة ===== */

  async prompt(text, options = {}) {
    const client = await this.ensure();
    this.touch();
    if (!this.meta.title) {
      this.meta.title = String(text).replace(/\s+/g, " ").trim().slice(0, 80) || null;
      this.#save();
    }
    const source = SOURCES.includes(options.source) ? options.source : "web";
    const images = Array.isArray(options.images) && options.images.length ? options.images : undefined;
    this.#emit({ type: "user_message", text: String(text), source, timestamp: Date.now() });

    if (this.isBusy) {
      const steered = options.mode === "steer";
      const data = await client.send({
        type: steered ? "steer" : "follow_up",
        message: String(text),
        ...(images ? { images } : {}),
      });
      return data?.disposition || "queued";
    }

    // run_start يأتي من حدث agent_start من العملية الفرعية (مصدر الحقيقة)،
    // فلا نكرّره هنا. نعلّم الانشغال فوراً لتفادي إرسال prompt متزامن.
    this.busy = true;
    this.remote.isStreaming = true;
    try {
      const data = await client.send(
        {
          type: "prompt",
          message: String(text),
          ...(images ? { images } : {}),
        },
        { timeoutMs: PROMPT_TIMEOUT_MS },
      );
      if (data?.disposition === "handled") {
        // لا تشغيل فعلي (أمر إضافة استهلك الرسالة)؛ لن يصل agent_settled.
        this.busy = false;
        this.remote.isStreaming = false;
      }
      return data?.disposition || "started";
    } catch (err) {
      this.busy = false;
      this.remote.isStreaming = false;
      this.#emit({ type: "error", message: err?.message || String(err) });
      throw err;
    }
  }

  /**
   * يردّ على حوار إضافة معلّق (select/confirm/input/editor).
   * payload: { value } | { confirmed } | { cancelled: true }
   * @returns {Promise<boolean>} true إن أُرسل الرد فعلاً.
   */
  async respondExtensionUI(id, payload = {}, meta = {}) {
    if (!id) return false;
    const pending = this.pendingUI.get(id);
    if (pending) {
      pending.respond(payload, meta);
      this.touch();
      return true;
    }
    // أول رد يفوز: إن حُسم الحوار من قناة أخرى لا نرسل رداً ثانياً إلى pi.
    if (this.resolvedUI.has(id)) return false;
    // احتياط: قد يصل الرد بعد إعادة تشغيل/إعادة ربط؛ نمرّره إن أمكن.
    const client = this.client;
    if (!client) return false;
    await client.respond(id, payload);
    this.touch();
    return true;
  }

  /** ينتظر رد المشتركين على حوار إضافة ثم يرسله إلى pi. */
  #awaitExtensionDialog(request, respond) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (payload, send, meta = {}) => {
        if (settled) return;
        settled = true;
        this.pendingUI.delete(request.id);
        const source = meta?.source || null;
        this.#markResolved(request.id, source);
        // نُبلّغ كل القنوات (الويب + تيليجرام) بالحسم كي تُغلق الواجهة الأخرى فوراً.
        this.#emit({
          type: "extension_ui_resolved",
          requestId: request.id,
          method: request.method,
          source,
          cancelled: !send || !!payload?.cancelled,
          decision: uiDecisionText(request.method, payload, send),
        });
        if (!send) {
          resolve();
          return;
        }
        Promise.resolve()
          .then(() => respond(payload))
          .catch((err) => logger.debug(`[${this.id}] رد الحوار:`, err?.message || err))
          .finally(resolve);
      };
      this.pendingUI.set(request.id, {
        request,
        respond: (payload, meta) => settle(payload, true, meta),
        cancel: () => settle(null, false),
      });
    });
  }

  #markResolved(id, source) {
    if (!id) return;
    this.resolvedUI.set(id, { at: Date.now(), source });
    // تقليم دوري: نحتاج الذاكرة فقط لمنع الرد المزدوج القريب.
    if (this.resolvedUI.size > 200) {
      const cutoff = Date.now() - 30 * 60_000;
      for (const [key, value] of this.resolvedUI) {
        if (value.at < cutoff) this.resolvedUI.delete(key);
      }
    }
  }

  /** إغلاق كل الحوارات المعلّقة دون إرسال (بعد خروج العملية أو إغلاق الجلسة). */
  getPendingExtensionUI() {
    return [...this.pendingUI.values()]
      .map((entry) => entry.request)
      .filter(Boolean);
  }

  #cancelPendingUI() {
    if (!this.pendingUI.size) return;
    for (const entry of this.pendingUI.values()) {
      try {
        entry.cancel();
      } catch {
        /* تجاهل */
      }
    }
    this.pendingUI.clear();
  }

  async abort() {
    if (!this.client) return false;
    if (!this.isBusy) return false;
    await this.client.send({ type: "abort" }, { timeoutMs: 120_000 });
    this.busy = false;
    this.remote.isStreaming = false;
    return true;
  }

  async newSession() {
    await this.#disposeClient();
    this.meta.sessionFile = null;
    this.meta.title = null;
    this.state.contextUsage = null;
    this.transcript = [];
    this.queue.clear();
    this.#save();
    await this.ensure();
    this.#emit({ type: "session_reset", state: this.getState(), transcript: this.getTranscript() });
  }

  async switchSession(sessionFile) {
    if (!sessionFile) throw new Error("sessionFile مطلوب");
    await this.#disposeClient();
    this.meta.sessionFile = sessionFile;
    this.meta.title = null;
    this.state.contextUsage = null;
    this.transcript = [];
    this.queue.clear();
    this.#save();
    await this.ensure();
    this.#emit({ type: "session_reset", state: this.getState(), transcript: this.getTranscript() });
  }

  async setModel(provider, modelId) {
    const known = this.manager.resolveModel(provider, modelId);
    // نتحقق محلياً فقط إن كانت قائمة النماذج محمّلة؛ وإلا فالعملية الفرعية هي المرجع.
    if (!known && this.manager.availableModels?.length) {
      throw new Error(`النموذج غير موجود: ${provider}/${modelId}`);
    }
    const client = await this.ensure();
    const data = await client.send({ type: "set_model", provider, modelId });
    const chosen = data && typeof data === "object" && data.id ? data : known;
    if (!chosen?.provider || !chosen?.id) throw new Error(`تعذّر تغيير النموذج إلى ${provider}/${modelId}`);
    this.meta.provider = chosen.provider;
    this.meta.model = chosen.id;
    this.remote.model = { id: chosen.id, provider: chosen.provider };
    this.#save();
    this.#emit({ type: "model_changed", provider: chosen.provider, model: chosen.id });
    return { provider: chosen.provider, model: chosen.id };
  }

  async setAgent(agentId) {
    if (this.isBusy) throw new Error("لا يمكن تغيير الوكيل أثناء التوليد. أوقف التوليد أولاً.");
    const agent = this.manager.agents.get(agentId);
    if (!agent) throw new Error(`الوكيل غير موجود: ${agentId}`);
    this.meta.agentId = agent.id;
    if (agent.model) {
      const model = this.manager.resolveModel(agent.model.provider, agent.model.model);
      if (model) {
        this.meta.provider = model.provider;
        this.meta.model = model.id;
      }
    }
    if (agent.thinking) this.meta.thinking = agent.thinking;
    this.#save();
    await this.#disposeClient();
    await this.ensure();
    this.#emit({ type: "agent_changed", agent: this.getAgentState() });
    return this.getAgentState();
  }

  async reloadResources() {
    if (this.isBusy) throw new Error("لا يمكن إعادة تحميل الموارد أثناء التوليد. أوقف التوليد أولاً.");
    await this.#disposeClient();
    await this.ensure();
    this.#emit({ type: "session_ready", state: this.getState() });
    return this.getState();
  }

  async setThinking(level) {
    if (!this.client) await this.ensure();
    const client = this.client;
    const normalized = normalizeThinking(level);
    await client.send({ type: "set_thinking_level", level: normalized });
    this.meta.thinking = this.remote.thinkingLevel || normalized;
    this.#save();
    this.#emit({ type: "thinking_changed", level: this.meta.thinking });
    return this.meta.thinking;
  }

  async compact() {
    const client = await this.ensure();
    return client.send({ type: "compact" }, { timeoutMs: 120_000 });
  }

  /**
   * يمرّر أمر RPC عاماً مسموحاً (B1) ويعيد بيانات الرد كما وصلت من pi.
   * لا يغيّر أي مسار قائم: prompt/abort/compact… تبقى كما هي.
   * @param {string} command اسم الأمر في بروتوكول RPC
   * @param {object} [data] حقول الأمر (type/id يُضافان هنا ولا يُقبل تجاوزهما)
   * @returns {Promise<any>} data من رد pi (قد تكون null)
   */
  async rpc(command, data = {}) {
    const name = String(command || "").trim();
    if (!RPC_PASSTHROUGH_COMMANDS.includes(name)) {
      throw new Error(`أمر RPC غير مسموح: ${name || "(فارغ)"}`);
    }
    const client = await this.ensure();
    const payload = data && typeof data === "object" ? { ...data } : {};
    delete payload.id;
    delete payload.type;
    // توافق الواجهة: `sessionFile` في مساراتنا القديمة يقابله `sessionPath` في pi.
    if (name === "switch_session" && payload.sessionPath == null && payload.sessionFile != null) {
      payload.sessionPath = payload.sessionFile;
      delete payload.sessionFile;
    }
    // /compact مع تعليمات (B3): نقبل instructions ونحوّلها إلى customInstructions.
    if (name === "compact" && payload.customInstructions == null && payload.instructions != null) {
      payload.customInstructions = payload.instructions;
      delete payload.instructions;
    }
    const response = await client.send(
      { ...payload, type: name },
      { timeoutMs: RPC_PASSTHROUGH_TIMEOUTS[name] || 60_000 },
    );
    return response ?? null;
  }

  async setTitle(title) {
    const client = await this.ensure();
    const name = String(title).slice(0, 120);
    await client.send({ type: "set_session_name", name });
    this.meta.title = name;
    this.remote.sessionName = name;
    this.#save();
    this.#emit({ type: "title_changed", name: this.meta.title });
  }

  getState() {
    const model = this.remote.model;
    const agent = this.#resolveAgent();
    return {
      id: this.id,
      title: this.meta.title,
      provider: model?.provider || this.meta.provider,
      model: model?.id || this.meta.model,
      thinking: this.remote.thinkingLevel || this.meta.thinking,
      sessionFile: this.sessionFile,
      sessionId: this.remote.sessionId || null,
      isStreaming: this.isBusy,
      isIdle: !this.isBusy,
      messageCount: this.remote.messageCount || 0,
      toolNames: agent ? this.manager.agents.toolsFor(agent) : this.state.toolNames || [],
      thinkingLevels: this.getThinkingLevels(),
      contextUsage: this.state.contextUsage || null,
      agent: this.getAgentState(),
    };
  }

  getTranscript() {
    return this.transcript;
  }

  /**
   * إعادة جلب السجل من العملية الفرعية. مفيدة عند اتصال الواجهة قبل
   * اكتمال جاهزية جسر RPC (كان السجل يعود فارغاً في أول تحميل).
   */
  async refreshTranscript() {
    const client = await this.ensure();
    await this.#refreshTranscript(client, 60_000);
    return this.transcript;
  }

  async #disposeClient() {
    const client = this.client;
    this.client = null;
    this.busy = false;
    this.remote.isStreaming = false;
    this.#cancelPendingUI();
    if (!client) return;
    try {
      await client.dispose();
    } catch (err) {
      logger.debug(`[${this.id}] إغلاق الجسر:`, err?.message || err);
    }
  }
  dispose() {
    const client = this.client;
    this.client = null;
    this.busy = false;
    this.#cancelPendingUI();
    this.listeners.clear();
    if (client) {
      try {
        client.dispose().catch(() => undefined);
      } catch {
        /* تجاهل */
      }
    }
  }
}

export default RpcConversation;
