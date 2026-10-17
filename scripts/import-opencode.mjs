#!/usr/bin/env node
/**
 * استيراد مهارات/إضافات/MCP/مزوّدي OpenCode إلى Pi.
 *
 * الاستخدام:
 *   node scripts/import-opencode.mjs                 # عرض الخطة فقط (بدون كتابة)
 *   node scripts/import-opencode.mjs --apply         # تنفيذ الاستيراد
 *   node scripts/import-opencode.mjs --apply --migration-dir <dir>
 *
 * مبادئ الأمان:
 * - لا يعدّل OpenCode إطلاقاً.
 * - يأخذ نسخة احتياطية من ملفات Pi قبل الكتابة.
 * - يحفظ الملفات القديمة عند التعارض بدل استبدالها.
 * - يتحقق من صحة المهارات/models/auth بعد الكتابة.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const PI_AGENT = process.env.PI_AGENT_DIR || path.join(HOME, ".pi", "agent");
const PI_DATA = process.env.DATA_DIR || path.join(ROOT, "data");
const OPENCODE_CONFIG = path.join(HOME, ".config", "opencode", "opencode.json");
const OPENCODE_AUTH = path.join(HOME, ".local", "share", "opencode", "auth.json");
const OPENCODE_SKILLS = path.join(HOME, ".config", "opencode", "skills");
const OPENCODE_CACHE = path.join(HOME, ".cache", "opencode");
const OMO_ROOT = path.join(
  OPENCODE_CACHE,
  "packages",
  "oh-my-openagent@latest",
  "node_modules",
  "oh-my-openagent",
);
const OWC_ROOT = path.join(
  OPENCODE_CACHE,
  "packages",
  "opencode-with-claude@latest",
  "node_modules",
  "opencode-with-claude",
);

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APPLY = hasFlag("--apply");
const API_BASE = argValue("--api", process.env.PI_API_BASE || "http://127.0.0.1:8787");
const NO_API = hasFlag("--no-api");
const TS = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
const MIGRATION_DIR =
  argValue("--migration-dir", null) ||
  path.join(PI_DATA, "migrations", `opencode-import-${TS}`);

const report = {
  createdAt: new Date().toISOString(),
  mode: APPLY ? "apply" : "dry-run",
  source: {
    opencodeConfig: OPENCODE_CONFIG,
    opencodeAuth: OPENCODE_AUTH,
    skills: OPENCODE_SKILLS,
    cache: OPENCODE_CACHE,
    omo: OMO_ROOT,
    opencodeWithClaude: OWC_ROOT,
  },
  targets: {
    agentDir: PI_AGENT,
    dataDir: PI_DATA,
    skills: path.join(PI_AGENT, "skills"),
    extensions: path.join(PI_AGENT, "extensions"),
    mcp: path.join(PI_AGENT, "mcp.json"),
    models: path.join(PI_AGENT, "models.json"),
    auth: path.join(PI_AGENT, "auth.json"),
    permissionMap: path.join(PI_AGENT, "opencode-permissions.json"),
    agents: path.join(PI_DATA, "agents.json"),
  },
  skills: { chosen: [], skipped: [], renamed: [], invalid: [], validation: null },
  mcp: { servers: [], conflicts: [] },
  providers: { added: [], merged: [], authAdded: [], authConflicts: [], validation: null },
  agents: { imported: [], skipped: [], errors: [] },
  extensions: { installed: [], preserved: [], incompatible: [] },
  warnings: [],
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, mode = 0o644) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* ignore */
  }
}

function writeText(file, text, mode = 0o644) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode });
  fs.renameSync(tmp, file);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function backupFile(file, name) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(MIGRATION_DIR, "backup");
  ensureDir(dir);
  const target = path.join(dir, name || path.basename(file));
  fs.copyFileSync(file, target);
  try {
    fs.chmodSync(target, fs.statSync(file).mode);
  } catch {
    /* ignore */
  }
  return target;
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function slugify(text, fallback = "skill") {
  const value = String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return value || `${fallback}-${Date.now().toString(36)}`;
}

function normalizeSkillName(name, fallback) {
  let value = String(name || "").trim().toLowerCase();
  value = value.replace(/_/g, "-").replace(/\s+/g, "-");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) || value.length > 64) {
    value = slugify(value || fallback, "skill");
  }
  return value;
}

function parseFrontmatter(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
  if (!match) return { meta: {}, body: source, hasFrontmatter: false };
  const meta = {};
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const collected = [];
      while (i + 1 < lines.length && (/^\s{2,}/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        i++;
        collected.push(lines[i].replace(/^\s{2,}/, ""));
      }
      value = collected.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: match[2] || "", hasFrontmatter: true };
}

