#!/usr/bin/env node
/**
 * Pi Web UI + Telegram bridge — CLI
 * Made by @coder480
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] || "help";

function version() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function help() {
  console.log(`
  Pi Web UI + Telegram bridge  v${version()}
  Made by @coder480

  Usage:
    pi-webui setup [options]     Interactive installer (Arabic / English)
    pi-webui start [--no-web] [--no-telegram]
    pi-webui --version

  Setup options:
    --lang=ar|en        Interface language
    --name="..."        Assistant display name
    --port=8787         Web UI port
    --workspace=DIR     Agent workspace
    --telegram-id=ID    Telegram numeric ID (optional, allowlist)
    --token=TOKEN       Telegram bot token (optional)
    --no-service        Do not create a systemd user service
    --force             Overwrite an existing .env
    --yes               Non-interactive defaults (for automation)
`);
}

if (command === "setup" || command === "install") {
  const child = spawn(process.execPath, [join(ROOT, "scripts", "install-wizard.mjs"), ...args.slice(1)], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (command === "start" || command === "serve") {
  // pass through flags such as --no-web / --no-telegram
  process.argv = [process.argv[0], join(ROOT, "src", "index.js"), ...args.slice(1)];
  await import(join(ROOT, "src", "index.js"));
} else if (command === "--version" || command === "-v" || command === "version") {
  console.log(version());
} else {
  help();
}
