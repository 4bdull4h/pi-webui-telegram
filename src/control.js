/**
 * مركز التحكم: إدارة المهارات، الوكلاء وملفات الأدوار، مزوّدي النماذج،
 * وتتبّع الاستهلاك اليومي/الأسبوعي وحدود التوكنز.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import os from "node:os";

import config from "./config.js";
import logger from "./logger.js";
import { JsonStore } from "./store.js";

/* =========================================================================
 * أدوات عامة
 * ========================================================================= */

const DAY_MS = 24 * 60 * 60 * 1000;

const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function slugifyId(text, fallback = "item") {
  const raw = String(text ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return raw || `${fallback}-${Date.now().toString(36)}`;
}

function atomicWrite(path, data, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, { encoding: "utf8", mode });
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    /* ignore */
  }
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return structuredClone(fallback);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(path, data, mode = 0o644) {
  atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`, mode);
}

function walkFiles(dir, { depth = 3, extensions = null } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const visit = (current, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
      if (entry.name === "node_modules" || entry.name === "data") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, level + 1);
      } else if (entry.isFile()) {
        if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
          out.push(full);
        }
      }
    }
  };
  visit(dir, 1);
  return out;
}

function safeInside(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

/* =========================================================================
 * المهارات
 * ========================================================================= */

function parseSkillFile(file) {
  const text = readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = {};
  let body = text;
  if (match) {
    body = match[2] || "";
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      let value = line.slice(colon + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value === ">" || value === "|") value = "";
      meta[key] = value;
    }
  }
  return { meta, body: body.trimStart() };
}

function skillMarkdown({ id, description, instructions, license, meta = {} }) {
  const cleanDescription = String(description || "").replace(/\s+/g, " ").trim().slice(0, 1024);
  const lines = [
    "---",
    `name: ${id}`,
    `description: ${cleanDescription || `مهارة ${id}`}`,
  ];
  if (license) lines.push(`license: ${String(license).replace(/\s+/g, " ").trim()}`);
  for (const [key, value] of Object.entries(meta || {})) {
    if (["name", "description", "license"].includes(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}: ${String(value).replace(/\s+/g, " ").trim()}`);
  }
  lines.push("---", "", `# ${id}`, "", String(instructions || "").trim(), "");
  return lines.join("\n");
}

export class SkillManager {
  constructor() {
    this.userDir = join(config.agentDir, "skills");
    this.projectDir = join(config.workspace, ".pi", "skills");
    this.agentsDir = join(os.homedir(), ".agents", "skills");
  }

  locations() {
    return [
      { scope: "user", label: "مهارات المستخدم", dir: this.userDir, editable: true },
      { scope: "project", label: "مهارات المشروع", dir: this.projectDir, editable: false },
      { scope: "agents", label: "مهارات .agents", dir: this.agentsDir, editable: false },
    ];
  }

