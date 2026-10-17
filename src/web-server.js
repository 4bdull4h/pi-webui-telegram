import { createServer } from "node:http";
import { readFile, stat, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";

import config from "./config.js";
import logger from "./logger.js";
import { RPC_PASSTHROUGH_COMMANDS } from "./rpc/shared.js";
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
import {
  MAX_IMAGES,
  MAX_TOTAL_BYTES,
  MULTIPART_SLACK_BYTES,
  UploadError,
  isImageMime,
  listWorkspacePaths,
  normalizeAttachments,
  normalizeImage,
  parseMultipart,
  resolveUploadFile,
  saveUploads,
  sniffImageMime,
} from "./uploads.js";

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

/** وصف مختصر لقرار المستخدم في حوار الامتداد (للسجل فقط). */
function describeUiResponse(payload) {
  if (!payload || typeof payload !== "object") return "empty";
  if (payload.cancelled) return "cancelled";
  if (payload.confirmed !== undefined) return payload.confirmed ? "confirmed:true" : "confirmed:false";
  if (payload.value !== undefined) {
    const value = String(payload.value).replace(/\s+/g, " ").trim();
    return `value:${value.slice(0, 60)}`;
  }
  return "empty";
}

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

/* ===== كسر كاش المتصفح للملفات الثابتة ===== */

/** ذاكرة مؤقتة قصيرة لبصمة mtime: لا تتجاوز دقيقة واحدة. */
const BUILD_STAMP_TTL_MS = 60_000;
const buildStamps = new Map(); // path -> { at, token }

/** بصمة إصدار من mtime، مخزّنة مؤقتاً لدقيقة كحد أقصى. */
async function buildStamp(filePath) {
  const now = Date.now();
  const cached = buildStamps.get(filePath);
  if (cached && now - cached.at < BUILD_STAMP_TTL_MS) return cached.token;
  let token = "0";
  try {
    token = String(Math.floor((await stat(filePath)).mtimeMs));
  } catch {
    // ملف غير موجود: بصمة ثابتة (سيُعيد serveFile 404 على أي حال).
  }
  buildStamps.set(filePath, { at: now, token });
  return token;
}

function isInsidePublic(filePath) {
  return filePath === config.publicDir || filePath.startsWith(config.publicDir + sep);
}

/* ===== C2/B3: قواعد موافقة الأدوات (data/approvals.json) ===== */

/**
 * نفس الملف الذي تكتبه extensions/approvals.ts: متغيّر صريح، وإلا DATA_DIR،
 * وإلا مجلد data في جذر المشروع. هذا يبقي الخادم والإضافة متطابقين.
 */
function approvalsFilePath() {
  const explicit = process.env.PI_APPROVALS_FILE || process.env.APPROVALS_FILE;
  if (explicit && explicit.trim()) return resolve(explicit.trim());
  return join(config.dataDir, "approvals.json");
}

function normalizeApprovalRules(parsed) {
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rules)
      ? parsed.rules
      : [];
  const seen = new Set();
  const rules = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const tool = typeof item.tool === "string" ? item.tool.trim() : "";
    const pattern = typeof item.pattern === "string" ? item.pattern.trim() : "";
    if (!tool || !pattern) continue;
    const key = `${tool}\u0000${pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const createdAt = Number(item.createdAt);
    rules.push({ tool, pattern, ...(Number.isFinite(createdAt) ? { createdAt } : {}) });
  }
  return rules;
}

async function readApprovalRules(file = approvalsFilePath()) {
  try {
    return normalizeApprovalRules(JSON.parse(await readFile(file, "utf8")));
  } catch {
    // ملف غائب أو تالف: لا قواعد (السلوك الآمن = طلب موافقة جديد).
    return [];
  }
}

async function writeApprovalRules(rules, file = approvalsFilePath()) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** يقرأ الجسم الخام كـBuffer (للرفع الثنائي) بحد أقصى. */
async function readRawBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const onData = (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.off("data", onData);
        // نتجاهل بقية الجسم بدل قطع الاتصال، حتى يصل رد 413 واضحاً للعميل.
        req.resume();
        reject(new UploadError(413, "حجم الطلب يتجاوز الحد المسموح (40MB للملفات)"));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (done) return;
      done = true;
      resolvePromise(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
    req.on("aborted", () => {
      if (done) return;
      done = true;
      reject(new UploadError(400, "انقطع رفع الملف"));
    });
  });
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

/** يبني نص/صور الطلب القادم من الواجهة مع التحقق من الأحجام والصيغ. */
async function composeWebPrompt(msg) {
  const rawText = typeof msg.text === "string" ? msg.text : msg.text == null ? "" : String(msg.text);
  const rawImages = Array.isArray(msg.images) ? msg.images : [];
  if (rawImages.length > MAX_IMAGES) {
    throw new UploadError(400, `الحد الأقصى ${MAX_IMAGES} صور في الرسالة الواحدة`);
  }

  const images = [];
  let total = 0;
  for (const entry of rawImages) {
    const image = normalizeImage(entry);
    total += image.size;
    if (total > MAX_TOTAL_BYTES) {
      throw new UploadError(413, "مجموع حجم الصور يتجاوز الحد المسموح (40MB)");
    }
    images.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }

  const attachments = await normalizeAttachments(msg.attachments);
  const fileAttachments = attachments.filter((a) => !isImageMime(a.mime));
  const imageAttachments = attachments.filter((a) => isImageMime(a.mime));

  // عميل أرسل مسار صورة فقط (بلا base64): نحوّلها هنا حتى لا تضيع بصمت.
  if (!images.length && imageAttachments.length) {
    for (const attachment of imageAttachments.slice(0, MAX_IMAGES)) {
      const buffer = await readFile(attachment.path).catch(() => null);
      if (!buffer) continue;
      const image = normalizeImage({
        data: buffer.toString("base64"),
        mimeType: sniffImageMime(buffer) || attachment.mime,
      });
      total += image.size;
      if (total > MAX_TOTAL_BYTES) {
        throw new UploadError(413, "مجموع حجم الصور يتجاوز الحد المسموح (40MB)");
      }
      images.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
  }

  let text = rawText;
  if (fileAttachments.length) {
    const line = `📎 مرفقات: ${fileAttachments.map((a) => a.path).join(", ")}`;
    text = text.trim() ? `${text.replace(/\s+$/, "")}\n\n${line}` : line;
  }
  if (!text.trim() && images.length) text = "🖼️ صورة مرفقة";
  if (!text.trim() && !images.length) return null;
  return { text, images };
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

      // ===== C2: قواعد الموافقة المحفوظة (عرض/حذف) — محمية بـWEB_TOKEN =====
      if (pathname === "/api/approvals") {
        const file = approvalsFilePath();
        if (method === "GET") {
          return sendJson(res, 200, { ok: true, path: file, rules: await readApprovalRules(file) });
        }
        if (method === "DELETE") {
          const body = await readBody(req).catch(() => ({}));
          const filePath = approvalsFilePath();
          const current = await readApprovalRules(filePath);
          const tool = typeof body?.tool === "string" ? body.tool.trim() : "";
          const pattern = typeof body?.pattern === "string" ? body.pattern.trim() : "";
          // بلا tool = حذف كل القواعد؛ مع tool/pattern = حذف قاعدة محددة.
          const next = tool
            ? current.filter((rule) => !(rule.tool === tool && (!pattern || rule.pattern === pattern)))
            : [];
          await writeApprovalRules(next, filePath);
          logger.info(`ويب: حُدّثت قواعد الموافقة (${current.length} → ${next.length}).`);
          return sendJson(res, 200, {
            ok: true,
            path: filePath,
            rules: next,
            removed: current.length - next.length,
          });
        }
        return sendJson(res, 405, { ok: false, error: "method not allowed" });
      }

      // ===== B2: رفع الملفات وإكمال المسارات والمعاينة =====
      if (pathname === "/api/upload" && method === "POST") {
        const ctype = String(req.headers["content-type"] || "");
        if (!/^multipart\/form-data/i.test(ctype)) {
          throw new UploadError(415, "يجب إرسال الملفات بصيغة multipart/form-data");
        }
        const boundary =
          /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype)?.slice(1).find(Boolean)?.trim() || "";
        const raw = await readRawBody(req, MAX_TOTAL_BYTES + MULTIPART_SLACK_BYTES);
        const files = await saveUploads(parseMultipart(raw, boundary), { token: config.web.token });
        if (!files.length) throw new UploadError(400, "لم يتم إرسال أي ملف");
        return sendJson(res, 200, { ok: true, files });
      }

      if (pathname === "/api/files" && method === "GET") {
        const items = await listWorkspacePaths(url.searchParams.get("q") || "", {
          limit: url.searchParams.get("limit"),
        });
        return sendJson(res, 200, { ok: true, items });
      }

      const previewMatch = /^\/files\/(.+)$/.exec(pathname);
      if (previewMatch) {
        // المعاينة تعرض ملفات مرفوعة: نحميها بنفس رمز الواجهة إن كان مفعّلاً.
        if (!this.#tokenOk(url)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
        if (method !== "GET") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        const found = await resolveUploadFile(previewMatch[1]);
        if (!found) return sendJson(res, 404, { ok: false, error: "الملف غير موجود" });
        res.writeHead(200, {
          "content-type": found.mime,
          "content-length": found.data.length,
          "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff",
        });
        return res.end(found.data);
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
      const status = Number.isInteger(err?.status) ? err.status : 400;
      if (status >= 500) logger.warn("ويب: خطأ في الطلب:", message);
      else logger.debug("ويب: طلب مرفوض:", message);
      sendJson(res, status, { ok: false, error: message });
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
      const extension = extname(filePath).toLowerCase();
      const type = overrideType || MIME[extension] || "application/octet-stream";
      const inPublic = isInsidePublic(filePath);
      let data = await readFile(filePath);

      // نصوص الواجهة: بصمة إصدار داخل الملف + ربط الأصول ببصمة كل أصل (mtime)
      // حتى لا يبقى المتصفح على نسخة قديمة من app.js.
      if (
        inPublic &&
        (extension === ".html" || extension === ".js" || extension === ".mjs" || extension === ".css")
      ) {
        let text = data.toString("utf8");
        if (extension === ".html") {
          const appVersion = await buildStamp(join(config.publicDir, "app.js"));
          const cssVersion = await buildStamp(join(config.publicDir, "styles.css"));
          text = text
            .replace(/src="\/app\.js"/g, `src="/app.js?v=${appVersion}"`)
            .replace(/href="\/styles\.css"/g, `href="/styles.css?v=${cssVersion}"`);
        }
        text = text.replaceAll("__BUILD__", await buildStamp(filePath));
        data = Buffer.from(text, "utf8");
      }

      const headers = {
        "content-type": type,
        "content-length": data.length,
      };
      if (inPublic) {
        // ملفات public/ متغيّرة أثناء التطوير: منع أي تخزين في المتصفح.
        headers["cache-control"] = "no-store, must-revalidate";
        headers["pragma"] = "no-cache";
      } else {
        headers["cache-control"] = "no-cache";
      }
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404");
    }
  }

  /** عدد عملاء WS المرتبطين حالياً بمحادثة معيّنة. */
  conversationClientCount(conversationId) {
    let count = 0;
    for (const entry of this.clients.values()) {
      if (entry.conversationId === conversationId) count += 1;
    }
    return count;
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

    this.clients.set(ws, { conversationId, unsubscribe: null, pendingUI: new Set(), watchers: new Map() });

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

    // B1: تبويبات متوازية — نراقب جلسات التبويبات غير النشطة دون ربطها بالاتصال.
    const clearWatchers = (entry) => {
      if (!entry?.watchers?.size) return;
      for (const unsubscribe of entry.watchers.values()) {
        try {
          unsubscribe?.();
        } catch {
          /* تجاهل */
        }
      }
      entry.watchers.clear();
    };

    const bind = async (id) => {
      const existing = this.clients.get(ws);
      clearWatchers(existing);
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

        if (!event.expectsResponse) {
          logger.debug("ويب: تحديث واجهة إضافة", { conversationId: id, method: event.method });
          return;
        }
        // تشخيص الموافقة: من المسؤول عن عرض النافذة، وهل يوجد عميل أصلاً؟
        const clients = this.conversationClientCount(id);
        const rawTitle = String(event.title || event.message || "");
        const firstLine = rawTitle
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean) || "";
        logger.info("ويب: بث طلب موافقة", {
          conversationId: id,
          method: event.method,
          title: firstLine.slice(0, 80),
          clients,
        });
        // الجلسة المشتركة قد يعرضها بوت تيليجرام، فلا نطلق تحذيراً مضلّلاً.
        const telegramShared = !!config.syncWebTelegram && config.sharedSessionId === id;
        if (clients === 0 && !telegramShared) {
          logger.warn(
            `ويب: لا عميل متصل لاستلام الموافقة (${id}). ` +
              "افتح الصفحة أو حدّثها (Ctrl+Shift+R) ثم أعد المحاولة، أو أرسل /stop للإلغاء.",
          );
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

      // قد يسبق أول get_messages جاهزية جسر RPC فيعود السجل فارغاً؛
      // نعيد جلبه بعد لحظة ونرسله إن لم يكن قد وصل.
      if (!transcript.length) {
        setTimeout(async () => {
          try {
            const fresh = conversation.refreshTranscript
              ? await conversation.refreshTranscript()
              : conversation.getTranscript();
            if (fresh?.length) send({ type: "transcript", transcript: fresh });
          } catch (err) {
            logger.debug("ويب: تحديث السجل:", err?.message || err);
          }
        }, 900).unref?.();
      }
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
            const composed = await composeWebPrompt(msg);
            if (!composed) break;
            await conversation.prompt(composed.text, {
              source: "web",
              images: composed.images.length ? composed.images : undefined,
            });
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
          case "get_transcript": {
            const transcript = conversation.refreshTranscript
              ? await conversation.refreshTranscript()
              : conversation.getTranscript();
            send({ type: "transcript", transcript });
            break;
          }
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
            logger.info("ويب: قرار الموافقة", {
              conversationId: entry?.conversationId ?? null,
              requestId,
              decision: describeUiResponse(payload),
            });
            await conversation.respondExtensionUI(requestId, payload);
            break;
          }
          case "extension_ui_dismiss":
            // إغلاق محلي (مهلة انتهت في المتصفح): نحرّر الحوار المعلّق.
            // pi يتجاهل الرد إن كان قد حلّ الحوار تلقائياً بمهلته.
            if (msg.id) {
              entry?.pendingUI?.delete(msg.id);
              logger.info("ويب: قرار الموافقة", {
                conversationId: entry?.conversationId ?? null,
                requestId: msg.id,
                decision: "dismissed (مهلة/إغلاق محلي)",
              });
              await conversation.respondExtensionUI(msg.id, { cancelled: true });
            }
            break;
          case "bind":
            await bind(String(msg.conversationId || entry.conversationId));
            break;
          // ===== B1: تمرير RPC عام مسموح =====
          case "rpc": {
            const id = msg.id ?? null;
            const command = String(msg.command || "").trim();
            if (!RPC_PASSTHROUGH_COMMANDS.includes(command)) {
              send({ type: "rpc_error", id, message: `أمر RPC غير مسموح: ${command || "(فارغ)"}` });
              break;
            }
            if (typeof conversation.rpc !== "function") {
              send({
                type: "rpc_error",
                id,
                message: "جسر RPC غير مفعّل (يتطلب FEATURE_RPC=1).",
              });
              break;
            }
            try {
              const data = await conversation.rpc(command, msg.data || {});
              send({ type: "rpc_result", id, ok: true, data: data ?? null });
            } catch (err) {
              send({ type: "rpc_error", id, message: err?.message || String(err) });
            }
            break;
          }
          // ===== B1: مراقبة تبويبات أخرى (عدّاد غير المقروء + حالة الانشغال) =====
          case "watch": {
            clearWatchers(entry);
            const ids = Array.isArray(msg.conversationIds) ? msg.conversationIds : [];
            for (const raw of ids.slice(0, 20)) {
              const id = String(raw || "").slice(0, 120);
              if (!id || id === entry.conversationId || entry.watchers.has(id)) continue;
              // لا ننشئ جلسات جديدة (كي لا نشغّل عمليات pi لكل تبويب مخزّن).
              const watched = this.manager.get(id);
              if (!watched) continue;
              entry.watchers.set(
                id,
                watched.subscribe((event) => send({ type: "event", conversationId: id, event })),
              );
            }
            send({ type: "watching", conversationIds: [...entry.watchers.keys()] });
            break;
          }
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
      clearWatchers(entry);
      entry?.unsubscribe?.();
      this.clients.delete(ws);
    });
    ws.on("error", () => {
      cancelPendingDialogs();
      const entry = this.clients.get(ws);
      clearWatchers(entry);
      entry?.unsubscribe?.();
      this.clients.delete(ws);
    });
  }
}

export default WebServer;
