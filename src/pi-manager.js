import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

import config from "./config.js";
import logger from "./logger.js";
import { AgentRegistry, UsageTracker } from "./control.js";
import { normalizeEvent, transcriptFromMessages } from "./events.js";
import { RpcConversation } from "./rpc/conversation.js";
import { SYSTEM_APPEND, THINKING_LEVELS, normalizeThinking, safeId } from "./rpc/shared.js";

/** حارس صلاحيات OpenCode: يطبّق خريطة deny حتى في الجلسات الفرعية. */
function createPermissionGuardExtension() {
  const denied = new Set();
  try {
    const file = join(config.agentDir, "opencode-permissions.json");
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (const [name, value] of Object.entries(data.permissions || {})) {
        if (value === "deny") denied.add(String(name));
      }
    }
  } catch {
    /* ignore */
  }
  return (pi) => {
    if (!denied.size) return;
    pi.on("tool_call", async (event) => {
      const toolName = String(event.toolName || "");
      const parts = toolName.split("__");
      const server = parts.length >= 3 ? parts[1] : "";
      const short = parts.length >= 3 ? parts.slice(2).join("__") : parts.pop() || "";
      const candidates = [toolName, short];
      if (server) candidates.push(`${server}_${short}`);
      if (candidates.some((name) => denied.has(name))) {
        return { block: true, reason: `OpenCode permission map denies ${toolName}` };
      }
      return undefined;
    });
  };
}

/** محادثة واحدة تملك جلسة Pi واحدة. */
class Conversation {
  constructor(id, manager) {
    this.id = id;
    this.manager = manager;
    this.session = null;
    this.unsubscribe = null;
    this.listeners = new Set();
    this.creating = null;
    this.lastActivity = Date.now();
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

  touch() {
    this.lastActivity = Date.now();
  }

  #resolveModel() {
    return this.manager.resolveModel(this.meta.provider, this.meta.model);
  }

