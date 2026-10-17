import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * مخزن JSON بسيط مع كتابة ذرّية، لحفظ بيانات المحادثات
 * (مسار الجلسة، النموذج، مستوى التفكير، العنوان…).
 */
export class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = this.#load();
    this._flushTimer = null;
  }

  #load() {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        if (parsed && typeof parsed === "object") return { ...this.defaults, ...parsed };
      }
    } catch {
      /* ملف تالف: نبدأ من جديد */
    }
    return structuredClone(this.defaults);
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.#scheduleFlush();
    return value;
  }

  delete(key) {
    delete this.data[key];
    this.#scheduleFlush();
  }

  all() {
    return this.data;
  }

  #scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, 250);
    this._flushTimer.unref?.();
  }

  flush() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch {
      /* تجاهل أخطاء الكتابة */
    }
  }
}

export function dataPath(config, ...parts) {
  return join(config.dataDir, ...parts);
}

export default JsonStore;
