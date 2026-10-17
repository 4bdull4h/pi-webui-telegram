/**
 * إضافة التفويض (delegate) لوضع RPC.
 *
 * سبب الوجود: أنماط RPC لا تدعم customTools، فتُسجَّل الأداة هنا كإضافة pi
 * تُحمَّل عبر `--extension <project>/extensions` من src/rpc/client.js.
 *
 * السلوك مطابق لـ createDelegateTool في src/pi-manager.js:
 * - اختيار الوكيل بالمعرّف أو الاسم من data/agents.json.
 * - تشغيل الوكيل الهدف في عملية `pi --print` معزولة.
 * - إرجاع نص نتيجة الوكيل مع اسمه ودوره.
 *
 * قيود الأمان والموثوقية:
 * - الوكيل الحالي يجب أن يملك صلاحية `delegate`.
 * - عمق التفويض محدود (PI_DELEGATE_DEPTH ≤ 2).
 * - مهلة افتراضية 5 دقائق (DELEGATE_TIMEOUT_MS)، ويمكن تعطيل الأداة (DELEGATE_ENABLED=0).
 * - تحديثات تقدّم دورية كل 15 ثانية حتى يرى المستخدم أن الوكيل يعمل.
 * - قصّ النتيجة إلى 12000 حرف.
 * - لا تُستخدم ctx.ui.custom إطلاقاً، فتعمل الإضافة في TUI وRPC وprint.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/* =========================================================================
 * الثوابت
 * ========================================================================= */

/** مهلة التنفيذ الافتراضية: 5 دقائق. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** الحد الأقصى لعمق التفويض المتداخل. */
const MAX_DEPTH = 2;
/** الحد الأقصى لطول النص المُعاد إلى النموذج. */
const MAX_RESULT_CHARS = 12_000;
/** المهلة القصوى المسموح ضبطها عبر المتغير البيئي (24 ساعة). */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const FILE_DIR = dirname(fileURLToPath(import.meta.url));

/* =========================================================================
 * أدوات مساعدة
 * ========================================================================= */

interface AgentPermissions {
  read?: boolean;
  write?: boolean;
  execute?: boolean;
  network?: boolean;
  mcp?: boolean;
  delegate?: boolean;
  approve?: boolean;
}

interface AgentRecord {
  id: string;
  name?: string;
  role?: string;
  emoji?: string;
  systemPrompt?: string;
  permissions?: AgentPermissions;
  model?: { provider?: string; model?: string } | null;
  enabled?: boolean;
  /** غير قياسي: يفعّله المشرف إن أراد جلسة محفوظة للوكيل الفرعي. */
  session?: boolean;
}