  list() {
    const results = [];
    const seen = new Set();
    for (const location of this.locations()) {
      const files = walkFiles(location.dir, { depth: 3, extensions: null }).filter(
        (file) => basename(file) === "SKILL.md",
      );
      for (const file of files) {
        try {
          const { meta, body } = parseSkillFile(file);
          const dir = dirname(file);
          const dirName = basename(dir);
          const id = meta.name || dirName;
          const key = `${location.scope}:${id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            id,
            name: meta.name || dirName,
            description: meta.description || "",
            scope: location.scope,
            scopeLabel: location.label,
            editable: location.editable,
            path: file,
            relativePath: file.slice(location.dir.length + 1),
            modelInvocation: String(meta["disable-model-invocation"] || "").toLowerCase() !== "true",
            license: meta.license || "",
            size: statSync(file).size,
            updatedAt: statSync(file).mtimeMs,
          });
        } catch (err) {
          logger.debug(`تعذّرت قراءة المهارة ${file}:`, err?.message || err);
        }
      }
    }
    return results.sort((a, b) => {
      if (a.scope === "user" && b.scope !== "user") return -1;
      if (b.scope === "user" && a.scope !== "user") return 1;
      return a.id.localeCompare(b.id);
    });
  }

  get(id) {
    const found = this.list().find((skill) => skill.id === id && skill.scope === "user");
    if (!found) return null;
    const { body } = parseSkillFile(found.path);
    return { ...found, instructions: body };
  }

  #userPath(id) {
    const safe = String(id);
    if (!SKILL_ID_RE.test(safe)) throw new Error("معرّف المهارة يجب أن يكون حروفاً إنجليزية صغيرة وأرقاماً وشرطات فقط.");
    const dir = join(this.userDir, safe);
    if (!safeInside(this.userDir, dir)) throw new Error("مسار غير صالح.");
    return { dir, file: join(dir, "SKILL.md") };
  }

  create({ id, description, instructions, license }) {
    const finalId = id ? String(id).trim() : slugifyId(description || "skill");
    const { dir, file } = this.#userPath(finalId);
    if (existsSync(dir)) throw new Error(`المهارة موجودة بالفعل: ${finalId}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, skillMarkdown({ id: finalId, description, instructions, license }), "utf8");
    return this.get(finalId);
  }

  update(id, { description, instructions, license }) {
    const existing = this.get(id);
    if (!existing) throw new Error(`المهارة غير موجودة: ${id}`);
    const { file } = this.#userPath(id);
    const { meta } = parseSkillFile(file);
    writeFileSync(
      file,
      skillMarkdown({
        id,
        description: description ?? existing.description,
        instructions: instructions ?? existing.instructions,
        license: license ?? existing.license,
        meta,
      }),
      "utf8",
    );
    return this.get(id);
  }

  remove(id) {
    const existing = this.get(id);
    if (!existing) throw new Error(`المهارة غير موجودة أو غير قابلة للحذف: ${id}`);
    const { dir } = this.#userPath(id);
    if (!safeInside(this.userDir, dir)) throw new Error("مسار غير صالح.");
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

/* =========================================================================
 * الوكلاء والأدوار والصلاحيات
 * ========================================================================= */

export const PERMISSIONS = [
  { key: "read", label: "القراءة", icon: "📖", hint: "قراءة الملفات والبحث والاستكشاف" },
  { key: "write", label: "الكتابة", icon: "✍️", hint: "إنشاء الملفات وتعديلها" },
  { key: "execute", label: "التنفيذ", icon: "⚡", hint: "تشغيل الأوامر والاختبارات" },
  { key: "network", label: "الشبكة", icon: "🌐", hint: "البحث في الويب وجلب الصفحات" },
  { key: "mcp", label: "أدوات MCP", icon: "🔗", hint: "استخدام أدوات خوادم MCP" },
  { key: "delegate", label: "التفويض", icon: "🔀", hint: "تفويض مهام إلى وكلاء آخرين" },
  { key: "approve", label: "الموافقة", icon: "✅", hint: "اعتماد النتائج وإغلاق المهام" },
];

const DEFAULT_PERMISSIONS = {
  read: true,
  write: false,
  execute: false,
  network: false,
  mcp: false,
  delegate: false,
  approve: false,
};

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export const ROLE_TEMPLATES = [
  {
    id: "leader",
    name: "القائد",
    emoji: "👑",
    description: "يوزّع المهام، يفوّضها للوكلاء، يراجع النتائج ويتخذ القرار النهائي.",
    systemPrompt:
      "أنت القائد (الرئيس). مهمتك تحليل الطلب وتقسيمه إلى مهام واضحة، ثم تفويض كل مهمة إلى الوكيل الأنسب عبر أداة delegate. لا تنفّذ كل شيء بنفسك؛ راجع مخرجات الوكلاء، تحقق من اتساقها، واجمع النتيجة النهائية للمستخدم. اذكر دائماً من فعل ماذا.",
    permissions: { read: true, write: true, execute: true, network: true, mcp: true, delegate: true, approve: true },
    thinking: "high",
  },
  {
    id: "planner",
    name: "المخطط",
    emoji: "🗺️",
    description: "يحلل المتطلبات ويضع خطة تنفيذ تفصيلية دون تعديل الملفات.",
    systemPrompt:
      "أنت المخطط. حلّل الطلب بعمق واقرأ الملفات ذات الصلة، ثم أنتج خطة مرقّمة وقابلة للتنفيذ: الخطوات، الملفات المتأثرة، المخاطر، ومعايير القبول. لا تعدّل الملفات ولا تشغّل أوامر تغييرية. اجعل خطتك واضحة بما يكفي لينفّذها وكيل آخر دون أسئلة.",
    permissions: { read: true, write: false, execute: false, network: true, mcp: false, delegate: false, approve: false },
    thinking: "high",
  },
  {
    id: "executor",
    name: "المنفذ",
    emoji: "⚙️",
    description: "ينفّذ الخطة ويعدّل الملفات ويشغّل الأوامر والاختبارات.",
    systemPrompt:
      "أنت المنفذ. التزم بالخطة المطلوبة ونفّذها بدقة. عدّل الملفات اللازمة، شغّل الاختبارات، وأبلغ عن أي عقبة فوراً. لا تغيّر نطاق المهمة دون إذن. عند الانتهاء لخّص ما غيّرته وأمر التحقق.",
    permissions: { read: true, write: true, execute: true, network: false, mcp: true, delegate: false, approve: false },
    thinking: "medium",
  },
  {
    id: "reviewer",
    name: "المراجع",
    emoji: "🧪",
    description: "يفحص الكود والنتائج ويتحقق من الجودة والأمان دون تعديل.",
    systemPrompt:
      "أنت المراجع. افحص التغييرات والملفات والنتائج بصرامة. ابحث عن الأخطاء المنطقية، الثغرات الأمنية، حالات الحافة، وضعف الاختبارات. لا تعدّل الملفات. صنّف الملاحظات إلى: حرجة، مهمة، تحسين، واقترح إصلاحاً مختصراً لكل ملاحظة.",
    permissions: { read: true, write: false, execute: true, network: false, mcp: true, delegate: false, approve: false },
    thinking: "high",
  },
  {
    id: "researcher",
    name: "الباحث",
    emoji: "🔎",
    description: "يبحث في الويب والوثائق ويجمع المصادر والمعلومات.",
    systemPrompt:
      "أنت الباحث. اجمع المعلومات من الويب والوثائق، وثّق المصادر، وقارن بينها. قدّم ملخصاً منظماً مع روابط ودرجة ثقة. لا تعدّل ملفات المشروع.",
    permissions: { read: true, write: false, execute: false, network: true, mcp: true, delegate: false, approve: false },
    thinking: "medium",
  },
  {
    id: "custom",
    name: "مخصص",
    emoji: "🧩",
    description: "دور مخصص تحدّد صلاحياته وتعليماته بنفسك.",
    systemPrompt: "أنت وكيل مخصص ضمن فريق. التزم بالتعليمات والصلاحيات الممنوحة لك.",
    permissions: { ...DEFAULT_PERMISSIONS },
    thinking: "medium",
  },
];

function normalizePermissions(input) {
  const out = {};
  for (const key of PERMISSION_KEYS) out[key] = !!(input && input[key]);
  return out;
}

function normalizeAgent(input, existing = null) {
  const role = ROLE_TEMPLATES.some((r) => r.id === input.role) ? input.role : existing?.role || "custom";
  const template = ROLE_TEMPLATES.find((r) => r.id === role) || ROLE_TEMPLATES.at(-1);
  const id = input.id
    ? String(input.id).trim()
    : existing?.id || slugifyId(input.name || input.description || role, "agent");
  if (!AGENT_ID_RE.test(id)) throw new Error("معرّف الوكيل غير صالح.");
  const permissions = input.permissions
    ? normalizePermissions(input.permissions)
    : existing?.permissions || { ...template.permissions };
  const model =
    input.model && input.model.provider && input.model.model
      ? { provider: String(input.model.provider), model: String(input.model.model) }
      : input.model === null
        ? null
        : existing?.model || null;
  return {
    id,
    name: String(input.name || existing?.name || template.name).trim().slice(0, 80),
    role,
    emoji: String(input.emoji || existing?.emoji || template.emoji).slice(0, 8),
    description: String(input.description ?? existing?.description ?? template.description).trim().slice(0, 400),
    systemPrompt: String(input.systemPrompt ?? existing?.systemPrompt ?? template.systemPrompt).trim().slice(0, 12000),
    permissions,
    extraTools: Array.isArray(input.extraTools)
      ? input.extraTools.map((t) => String(t).trim()).filter(Boolean).slice(0, 30)
      : existing?.extraTools || [],
    model,
    thinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.thinking)
      ? input.thinking
      : existing?.thinking || template.thinking,
    enabled: input.enabled === undefined ? existing?.enabled !== false : !!input.enabled,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

function defaultAgents() {
  return ROLE_TEMPLATES.filter((r) => r.id !== "custom").map((template) => ({
    ...normalizeAgent(
      {
        id: template.id,
        name: template.name,
        role: template.id,
        emoji: template.emoji,
        description: template.description,
        systemPrompt: template.systemPrompt,
        permissions: template.permissions,
        thinking: template.thinking,
        enabled: true,
      },
      null,
    ),
    createdAt: Date.now(),
  }));
}

export class AgentRegistry {
  constructor(file) {
    this.file = file;
    this.store = new JsonStore(file, { agents: [] });
    this.#seed();
  }

  #seed() {
    const agents = this.store.get("agents", []);
    if (!Array.isArray(agents) || agents.length === 0) {
      this.store.set("agents", defaultAgents());
      this.store.flush();
      return;
    }
    // ترقية آمنة: تأكد من وجود كل مفاتيح الصلاحيات في الوكلاء القدامى.
    let changed = false;
    for (const agent of agents) {
      const template = ROLE_TEMPLATES.find((role) => role.id === agent.role) || ROLE_TEMPLATES.at(-1);
      const current = agent.permissions || {};
      const permissions = {};
      for (const key of PERMISSION_KEYS) {
        permissions[key] = typeof current[key] === "boolean" ? current[key] : !!template?.permissions?.[key];
        if (permissions[key] !== current[key]) changed = true;
      }
      agent.permissions = permissions;
    }
    if (changed) {
      this.store.set("agents", agents);
      this.store.flush();
    }
  }

  #all() {
    const agents = this.store.get("agents", []);
    return Array.isArray(agents) ? agents : [];
  }

  #save(agents) {
    this.store.set("agents", agents);
    this.store.flush();
  }

  list() {
    return this.#all().map((agent) => ({ ...agent, tools: this.toolsFor(agent) }));
  }

  get(id) {
    if (!id) return null;
    return this.#all().find((agent) => agent.id === id) || null;
  }

  defaultAgent() {
    const agents = this.#all();
    return agents.find((agent) => agent.id === "leader") || agents.find((agent) => agent.enabled) || agents[0] || null;
  }

  defaultId() {
    return this.defaultAgent()?.id || "leader";
  }

  create(input) {
    const agent = normalizeAgent(input);
    if (this.get(agent.id)) throw new Error(`معرّف الوكيل مستخدم بالفعل: ${agent.id}`);
    const agents = this.#all();
    agents.push(agent);
    this.#save(agents);
    return { ...agent, tools: this.toolsFor(agent) };
  }

  update(id, input) {
    const agents = this.#all();
    const index = agents.findIndex((agent) => agent.id === id);
    if (index === -1) throw new Error(`الوكيل غير موجود: ${id}`);
    const updated = normalizeAgent({ ...input, id: input.id || id }, agents[index]);
    agents[index] = updated;
    this.#save(agents);
    return { ...updated, tools: this.toolsFor(updated) };
  }

  duplicate(id) {
    const source = this.get(id);
    if (!source) throw new Error(`الوكيل غير موجود: ${id}`);
    const copy = normalizeAgent(
      {
        ...source,
        id: `${source.id}-copy`.slice(0, 64),
        name: `${source.name} (نسخة)`,
      },
      null,
    );
    let candidate = copy.id;
    let n = 2;
    while (this.get(candidate)) {
      candidate = `${copy.id}-${n++}`.slice(0, 64);
    }
    copy.id = candidate;
    const agents = this.#all();
    agents.push(copy);
    this.#save(agents);
    return { ...copy, tools: this.toolsFor(copy) };
  }

  remove(id) {
    const agents = this.#all();
    const next = agents.filter((agent) => agent.id !== id);
    if (next.length === agents.length) throw new Error(`الوكيل غير موجود: ${id}`);
    if (next.length === 0) throw new Error("لا يمكن حذف كل الوكلاء.");
    this.#save(next);
    return true;
  }

  toolsFor(agent) {
    if (!agent) return [];
    const p = agent.permissions || {};
    const tools = [];
    if (p.read) tools.push("read", "grep", "find", "ls");
    if (p.write) tools.push("write", "edit");
    if (p.execute) tools.push("bash");
    if (p.network) tools.push("web_search", "web_fetch");
    if (p.mcp) tools.push("mcp__*");
    if (p.delegate) tools.push("delegate");
    for (const extra of agent.extraTools || []) if (!tools.includes(extra)) tools.push(extra);
    return [...new Set(tools)];
  }
}

/* =========================================================================
 * تتبّع الاستهلاك والحدود
 * ========================================================================= */

const DEFAULT_LIMITS = {
  dailyTokens: 1_000_000,
  weeklyTokens: 5_000_000,
  dailyCost: 0,
  weeklyCost: 0,
};

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** الأسبوع يبدأ الأحد (المعتاد في المنطقة العربية). */
function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class UsageTracker {
  constructor(file) {
    this.file = file;
    this.store = new JsonStore(file, { events: [], limits: { ...DEFAULT_LIMITS }, seededAt: null });
    this.listeners = new Set();
  }

  get limits() {
    return { ...DEFAULT_LIMITS, ...(this.store.get("limits", {}) || {}) };
  }

  setLimits(patch) {
    const next = { ...this.limits };
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      if (patch[key] !== undefined) next[key] = Math.max(0, num(patch[key]));
    }
    this.store.set("limits", next);
    this.store.flush();
    this.#emit();
    return next;
  }

  get events() {
    const events = this.store.get("events", []);
    return Array.isArray(events) ? events : [];
  }

  #saveEvents(events) {
    const cutoff = Date.now() - 120 * DAY_MS;
    const kept = events
      .filter((event) => event && num(event.ts) >= cutoff)
      .slice(-50_000);
    this.store.set("events", kept);
    this.store.flush();
  }

