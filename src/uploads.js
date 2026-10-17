/**
 * المرحلة B2: رفع الملفات والصور + قراءة آمنة + إكمال مسارات مساحة العمل.
 * بلا تبعيات خارجية: تحليل multipart يدوي + لقطة توقيع بايتات للصور.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

import config from "./config.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB للملف
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024; // 40MB لمجموع الطلب
export const MAX_FILES = 20;
export const MAX_IMAGES = 10;
/** هامش لرؤوس multipart فوق حد المجموع. */
export const MULTIPART_SLACK_BYTES = 2 * 1024 * 1024;

/** الصيغ المسموح تمريرها للنموذج كصور. */
export const IMAGE_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".log": "text/plain",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/plain",
  ".py": "text/plain",
  ".sh": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

/** خطأ يحمل رمز حالة HTTP ورسالة عربية واضحة. */
export class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

export function uploadsRoot() {
  return join(config.dataDir, "uploads");
}

/** يكتشف صيغة الصورة من بايتاتها الفعلية (لا نثق بـ Content-Type). */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6) {
    const head = buf.toString("latin1", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (buf.length >= 12) {
    if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
      return "image/webp";
    }
  }
  return null;
}

function normalizeMime(raw) {
  return String(raw || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function mimeForName(name) {
  return MIME_BY_EXT[extname(String(name || "")).toLowerCase()] || "";
}

function extForMime(mime) {
  return IMAGE_TYPES[mime] || Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)?.[0] || "";
}

/** ينظّف اسم الملف: بلا مسارات أو محارف تحكّم، ويرفض محاولات الالتفاف. */
export function safeFileName(raw) {
  const value = String(raw ?? "").replace(/\\/g, "/");
  if (!value.trim()) throw new UploadError(400, "اسم ملف فارغ غير مسموح");
  if (value.includes("\0")) throw new UploadError(400, "اسم الملف يحتوي محارف غير صالحة");
  if (value.split("/").includes("..")) throw new UploadError(400, "مسار الملف غير مسموح (يحتوي ..)");
  const base = value.split("/").filter(Boolean).pop() || "";
  if (!base || base === "." || base === "..") throw new UploadError(400, "اسم الملف غير صالح");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._\u0600-\u06ff-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 96);
  if (!cleaned.trim("._")) throw new UploadError(400, "اسم الملف غير صالح بعد التنقية");
  return cleaned;
}

/**
 * تحليل جسم multipart/form-data يدوياً.
 * @returns {Array<{name:string, filename:?string, mime:string, data:Buffer}>}
 */
