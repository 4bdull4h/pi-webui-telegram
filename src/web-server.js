import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";

import config from "./config.js";
import logger from "./logger.js";
import {
  KNOWN_APIS,
  PERMISSIONS,
  ROLE_TEMPLATES,
  ExtensionManager,
  ProviderManager,
  SkillManager,
  McpManager,
  countPromptTemplates,
} from "./control.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
};

/** يبني طلب حوار موحّداً للعميل من حدث extension_ui. */
function extensionUiRequest(event) {
  return {
    id: event.requestId,
    method: event.method,
    title: event.title || "",
    message: event.message || "",
    options: Array.isArray(event.options) ? event.options : [],
    placeholder: event.placeholder || "",
    prefill: event.prefill || "",
    notifyType: event.notifyType || "info",
    statusKey: event.statusKey ?? null,
    statusText: event.statusText ?? null,
    widgetKey: event.widgetKey ?? null,
    widgetLines: Array.isArray(event.widgetLines) ? event.widgetLines : null,
    widgetPlacement: event.widgetPlacement || null,
    timeout: event.timeout ?? null,
    text: typeof event.text === "string" ? event.text : null,
    expectsResponse: !!event.expectsResponse,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function safeJoin(root, target) {
  const resolved = resolve(root, `.${normalize(target)}`);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

async function readBody(req, limit = 1_000_000) {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        req.destroy();
        reject(new Error("حجم الطلب كبير جداً"));
      }
    });
    req.on("end", () => {
      if (!data.trim()) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(data));
      } catch {
        reject(new Error("صيغة JSON غير صالحة"));
      }
    });
    req.on("error", reject);
  });
}