  async ensure() {
    if (this.session) return this.session;
    if (this.creating) return this.creating;
    this.creating = this.#createSession().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  async #createSession() {
    const sessionDir = join(config.dataDir, "sessions", safeId(this.id));
    mkdirSync(sessionDir, { recursive: true });

    let sessionManager;
    if (this.meta.sessionFile && existsSync(this.meta.sessionFile)) {
      sessionManager = SessionManager.open(this.meta.sessionFile, sessionDir, config.workspace);
    } else {
      sessionManager = SessionManager.create(config.workspace, sessionDir);
    }

    const settingsManager = SettingsManager.create(config.workspace, config.agentDir);

    const agent = this.#resolveAgent();
    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspace,
      agentDir: config.agentDir,
      settingsManager,
      noExtensions: config.pi.noExtensions,
      noSkills: config.pi.noSkills,
      extensionFactories: [createMcpExtension(), createPermissionGuardExtension()],
      appendSystemPrompt: [SYSTEM_APPEND, config.pi.systemPromptExtra, agent?.systemPrompt].filter(Boolean),
    });
    await resourceLoader.reload();

    const model =
      this.#resolveModel() ||
      (agent?.model ? this.manager.resolveModel(agent.model.provider, agent.model.model) : undefined);
    const agentTools = agent ? this.manager.agents.toolsFor(agent) : [];
    const options = {
      cwd: config.workspace,
      agentDir: config.agentDir,
      modelRuntime: this.manager.runtime,
      thinkingLevel: normalizeThinking(agent?.thinking || this.meta.thinking),
      sessionManager,
      settingsManager,
      resourceLoader,
      tools: agent ? agentTools : config.pi.tools.length ? config.pi.tools : undefined,
    };
    if (model) options.model = model;
    if (agent?.permissions?.delegate) options.customTools = [this.manager.createDelegateTool(this)];

    let created;
    try {
      created = await createAgentSession(options);
    } catch (err) {
      logger.error(`[${this.id}] فشل إنشاء الجلسة:`, err?.message || err);
      throw err;
    }
    const { session, modelFallbackMessage } = created;
    if (modelFallbackMessage) logger.warn(`[${this.id}] ${modelFallbackMessage}`);

    try {
      await session.bindExtensions({});
    } catch (err) {
      logger.debug(`[${this.id}] bindExtensions:`, err?.message || err);
    }

    this.unsubscribe = session.subscribe((event) => this.#handleRaw(event));

    this.session = session;
    if (session.sessionFile) this.meta.sessionFile = session.sessionFile;
    if (session.model) {
      this.meta.provider = session.model.provider;
      this.meta.model = session.model.id;
    }
    this.#save();
    this.#emit({ type: "session_ready", state: this.getState() });
    this.touch();
    return session;
  }

  #handleRaw(event) {
    const events = normalizeEvent(event);
    if (!events.length) return;
    this.touch();
    for (const evt of events) {
      if (evt.type === "title_changed") this.meta.title = evt.name || this.meta.title;
      if (evt.type === "assistant_message") {
        if (evt.model) {
          this.meta.model = evt.model;
        }
        if (evt.usage) {
          this.manager.usage.record({
            ts: Date.now(),
            conversationId: this.id,
            agentId: this.meta.agentId,
            provider: this.session?.model?.provider || this.meta.provider,
            model: evt.model || this.session?.model?.id || this.meta.model,
            usage: evt.usage,
            source: "live",
          });
        }
        this.manager.store.set(this.id, this.meta);
        const contextUsage = this.session?.getContextUsage?.() || null;
        this.#emit({ type: "context_usage", usage: contextUsage });
      }
      this.#emit(evt);
    }
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

  get hasListeners() {
    return this.listeners.size > 0;
  }

  get isBusy() {
    return !!this.session && !this.session.isIdle;
  }

  async prompt(text, options = {}) {
    const session = await this.ensure();
    this.touch();
    if (!this.meta.title) {
      this.meta.title = String(text).replace(/\s+/g, " ").trim().slice(0, 80) || null;
      this.#save();
    }
    const source = ["web", "telegram", "api", "system"].includes(options.source)
      ? options.source
      : "web";
    const images =
      Array.isArray(options.images) && options.images.length ? options.images : undefined;
    this.#emit({
      type: "user_message",
      text: String(text),
      source,
      timestamp: Date.now(),
    });
    if (session.isStreaming) {
      const disposition = await session.followUp(text, images);
      return disposition;
    }
    this.#emit({ type: "run_start" });
    try {
      await session.prompt(text, images ? { images } : undefined);
    } catch (err) {
      this.#emit({ type: "error", message: err?.message || String(err) });
      throw err;
    }
  }

  async abort() {
    if (!this.session) return false;
    if (this.session.isIdle) return false;
    await this.session.abort();
    return true;
  }

  async newSession() {
    this.#disposeSession();
    this.meta.sessionFile = null;
    this.meta.title = null;
    this.#save();
    await this.ensure();
    this.#emit({ type: "session_reset", state: this.getState(), transcript: this.getTranscript() });
  }

  async switchSession(sessionFile) {
    if (!sessionFile) throw new Error("sessionFile مطلوب");
    this.#disposeSession();
    this.meta.sessionFile = sessionFile;
    this.meta.title = null;
    this.#save();
    await this.ensure();
    this.#emit({ type: "session_reset", state: this.getState(), transcript: this.getTranscript() });
  }

  async setModel(provider, modelId) {
    const model = this.manager.resolveModel(provider, modelId);
    if (!model) throw new Error(`النموذج غير موجود: ${provider}/${modelId}`);
    const session = await this.ensure();
    await session.setModel(model);
    this.meta.provider = model.provider;
    this.meta.model = model.id;
    this.#save();
    this.#emit({ type: "model_changed", provider: model.provider, model: model.id });
    return { provider: model.provider, model: model.id };
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
    this.#disposeSession();
    await this.ensure();
    this.#emit({ type: "agent_changed", agent: this.getAgentState() });
    return this.getAgentState();
  }

  async reloadResources() {
    if (this.isBusy) throw new Error("لا يمكن إعادة تحميل الموارد أثناء التوليد. أوقف التوليد أولاً.");
    this.#disposeSession();
    await this.ensure();
    this.#emit({ type: "session_ready", state: this.getState() });
    return this.getState();
  }

  async setThinking(level) {
    const session = await this.ensure();
    const normalized = normalizeThinking(level);
    session.setThinkingLevel(normalized);
    this.meta.thinking = session.thinkingLevel || normalized;
    this.#save();
    this.#emit({ type: "thinking_changed", level: this.meta.thinking });
    return this.meta.thinking;
  }

  async compact() {
    const session = await this.ensure();
    return session.compact();
  }

  async setTitle(title) {
    const session = await this.ensure();
    session.setSessionName(String(title).slice(0, 120));
    this.meta.title = String(title).slice(0, 120);
    this.#save();
    this.#emit({ type: "title_changed", name: this.meta.title });
  }

  getState() {
    const session = this.session;
    return {
      id: this.id,
      title: this.meta.title,
      provider: session?.model?.provider || this.meta.provider,
      model: session?.model?.id || this.meta.model,
      thinking: session?.thinkingLevel || this.meta.thinking,
      sessionFile: session?.sessionFile || this.meta.sessionFile || null,
      sessionId: session?.sessionId || null,
      isStreaming: !!session?.isStreaming,
      isIdle: session ? session.isIdle : true,
      messageCount: session?.state?.messages?.length || 0,
      toolNames: session?.getActiveToolNames?.() || [],
      thinkingLevels: session?.getAvailableThinkingLevels?.() || THINKING_LEVELS,
      contextUsage: session?.getContextUsage?.() || null,
      agent: this.getAgentState(),
    };
  }

  getTranscript() {
    if (!this.session) return [];
    return transcriptFromMessages(this.session.state?.messages || []);
  }

  #disposeSession() {
    try {
      this.unsubscribe?.();
    } catch {
      /* ignore */
    }
    this.unsubscribe = null;
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = null;
  }

  dispose() {
    this.#disposeSession();
    this.listeners.clear();
  }
}