function timeoutMs(): number {
  const raw = Number(process.env.DELEGATE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
}

function depth(): number {
  const raw = Number(process.env.PI_DELEGATE_DEPTH);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/** هل أداة التفويض مفعّلة؟ (DELEGATE_ENABLED=0 يعطّلها تماماً). */
function delegateEnabled(): boolean {
  const raw = String(process.env.DELEGATE_ENABLED ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/** مسارات محتملة لملف الوكلاء، بالترتيب. */
function agentsFileCandidates(): string[] {
  const list: string[] = [];
  for (const key of ["PI_WEBUI_AGENTS_FILE", "PI_AGENTS_FILE"]) {
    const value = process.env[key];
    if (value) list.push(resolve(value));
  }
  // الإضافة تعيش في <project>/extensions/delegate.ts
  list.push(resolve(FILE_DIR, "..", "data", "agents.json"));
  const cwd = process.cwd();
  list.push(join(cwd, "data", "agents.json"));
  list.push(join(cwd, "pi-webui-telegram", "data", "agents.json"));
  return [...new Set(list)];
}

/** يقرأ قائمة الوكلاء من data/agents.json (مع تسامح مع الشكلين). */
function loadAgents(): { agents: AgentRecord[]; file: string | null } {
  for (const file of agentsFileCandidates()) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const raw = Array.isArray(parsed)
        ? (parsed as AgentRecord[])
        : ((parsed as { agents?: AgentRecord[] })?.agents ?? []);
      const agents = raw.filter((agent) => agent && typeof agent.id === "string");
      if (agents.length > 0) return { agents, file };
    } catch {
      /* ملف تالف: جرّب المسار التالي */
    }
  }
  return { agents: [], file: null };
}

/** اختيار الوكيل بالمعرّف أو الاسم (أو الدور). */
function findAgent(agents: AgentRecord[], key: string): AgentRecord | undefined {
  const wanted = String(key || "").trim().toLowerCase();
  if (!wanted) return undefined;
  return (
    agents.find((agent) => agent.id.toLowerCase() === wanted) ||
    agents.find((agent) => (agent.name || "").trim().toLowerCase() === wanted) ||
    agents.find((agent) => (agent.role || "").trim().toLowerCase() === wanted) ||
    agents.find((agent) => (agent.name || "").toLowerCase().includes(wanted))
  );
}

/**
 * أدوات الوكيل الهدف من صلاحياته فقط (نفس منطق toolsFor في src/control.js
 * مع الالتزام بخريطة الصلاحيات → الأدوات المطلوبة).
 */
function toolsFor(agent: AgentRecord): string[] {
  const p = agent.permissions || {};
  const tools: string[] = [];
  if (p.read) tools.push("read", "grep", "find", "ls");
  if (p.write) tools.push("write", "edit");
  if (p.execute) tools.push("bash");
  if (p.network) tools.push("web_search", "web_fetch");
  if (p.delegate) tools.push("delegate");
  return [...new Set(tools)];
}

/** الوكيل الحالي: من متغير البيئة أو من بصمة systemPrompt المُلحَق بالجلسة. */
function resolveCurrentAgent(agents: AgentRecord[], systemPrompt: string): AgentRecord | undefined {
  for (const key of ["PI_AGENT_ID", "PI_WEBUI_AGENT_ID", "DELEGATE_AGENT_ID"]) {
    const value = process.env[key];
    if (!value) continue;
    const agent = findAgent(agents, value);
    if (agent) return agent;
  }
  if (!systemPrompt) return undefined;
  let best: AgentRecord | undefined;
  let bestLength = 0;
  for (const agent of agents) {
    const prompt = (agent.systemPrompt || "").trim();
    if (prompt.length < 12) continue;
    if (systemPrompt.includes(prompt) && prompt.length > bestLength) {
      best = agent;
      bestLength = prompt.length;
    }
  }
  return best;
}

/** مسار CLI الحالي: نفس ما شُغّلت به العملية الحالية. */
function resolveCliPath(): string | null {
  const fromEnv = process.env.PI_CLI_PATH;
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv);
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1)) return resolve(argv1);
  return null;
}