function legacyDescription(body) {
  const text = String(body || "").replace(/\r\n/g, "\n");
  const startMatch = /^##\s+Description\s*$/im.exec(text);
  if (startMatch) {
    const rest = text.slice(startMatch.index + startMatch[0].length);
    const next = /^##\s+/m.exec(rest);
    const sectionText = next ? rest.slice(0, next.index) : rest;
    const value = normalizeWhitespace(sectionText.replace(/^[-*]\s+/gm, ""));
    if (value) return value;
  }
  const afterTitle = text.replace(/^#\s+.*$/m, "");
  const paragraphs = afterTitle
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("##") && !part.startsWith("- **") && !part.startsWith("`"));
  return paragraphs[0] ? normalizeWhitespace(paragraphs[0]) : "";
}

function normalizeDescription(desc, fallback) {
  let value = normalizeWhitespace(desc || fallback || "");
  if (!value) return "";
  if (value.length > 1024) {
    const cut = value.slice(0, 1000);
    const lastSpace = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
    value = `${cut.slice(0, lastSpace > 600 ? lastSpace + 1 : 1000).trim()}…`;
  }
  return value;
}

function buildSkillFile({ name, description, body, meta }) {
  const extra = { ...(meta || {}) };
  delete extra.name;
  delete extra.description;
  const lines = ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`];
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") continue;
    const rendered = String(value).replace(/\s+/g, " ").trim();
    if (!rendered) continue;
    lines.push(`${key}: ${JSON.stringify(rendered)}`);
  }
  lines.push("---", "", String(body || "").replace(/^\n+/, "").trimEnd(), "");
  return lines.join("\n");
}

function listSkillCandidates() {
  const sources = [
    { source: "opencode-config", dir: OPENCODE_SKILLS, priority: 400 },
    { source: "opencode-cache", dir: path.join(OPENCODE_CACHE, "skills"), priority: 300 },
    { source: "omo-dist", dir: path.join(OMO_ROOT, "dist", "skills"), priority: 200 },
    { source: "omo-agents", dir: path.join(OMO_ROOT, ".agents", "skills"), priority: 100 },
  ];
  const candidates = [];
  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue;
    for (const entry of fs.readdirSync(source.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(source.dir, entry.name);
      const file = path.join(dir, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      const { meta, body, hasFrontmatter } = parseFrontmatter(text);
      const name = normalizeSkillName(meta.name || entry.name, entry.name);
      const description = normalizeDescription(
        meta.description || legacyDescription(body),
        `${entry.name} skill from OpenCode`,
      );
      const valid = !!description;
      const size = fs.statSync(file).size;
      const score =
        (valid ? 100000 : 0) +
        (hasFrontmatter ? 10000 : 0) +
        Math.min(description.length, 1024) +
        source.priority +
        Math.min(size / 100, 1000);
      candidates.push({
        ...source,
        folder: entry.name,
        dir,
        file,
        text,
        meta,
        body,
        hasFrontmatter,
        name,
        description,
        valid,
        size,
        score,
        converted: !hasFrontmatter || !meta.description || name !== (meta.name || entry.name),
      });
    }
  }
  return candidates;
}

function chooseSkills() {
  const candidates = listSkillCandidates();
  const byName = new Map();
  for (const candidate of candidates) {
    if (!candidate.valid) {
      report.skills.invalid.push({
        source: candidate.source,
        folder: candidate.folder,
        name: candidate.name,
        reason: "no description",
      });
      continue;
    }
    const existing = byName.get(candidate.name);
    if (!existing || candidate.score > existing.score) {
      if (existing) {
        report.skills.skipped.push({
          name: existing.name,
          source: existing.source,
          folder: existing.folder,
          reason: `duplicate; kept ${candidate.source}`,
        });
      }
      byName.set(candidate.name, candidate);
    } else {
      report.skills.skipped.push({
        name: candidate.name,
        source: candidate.source,
        folder: candidate.folder,
        reason: `duplicate; kept ${existing.source}`,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function applySkills(chosen) {
  const targetRoot = path.join(PI_AGENT, "skills");
  if (APPLY) ensureDir(targetRoot);
  for (const skill of chosen) {
    const baseContent = buildSkillFile({
      name: skill.name,
      description: skill.description,
      body: skill.body,
      meta: skill.meta,
    });
    const baseDir = path.join(targetRoot, skill.name);
    const baseFile = path.join(baseDir, "SKILL.md");
    if (fs.existsSync(baseFile) && sha256(fs.readFileSync(baseFile, "utf8")) === sha256(baseContent)) {
      report.skills.chosen.push({
        name: skill.name,
        sourceName: skill.name,
        source: skill.source,
        folder: skill.folder,
        targetDir: baseDir,
        descriptionLength: skill.description.length,
        converted: skill.converted,
        hasFrontmatter: skill.hasFrontmatter,
        action: "unchanged",
      });
      continue;
    }
    let targetName = skill.name;
    let suffix = 1;
    let targetDir = path.join(targetRoot, targetName);
    while (fs.existsSync(targetDir) && suffix < 100) {
      targetName = `${skill.name}-opencode${suffix === 1 ? "" : `-${suffix}`}`;
      targetDir = path.join(targetRoot, targetName);
      suffix++;
    }
    if (targetName !== skill.name) {
      report.skills.renamed.push({
        from: skill.name,
        to: targetName,
        source: skill.source,
        folder: skill.folder,
      });
    }
    const content = buildSkillFile({
      name: targetName,
      description: skill.description,
      body: skill.body,
      meta: skill.meta,
    });
    const record = {
      name: targetName,
      sourceName: skill.name,
      source: skill.source,
      folder: skill.folder,
      targetDir,
      descriptionLength: skill.description.length,
      converted: skill.converted,
      hasFrontmatter: skill.hasFrontmatter,
    };
    report.skills.chosen.push(record);
    if (!APPLY) continue;
    if (!fs.existsSync(targetDir)) {
      fs.cpSync(skill.dir, targetDir, { recursive: true, errorOnExist: false, force: false });
    }
    const targetFile = path.join(targetDir, "SKILL.md");
    const existing = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8") : null;
    if (existing !== null && sha256(existing) === sha256(content)) continue;
    if (existing !== null) backupFile(targetFile, `skill-${targetName}-SKILL.md`);
    writeText(targetFile, content);
  }
}

async function validateSkills() {
  try {
    const { DefaultResourceLoader, SettingsManager } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const loader = new DefaultResourceLoader({
      cwd: HOME,
      agentDir: PI_AGENT,
      settingsManager: SettingsManager.create(HOME, PI_AGENT),
      noExtensions: true,
      noSkills: false,
    });
    await loader.reload();
    const result = loader.getSkills();
    report.skills.validation = {
      loaded: result.skills.length,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        type: diagnostic.type,
        message: diagnostic.message,
        path: diagnostic.path,
      })),
      names: result.skills.map((skill) => skill.name),
    };
  } catch (error) {
    report.skills.validation = { error: error?.message || String(error) };
    report.warnings.push(`تعذّر التحقق من المهارات عبر Pi: ${error?.message || error}`);
  }
}

function convertMcp(config) {
  const servers = {};
  const hiddenByServer = {};
  for (const [tool, value] of Object.entries(config.permission || {})) {
    if (value !== "deny") continue;
    if (tool.startsWith("ghidra_")) {
      hiddenByServer.ghidra = hiddenByServer.ghidra || {};
      hiddenByServer.ghidra[tool.slice("ghidra_".length)] = "hidden";
    } else if (tool.startsWith("x64dbg_")) {
      hiddenByServer.x64dbg = hiddenByServer.x64dbg || {};
      hiddenByServer.x64dbg[tool.slice("x64dbg_".length)] = "hidden";
    }
  }
  for (const [name, entry] of Object.entries(config.mcp || {})) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "local" || Array.isArray(entry.command)) {
      const command = Array.isArray(entry.command) ? entry.command : [];
      const [bin, ...rest] = command;
      if (!bin) continue;
      const converted = {
        command: bin,
        args: rest,
        exposure: "direct",
      };
      if (entry.environment && typeof entry.environment === "object") converted.env = entry.environment;
      if (entry.enabled === false) converted.enabled = false;
      if (entry.description) converted.description = entry.description;
      if (hiddenByServer[name]) converted.toolExposure = hiddenByServer[name];
      servers[name] = converted;
    } else if (entry.type === "remote" || entry.url) {
      let url = String(entry.url || "");
      let enabled = entry.enabled !== false;
      let description = entry.description || "";
      if (/\/sse\/?$/i.test(url)) {
        url = url.replace(/\/sse\/?$/i, "/mcp");
        enabled = false;
        description =
          `${description ? `${description} ` : ""}OpenCode used SSE; Pi supports Streamable HTTP only. ` +
          "Enable after confirming the server exposes /mcp.";
      }
      const converted = { url, exposure: "direct" };
      if (entry.headers && typeof entry.headers === "object") converted.headers = entry.headers;
      if (entry.oauth) converted.oauth = entry.oauth;
      if (!enabled) converted.enabled = false;
      if (description) converted.description = description;
      if (hiddenByServer[name]) converted.toolExposure = hiddenByServer[name];
      servers[name] = converted;
    }
  }
  return servers;
}

function applyMcp(config) {
  const mcpPath = path.join(PI_AGENT, "mcp.json");
  const existing = readJson(mcpPath, { mcpServers: {} });
  if (!existing.mcpServers || typeof existing.mcpServers !== "object") existing.mcpServers = {};
  const incoming = convertMcp(config);
  for (const [name, server] of Object.entries(incoming)) {
    if (!existing.mcpServers[name]) {
      existing.mcpServers[name] = server;
      report.mcp.servers.push({ name, action: "added", type: server.command ? "stdio" : "http", enabled: server.enabled !== false });
    } else if (JSON.stringify(existing.mcpServers[name]) === JSON.stringify(server)) {
      report.mcp.servers.push({ name, action: "unchanged" });
    } else {
      existing.mcpServers[name] = {
        ...server,
        ...existing.mcpServers[name],
        ...(server.toolExposure ? { toolExposure: server.toolExposure } : {}),
      };
      report.mcp.servers.push({ name, action: "merged" });
    }
  }
  if (APPLY) {
    if (fs.existsSync(mcpPath)) backupFile(mcpPath, "mcp.json");
    writeJson(mcpPath, existing, 0o600);
  }
}

function modelMetaFromCache(providerId) {
  const cache = readJson(path.join(OPENCODE_CACHE, "models.json"), {});
  return cache?.[providerId] || null;
}

function toPiModel(id, meta = {}, fallbackName = "") {
  const input = Array.isArray(meta.modalities?.input) && meta.modalities.input.includes("image")
    ? ["text", "image"]
    : ["text"];
  const reasoning = meta.reasoning === true || Array.isArray(meta.reasoning_options);
  const contextWindow = Number(meta.limit?.context || meta.contextWindow || 128000) || 128000;
  const maxTokens = Number(meta.limit?.output || meta.maxTokens || 8192) || 8192;
  const cost = meta.cost || {};
  return {
    id,
    name: String(meta.name || fallbackName || id),
    input,
    reasoning,
    contextWindow,
    maxTokens,
    cost: {
      input: Number(cost.input) || 0,
      output: Number(cost.output) || 0,
      cacheRead: Number(cost.cache_read ?? cost.cacheRead) || 0,
      cacheWrite: Number(cost.cache_write ?? cost.cacheWrite) || 0,
    },
  };
}

function providerFromCache(providerId) {
  const cached = modelMetaFromCache(providerId);
  if (!cached) return null;
  return {
    id: providerId,
    name: cached.name || providerId,
    baseUrl: cached.api || cached.baseURL || "",
    api: "openai-completions",
    models: Object.entries(cached.models || {}).map(([id, meta]) => toPiModel(id, meta)),
  };
}

function providerFromConfig(providerId, entry) {
  const models = Object.entries(entry.models || {}).map(([id, meta]) =>
    toPiModel(id, {
      name: meta.name,
      reasoning: meta.reasoning,
      modalities: meta.modalities,
      limit: meta.limit,
      cost: meta.cost,
    }),
  );
  return {
    id: providerId,
    name: entry.name || providerId,
    baseUrl: entry.options?.baseURL || entry.baseUrl || "",
    api: "openai-completions",
    models,
  };
}

function mergeProvider(existing, incoming) {
  const out = {
    ...existing,
    name: existing?.name || incoming.name,
    baseUrl: existing?.baseUrl || incoming.baseUrl,
    api: existing?.api || incoming.api,
    models: Array.isArray(existing?.models) ? [...existing.models] : [],
  };
  const known = new Set(out.models.map((model) => model.id));
  for (const model of incoming.models || []) {
    if (!known.has(model.id)) {
      out.models.push(model);
      known.add(model.id);
    }
  }
  return out;
}

function readDotEnv() {
  const file = path.join(ROOT, ".env");
  const result = {};
  try {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    /* ignore */
  }
  return result;
}

function buildProviderPlans(config) {
  const plans = [];
  const auth = readJson(OPENCODE_AUTH, {});
  const configProviders = config.provider || {};

  for (const id of ["tokenharbor", "xkiro"]) {
    if (!configProviders[id]) continue;
    const plan = providerFromConfig(id, configProviders[id]);
    const key = configProviders[id].options?.apiKey;
    plans.push({ ...plan, authKey: key ? String(key) : null });
  }

  const zai = providerFromCache("zai-coding-plan");
  if (zai) plans.push({ ...zai, authKey: auth["zai-coding-plan"]?.key || null });

  const opencode = providerFromCache("opencode");
  if (opencode) plans.push({ ...opencode, authKey: auth.opencode?.key || null });

  const deepseek = providerFromCache("deepseek");
  if (deepseek) plans.push({ ...deepseek, authKey: auth.deepseek?.key || null });

  const anthropic = providerFromCache("anthropic");
  if (anthropic) {
    plans.push({
      ...anthropic,
      id: "anthropic-local",
      name: "Anthropic (Meridian local proxy)",
      baseUrl: configProviders.anthropic?.options?.baseURL || "http://127.0.0.1:3456",
      api: "anthropic-messages",
      authKey: configProviders.anthropic?.options?.apiKey || "dummy",
    });
  }
  return plans;
}

function applyProviders(config) {
  const modelsPath = path.join(PI_AGENT, "models.json");
  const authPath = path.join(PI_AGENT, "auth.json");
  const models = readJson(modelsPath, {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {},
  });
  if (!models.providers || typeof models.providers !== "object") models.providers = {};
  const auth = readJson(authPath, {});
  const plans = buildProviderPlans(config);
  report.providers.planned = plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    baseUrl: plan.baseUrl,
    api: plan.api,
    modelCount: plan.models?.length || 0,
    hasAuth: !!plan.authKey,
  }));

  for (const plan of plans) {
    if (!plan.models?.length) {
      report.warnings.push(`المزوّد ${plan.id} بلا نماذج؛ تم تخطيه.`);
      continue;
    }
    const existing = models.providers[plan.id];
    const incoming = {
      name: plan.name,
      baseUrl: plan.baseUrl,
      api: plan.api,
      models: plan.models,
    };
    if (existing) {
      models.providers[plan.id] = mergeProvider(existing, incoming);
      report.providers.merged.push({
        id: plan.id,
        models: plan.models.length,
        totalModels: models.providers[plan.id].models.length,
      });
    } else {
      models.providers[plan.id] = incoming;
      report.providers.added.push({ id: plan.id, models: plan.models.length });
    }

    if (plan.authKey) {
      if (auth[plan.id]) {
        const existingKey = auth[plan.id]?.key || auth[plan.id]?.access;
        if (existingKey && existingKey !== plan.authKey) {
          report.providers.authConflicts.push({
            id: plan.id,
            action: "kept-existing",
            newKeySavedIn: "source/opencode-auth.json",
          });
        }
      } else {
        auth[plan.id] = { type: "api_key", key: plan.authKey };
        report.providers.authAdded.push({ id: plan.id });
      }
    }
  }

  // OpenCode's ChatGPT OAuth is structurally compatible with Pi's openai-codex.
  const openai = readJson(OPENCODE_AUTH, {}).openai;
  if (openai && !auth["openai-codex"]) {
    auth["openai-codex"] = {
      type: "oauth",
      access: openai.access,
      refresh: openai.refresh,
      expires: openai.expires,
      ...(openai.accountId ? { accountId: openai.accountId } : {}),
    };
    report.providers.authAdded.push({ id: "openai-codex", type: "oauth" });
  } else if (openai && auth["openai-codex"]) {
    report.providers.authConflicts.push({ id: "openai-codex", action: "kept-existing", newKeySavedIn: "source/opencode-auth.json" });
  }

  const hadModels = fs.existsSync(modelsPath);
  const previousModels = hadModels ? fs.readFileSync(modelsPath, "utf8") : null;
  const hadAuth = fs.existsSync(authPath);
  const previousAuth = hadAuth ? fs.readFileSync(authPath, "utf8") : null;
  if (APPLY) {
    if (hadModels) backupFile(modelsPath, "models.json");
    if (hadAuth) backupFile(authPath, "auth.json");
    writeJson(modelsPath, models, 0o644);
    writeJson(authPath, auth, 0o600);
  }
  return { modelsPath, authPath, hadModels, previousModels, hadAuth, previousAuth };
}

async function validateProviders(paths) {
  try {
    process.env.PI_OFFLINE = "1";
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({
      authPath: paths.authPath,
      modelsPath: paths.modelsPath,
      allowModelNetwork: false,
      refreshOnCreate: true,
    });
    const available = await runtime.getAvailable();
    const byProvider = {};
    for (const model of available) {
      byProvider[model.provider] = (byProvider[model.provider] || 0) + 1;
    }
    report.providers.validation = {
      totalAvailable: available.length,
      byProvider,
      error: runtime.getError() || null,
      providers: runtime.getProviders().map((provider) => provider.id),
    };
    return !report.providers.validation.error && available.length > 0;
  } catch (error) {
    report.providers.validation = { error: error?.message || String(error) };
    report.warnings.push(`فشل التحقق من models/auth: ${error?.message || error}`);
    return false;
  }
}

function buildAgents(config) {
  const agents = [];
  const map = {
    "average-implementer": { role: "executor", emoji: "⚙️" },
    "average-reviewer": { role: "reviewer", emoji: "🧪" },
    "deepseek-researcher": { role: "researcher", emoji: "🔎" },
    "glm-reviewer": { role: "reviewer", emoji: "🧠" },
  };
  for (const [id, entry] of Object.entries(config.agent || {})) {
    const mapped = map[id] || { role: "custom", emoji: "🤖" };
    const modelRef = String(entry.model || "");
    const [provider, ...rest] = modelRef.split("/");
    const model = rest.length ? { provider, model: rest.join("/") } : null;
    agents.push({
      id,
      name: entry.description ? entry.description.slice(0, 48) : id,
      role: mapped.role,
      emoji: mapped.emoji,
      description: entry.description || `OpenCode agent: ${id}`,
      systemPrompt: entry.prompt || "",
      permissions: {
        read: false,
        write: false,
        execute: false,
        network: false,
        mcp: false,
        delegate: false,
        approve: false,
      },
      extraTools: [],
      model,
      thinking: "medium",
      enabled: true,
    });
  }
  return agents;
}

function readApiToken() {
  return process.env.WEB_TOKEN || readDotEnv().WEB_TOKEN || "";
}

async function importAgentsViaApi(agents) {
  if (NO_API) return false;
  let healthy = false;
  try {
    const response = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    healthy = response.ok;
  } catch {
    healthy = false;
  }
  if (!healthy) return false;

  const token = readApiToken();
  const headers = { "content-type": "application/json" };
  if (token) headers["x-pi-token"] = token;
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  let existing = [];
  try {
    const response = await fetch(`${API_BASE}/api/agents${query}`, { headers });
    if (response.ok) existing = (await response.json()).agents || [];
  } catch {
    /* ignore */
  }
  const existingIds = new Set(existing.map((agent) => agent.id));
  for (const agent of agents) {
    if (existingIds.has(agent.id)) {
      report.agents.skipped.push({ id: agent.id, reason: "existing" });
      continue;
    }
    try {
      const response = await fetch(`${API_BASE}/api/agents${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify(agent),
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error.slice(0, 300));
      }
      report.agents.imported.push({ id: agent.id });
    } catch (error) {
      report.agents.errors.push({ id: agent.id, error: error?.message || String(error) });
    }
  }
  return true;
}