/** يدير مجموعة المحادثات والجلسات ونماذج Pi. */
export class PiManager {
  constructor(store, options = {}) {
    this.store = store;
    this.runtime = null;
    this.availableModels = [];
    this.conversations = new Map();
    this.sweeper = null;
    this.agents = options.agents || new AgentRegistry(join(config.dataDir, "agents.json"));
    this.usage = options.usage || new UsageTracker(join(config.dataDir, "usage.json"));
  }

  async init() {
    this.runtime = await ModelRuntime.create({
      authPath: join(config.agentDir, "auth.json"),
      modelsPath: join(config.agentDir, "models.json"),
    });
    await this.refreshModels();
    logger.info(`محرّك الجلسات: ${config.featureRpc ? "RPC (FEATURE_RPC=1)" : "SDK (افتراضي)"}`);
    this.#migrateSharedSession();
    try {
      this.usage.seedFromSessions(join(config.dataDir, "sessions"));
    } catch (err) {
      logger.warn("تعذّر استيراد الاستهلاك السابق:", err?.message || err);
    }
    this.sweeper = setInterval(() => this.#sweep(), 60_000);
    this.sweeper.unref?.();
    return this;
  }

  /**
   * عند تفعيل المزامنة أول مرة: اعتمد أحدث جلسة ويب كجلسة مشتركة
   * حتى يستمر نفس السياق في الويب وتيليجرام بعد إعادة التشغيل.
   */
  #migrateSharedSession() {
    if (!config.syncWebTelegram || !config.sharedSessionId) return;
    if (this.store.get(config.sharedSessionId, null)) return;
    const candidates = Object.entries(this.store.all() || {})
      .filter(([id, meta]) => id.startsWith("web:") && meta?.sessionFile)
      .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    const [oldId, oldMeta] = candidates[0] || [];
    if (!oldId || !oldMeta) return;
    const migrated = {
      ...oldMeta,
      title: oldMeta.title || "الجلسة المشتركة",
      agentId: oldMeta.agentId || this.agents.defaultId(),
      updatedAt: Date.now(),
    };
    this.store.set(config.sharedSessionId, migrated);
    this.store.delete(oldId);
    this.store.flush();
    logger.ok(
      `المزامنة: تم اعتماد الجلسة ${oldId} كجلسة مشتركة (${config.sharedSessionId}) للويب وتيليجرام.`,
    );
  }

