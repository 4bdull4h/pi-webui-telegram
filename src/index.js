#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import config, { ROOT } from "./config.js";
import logger from "./logger.js";
import { JsonStore } from "./store.js";
import { PiManager } from "./pi-manager.js";
import { WebServer } from "./web-server.js";
import { TelegramBot } from "./telegram-bot.js";

function banner() {
  const line = "─".repeat(48);
  console.log(`\n\x1b[36m${line}\x1b[0m`);
  console.log("  \x1b[1mPi — مساعد برمجي عربي\x1b[0m");
  console.log(`  واجهة ويب RTL + بوت تيليجرام`);
  console.log(`\x1b[36m${line}\x1b[0m`);
  console.log(`  مساحة العمل : ${config.workspace}`);
  console.log(`  النموذج     : ${config.defaultProvider}/${config.defaultModel}`);
  console.log(`  التفكير     : ${config.defaultThinking}`);
  console.log(`  الويب        : ${config.web.enabled ? `http://${config.host}:${config.port}` : "معطّل"}`);
  console.log(`  تيليجرام    : ${config.telegram.enabled && config.telegram.token ? "مفعّل" : "معطّل"}`);
  console.log(`  المشرف      : ${config.supervised ? "نعم (إعادة تشغيل ذاتية)" : "لا (شغّل عبر server.sh start)"}`);
  console.log(`\x1b[36m${line}\x1b[0m\n`);
}

async function main() {
  mkdirSync(config.dataDir, { recursive: true });
  banner();

  const store = new JsonStore(join(config.dataDir, "conversations.json"), {});
  const manager = new PiManager(store);
  await manager.init();
  logger.ok(`تم تحميل ${manager.listModels().length} نموذجاً متاحاً.`);

  let shuttingDown = false;
  let web;
  let telegram;

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`إيقاف (رمز ${code})…`);
    telegram?.stop();
    await web?.stop().catch(() => undefined);
    manager.disposeAll();
    logger.ok("تم الإيقاف.");
    process.exit(code);
  };

  // رمز 75 = EX_TEMPFAIL: يطلب من المشرف في server.sh إعادة التشغيل
  const requestRestart = async (source = "app") => {
    if (!config.supervised) {
      logger.warn(`إعادة تشغيل مطلوبة من ${source} لكن الخادم غير مُدار. شغّله عبر ./server.sh start`);
      return false;
    }
    logger.info(`إعادة تشغيل مطلوبة من ${source}…`);
    await shutdown(75);
    return true;
  };

  web = new WebServer(manager, { onRestart: requestRestart });
  telegram = new TelegramBot(manager, { onRestart: requestRestart });

  await web.start();
  await telegram.start();

  if (!config.web.enabled && !telegram.enabled) {
    logger.warn("لا شيء مفعّل. شغّل الويب أو اضبط TELEGRAM_BOT_TOKEN.");
  }

  // إعادة تشغيل مؤجّلة: يكتبها server.sh عندما يُستدعى من داخل الخادم،
  // فننتظر حتى تنتهي المهام الجارية ثم نعيد التشغيل دون قطع الجلسات.
  const restartFlag = join(ROOT, ".run", "restart.requested");
  let restartArmedAt = 0;
  const restartWatcher = setInterval(() => {
    if (!existsSync(restartFlag)) {
      restartArmedAt = 0;
      return;
    }
    if (!restartArmedAt) {
      restartArmedAt = Date.now();
      logger.info("طُلب إعادة تشغيل — بانتظار انتهاء المهام الجارية…");
    }
    const forced = Date.now() - restartArmedAt > 10 * 60 * 1000;
    if (!manager.isIdle() && !forced) return;
    try {
      rmSync(restartFlag, { force: true });
    } catch {
      /* ignore */
    }
    clearInterval(restartWatcher);
    void requestRestart("flag");
  }, 1000);
  restartWatcher.unref?.();

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("unhandledRejection", (err) => logger.error("وعد مرفوض:", err));
  process.on("uncaughtException", (err) => logger.error("استثناء غير ملتقط:", err));
}

main().catch((err) => {
  logger.error("فشل بدء التشغيل:", err?.stack || err?.message || err);
  process.exit(1);
});