export function parseMultipart(buf, boundary) {
  if (!boundary) throw new UploadError(400, "طلب multipart بلا boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buf.indexOf(delimiter);
  if (cursor === -1) throw new UploadError(400, "لم يُعثر على بداية أجزاء النموذج");

  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    // إشارة النهاية: --boundary--
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;

    const next = buf.indexOf(delimiter, start);
    if (next === -1) break;
    let end = next;
    if (end >= 2 && buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;

    const chunk = buf.subarray(start, end);
    const headerEnd = chunk.indexOf("\r\n\r\n");
    const rawHeaders = headerEnd === -1 ? "" : chunk.subarray(0, headerEnd).toString("utf8");
    const data = headerEnd === -1 ? Buffer.alloc(0) : chunk.subarray(headerEnd + 4);

    const disposition = /content-disposition:([^\r\n]+)/i.exec(rawHeaders)?.[1] || "";
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] || "";
    let filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    const encoded = /filename\*=([^;\r\n]+)/i.exec(disposition)?.[1];
    if (filename === null && encoded) {
      // RFC 5987: UTF-8''name%20with%20spaces
      const value = encoded.trim().replace(/^[^']*'[^']*'/, "");
      try {
        filename = decodeURIComponent(value);
      } catch {
        filename = value;
      }
    }
    const mime = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1]?.trim() || "";
    parts.push({ name, filename, mime: normalizeMime(mime), data });
    cursor = next;
  }
  return parts;
}

/** يحفظ أجزاء النموذج في data/uploads/<yyyy-mm-dd>/<uuid>-<safe-name>. */
export async function saveUploads(parts, options = {}) {
  const root = options.root || uploadsRoot();
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(root, day);
  const files = [];
  let total = 0;
  let created = false;

  for (const part of parts) {
    if (!part.filename) continue; // حقول نصية عادية: لا شأن لنا بها
    if (!part.data?.length) continue;
    if (files.length >= MAX_FILES) {
      throw new UploadError(413, `الحد الأقصى ${MAX_FILES} ملفاً في الطلب الواحد`);
    }
    if (part.data.length > MAX_FILE_BYTES) {
      throw new UploadError(
        413,
        `حجم الملف "${part.filename}" يتجاوز الحد المسموح (25MB)`,
      );
    }
    total += part.data.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new UploadError(413, "مجموع حجم الملفات يتجاوز الحد المسموح (40MB)");
    }

    const name = safeFileName(part.filename);
    const sniffed = sniffImageMime(part.data);
    const mime = sniffed || normalizeMime(part.mime) || mimeForName(name) || "application/octet-stream";
    const kind = sniffed ? "image" : "file";
    const ext = extname(name) ? "" : extForMime(mime);
    const stored = `${randomUUID()}-${name}${ext}`;
    const id = `${day}/${stored}`;

    if (!created) {
      await mkdir(dir, { recursive: true });
      created = true;
    }
    const abs = join(dir, stored);
    await writeFile(abs, part.data);
    const token = String(options.token || "").trim();
    const url = `/files/${encodeURI(id)}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    files.push({
      id,
      path: abs,
      name: name.slice(0, 120),
      size: part.data.length,
      mime,
      kind,
      url,
    });
  }
  return files;
}

/** يقرأ ملفاً مرفوعاً للمعاينة — صور فقط، وبلا التفاف مسارات. */
export async function resolveUploadFile(id, options = {}) {
  const raw = String(id ?? "");
  const root = options.root || uploadsRoot();
  if (!raw || raw.length > 300) return null;
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) return null;
  if (!/^\d{4}-\d{2}-\d{2}\/[^/]+$/.test(raw)) return null;

  const abs = resolve(root, raw);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) return null;
  const data = await readFile(abs).catch(() => null);
  if (!data) return null;
  const mime = sniffImageMime(data);
  if (!mime) return null; // الصور فقط
  return { abs, mime, data, size: info.size };
}

function clampLimit(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return 20;
  return Math.min(Math.max(n, 1), 20);
}

/**
 * إكمال المسارات داخل مساحة العمل. يعيد مسارات نسبية فقط.
 * q = بادئة نسبية، ويجوز أن تنتهي بـ / لسرد مجلد.
 */
export async function listWorkspacePaths(rawQuery, options = {}) {
  const root = options.root || config.workspace;
  const limit = clampLimit(options.limit);
  const skip = new Set(["node_modules", ".git"]);

  let q = String(rawQuery ?? "").trim().replace(/\\/g, "/");
  if (q.includes("\0")) throw new UploadError(400, "مسار غير صالح");
  if (q.startsWith("/") || /^[a-zA-Z]:/.test(q)) {
    throw new UploadError(400, "استخدم مساراً نسبياً داخل مساحة العمل");
  }
  if (q.split("/").includes("..") || q.startsWith("..")) {
    throw new UploadError(400, "مسار غير صالح: .. غير مسموح");
  }
  q = q.replace(/^\.\//, "").replace(/\/{2,}/g, "/");

  let listDir = "";
  let prefix = q;
  if (q.endsWith("/")) {
    listDir = q.slice(0, -1);
    prefix = "";
  } else if (q.includes("/")) {
    listDir = q.slice(0, q.lastIndexOf("/"));
    prefix = q.slice(q.lastIndexOf("/") + 1);
  }

  const dirAbs = listDir ? resolve(root, listDir) : resolve(root);
  if (dirAbs !== resolve(root) && !dirAbs.startsWith(resolve(root) + sep)) return [];
  const info = await stat(dirAbs).catch(() => null);
  if (!info?.isDirectory()) return [];

  let entries = [];
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }

  const needle = prefix.toLowerCase();
  const items = [];
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const isDir = entry.isDirectory();
    if (!isDir && !entry.isFile()) continue;
    if (needle && !entry.name.toLowerCase().startsWith(needle)) continue;
    const rel = listDir ? `${listDir}/${entry.name}` : entry.name;
    items.push({
      path: isDir ? `${rel}/` : rel,
      name: entry.name,
      type: isDir ? "dir" : "file",
    });
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "ar", { numeric: true });
  });
  return items.slice(0, limit);
}

/** يتحقق من صورة قادمة عبر WS ويعيد صيغة ImageContent بلا بادئة data:. */
export function normalizeImage(entry) {
  if (!entry || typeof entry !== "object") throw new UploadError(400, "صورة غير صالحة");
  const rawMime = normalizeMime(entry.mimeType || entry.mime);
  const mime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
  if (!IMAGE_TYPES[mime]) {
    throw new UploadError(
      400,
      `صيغة الصورة غير مدعومة (${rawMime || "غير معروفة"}). المسموح: PNG, JPEG, WEBP, GIF`,
    );
  }
  let data = String(entry.data ?? entry.base64 ?? "").trim();
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",");
    data = comma === -1 ? "" : data.slice(comma + 1);
  }
  data = data.replace(/\s+/g, "");
  if (!data) throw new UploadError(400, "بيانات الصورة فارغة");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new UploadError(400, "بيانات الصورة ليست base64 صالحاً");
  }
  const size = Math.floor((data.replace(/=+$/, "").length * 3) / 4);
  if (size > MAX_FILE_BYTES) {
    throw new UploadError(413, "حجم الصورة يتجاوز الحد المسموح (25MB)");
  }
  return { type: "image", data, mimeType: mime, size };
}

/** يتحقق من مرفقات المسارات ويعيد {path,name,mime,size} مطلقة. */
export async function normalizeAttachments(list, options = {}) {
  const out = [];
  const root = resolve(options.root || config.workspace);
  const uploads = resolve(options.uploadsRoot || uploadsRoot());
  const inside = (base, target) => target === base || target.startsWith(base + sep);
  let total = 0;

  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry) continue;
    const raw = typeof entry === "string" ? entry : entry.path;
    const given = String(raw ?? "").trim();
    if (!given) continue;
    if (given.includes("\0")) throw new UploadError(400, "مسار مرفق غير صالح");
    const abs = resolve(root, given);
    if (!inside(root, abs) && !inside(uploads, abs)) {
      throw new UploadError(400, `مرفق خارج مساحة العمل غير مسموح: ${given}`);
    }
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new UploadError(400, `المرفق غير موجود: ${given}`);
    if (info.size > MAX_FILE_BYTES) {
      throw new UploadError(413, `حجم المرفق "${given}" يتجاوز الحد المسموح (25MB)`);
    }
    total += info.size;
    if (total > MAX_TOTAL_BYTES) {
      throw new UploadError(413, "مجموع حجم المرفقات يتجاوز الحد المسموح (40MB)");
    }
    const mime =
      normalizeMime(entry.mime) || mimeForName(abs) || "application/octet-stream";
    out.push({
      path: abs,
      name: String(entry.name || abs.split(sep).pop() || "").slice(0, 160),
      mime,
      size: info.size,
    });
  }
  return out;
}

/** هل الصيغة صورة مدعومة؟ (يُستخدم لفرز المرفقات نصياً) */
export function isImageMime(mime) {
  return !!IMAGE_TYPES[normalizeMime(mime)];
}