  record({ ts = Date.now(), conversationId = "", agentId = "unknown", provider = "unknown", model = "unknown", usage = {}, source = "live" }) {
    const tokens = {
      input: num(usage.input),
      output: num(usage.output),
      cacheRead: num(usage.cacheRead),
      cacheWrite: num(usage.cacheWrite),
      total: num(usage.totalTokens) || num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite),
    };
    const cost = num(usage.cost?.total);
    if (!tokens.total && !cost) return;
    const events = this.events;
    events.push({
      ts: num(ts) || Date.now(),
      conversationId: String(conversationId || ""),
      agentId: String(agentId || "unknown"),
      provider: String(provider || "unknown"),
      model: String(model || "unknown"),
      tokens,
      cost,
      source,
    });
    this.#saveEvents(events);
    this.#emit();
  }

  /** يستورد الاستهلاك من ملفات الجلسات الموجودة مرة واحدة فقط. */
  seedFromSessions(sessionsRoot) {
    if (this.store.get("seededAt")) return 0;
    let count = 0;
    const files = walkFiles(sessionsRoot, { depth: 3, extensions: [".jsonl"] });
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry?.type !== "message") continue;
        const message = entry.message;
        if (message?.role !== "assistant" || !message.usage) continue;
        const ts = Date.parse(entry.timestamp) || Date.now();
        const usage = message.usage;
        const tokens = {
          input: num(usage.input),
          output: num(usage.output),
          cacheRead: num(usage.cacheRead),
          cacheWrite: num(usage.cacheWrite),
          total:
            num(usage.totalTokens) ||
            num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite),
        };
        if (!tokens.total && !num(usage.cost?.total)) continue;
        this.events.push({
          ts,
          conversationId: basename(dirname(file)),
          agentId: "unknown",
          provider: message.provider || "unknown",
          model: message.model || "unknown",
          tokens,
          cost: num(usage.cost?.total),
          source: "seed",
        });
        count++;
      }
    }
    if (count) {
      const events = this.events;
      this.#saveEvents(events);
    }
    this.store.set("seededAt", Date.now());
    this.store.flush();
    logger.info(`الاستهلاك: تم استيراد ${count} سجلاً من الجلسات السابقة.`);
    return count;
  }

  #aggregate(from) {
    const agg = {
      tokens: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      requests: 0,
    };
    for (const event of this.events) {
      if (num(event.ts) < from) continue;
      agg.tokens += num(event.tokens?.total);
      agg.input += num(event.tokens?.input);
      agg.output += num(event.tokens?.output);
      agg.cacheRead += num(event.tokens?.cacheRead);
      agg.cacheWrite += num(event.tokens?.cacheWrite);
      agg.cost += num(event.cost);
      agg.requests++;
    }
    return agg;
  }

  summary(context = null) {
    const now = Date.now();
    const dayStart = startOfDay(now);
    const weekStart = startOfWeek(now);
    const limits = this.limits;
    const daily = this.#aggregate(dayStart);
    const weekly = this.#aggregate(weekStart);

    const decorate = (agg, tokenLimit, costLimit, resetAt) => {
      const remainingTokens = tokenLimit > 0 ? Math.max(0, tokenLimit - agg.tokens) : null;
      const remainingCost = costLimit > 0 ? Math.max(0, costLimit - agg.cost) : null;
      return {
        ...agg,
        tokenLimit,
        costLimit,
        remainingTokens,
        remainingCost,
        percentTokens: tokenLimit > 0 ? Math.min(100, (agg.tokens / tokenLimit) * 100) : null,
        percentCost: costLimit > 0 ? Math.min(100, (agg.cost / costLimit) * 100) : null,
        resetAt,
      };
    };

    const series = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(dayStart);
      day.setDate(day.getDate() - i);
      const from = day.getTime();
      const to = from + DAY_MS;
      let tokens = 0;
      let cost = 0;
      let requests = 0;
      for (const event of this.events) {
        const ts = num(event.ts);
        if (ts < from || ts >= to) continue;
        tokens += num(event.tokens?.total);
        cost += num(event.cost);
        requests++;
      }
      series.push({
        date: new Date(from).toISOString().slice(0, 10),
        tokens,
        cost,
        requests,
      });
    }

    const byProviderMap = new Map();
    const byModelMap = new Map();
    const byAgentMap = new Map();
    for (const event of this.events) {
      if (num(event.ts) < weekStart) continue;
      const provider = event.provider || "unknown";
      const model = event.model || "unknown";
      const agentId = event.agentId || "unknown";
      const p = byProviderMap.get(provider) || { provider, tokens: 0, cost: 0, requests: 0 };
      p.tokens += num(event.tokens?.total);
      p.cost += num(event.cost);
      p.requests++;
      byProviderMap.set(provider, p);
      const m = byModelMap.get(model) || { model, provider, tokens: 0, cost: 0, requests: 0 };
      m.tokens += num(event.tokens?.total);
      m.cost += num(event.cost);
      m.requests++;
      byModelMap.set(model, m);
      const a = byAgentMap.get(agentId) || { agent: agentId, agentId, tokens: 0, cost: 0, requests: 0 };
      a.tokens += num(event.tokens?.total);
      a.cost += num(event.cost);
      a.requests++;
      byAgentMap.set(agentId, a);
    }

    const totalAll = this.events.reduce(
      (acc, event) => {
        acc.tokens += num(event.tokens?.total);
        acc.cost += num(event.cost);
        acc.requests++;
        return acc;
      },
      { tokens: 0, cost: 0, requests: 0 },
    );

    return {
      now,
      limits,
      daily: decorate(daily, num(limits.dailyTokens), num(limits.dailyCost), dayStart + DAY_MS),
      weekly: decorate(weekly, num(limits.weeklyTokens), num(limits.weeklyCost), weekStart + 7 * DAY_MS),
      series,
      byProvider: [...byProviderMap.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8),
      byModel: [...byModelMap.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8),
      byAgent: [...byAgentMap.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12),
      totalAll,
      context: context || null,
    };
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.listeners) {
      try {
        listener(this.summary());
      } catch {
        /* ignore */
      }
    }
  }
}