function patchImportedAgentPermissions(agents) {
  const file = path.join(PI_DATA, "agents.json");
  const data = readJson(file, { agents: [] });
  if (!Array.isArray(data.agents)) return;
  const ids = new Set(agents.map((agent) => agent.id));
  let changed = false;
  for (const agent of data.agents) {
    if (!ids.has(agent.id)) continue;
    agent.permissions = {
      read: false,
      write: false,
      execute: false,
      network: false,
      mcp: false,
      delegate: false,
      approve: false,
    };
    changed = true;
  }
  if (changed && APPLY) {
    backupFile(file, "agents.json");
    writeJson(file, data, 0o600);
  }
}

async function importAgentsDirect(agents) {
  const { AgentRegistry } = await import("../src/control.js");
  const registry = new AgentRegistry(path.join(PI_DATA, "agents.json"));
  for (const agent of agents) {
    if (registry.get(agent.id)) {
      report.agents.skipped.push({ id: agent.id, reason: "existing" });
      continue;
    }
    try {
      registry.create(agent);
      report.agents.imported.push({ id: agent.id });
    } catch (error) {
      report.agents.errors.push({ id: agent.id, error: error?.message || String(error) });
    }
  }
}

const NOTIFY_EXTENSION = `/**
 * OpenCode notify → Pi extension (converted)
 * Sends a desktop notification when a run settles or a tool fails.
 * Source: ~/.config/opencode/plugins/notify.ts (OpenCode API differs; this is a Pi-native rewrite).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "opencode", "kdco-notify.json"), "utf8"));
  } catch {
    return {};
  }
}

function quietHours(config: any) {
  if (!config?.quietHours?.enabled) return false;
  const [sh, sm] = String(config.quietHours.start || "22:00").split(":").map(Number);
  const [eh, em] = String(config.quietHours.end || "08:00").split(":").map(Number);
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = (sh || 0) * 60 + (sm || 0);
  const end = (eh || 0) * 60 + (em || 0);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function notify(title: string, body: string) {
  const config = loadConfig();
  if (quietHours(config)) return;
  const timeout = Number(config.timeout) || 0;
  execFile("notify-send", ["-a", "Pi", "-t", String(timeout), title, body], () => undefined);
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", async (event) => {
    if (!event.aborted) notify("Pi", "اكتملت المهمة.");
  });
  pi.on("tool_execution_end", async (event) => {
    if (event.isError) notify("Pi — خطأ في أداة", String(event.toolName || "tool"));
  });
}
`;

