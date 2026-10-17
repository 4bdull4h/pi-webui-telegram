/**
 * اكتشاف جلسات pi الموجودة على القرص (المرحلة B4a).
 *
 * الجلسات تُخزَّن كـ JSONL في:
 *   <agentDir>/sessions/--<project-path>--/<timestamp>_<uuid>.jsonl
 * (انظر docs/session-format.md في حزمة pi).
 *
 * هذا الملف للقراءة فقط + نقل إلى `.trash` عند الحذف. لا يكتب أي ملف جلسة.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import config from "../config.js";

/** أقصى عدد أسطر نقرأها لحساب عدد الرسائل (تفادي البطء على الجلسات الضخمة). */
export const MAX_SCAN_LINES = 4000;

const MAX_DIR_DEPTH = 3;
const TRASH_DIR = ".trash";

/**
 * يفكّ ترميز اسم مجلد المشروع: `--home--asus--` ← `/home/asus`
 * (pi يحذف الفاصل الأول ويستبدل `/` `\` `:` بـ `-`، ثم يحيط الاسم بـ `--`).
 */
export function decodeProjectDir(dirName) {
  if (!dirName) return "";
  let inner = String(dirName);
  if (inner.startsWith("--") && inner.endsWith("--") && inner.length > 4) {
    inner = inner.slice(2, -2);
  } else if (inner.startsWith("--")) {
    inner = inner.slice(2);
  }
  const path = inner.split("-").filter(Boolean).join("/");
  return path ? `/${path}` : "";
}

/** يستخرج UUID من اسم الملف `<timestamp>_<uuid>.jsonl`. */
export function sessionIdFromFileName(fileName) {
  const base = basename(String(fileName)).replace(/\.jsonl$/i, "");
  const idx = base.indexOf("_");
  return (idx === -1 ? base : base.slice(idx + 1)) || base;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" ? (block.text ?? "") : ""))
    .filter(Boolean)
    .join(" ");
}

function firstLine(text, max = 90) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function projectPathFromHeader(header, dirName) {
  const cwd = typeof header?.cwd === "string" ? header.cwd : "";
  return cwd || decodeProjectDir(dirName);
}

function projectLabel(projectPath) {
  if (!projectPath) return "—";
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : projectPath;
}

/** يقرأ حتى `maxLines` سطراً ويستخرج البيانات الوصفية. */
async function scanSessionFile(filePath, maxLines = MAX_SCAN_LINES) {
  const info = {
    id: sessionIdFromFileName(filePath),
    header: null,
    name: null, // session_info.name (تسمية صريحة من /name)
    title: null, // أول رسالة مستخدم
    messageCount: 0,
    cwd: null,
    partial: false,
    lines: 0,
  };

  const stream = createReadStream(filePath, { encoding: "utf8" });
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        info.lines += 1;
        if (info.lines > maxLines) {
          info.partial = true;
          break;
        }
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!entry || typeof entry !== "object") continue;
        if (entry.type === "session" && !info.header) {
          info.header = entry;
          if (entry.id) info.id = entry.id;
          continue;
        }
        if (entry.type === "session_info") {
          if (typeof entry.name === "string" && entry.name.trim()) info.name = entry.name.trim();
          continue;
        }
        if (entry.type === "message") {
          const message = entry.message || {};
          const role = message.role;
          if (role === "user" || role === "assistant") info.messageCount += 1;
          if (!info.title && role === "user") {
            const text = firstLine(textFromContent(message.content));
            if (text) info.title = text;
          }
        }
      }
      if (info.partial) break;
    }
    // آخر سطر قد لا ينتهي بسطر جديد
    if (!info.partial && buffer.trim()) {
      try {
        const entry = JSON.parse(buffer.trim());
        if (entry?.type === "message") {
          const role = entry.message?.role;
          if (role === "user" || role === "assistant") info.messageCount += 1;
          if (!info.title && role === "user") {
            const text = firstLine(textFromContent(entry.message?.content));
            if (text) info.title = text;
          }
        }
      } catch {
        /* سطر مقطوع — نتجاهله */
      }
    }
  } catch {
    info.error = true;
  } finally {
    stream.destroy();
  }
  return info;
}