  async reloadModels() {
    if (this.runtime?.refresh) await this.runtime.refresh({ allowNetwork: false });
    return this.refreshModels();
  }

  getUsage(context = null) {
    return this.usage.summary(context);
  }

  /** أداة تفويض مهمة إلى وكيل آخر بجلسة فرعية معزولة. */
  createDelegateTool(parentConversation) {
    const agents = this.agents
      .list()
      .filter((agent) => agent.enabled)
      .map((agent) => `${agent.id}=${agent.name}`)
      .join("، ");
    return {
      name: "delegate",
      label: "تفويض وكيل",
      description: `فوّض مهمة إلى وكيل متخصص وأعد نتيجته. الوكلاء المتاحون: ${agents || "لا يوجد"}. استخدمه عندما تكون المهمة مناسبة لدور وكيل آخر.`,
      promptSnippet: "delegate: فوّض مهمة إلى وكيل متخصص (مخطط، منفذ، مراجع...)",
      parameters: Type.Object({
        agent: Type.String({ description: "معرّف الوكيل المطلوب، مثل planner أو executor أو reviewer" }),
        task: Type.String({ description: "وصف كامل ومحدد للمهمة المفوّضة" }),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => {
        const result = await this.runSubAgent({
          agentId: params.agent,
          task: params.task,
          parentConversationId: parentConversation?.id || "",
          signal,
        });
        return {
          content: [
            {
              type: "text",
              text: `${result.agent.emoji || "🤖"} ${result.agent.name} (${result.agent.role}):\n${result.text}`,
            },
          ],
          details: { agent: result.agent.id, usage: result.usage },
          usage: result.usage,
        };
      },
    };
  }

  async runSubAgent({ agentId, task, parentConversationId = "", signal }) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`الوكيل غير موجود: ${agentId}`);
    if (!agent.enabled) throw new Error(`الوكيل معطّل: ${agent.name}`);
    const parent = this.conversations.get(parentConversationId);
    const parentProvider = parent?.meta?.provider || config.defaultProvider;
    const parentModel = parent?.meta?.model || config.defaultModel;
    const model = agent.model
      ? this.resolveModel(agent.model.provider, agent.model.model)
      : this.resolveModel(parentProvider, parentModel);

    const settingsManager = SettingsManager.create(config.workspace, config.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspace,
      agentDir: config.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: config.pi.noSkills,
      extensionFactories: [createMcpExtension(), createPermissionGuardExtension()],
      appendSystemPrompt: [SYSTEM_APPEND, config.pi.systemPromptExtra, agent.systemPrompt].filter(Boolean),
    });
    await resourceLoader.reload();

    const options = {
      cwd: config.workspace,
      agentDir: config.agentDir,
      modelRuntime: this.runtime,
      thinkingLevel: normalizeThinking(agent.thinking),
      sessionManager: SessionManager.inMemory(config.workspace),
      settingsManager,
      resourceLoader,
      tools: this.agents.toolsFor(agent),
    };
    if (model) options.model = model;
    const { session } = await createAgentSession(options);
    try {
      await session.bindExtensions({});
    } catch {
      /* ignore */
    }

