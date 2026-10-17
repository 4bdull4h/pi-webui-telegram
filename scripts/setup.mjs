#!/usr/bin/env node
/**
 * يربط حزمة Pi المثبّتة بمسار node_modules في المشروع،
 * وينشئ ملف .env من .env.example عند الحاجة.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  realpathSync,
  copyFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TARGET_PKG = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const LINK = join(ROOT, "node_modules");

const log = (...a) => console.log("[setup]", ...a);

function hasPackage(nodeModulesDir) {
  return (
    !!nodeModulesDir &&
    existsSync(join(nodeModulesDir, "@earendil-works", "pi-coding-agent"))
  );
}

function candidateNodeModules() {
  const candidates = [];

  const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
  if (installRoot) {
    try {
      const releases = join(realpathSync(installRoot), "releases");
      if (existsSync(releases)) {
        for (const v of readdirSync(releases).sort().reverse()) {
          candidates.push(join(releases, v, "node_modules"));
        }
      }
    } catch {
      /* ignore */
    }
  }

  // عبر الأمر المثبّت: pi -> .../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
  try {
    const piBin = execSync("command -v pi", { encoding: "utf8" }).trim();
    if (piBin) {
      const real = realpathSync(piBin);
      const marker = join("@earendil-works", "pi-coding-agent");
      const idx = real.indexOf(marker);
      if (idx !== -1) candidates.push(real.slice(0, idx - 1));
    }
  } catch {
    /* ignore */
  }

  // مسار Pi المُدار الافتراضي لمستخدمي Linux/macOS
  const releases = join(os.homedir(), ".pi", "agent", "install", "releases");
  if (existsSync(releases)) {
    for (const v of readdirSync(releases).sort().reverse()) {
      candidates.push(join(releases, v, "node_modules"));
    }
  }

  // Windows / WSL
  const winReleases = join(os.homedir(), ".pi", "agent", "install", "releases");
  void winReleases;

  return candidates;
}

function ensureLink() {
  if (hasPackage(join(ROOT, "node_modules"))) {
    log("تبعيات Pi موجودة مسبقاً.");
    return;
  }

  const source = candidateNodeModules().find(hasPackage);
  if (!source) {
    console.error(
      "[setup] تعذّر العثور على حزمة @earendil-works/pi-coding-agent.\n" +
        "       ثبّت Pi أولاً أو مرّر PI_MANAGED_INSTALL_ROOT.",
    );
    process.exit(1);
  }

  try {
    const st = lstatSync(LINK);
    if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) unlinkSync(LINK);
  } catch {
    /* لا يوجد */
  }

  mkdirSync(ROOT, { recursive: true });
  symlinkSync(source, LINK, "dir");
  log(`تم الربط: ${LINK} -> ${source}`);
}

function ensureEnv() {
  const envPath = join(ROOT, ".env");
  const example = join(ROOT, ".env.example");
  if (!existsSync(envPath) && existsSync(example)) {
    copyFileSync(example, envPath);
    log("تم إنشاء ملف .env — عدّل التوكن والإعدادات قبل التشغيل.");
  }
}

ensureLink();
ensureEnv();
log("جاهز.");