const PERMISSIONS_EXTENSION = `/**
 * OpenCode permission map → Pi extension (converted)
 * Blocks tools that OpenCode marked as "deny".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function loadDenied() {
  const denied = new Set<string>();
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const file = path.join(agentDir, "opencode-permissions.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [name, value] of Object.entries(data.permissions || {})) {
      if (value === "deny") denied.add(String(name));
    }
  } catch {
    /* ignore */
  }
  return denied;
}

export default function (pi: ExtensionAPI) {
  const denied = loadDenied();
  if (!denied.size) return;
  pi.on("tool_call", async (event) => {
    const toolName = String(event.toolName || "");
    const parts = toolName.split("__");
    const server = parts.length >= 3 ? parts[1] : "";
    const short = parts.length >= 3 ? parts.slice(2).join("__") : parts.pop() || "";
    const candidates = [toolName, short];
    if (server) candidates.push(server + "_" + short);
    if (candidates.some((name) => denied.has(name))) {
      return { block: true, reason: "OpenCode permission map denies " + toolName };
    }
    return undefined;
  });
}
`;

function installExtensions(config) {
  const extensionsDir = path.join(PI_AGENT, "extensions");
  if (APPLY) ensureDir(extensionsDir);
  const files = [
    ["opencode-notify", NOTIFY_EXTENSION],
    ["opencode-permissions", PERMISSIONS_EXTENSION],
  ];
  for (const [name, content] of files) {
    const file = path.join(extensionsDir, `${name}.ts`);
    if (APPLY) {
      if (fs.existsSync(file)) backupFile(file, `${name}.ts`);
      writeText(file, content);
    }
    report.extensions.installed.push({ id: name, file });
  }

  const permissions = config.permission || {};
  if (Object.keys(permissions).length) {
    const file = path.join(PI_AGENT, "opencode-permissions.json");
    if (APPLY) {
      if (fs.existsSync(file)) backupFile(file, "opencode-permissions.json");
      writeJson(file, { source: OPENCODE_CONFIG, permissions }, 0o600);
    }
    report.extensions.installed.push({ id: "opencode-permissions-map", file });
  }

  // Preserve original plugin sources for reference; they are OpenCode-specific.
  const preserveDir = path.join(MIGRATION_DIR, "source", "opencode-plugins");
  const pluginsDir = path.join(HOME, ".config", "opencode", "plugins");
  if (APPLY && fs.existsSync(pluginsDir)) {
    ensureDir(preserveDir);
    fs.cpSync(pluginsDir, preserveDir, { recursive: true, force: true });
  }
  report.extensions.preserved.push({ path: pluginsDir, copiedTo: preserveDir });

  report.extensions.incompatible.push(
    {
      id: "oh-my-openagent@latest",
      path: OMO_ROOT,
      reason: "OpenCode plugin API; imported its skills separately. Install OmO/Pi-native separately if needed.",
    },
    {
      id: "opencode-with-claude",
      path: OWC_ROOT,
      reason: "Starts a Meridian proxy for OpenCode. Pi uses the anthropic-local provider; run Meridian separately to use it.",
    },
    {
      id: "kdco-primitives",
      path: path.join(pluginsDir, "kdco-primitives"),
      reason: "Helper library, not a standalone extension; preserved for reference.",
    },
  );
}