/** مسار ملف الإضافة نفسه (لتوريثه إلى الوكيل الفرعي عند السماح بالتفويض). */
function resolveSelfExtension(): string | null {
  for (const ext of [".ts", ".js", ".mjs", ".tsx"]) {
    const file = join(FILE_DIR, `delegate${ext}`);
    if (existsSync(file)) return file;
  }
  return null;
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n…[قُصِّصت النتيجة إلى ${MAX_RESULT_CHARS} حرفاً]`,
    truncated: true,
  };
}

interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/** يشغّل العملية الفرعية ويجمع مخرجاتها مع مهلة وإلغاء. */
function runChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal },
): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, signal, stdout, stderr, timedOut, aborted });
    };

    const kill = (reason: "timeout" | "abort") => {
      if (reason === "timeout") timedOut = true;
      else aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* العملية انتهت بالفعل */
      }
      setTimeout(() => {
        if (!settled) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* تجاهل */
          }
        }
      }, 3000).unref?.();
    };

    const onAbort = () => kill("abort");
    const timer = setTimeout(() => kill("timeout"), options.timeout);
    timer.unref?.();

    if (options.signal) {
      if (options.signal.aborted) kill("abort");
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}${err instanceof Error ? err.message : String(err)}`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/* =========================================================================
 * الأداة
 * ========================================================================= */

const delegateTool = defineTool({
  name: "delegate",
  label: "تفويض وكيل",
  description:
    "فوّض مهمة إلى وكيل متخصص وأعد نتيجته. يقبل معرّف الوكيل أو اسمه (مثل planner أو المنفذ أو reviewer) ويشغّله في عملية معزولة بأدواته وصلاحياته الخاصة، ثم يعيد نص نتيجته.",
  promptSnippet: "delegate: فوّض مهمة إلى وكيل متخصص (مخطط، منفذ، مراجع...)",
  parameters: Type.Object({
    agent: Type.String({ description: "معرّف الوكيل أو اسمه، مثل planner أو المنفذ أو reviewer" }),
    task: Type.String({ description: "وصف كامل ومحدد للمهمة المفوّضة" }),
  }),
  executionMode: "sequential",

  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    const startedAt = Date.now();
    const fail = (message: string, details: Record<string, unknown> = {}) => ({
      content: [{ type: "text" as const, text: message }],
      details: { ...details, ok: false, durationMs: Date.now() - startedAt },
      isError: true,
    });

    /* --- 0) هل التفويض مفعّل؟ --- */
    if (!delegateEnabled()) {
      return fail("التفويض معطّل حالياً (DELEGATE_ENABLED=0). نفّذ المهمة مباشرةً بدل تفويضها.");
    }

    /* --- 1) عمق التفويض --- */
    const currentDepth = depth();
    if (currentDepth >= MAX_DEPTH) {
      return fail(
        `تعذّر التفويض: تجاوزت الحد الأقصى لعمق التفويض (${MAX_DEPTH}). العمق الحالي: ${currentDepth}. نفّذ المهمة بنفسك بدل تفويضها.`,
        { depth: currentDepth },
      );
    }

    const task = String(params?.task || "").trim();
    if (!task) return fail("تعذّر التفويض: نص المهمة (task) فارغ.");
    const requested = String(params?.agent || "").trim();
    if (!requested) return fail("تعذّر التفويض: اسم الوكيل (agent) فارغ.");

    /* --- 2) الوكلاء من data/agents.json --- */
    const { agents, file } = loadAgents();
    if (agents.length === 0) {
      return fail(
        `تعذّر التفويض: لم يُعثر على ملف الوكلاء data/agents.json أو أنه لا يحتوي وكلاء. (المسارات المجرّبة: ${agentsFileCandidates().join("، ")})`,
      );
    }

    const target = findAgent(agents, requested);
    if (!target) {
      const available = agents.map((agent) => `${agent.id}=${agent.name || agent.id}`).join("، ");
      return fail(`تعذّر التفويض: الوكيل غير موجود: ${requested}. الوكلاء المتاحون: ${available}.`);
    }
    if (target.enabled === false) {
      return fail(`تعذّر التفويض: الوكيل معطّل: ${target.name || target.id}.`);
    }

    /* --- 3) صلاحية التفويض للوكيل الحالي --- */
    const currentAgent = resolveCurrentAgent(agents, String(ctx?.getSystemPrompt?.() || ""));
    if (currentAgent && !currentAgent.permissions?.delegate) {
      return fail(
        `تعذّر التفويض: الوكيل الحالي (${currentAgent.name || currentAgent.id}) لا يملك صلاحية التفويض. اطلب تمكين "التفويض" له من الإعدادات.`,
        { currentAgent: currentAgent.id },
      );
    }

    /* --- 4) بناء أوامر العملية الفرعية --- */
    const cliPath = resolveCliPath();
    if (!cliPath) {
      return fail(
        "تعذّر التفويض: لم يُعثر على واجهة pi CLI. اضبط PI_CLI_PATH على مسار dist/cli.js.",
      );
    }

    // النموذج: إعدادات الوكيل الهدف، وإلا نموذج الجلسة الحالية، وإلا متغيرات البيئة.
    const sessionModel = ctx?.model as { provider?: string; id?: string } | undefined;
    const agentModel = target.model && (target.model.provider || target.model.model) ? target.model : null;
    const provider = agentModel
      ? agentModel.provider || sessionModel?.provider || process.env.PI_PROVIDER || null
      : sessionModel?.provider || process.env.PI_PROVIDER || null;
    const model = agentModel
      ? agentModel.model || null
      : sessionModel?.id || process.env.PI_MODEL || null;

    const tools = toolsFor(target);
    const args: string[] = [cliPath, "--print"];
    if (provider && model) args.push("--provider", String(provider));
    if (model) args.push("--model", String(model));
    if (tools.length > 0) args.push("--tools", tools.join(","));

    // جلسة الوكيل: افتراضياً بلا جلسة (معزولة تماماً كما في runSubAgent).
    const keepSession = target.session === true;
    if (!keepSession) args.push("--no-session");
    args.push("--name", `sub:${target.id}`);

    // دور الوكيل يُمرّر كتعليمات إضافية حتى يتصرف كدوره.
    if (target.systemPrompt && target.systemPrompt.trim()) {
      args.push("--append-system-prompt", target.systemPrompt.trim());
    }

    // إن كان الوكيل الهدف يملك التفويض نُتيح له الأداة (وحارس العمق يمنع الشلال).
    if (target.permissions?.delegate) {
      const selfExtension = resolveSelfExtension();
      if (selfExtension) args.push("--extension", selfExtension);
    }

    args.push(task);

    const nodeBin = process.env.PI_NODE_PATH || process.execPath;
    const cwd = ctx?.cwd || process.cwd();
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PI_DELEGATE_DEPTH: String(currentDepth + 1),
      ...(currentAgent ? { PI_AGENT_ID: currentAgent.id } : {}),
    };

    // تحديثات تقدّم دورية حتى يرى المستخدم أن الوكيل ما زال يعمل.
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    if (typeof onUpdate === "function") {
      const label = target.name || target.id;
      progressTimer = setInterval(() => {
        const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        const mm = Math.floor(elapsed / 60);
        const ss = String(elapsed % 60).padStart(2, "0");
        try {
          onUpdate({
            content: [{ type: "text" as const, text: `⏳ الوكيل ${label} يعمل… (${mm}:${ss})` }],
            details: { agent: target.id, elapsedMs: Date.now() - startedAt },
          });
        } catch {
          /* تجاهل فشل التحديث */
        }
      }, 15_000);
      progressTimer.unref?.();
    }

    let outcome: SpawnOutcome;
    try {
      outcome = await runChild(nodeBin, args, {
        cwd,
        env: childEnv,
        timeout: timeoutMs(),
        signal,
      });
    } catch (err) {
      return fail(
        `فشل تشغيل الوكيل ${target.name || target.id}: ${err instanceof Error ? err.message : String(err)}`,
        { agent: target.id },
      );
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }

    const stderrTail = outcome.stderr.trim().slice(-2000);
    const details = {
      ok: outcome.code === 0 && !outcome.timedOut && !outcome.aborted,
      agent: target.id,
      provider: provider || null,
      model: model || null,
      tools,
      exitCode: outcome.code,
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      depth: currentDepth,
      agentsFile: file,
      durationMs: Date.now() - startedAt,
    };

    if (outcome.timedOut) {
      return fail(
        `انتهت مهلة تفويض الوكيل ${target.name || target.id} بعد ${Math.round(timeoutMs() / 1000)} ثانية. قلّل نطاق المهمة أو ارفع DELEGATE_TIMEOUT_MS.${stderrTail ? `\nآخر أخطاء: ${stderrTail}` : ""}`,
        details,
      );
    }
    if (outcome.aborted) {
      return fail(`أُلغي تفويض الوكيل ${target.name || target.id}.`, details);
    }
    if (outcome.code !== 0) {
      return fail(
        `فشل الوكيل ${target.name || target.id} (رمز الخروج ${outcome.code ?? "غير معروف"}).${stderrTail ? `\nالسبب: ${stderrTail}` : "\nلم تُرجع العملية أي تفاصيل."}`,
        details,
      );
    }

    const raw = (outcome.stdout || "").replace(/\r\n/g, "\n").trim();
    if (!raw) {
      return fail(
        `لم يُرجع الوكيل ${target.name || target.id} أي نص.${stderrTail ? `\nالسبب: ${stderrTail}` : ""}`,
        details,
      );
    }

    const { text, truncated } = truncate(raw);
    const header = `${target.emoji || "🤖"} ${target.name || target.id} (${target.role || target.id}):`;
    return {
      content: [{ type: "text" as const, text: `${header}\n${text}` }],
      details: { ...details, truncated },
    };
  },
});

export default function delegateExtension(pi: ExtensionAPI): void {
  if (!delegateEnabled()) return;
  pi.registerTool(delegateTool);
}