export class WebServer {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.onRestart = options.onRestart || null;
    this.server = null;
    this.wss = null;
    this.clients = new Map(); // ws -> { conversationId, unsubscribe }
    this.heartbeat = null;
    this.skills = new SkillManager();
    this.extensions = new ExtensionManager();
    this.mcp = new McpManager();
    this.providers = new ProviderManager(manager);
    this.usageUnsubscribe = null;
  }

  broadcast(message) {
    for (const ws of this.wss?.clients || []) {
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.send(JSON.stringify(message));
      } catch {
        /* ignore */
      }
    }
  }

  #tokenOk(url) {
    if (!config.web.token) return true;
    const token = url.searchParams.get("token");
    return token === config.web.token;
  }

  async start() {
    if (!config.web.enabled) {
      logger.info("الويب: معطّل.");
      return;
    }
    this.server = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      if (!this.#tokenOk(url)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws, req) => this.handleSocket(ws, req));

    this.usageUnsubscribe = this.manager.usage.onChange((usage) => {
      this.broadcast({ type: "usage", usage });
    });

    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30_000);
    this.heartbeat.unref?.();

    await new Promise((resolvePromise) => {
      this.server.listen(config.port, config.host, resolvePromise);
    });
    const shown = config.host === "0.0.0.0" ? "localhost" : config.host;
    logger.ok(`الويب: http://${shown}:${config.port}${config.web.token ? `/?token=${config.web.token}` : ""}`);
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.usageUnsubscribe?.();
    for (const ws of this.wss?.clients || []) ws.close();
    await new Promise((r) => this.server?.close(r));
  }

  // ===== HTTP =====

  async handleHttp(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = (req.method || "GET").toUpperCase();

      if (pathname === "/health") {
        return sendJson(res, 200, { ok: true, uptime: process.uptime() });
      }

      if (pathname.startsWith("/api/") && !this.#tokenOk(url)) {
        return sendJson(res, 401, { error: "unauthorized" });
      }

      if (pathname === "/api/overview" && method === "GET") {
        return sendJson(res, 200, await this.overview());
      }

      if (pathname === "/api/config") {
        return sendJson(res, 200, this.clientConfig());
      }

      if (pathname === "/api/models") {
        return sendJson(res, 200, { models: this.manager.listModels() });
      }

      if (pathname === "/api/sessions") {
        return sendJson(res, 200, { sessions: this.manager.listConversations() });
      }

      if (pathname === "/api/usage" && method === "GET") {
        return sendJson(res, 200, { usage: this.manager.getUsage(), limits: this.manager.usage.limits });
      }

      if (pathname === "/api/limits") {
        if (method === "GET") {
          return sendJson(res, 200, { limits: this.manager.usage.limits });
        }
        if (method === "PUT" || method === "POST") {
          const body = await readBody(req);
          const limits = this.manager.usage.setLimits(body.limits || body);
          this.broadcast({ type: "usage", usage: this.manager.getUsage() });
          return sendJson(res, 200, { limits, usage: this.manager.getUsage() });
        }
      }

      if (pathname === "/api/reload" && method === "POST") {
        await this.providers.reload();
        this.broadcast({ type: "models", models: this.manager.listModels() });
        return sendJson(res, 200, await this.overview());
      }

      // ===== الإضافات =====
      if (pathname === "/api/extensions") {
        if (method === "GET") return sendJson(res, 200, { extensions: this.extensions.list() });
        if (method === "POST") {
          const body = await readBody(req);
          const extension = this.extensions.create(body);
          this.broadcast({ type: "extensions", extensions: this.extensions.list() });
          return sendJson(res, 201, { extension, extensions: this.extensions.list() });
        }
      }
      const extensionMatch = /^\/api\/extensions\/([^/]+)$/.exec(pathname);
      if (extensionMatch) {
        const id = extensionMatch[1];
        if (method === "PUT" || method === "PATCH") {
          const body = await readBody(req);
          const extension = this.extensions.update(id, body);
          this.broadcast({ type: "extensions", extensions: this.extensions.list() });
          return sendJson(res, 200, { extension, extensions: this.extensions.list() });
        }
        if (method === "DELETE") {
          this.extensions.remove(id);
          this.broadcast({ type: "extensions", extensions: this.extensions.list() });
          return sendJson(res, 200, { ok: true, extensions: this.extensions.list() });
        }
      }

      // ===== MCP =====
      if (pathname === "/api/mcp") {
        if (method === "GET") return sendJson(res, 200, this.mcp.list());
      }
      const mcpMatch = /^\/api\/mcp\/([^/]+)$/.exec(pathname);
      if (mcpMatch && (method === "PUT" || method === "PATCH")) {
        const body = await readBody(req);
        const result = this.mcp.setEnabled(mcpMatch[1], body.enabled !== false, body.scope === "project" ? "project" : "user");
        this.broadcast({ type: "mcp", mcp: result });
        return sendJson(res, 200, result);
      }

      // ===== المهارات =====
      if (pathname === "/api/skills") {
        if (method === "GET") return sendJson(res, 200, { skills: this.skills.list() });
        if (method === "POST") {
          const body = await readBody(req);
          const skill = this.skills.create(body);
          this.broadcast({ type: "skills", skills: this.skills.list() });
          return sendJson(res, 201, { skill, skills: this.skills.list() });
        }
      }
      const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(pathname);
      if (skillMatch) {
        const id = skillMatch[1];
        if (method === "GET") {
          const skill = this.skills.get(id);
          if (!skill) return sendJson(res, 404, { error: "المهارة غير موجودة" });
          return sendJson(res, 200, { skill });
        }
        if (method === "PUT" || method === "PATCH") {
          const body = await readBody(req);
          const skill = this.skills.update(id, body);
          this.broadcast({ type: "skills", skills: this.skills.list() });
          return sendJson(res, 200, { skill, skills: this.skills.list() });
        }
        if (method === "DELETE") {
          this.skills.remove(id);
          this.broadcast({ type: "skills", skills: this.skills.list() });
          return sendJson(res, 200, { ok: true, skills: this.skills.list() });
        }
      }

      // ===== الوكلاء =====
      if (pathname === "/api/agents") {
        if (method === "GET") {
          return sendJson(res, 200, {
            agents: this.manager.agents.list(),
            roles: ROLE_TEMPLATES,
            permissions: PERMISSIONS,
          });
        }
        if (method === "POST") {
          const body = await readBody(req);
          const agent = this.manager.agents.create(body);
          this.broadcast({ type: "agents", agents: this.manager.agents.list() });
          return sendJson(res, 201, { agent, agents: this.manager.agents.list() });
        }
      }
      const agentDuplicateMatch = /^\/api\/agents\/([^/]+)\/duplicate$/.exec(pathname);
      if (agentDuplicateMatch && method === "POST") {
        const agent = this.manager.agents.duplicate(agentDuplicateMatch[1]);
        this.broadcast({ type: "agents", agents: this.manager.agents.list() });
        return sendJson(res, 201, { agent, agents: this.manager.agents.list() });
      }
      const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(pathname);
      if (agentMatch) {
        const id = agentMatch[1];
        if (method === "PUT" || method === "PATCH") {
          const body = await readBody(req);
          const agent = this.manager.agents.update(id, body);
          this.broadcast({ type: "agents", agents: this.manager.agents.list() });
          return sendJson(res, 200, { agent, agents: this.manager.agents.list() });
        }
        if (method === "DELETE") {
          this.manager.agents.remove(id);
          this.broadcast({ type: "agents", agents: this.manager.agents.list() });
          return sendJson(res, 200, { ok: true, agents: this.manager.agents.list() });
        }
      }

      // ===== المزوّدون =====
      if (pathname === "/api/providers") {
        if (method === "GET") return sendJson(res, 200, await this.providers.list());
        if (method === "POST") {
          const body = await readBody(req);
          const provider = await this.providers.add(body);
          this.broadcast({ type: "models", models: this.manager.listModels() });
          return sendJson(res, 201, { provider, ...(await this.providers.list()) });
        }
      }
      const providerKeyMatch = /^\/api\/providers\/([^/]+)\/key$/.exec(pathname);
      if (providerKeyMatch) {
        const id = providerKeyMatch[1];
        if (method === "POST" || method === "PUT") {
          const body = await readBody(req);
          const provider = await this.providers.setKey(id, body.apiKey);
          this.broadcast({ type: "models", models: this.manager.listModels() });
          return sendJson(res, 200, { provider, ...(await this.providers.list()) });
        }
        if (method === "DELETE") {
          await this.providers.clearKey(id);
          this.broadcast({ type: "models", models: this.manager.listModels() });
          return sendJson(res, 200, await this.providers.list());
        }
      }
      const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(pathname);
      if (providerMatch) {
        const id = providerMatch[1];
        if (method === "PUT" || method === "PATCH") {
          const body = await readBody(req);
          const provider = await this.providers.update(id, body);
          this.broadcast({ type: "models", models: this.manager.listModels() });
          return sendJson(res, 200, { provider, ...(await this.providers.list()) });
        }
        if (method === "DELETE") {
          await this.providers.remove(id);
          this.broadcast({ type: "models", models: this.manager.listModels() });
          return sendJson(res, 200, await this.providers.list());
        }
      }

      if (pathname === "/vendor/marked.js") {
        const dist = join(
          config.publicDir,
          "..",
          "node_modules",
          "marked",
          "lib",
          "marked.umd.js",
        );
        return this.serveFile(res, dist, "text/javascript; charset=utf-8");
      }

      const target = pathname === "/" ? "/index.html" : pathname;
      const filePath = safeJoin(config.publicDir, target);
      if (!filePath) return sendJson(res, 400, { error: "bad path" });
      return this.serveFile(res, filePath);
    } catch (err) {
      const message = err?.message || String(err);
      logger.warn("ويب: خطأ في الطلب:", message);
      sendJson(res, 400, { error: message });
    }
  }

  async overview() {
    const providers = await this.providers.list();
    const skills = this.skills.list();
    const agents = this.manager.agents.list();
    const extensionList = this.extensions.list();
    const mcp = this.mcp.list();
    const prompts = countPromptTemplates();
    const sessions = this.manager.listConversations();
    const models = this.manager.listModels();
    return {
      counts: {
        skills: skills.length,
        userSkills: skills.filter((s) => s.scope === "user").length,
        agents: agents.length,
        enabledAgents: agents.filter((a) => a.enabled).length,
        providers: providers.configuredCount,
        allProviders: providers.providers.length,
        customProviders: providers.customCount,
        models: models.length,
        extensions: extensionList.length,
        mcp: mcp.total,
        mcpEnabled: mcp.enabled,
        prompts: prompts.total,
        sessions: sessions.length,
      },
      usage: this.manager.getUsage(),
      limits: this.manager.usage.limits,
      defaults: {
        provider: config.defaultProvider,
        model: config.defaultModel,
        thinking: config.defaultThinking,
      },
      sharedSessionId: config.sharedSessionId,
      syncWebTelegram: config.syncWebTelegram,
      workspace: config.workspace,
      agentDir: config.agentDir,
      skills,
      agents,
      roles: ROLE_TEMPLATES,
      permissions: PERMISSIONS,
      providers: providers.providers,
      apis: KNOWN_APIS,
      models,
      extensions: extensionList,
      mcp,
      prompts,
      sessions,
    };
  }

  async serveFile(res, filePath, overrideType) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
      const data = await readFile(filePath);
      const type = overrideType || MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "content-type": type,
        "cache-control": "no-cache",
        "content-length": data.length,
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404");
    }
  }

  clientConfig() {
    return {
      appName: "Pi",
      language: config.language,
      workspace: config.workspace,
      defaults: {
        provider: config.defaultProvider,
        model: config.defaultModel,
        thinking: config.defaultThinking,
      },
      sharedSessionId: config.sharedSessionId,
      syncWebTelegram: config.syncWebTelegram,
      models: this.manager.listModels(),
      tokenRequired: !!config.web.token,
      supervised: !!config.supervised,
    };
  }

  // ===== WebSocket =====

  handleSocket(ws, req) {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    const url = new URL(req.url || "/ws", `http://${req.headers.host || "localhost"}`);
    const requestedId = url.searchParams.get("conversation");
    const fallbackId =
      config.syncWebTelegram && config.sharedSessionId
        ? config.sharedSessionId
        : `web:${Math.random().toString(36).slice(2, 10)}`;
    const conversationId = (requestedId || fallbackId).slice(0, 120);

    this.clients.set(ws, { conversationId, unsubscribe: null, pendingUI: new Set() });

    const send = (message) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(message));
        } catch {
          /* ignore */
        }
      }
    };

    // إلغاء حوارات الإضافة المعلّقة لهذا الاتصال (عند الانقطاع أو تغيير الجلسة).
    const cancelPendingDialogs = () => {
      const entry = this.clients.get(ws);
      if (!entry?.pendingUI?.size) return;
      const conversation = this.manager.get(entry.conversationId);
      for (const requestId of entry.pendingUI) {
        try {
          const result = conversation?.respondExtensionUI(requestId, { cancelled: true });
          if (result && typeof result.catch === "function") result.catch(() => undefined);
        } catch {
          /* تجاهل: الاتصال انقطع أو الجسر أُغلق */
        }
      }
      entry.pendingUI.clear();
    };

    const bind = async (id) => {
      const existing = this.clients.get(ws);
      existing.unsubscribe?.();
      if (existing.conversationId !== id) cancelPendingDialogs();
      const conversation = this.manager.getOrCreate(id);
      let transcript = [];
      try {
        await conversation.ensure();
        transcript = conversation.getTranscript();
      } catch (err) {
        logger.warn(`ويب: تعذّر تحميل الجلسة ${id}:`, err?.message || err);
      }
      const unsubscribe = conversation.subscribe((event) => {
        send({ type: "event", event });
        if (event.type !== "extension_ui") return;
        // جسر حوارات الامتدادات: رسالة مخصّصة أوضح للعميل + تتبّع الحوارات المعلّقة.
        send({ type: "extension_ui", conversationId: id, request: extensionUiRequest(event) });
        const entry = this.clients.get(ws);
        if (entry?.pendingUI && event.expectsResponse && event.requestId) {
          entry.pendingUI.add(event.requestId);
        }
      });
      existing.conversationId = id;
      existing.unsubscribe = unsubscribe;
      send({
        type: "ready",
        conversationId: id,
        state: conversation.getState(),
        transcript,
        models: this.manager.listModels(),
        sessions: this.manager.listConversations(),
        agents: this.manager.agents.list(),
        agent: conversation.getAgentState(),
        usage: this.manager.getUsage(),
        limits: this.manager.usage.limits,
        sharedSessionId: config.sharedSessionId,
        syncWebTelegram: config.syncWebTelegram,
      });
    };

    bind(conversationId).catch((err) => logger.warn("ويب: فشل الربط:", err?.message || err));

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send({ type: "error", message: "صيغة رسالة غير صالحة" });
      }
      const entry = this.clients.get(ws);
      const conversation = this.manager.getOrCreate(entry.conversationId);
      try {
        switch (msg.type) {
          case "prompt": {
            if (!msg.text || !String(msg.text).trim()) break;
            await conversation.prompt(String(msg.text), { source: "web" });
            break;
          }
          case "abort":
            await conversation.abort();
            break;
          case "new_session":
            await conversation.newSession();
            break;
          case "switch_session":
            await conversation.switchSession(msg.sessionFile);
            break;
          case "set_model": {
            const result = await conversation.setModel(msg.provider, msg.model);
            send({ type: "state", state: conversation.getState() });
            void result;
            break;
          }
          case "set_thinking": {
            await conversation.setThinking(msg.level);
            send({ type: "state", state: conversation.getState() });
            break;
          }
          case "set_agent": {
            const agent = await conversation.setAgent(msg.agentId);
            send({ type: "state", state: conversation.getState() });
            send({ type: "agent", agent });
            send({ type: "notice", message: `تم تفعيل الوكيل: ${agent?.emoji || ""} ${agent?.name || ""}`.trim() });
            break;
          }
          case "reload_resources": {
            const state = await conversation.reloadResources();
            send({ type: "state", state, transcript: conversation.getTranscript() });
            send({ type: "notice", message: "تم إعادة تحميل المهارات والإضافات." });
            break;
          }
          case "get_usage":
            send({
              type: "usage",
              usage: this.manager.getUsage(conversation.getState().contextUsage),
            });
            break;
          case "get_agents":
            send({ type: "agents", agents: this.manager.agents.list() });
            break;
          case "compact":
            send({ type: "notice", message: "جارٍ ضغط السياق…" });
            await conversation.compact();
            send({ type: "notice", message: "تم ضغط السياق." });
            break;
          case "set_title":
            await conversation.setTitle(msg.title);
            break;
          case "list_models":
            send({ type: "models", models: this.manager.listModels() });
            break;
          case "list_sessions":
            send({ type: "sessions", sessions: this.manager.listConversations() });
            break;
          case "restart":
            if (!this.onRestart || !config.supervised) {
              send({ type: "error", message: "إعادة التشغيل متاحة فقط عند التشغيل عبر server.sh." });
              break;
            }
            send({ type: "notice", message: "♻️ جارٍ إعادة تشغيل الخادم…" });
            setTimeout(() => this.onRestart?.("web"), 250);
            break;
          case "extension_ui_response": {
            const requestId = msg.id || msg.requestId;
            if (!requestId) break;
            const payload = msg.cancelled
              ? { cancelled: true }
              : {
                  ...(msg.value !== undefined ? { value: msg.value } : {}),
                  ...(msg.confirmed !== undefined ? { confirmed: !!msg.confirmed } : {}),
                };
            // لا نرسل رداً فارغاً: الإلغاء هو الافتراضي الآمن.
            if (!msg.cancelled && payload.value === undefined && payload.confirmed === undefined) {
              payload.cancelled = true;
            }
            entry?.pendingUI?.delete(requestId);
            await conversation.respondExtensionUI(requestId, payload);
            break;
          }
          case "extension_ui_dismiss":
            // إغلاق محلي (مهلة انتهت في المتصفح): نحرّر الحوار المعلّق.
            // pi يتجاهل الرد إن كان قد حلّ الحوار تلقائياً بمهلته.
            if (msg.id) {
              entry?.pendingUI?.delete(msg.id);
              await conversation.respondExtensionUI(msg.id, { cancelled: true });
            }
            break;
          case "bind":
            await bind(String(msg.conversationId || entry.conversationId));
            break;
          default:
            send({ type: "error", message: `نوع غير معروف: ${msg.type}` });
        }
      } catch (err) {
        send({ type: "error", message: err?.message || String(err) });
      }
    });

    ws.on("close", () => {
      cancelPendingDialogs();
      const entry = this.clients.get(ws);
      entry?.unsubscribe?.();
      this.clients.delete(ws);
    });
    ws.on("error", () => {
      cancelPendingDialogs();
      const entry = this.clients.get(ws);
      entry?.unsubscribe?.();
      this.clients.delete(ws);
    });
  }
}

export default WebServer;
