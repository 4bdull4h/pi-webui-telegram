const COLORS = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const useColor = process.stdout.isTTY && process.env.NO_COLOR !== "1";

function paint(color, text) {
  return useColor ? `${color}${text}${COLORS.reset}` : text;
}

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function line(level, color, args) {
  const prefix = paint(COLORS.gray, stamp());
  const tag = paint(color, level.padEnd(5));
  console.log(`${prefix} ${tag}`, ...args);
}

export const logger = {
  info: (...a) => line("INFO", COLORS.cyan, a),
  warn: (...a) => line("WARN", COLORS.yellow, a),
  error: (...a) => line("ERROR", COLORS.red, a),
  ok: (...a) => line("OK", COLORS.green, a),
  debug: (...a) => {
    if (process.env.DEBUG) line("DEBUG", COLORS.magenta, a);
  },
};

export default logger;