function writeMigrationReadme() {
  const lines = [
    "# OpenCode → Pi migration",
    "",
    `- Created: ${report.createdAt}`,
    `- Mode: ${report.mode}`,
    "",
    "## Counts",
    "",
    `- Skills chosen: ${report.skills.chosen.length}`,
    `- Skills skipped: ${report.skills.skipped.length}`,
    `- Skills invalid: ${report.skills.invalid.length}`,
    `- MCP servers: ${report.mcp.servers.length} · conflicts: ${report.mcp.conflicts.length}`,
    `- Providers added: ${report.providers.added.length} · merged: ${report.providers.merged.length}`,
    `- Auth keys added: ${report.providers.authAdded.length} · conflicts: ${report.providers.authConflicts.length}`,
    `- Agents imported: ${report.agents.imported.length} · skipped: ${report.agents.skipped.length}`,
    `- Extensions installed: ${report.extensions.installed.length}`,
    "",
    "## Notes",
    "",
    "- OpenCode itself was not modified.",
    "- Existing Pi files were backed up in `backup/`.",
    "- OpenCode plugins use a different API and cannot load directly in Pi. The notify plugin and permission map were converted to Pi extensions; OmO and opencode-with-claude are preserved for reference.",
    "- The remote x64dbg MCP used SSE in OpenCode. Pi supports Streamable HTTP only, so it is imported disabled until `/mcp` is confirmed.",
    "- `anthropic-local` points to the Meridian proxy at http://127.0.0.1:3456. Start Meridian for it to work.",
    "",
    "## Restore",
    "",
    "```bash",
    `cd ${PI_AGENT}`,
    `tar -xzf ${path.join(MIGRATION_DIR, "backup", "pi-agent-config.tar.gz")}`,
    "```",
    "",
    "## Apply changes",
    "",
    "Restart the web app with `./restart.sh`, then open the control center.",
  ];
  if (APPLY) {
    writeText(path.join(MIGRATION_DIR, "README-migration.md"), `${lines.join("\n")}\n`);
  }
}