/* =========================================================================
 * مزوّدو النماذج
 * ========================================================================= */

export const KNOWN_APIS = [
  { id: "openai-completions", label: "OpenAI Compatible (Chat Completions)" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
  { id: "azure-openai-responses", label: "Azure OpenAI Responses" },
  { id: "mistral-conversations", label: "Mistral Conversations" },
  { id: "bedrock-converse-stream", label: "Amazon Bedrock" },
  { id: "google-vertex", label: "Google Vertex" },
  { id: "openai-codex-responses", label: "OpenAI Codex Responses" },
];

function maskValue(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.startsWith("$") || text.startsWith("!")) return text;
  if (text.length <= 4) return "••••";
  return `••••${text.slice(-4)}`;
}

export class ProviderManager {
  constructor(manager) {
    this.manager = manager;
    this.modelsPath = join(config.agentDir, "models.json");
    this.authPath = join(config.agentDir, "auth.json");
  }

  #readModels() {
    const data = readJson(this.modelsPath, { $schema: "https://pi.dev/schemas/models.schema.json", providers: {} });
    if (!data.providers || typeof data.providers !== "object") data.providers = {};
    return data;
  }

  #readAuth() {
    return readJson(this.authPath, {});
  }

  #writeModels(data) {
    writeJson(this.modelsPath, data, 0o644);
  }

  #writeAuth(data) {
    writeJson(this.authPath, data, 0o600);
  }

  #previewCredential(credential) {
    if (!credential) return null;
    if (credential.type === "api_key") {
      return credential.key ? maskValue(credential.key) : "مفتاح محفوظ";
    }
    if (credential.type === "oauth") return "OAuth";
    return credential.type || "محفوظ";
  }

  #authPreview(providerId) {
    return this.#previewCredential(this.#readAuth()[providerId]);
  }

  #providerKeyPreview(providerId, configEntry) {
    if (configEntry?.apiKey) return maskValue(configEntry.apiKey);
    return this.#authPreview(providerId);
  }

  async list() {
    const modelsJson = this.#readModels();
    const auth = this.#readAuth();
    const models = this.manager.listModels();
    const allProviders = this.manager.runtime?.getProviders?.() || [];
    const map = new Map();

    for (const provider of allProviders) {
      map.set(provider.id, {
        id: provider.id,
        name: provider.name || provider.id,
        custom: !!modelsJson.providers[provider.id],
        configured: false,
        authSource: null,
        keyPreview: null,
        baseUrl: modelsJson.providers[provider.id]?.baseUrl || provider.baseUrl || "",
        api: modelsJson.providers[provider.id]?.api || "",
        models: [],
        modelCount: 0,
      });
    }

    for (const [providerId, configEntry] of Object.entries(modelsJson.providers || {})) {
      if (!map.has(providerId)) {
        map.set(providerId, {
          id: providerId,
          name: configEntry.name || providerId,
          custom: true,
          configured: false,
          authSource: null,
          keyPreview: null,
          baseUrl: configEntry.baseUrl || "",
          api: configEntry.api || "",
          models: [],
          modelCount: 0,
        });
      }
    }

    for (const model of models) {
      const entry = map.get(model.provider);
      if (!entry) continue;
      entry.models.push({
        id: model.id,
        name: model.name || model.id,
        reasoning: !!model.reasoning,
        vision: !!model.vision,
        contextWindow: model.contextWindow || 128000,
        maxTokens: model.maxTokens || 8192,
      });
    }

    // أضف تعريفات النماذج المحفوظة في models.json حتى لو لم تكن متاحة بعد
    // (مثلاً مزوّد محلي لم يُشغّل بعد)، حتى يستطيع المستخدم تعديلها.
    for (const [providerId, configEntry] of Object.entries(modelsJson.providers || {})) {
      const entry = map.get(providerId);
      if (!entry || !Array.isArray(configEntry.models)) continue;
      for (const model of configEntry.models) {
        if (!model?.id || entry.models.some((item) => item.id === model.id)) continue;
        entry.models.push({
          id: model.id,
          name: model.name || model.id,
          reasoning: !!model.reasoning,
          vision: Array.isArray(model.input) && model.input.includes("image"),
          contextWindow: model.contextWindow || 128000,
          maxTokens: model.maxTokens || 8192,
        });
      }
    }

    for (const entry of map.values()) {
      const status = this.manager.runtime?.getProviderAuthStatus?.(entry.id) || { configured: false };
      const configEntry = modelsJson.providers[entry.id];
      entry.configured = !!status.configured || !!configEntry?.apiKey || !!auth[entry.id];
      entry.authSource = status.source || (configEntry?.apiKey ? "models_json_key" : auth[entry.id] ? "stored" : null);
      entry.keyPreview = configEntry?.apiKey ? maskValue(configEntry.apiKey) : this.#previewCredential(auth[entry.id]);
      entry.modelCount = entry.models.length;
      entry.models.sort((a, b) => a.id.localeCompare(b.id));
      entry.configModels = (modelsJson.providers[entry.id]?.models || []).map((model) => ({
        id: model.id,
        name: model.name || model.id,
        reasoning: !!model.reasoning,
        vision: Array.isArray(model.input) && model.input.includes("image"),
        contextWindow: model.contextWindow || 128000,
        maxTokens: model.maxTokens || 8192,
      }));
    }

    const providers = [...map.values()].sort((a, b) => {
      if (a.configured !== b.configured) return a.configured ? -1 : 1;
      if (a.custom !== b.custom) return a.custom ? -1 : 1;
      if (a.modelCount !== b.modelCount) return b.modelCount - a.modelCount;
      return a.id.localeCompare(b.id);
    });

    return {
      providers,
      configuredCount: providers.filter((p) => p.configured).length,
      customCount: providers.filter((p) => p.custom).length,
      models,
      apis: KNOWN_APIS,
    };
  }

  #validate(input, existing = null) {
    const id = String(input.id || existing?.id || "").trim();
    if (!PROVIDER_ID_RE.test(id)) {
      throw new Error("معرّف المزوّد يجب أن يكون حروفاً إنجليزية صغيرة وأرقاماً ونقاطاً/شرطات فقط.");
    }
    const models = Array.isArray(input.models) ? input.models : existing?.models || [];
    if (!models.length) throw new Error("أضف نموذجاً واحداً على الأقل.");
    const cleanModels = models.map((model) => {
      const modelId = String(model.id || "").trim();
      if (!modelId) throw new Error("معرّف النموذج مطلوب.");
      return {
        id: modelId,
        name: String(model.name || modelId).trim(),
        input: model.vision ? ["text", "image"] : ["text"],
        reasoning: !!model.reasoning,
        contextWindow: Math.max(1, num(model.contextWindow) || 128000),
        maxTokens: Math.max(1, num(model.maxTokens) || 8192),
        cost: {
          input: num(model.cost?.input),
          output: num(model.cost?.output),
          cacheRead: num(model.cost?.cacheRead),
          cacheWrite: num(model.cost?.cacheWrite),
        },
      };
    });
    return { id, cleanModels };
  }

  async add(input) {
    const { id, cleanModels } = this.#validate(input);
    const modelsJson = this.#readModels();
    if (modelsJson.providers[id]) throw new Error(`المزوّد موجود بالفعل: ${id}`);
    const entry = {
      name: String(input.name || id).trim(),
      baseUrl: String(input.baseUrl || "").trim(),
      api: String(input.api || "openai-completions").trim(),
      models: cleanModels,
    };
    if (!entry.baseUrl) throw new Error("عنوان baseUrl مطلوب للمزوّد الجديد.");
    try {
      new URL(entry.baseUrl);
    } catch {
      throw new Error("عنوان baseUrl غير صالح. مثال: http://localhost:11434/v1");
    }
    if (input.noKey || !input.apiKey) {
      if (input.noKey) entry.apiKey = "local";
    }
    const previousModels = JSON.stringify(modelsJson);
    const auth = this.#readAuth();
    const previousAuth = JSON.stringify(auth);
    modelsJson.providers[id] = entry;
    this.#writeModels(modelsJson);
    if (input.apiKey && !input.noKey) {
      if (String(input.apiKey).startsWith("$") || String(input.apiKey).startsWith("!")) {
        entry.apiKey = String(input.apiKey).trim();
        this.#writeModels(modelsJson);
      } else {
        auth[id] = { type: "api_key", key: String(input.apiKey).trim() };
        this.#writeAuth(auth);
      }
    }
    try {
      await this.reload();
    } catch (err) {
      this.#writeModels(JSON.parse(previousModels));
      this.#writeAuth(JSON.parse(previousAuth));
      await this.reload().catch(() => undefined);
      throw new Error(`تعذّر تحميل المزوّد: ${err?.message || err}`);
    }
    return (await this.list()).providers.find((p) => p.id === id) || null;
  }

  async update(id, input) {
    const modelsJson = this.#readModels();
    const existing = modelsJson.providers[id];
    const current = existing || { id };
    const { cleanModels } = this.#validate({ ...input, id }, current);
    const previousModels = JSON.stringify(modelsJson);
    const auth = this.#readAuth();
    const previousAuth = JSON.stringify(auth);

    const entry = {
      ...existing,
      name: String(input.name ?? existing?.name ?? id).trim(),
      baseUrl: String(input.baseUrl ?? existing?.baseUrl ?? "").trim(),
      api: String(input.api ?? existing?.api ?? "openai-completions").trim(),
      models: cleanModels,
    };
    if (input.apiKey) {
      if (input.apiKey.startsWith("$") || input.apiKey.startsWith("!")) {
        entry.apiKey = String(input.apiKey).trim();
        delete auth[id];
      } else {
        auth[id] = { type: "api_key", key: String(input.apiKey).trim() };
        delete entry.apiKey;
      }
    }
    if (entry.baseUrl) {
      try {
        new URL(entry.baseUrl);
      } catch {
        throw new Error("عنوان baseUrl غير صالح.");
      }
    }
    if (input.noKey) {
      entry.apiKey = "local";
      delete auth[id];
    }
    modelsJson.providers[id] = entry;
    this.#writeModels(modelsJson);
    if (input.apiKey) this.#writeAuth(auth);
    try {
      await this.reload();
    } catch (err) {
      this.#writeModels(JSON.parse(previousModels));
      this.#writeAuth(JSON.parse(previousAuth));
      await this.reload().catch(() => undefined);
      throw new Error(`تعذّر تحديث المزوّد: ${err?.message || err}`);
    }
    return (await this.list()).providers.find((p) => p.id === id) || null;
  }

  async remove(id) {
    const modelsJson = this.#readModels();
    if (!modelsJson.providers[id]) throw new Error(`لا يمكن حذف مزوّد مدمج: ${id}`);
    const previousModels = JSON.stringify(modelsJson);
    delete modelsJson.providers[id];
    this.#writeModels(modelsJson);
    const auth = this.#readAuth();
    const previousAuth = JSON.stringify(auth);
    delete auth[id];
    this.#writeAuth(auth);
    try {
      await this.reload();
    } catch (err) {
      this.#writeModels(JSON.parse(previousModels));
      this.#writeAuth(JSON.parse(previousAuth));
      await this.reload().catch(() => undefined);
      throw new Error(`تعذّر حذف المزوّد: ${err?.message || err}`);
    }
    return true;
  }

  async setKey(id, apiKey) {
    const key = String(apiKey || "").trim();
    if (!key) throw new Error("المفتاح مطلوب.");
    const auth = this.#readAuth();
    auth[id] = { type: "api_key", key };
    this.#writeAuth(auth);
    await this.reload();
    return (await this.list()).providers.find((p) => p.id === id) || null;
  }

  async clearKey(id) {
    const auth = this.#readAuth();
    delete auth[id];
    this.#writeAuth(auth);
    const modelsJson = this.#readModels();
    if (modelsJson.providers[id]?.apiKey) {
      delete modelsJson.providers[id].apiKey;
      this.#writeModels(modelsJson);
    }
    await this.reload();
    return true;
  }

  async reload() {
    if (this.manager.runtime?.refresh) {
      await this.manager.runtime.refresh({ allowNetwork: false });
    }
    await this.manager.refreshModels();
  }
}