/** يجمع كل ملفات `.jsonl` تحت مجلد الجلسات (يتجاهل `.trash`). */
function collectSessionFiles(sessionsDir) {
  const files = [];
  const walk = (dir, depth, projectDir) => {
    if (depth > MAX_DIR_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === TRASH_DIR || entry.name.startsWith(".")) continue;
        walk(full, depth + 1, projectDir ?? entry.name);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ filePath: full, projectDir: projectDir ?? "" });
      }
    }
  };
  walk(sessionsDir, 0, null);
  return files;
}

/** قائمة جلسات القرص مرتبة تنازلياً حسب آخر تعديل. */
export async function listDiskSessions(options = {}) {
  const agentDir = options.agentDir || config.agentDir;
  const query = String(options.query || "").trim().toLowerCase();
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 300;
  const maxLines = Number.isFinite(options.maxLines) ? Math.max(1, options.maxLines) : MAX_SCAN_LINES;
  const sessionsDir = join(agentDir, "sessions");

  const files = collectSessionFiles(sessionsDir);
  const sessions = [];
  for (const { filePath, projectDir } of files) {
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    const meta = await scanSessionFile(filePath, maxLines);
    const projectPath = projectPathFromHeader(meta.header, projectDir);
    const title = meta.name || meta.title || null;
    sessions.push({
      sessionFile: filePath,
      id: meta.id,
      title,
      name: meta.name,
      firstMessage: meta.title,
      projectPath,
      projectName: projectLabel(projectPath),
      updatedAt: st.mtimeMs,
      size: st.size,
      messageCount: meta.messageCount,
      partial: meta.partial,
      cwd: meta.header?.cwd || null,
      version: meta.header?.version ?? null,
    });
  }

  const filtered = query
    ? sessions.filter((s) =>
        [s.title, s.firstMessage, s.projectName, s.projectPath, s.id]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query)),
      )
    : sessions;

  filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return {
    sessionsDir,
    total: sessions.length,
    matched: filtered.length,
    sessions: filtered.slice(0, limit),
  };
}

/** ينقل ملف جلسة إلى `<agentDir>/sessions/.trash/` (نقل لا حذف). */
export async function trashSessionFile(sessionFile, options = {}) {
  const agentDir = options.agentDir || config.agentDir;
  const sessionsDir = resolve(join(agentDir, "sessions"));
  const target = resolve(String(sessionFile || ""));
  if (!sessionFile) throw new Error("sessionFile مطلوب");
  if (!existsSync(target)) throw new Error("ملف الجلسة غير موجود");
  if (!target.startsWith(sessionsDir + sep)) throw new Error("مسار الجلسة خارج مجلد الجلسات");
  if (target.split(sep).includes(TRASH_DIR)) throw new Error("الجلسة موجودة في سلة المهملات مسبقاً");
  const trashDir = join(sessionsDir, TRASH_DIR);
  await mkdir(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = join(trashDir, `${stamp}__${basename(target)}`);
  let n = 1;
  while (existsSync(dest)) {
    dest = join(trashDir, `${stamp}__${n}__${basename(target)}`);
    n += 1;
  }
  await rename(target, dest);
  return { moved: true, from: target, to: dest };
}

/** صحة مسار جلسة (يُستخدم في web-server قبل التبديل/الحذف). */
export function isSessionFileInsideAgent(sessionFile, agentDir = config.agentDir) {
  if (!sessionFile || typeof sessionFile !== "string") return false;
  const sessionsDir = resolve(join(agentDir, "sessions"));
  const target = resolve(sessionFile);
  if (!target.startsWith(sessionsDir + sep)) return false;
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

// ===== اختبار ذاتي =====
if (process.argv[1] && process.argv[1].endsWith("sessions.js") && process.argv.includes("--self-test")) {
  const result = await listDiskSessions({ limit: 3 });
  console.log("sessions dir:", result.sessionsDir);
  console.log("total:", result.total, "matched:", result.matched, "shown:", result.sessions.length);
  for (const s of result.sessions) {
    console.log(`- ${s.title || "(بلا اسم)"} | ${s.projectName} | ${s.messageCount} رسالة | ${s.sessionFile}`);
  }
}