async function main() {
  ensureDir(MIGRATION_DIR);
  ensureDir(path.join(MIGRATION_DIR, "source"));
  ensureDir(path.join(MIGRATION_DIR, "backup"));

  const config = readJson(OPENCODE_CONFIG, null);
  if (!config) throw new Error(`تعذّر قراءة إعداد OpenCode: ${OPENCODE_CONFIG}`);

  // نسخ المصادر المهمة إلى مجلد الهجرة
  if (APPLY) {
    for (const [source, name] of [
      [OPENCODE_CONFIG, "opencode.json"],
      [OPENCODE_AUTH, "opencode-auth.json"],
    ]) {
      if (fs.existsSync(source)) {
        const target = path.join(MIGRATION_DIR, "source", name);
        fs.copyFileSync(source, target);
        fs.chmodSync(target, source.includes("auth") ? 0o600 : 0o644);
      }
    }
  }

  console.log(`OpenCode → Pi migration (${APPLY ? "APPLY" : "DRY-RUN"})`);
  console.log(`Migration dir: ${MIGRATION_DIR}`);

  // 1) المهارات
  const chosen = chooseSkills();
  applySkills(chosen);
  if (APPLY) await validateSkills();
  console.log(`Skills: ${report.skills.chosen.length} chosen, ${report.skills.skipped.length} duplicates, ${report.skills.invalid.length} invalid`);

  // 2) MCP
  applyMcp(config);
  console.log(`MCP: ${report.mcp.servers.length} entries, ${report.mcp.conflicts.length} conflicts`);

  // 3) المزوّدون والمفاتيح
  const providerPaths = applyProviders(config);
  let providersOk = true;
  if (APPLY) {
    providersOk = await validateProviders(providerPaths);
    if (!providersOk) {
      report.warnings.push("فشل التحقق من models/auth؛ سيتم التراجع إلى النسخة السابقة.");
      if (providerPaths.hadModels) {
        writeText(providerPaths.modelsPath, providerPaths.previousModels, 0o644);
      } else {
        fs.rmSync(providerPaths.modelsPath, { force: true });
      }
      if (providerPaths.hadAuth) {
        writeText(providerPaths.authPath, providerPaths.previousAuth, 0o600);
      } else {
        fs.rmSync(providerPaths.authPath, { force: true });
      }
    }
  }
  console.log(
    `Providers: +${report.providers.added.length} added, ${report.providers.merged.length} merged, auth +${report.providers.authAdded.length}`,
  );

  // 4) الوكلاء
  const agents = buildAgents(config);
  if (APPLY) {
    const viaApi = await importAgentsViaApi(agents);
    if (!viaApi) await importAgentsDirect(agents);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    patchImportedAgentPermissions(agents);
  } else {
    report.agents.imported = agents.map((agent) => ({ id: agent.id, planned: true }));
  }
  console.log(`Agents: ${report.agents.imported.length} imported, ${report.agents.skipped.length} skipped`);

  // 5) الإضافات
  installExtensions(config);
  console.log(`Extensions: ${report.extensions.installed.length} installed, ${report.extensions.incompatible.length} incompatible`);

  // 6) التقرير
  writeMigrationReadme();
  writeJson(path.join(MIGRATION_DIR, "report.json"), report, 0o600);
  if (APPLY) {
    // إبلاغ التطبيق بإعادة تحميل النماذج إن كان يعمل
    try {
      const token = readApiToken();
      const url = new URL(`${API_BASE}/api/reload`);
      if (token) url.searchParams.set("token", token);
      await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000) });
    } catch {
      /* ignore */
    }
  }
  console.log(`Report: ${path.join(MIGRATION_DIR, "report.json")}`);
  if (report.warnings.length) {
    console.log("Warnings:");
    for (const warning of report.warnings) console.log(` - ${warning}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