    let text = "";
    const usageTotal = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const unsubscribe = session.subscribe((event) => {
      for (const evt of normalizeEvent(event)) {
        if (evt.type === "assistant_message") {
          if (evt.text) text = evt.text;
          if (evt.usage) {
            usageTotal.input += Number(evt.usage.input) || 0;
            usageTotal.output += Number(evt.usage.output) || 0;
            usageTotal.cacheRead += Number(evt.usage.cacheRead) || 0;
            usageTotal.cacheWrite += Number(evt.usage.cacheWrite) || 0;
            usageTotal.totalTokens += Number(evt.usage.totalTokens) || 0;
            usageTotal.cost.total += Number(evt.usage.cost?.total) || 0;
            this.usage.record({
              ts: Date.now(),
              conversationId: `sub:${parentConversationId}:${agentId}`,
              agentId,
              provider: session.model?.provider || model?.provider || "unknown",
              model: session.model?.id || model?.id || "unknown",
              usage: evt.usage,
              source: "delegate",
            });
          }
        }
      }
    });
    const onAbort = () => {
      session.abort().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(task);
      const finalText = (session.getLastAssistantText?.() || text || "").trim();
      return { text: finalText || "لم يُرجع الوكيل نصاً.", agent, usage: usageTotal };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  async refreshModels() {
    try {
      const models = await this.runtime.getAvailable();
      this.availableModels = models.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        reasoning: !!(m.reasoning || m.reasoningModel || m.thinkingLevels || m.supportsThinking),
        vision: !!(
          m.vision ||
          m.supportsVision ||
          m.modalities?.includes?.("image") ||
          (Array.isArray(m.input) && m.input.includes("image"))
        ),
        contextWindow: m.contextWindow || 0,
        maxTokens: m.maxTokens || 0,
        input: Array.isArray(m.input) ? m.input : undefined,
      }));
    } catch (err) {
      logger.error("فشل تحميل قائمة النماذج:", err?.message || err);
      this.availableModels = [];
    }
    return this.availableModels;
  }

  resolveModel(provider, modelId) {
    if (!provider || !modelId) return undefined;
    let model = this.runtime?.getModel?.(provider, modelId);
    if (model) return model;
    // بحث مرن حسب المعرّف فقط
    const found = this.availableModels.find(
      (m) => m.id === modelId || `${m.provider}/${m.id}` === `${provider}/${modelId}`,
    );
    if (found) return this.runtime?.getModel?.(found.provider, found.id);
    return undefined;
  }

  defaultModelRef() {
    const exact = this.availableModels.find(
      (m) => m.provider === config.defaultProvider && m.id === config.defaultModel,
    );
    if (exact) return { provider: exact.provider, model: exact.id };
    return this.availableModels[0] ? { provider: this.availableModels[0].provider, model: this.availableModels[0].id } : null;
  }

  listModels() {
    return this.availableModels;
  }

  get(id) {
    return this.conversations.get(id);
  }

  getOrCreate(id) {
    let conversation = this.conversations.get(id);
    if (!conversation) {
      // FEATURE_RPC=1 → جسر RPC، وإلا فالمسار القديم عبر SDK حرفياً.
      const Impl = config.featureRpc ? RpcConversation : Conversation;
      conversation = new Impl(id, this);
      this.conversations.set(id, conversation);
      this.#evictIfNeeded();
    }
    return conversation;
  }

  #evictIfNeeded() {
    if (this.conversations.size <= config.maxSessions) return;
    const idle = [...this.conversations.values()]
      .filter((c) => !c.hasListeners && !c.isBusy)
      .sort((a, b) => a.lastActivity - b.lastActivity);
    while (this.conversations.size > config.maxSessions && idle.length) {
      const victim = idle.shift();
      victim.dispose();
      this.conversations.delete(victim.id);
    }
  }

  #sweep() {
    const now = Date.now();
    for (const conversation of this.conversations.values()) {
      if (conversation.hasListeners || conversation.isBusy) continue;
      if (now - conversation.lastActivity > config.sessionIdleDisposeMs) {
        logger.debug(`تحرير جلسة خاملة: ${conversation.id}`);
        conversation.dispose();
      }
    }
  }

  listConversations() {
    const entries = Object.entries(this.store.all() || {});
    return entries
      .map(([id, meta]) => ({
        id,
        title: meta?.title || null,
        provider: meta?.provider,
        model: meta?.model,
        updatedAt: meta?.updatedAt || 0,
        sessionFile: meta?.sessionFile || null,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  save() {
    this.store.flush();
  }

  disposeAll() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const conversation of this.conversations.values()) conversation.dispose();
    this.conversations.clear();
    this.store.flush();
  }
}

export { Conversation, THINKING_LEVELS };
export default PiManager;