/* =========================================================================
 * خوادم MCP
 * ========================================================================= */

function looksLikeSecret(value) {
  const text = String(value || "");
  if (text.length < 16) return false;
  if (/^[A-Za-z0-9_\-./:]+$/.test(text) && /[A-Za-z]/.test(text) && /[0-9]/.test(text)) return text.length >= 24;
  return false;
}

export class McpManager {
  constructor() {
    this.userPath = join(config.agentDir, "mcp.json");
    this.projectPath = join(config.workspace, ".pi", "mcp.json");
  }

  #read(path) {
    const data = readJson(path, { mcpServers: {} });
    if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};
    return data;
  }

  #describeServer(name, config, scope) {
    const safe = config && typeof config === "object" ? config : {};
    return {
      name,
      scope,
      type: safe.command ? "stdio" : safe.url ? "http" : safe.type || "unknown",
      command: safe.command || "",
      args: Array.isArray(safe.args) ? safe.args.map((arg) => (looksLikeSecret(arg) ? "••••" : String(arg))) : [],
      url: safe.url || "",
      enabled: safe.enabled !== false,
      exposure: safe.exposure || "codemode",
      description: safe.description || "",
      envKeys: Object.keys(safe.env || {}),
      headerKeys: Object.keys(safe.headers || {}),
      hasOAuth: !!safe.oauth,
    };
  }

  list() {
    const user = this.#read(this.userPath);
    const project = this.#read(this.projectPath);
    const map = new Map();
    for (const [name, config] of Object.entries(user.mcpServers || {})) {
      map.set(name, this.#describeServer(name, config, "user"));
    }
    for (const [name, config] of Object.entries(project.mcpServers || {})) {
      map.set(name, this.#describeServer(name, config, "project"));
    }
    const servers = [...map.values()].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return {
      path: this.userPath,
      projectPath: this.projectPath,
      servers,
      total: servers.length,
      enabled: servers.filter((server) => server.enabled).length,
    };
  }

  setEnabled(name, enabled, scope = "user") {
    const path = scope === "project" ? this.projectPath : this.userPath;
    const data = this.#read(path);
    const server = data.mcpServers?.[name];
    if (!server) throw new Error(`خادم MCP غير موجود: ${name}`);
    server.enabled = !!enabled;
    writeJson(path, data, 0o600);
    return this.list();
  }
}

/* =========================================================================
 * الإضافات (Extensions)
 * ========================================================================= */

export class ExtensionManager {
  constructor() {
    this.userDir = join(config.agentDir, "extensions");
    this.projectDir = join(config.workspace, ".pi", "extensions");
  }

  locations() {
    return [
      { scope: "user", label: "إضافات المستخدم", dir: this.userDir, editable: true },
      { scope: "project", label: "إضافات المشروع", dir: this.projectDir, editable: false },
    ];
  }

  list() {
    const out = [];
    for (const location of this.locations()) {
      if (!existsSync(location.dir)) continue;
      let entries;
      try {
        entries = readdirSync(location.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = join(location.dir, entry.name);
        if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
          const id = entry.name.replace(/\.(ts|tsx|js|mjs)$/, "");
          out.push(this.#describe({ id, file: full, kind: "file", location }));
        } else if (entry.isDirectory()) {
          const entryFile = ["index.ts", "index.tsx", "index.js", "index.mjs"]
            .map((name) => join(full, name))
            .find((file) => existsSync(file));
          if (entryFile) {
            out.push(this.#describe({ id: entry.name, file: entryFile, kind: "dir", location }));
          }
        }
      }
    }
    return out.sort((a, b) => {
      if (a.scope === "user" && b.scope !== "user") return -1;
      if (b.scope === "user" && a.scope !== "user") return 1;
      return a.id.localeCompare(b.id);
    });
  }

  #describe({ id, file, kind, location }) {
    let code = "";
    let size = 0;
    let updatedAt = 0;
    try {
      const info = statSync(file);
      size = info.size;
      updatedAt = info.mtimeMs;
      if (location.editable && size <= 200_000) code = readFileSync(file, "utf8");
    } catch {
      /* ignore */
    }
    return {
      id,
      name: id,
      file,
      relativePath: file.slice(location.dir.length + 1),
      kind,
      scope: location.scope,
      scopeLabel: location.label,
      editable: location.editable,
      code,
      size,
      updatedAt,
    };
  }

  get(id) {
    return this.list().find((item) => item.id === id && item.scope === "user") || null;
  }

  #userPath(id) {
    const safe = String(id).trim();
    if (!SKILL_ID_RE.test(safe)) {
      throw new Error("معرّف الإضافة يجب أن يكون حروفاً إنجليزية صغيرة وأرقاماً وشرطات فقط.");
    }
    const dir = join(this.userDir, safe);
    if (!safeInside(this.userDir, dir)) throw new Error("مسار غير صالح.");
    return { dir, file: join(this.userDir, `${safe}.ts`) };
  }

  create({ id, code }) {
    const finalId = id ? String(id).trim() : `extension-${Date.now().toString(36)}`;
    const { dir, file } = this.#userPath(finalId);
    if (existsSync(file) || existsSync(dir)) throw new Error(`الإضافة موجودة بالفعل: ${finalId}`);
    const source = String(code || "").trim();
    if (!source) throw new Error("كود الإضافة مطلوب.");
    mkdirSync(this.userDir, { recursive: true });
    writeFileSync(file, `${source}\n`, "utf8");
    return this.get(finalId);
  }

  update(id, { code }) {
    const existing = this.get(id);
    if (!existing) throw new Error(`الإضافة غير موجودة أو غير قابلة للتعديل: ${id}`);
    const source = String(code || "").trim();
    if (!source) throw new Error("كود الإضافة مطلوب.");
    writeFileSync(existing.file, `${source}\n`, "utf8");
    return this.get(id);
  }

  remove(id) {
    const existing = this.get(id);
    if (!existing) throw new Error(`الإضافة غير موجودة أو غير قابلة للحذف: ${id}`);
    if (!safeInside(this.userDir, existing.file)) throw new Error("مسار غير صالح.");
    if (existing.kind === "dir") {
      rmSync(dirname(existing.file), { recursive: true, force: true });
    } else {
      rmSync(existing.file, { force: true });
    }
    return true;
  }
}

/* =========================================================================
 * إحصاءات الموارد
 * ========================================================================= */

export function countExtensions() {
  const user = walkFiles(join(config.agentDir, "extensions"), { depth: 2, extensions: [".js", ".mjs", ".ts", ".tsx"] });
  const project = walkFiles(join(config.workspace, ".pi", "extensions"), {
    depth: 2,
    extensions: [".js", ".mjs", ".ts", ".tsx"],
  });
  return { total: user.length + project.length, user: user.length, project: project.length, files: [...user, ...project] };
}

export function countPromptTemplates() {
  const user = walkFiles(join(config.agentDir, "prompts"), { depth: 2, extensions: [".md"] });
  const project = walkFiles(join(config.workspace, ".pi", "prompts"), { depth: 2, extensions: [".md"] });
  return { total: user.length + project.length, user: user.length, project: project.length };
}

export default {
  SkillManager,
  AgentRegistry,
  UsageTracker,
  ProviderManager,
  ExtensionManager,
  McpManager,
  ROLE_TEMPLATES,
  PERMISSIONS,
  KNOWN_APIS,
};
