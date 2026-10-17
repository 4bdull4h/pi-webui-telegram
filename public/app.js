/* مساعد Pi — منطق الواجهة العربية RTL */

const $ = (sel) => document.querySelector(sel);

const els = {
  app: $("#app"),
  sidebar: $("#sidebar"),
  sidebarClose: $("#sidebarClose"),
  menuBtn: $("#menuBtn"),
  sessions: $("#sessions"),
  newSessionBtn: $("#newSessionBtn"),
  agentSelect: $("#agentSelect"),
  agentBadge: $("#agentBadge"),
  syncBadge: $("#syncBadge"),
  modelSelect: $("#modelSelect"),
  thinkingSelect: $("#thinkingSelect"),
  sessionBadge: $("#sessionBadge"),
  statusBtn: $("#statusBtn"),
  statusModal: $("#statusModal"),
  statusClose: $("#statusClose"),
  statusBody: $("#statusBody"),
  messages: $("#messages"),
  hero: $("#hero"),
  input: $("#input"),
  sendBtn: $("#sendBtn"),
  stopBtn: $("#stopBtn"),
  composerHint: $("#composerHint"),
  conn: $("#conn"),
  themeBtn: $("#themeBtn"),
  compactBtn: $("#compactBtn"),
  restartBtn: $("#restartBtn"),
  toasts: $("#toasts"),
  usageOpen: $("#usageOpen"),
  uDailyRemain: $("#uDailyRemain"),
  uDailyBar: $("#uDailyBar"),
  uDailyUsed: $("#uDailyUsed"),
  uDailyLimit: $("#uDailyLimit"),
  uWeeklyRemain: $("#uWeeklyRemain"),
  uWeeklyBar: $("#uWeeklyBar"),
  uWeeklyUsed: $("#uWeeklyUsed"),
  uWeeklyLimit: $("#uWeeklyLimit"),
  uCtxRemain: $("#uCtxRemain"),
  uCtxBar: $("#uCtxBar"),
  uCtxText: $("#uCtxText"),
  controlCenter: $("#controlCenter"),
  controlClose: $("#controlClose"),
  controlTabs: $("#controlTabs"),
  controlBody: $("#controlBody"),
  controlReload: $("#controlReload"),
  controlSubtitle: $("#controlSubtitle"),
  controlBtnSide: $("#controlBtnSide"),
  controlBtnTop: $("#controlBtnTop"),
};

const THINKING_LABELS = {
  ar: {
    off: "متوقف",
    minimal: "بسيط جداً",
    low: "منخفض",
    medium: "متوسط",
    high: "مرتفع",
    xhigh: "مرتفع جداً",
    max: "أقصى",
  },
};
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const HERO_HTML = els.hero ? els.hero.outerHTML : "";

const state = {
  conversationId: null,
  ws: null,
  connected: false,
  models: [],
  sessions: [],
  agents: [],
  agent: null,
  skills: [],
  usage: null,
  contextUsage: null,
  current: null,
  streaming: false,
  currentTurn: null,
  toolCards: new Map(),
  reconnectDelay: 1000,
  config: null,
  control: {
    open: false,
    tab: "overview",
    overview: null,
    loading: false,
    skillDraft: null,
    extensionDraft: null,
    agentDraft: null,
    providerDraft: null,
    keyFor: null,
    showAllProviders: false,
    refreshTimer: null,
  },
};

/* ===== أدوات مساعدة ===== */

function getToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    localStorage.setItem("pi.token", fromUrl);
    return fromUrl;
  }
  return localStorage.getItem("pi.token") || "";
}

function getConversationId() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("conversation");
  if (fromUrl) {
    localStorage.setItem("pi.conversation", fromUrl);
    return fromUrl;
  }
  if (state.config?.syncWebTelegram && state.config?.sharedSessionId) {
    localStorage.setItem("pi.conversation", state.config.sharedSessionId);
    return state.config.sharedSessionId;
  }
  let id = localStorage.getItem("pi.conversation");
  if (!id || id.startsWith("web:")) {
    id = `web:${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("pi.conversation", id);
  }
  return id;
}

function toast(message, kind = "") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(8px)";
    setTimeout(() => node.remove(), 250);
  }, 4200);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

function fmtCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2).replace(/\.0+$/, "")}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0+$/, "")}K`;
  return String(Math.round(n));
}

function fmtCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "";
  }
}

function clampPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function levelClass(percent) {
  const p = Number(percent);
  if (!Number.isFinite(p)) return "";
  if (p >= 90) return "danger";
  if (p >= 70) return "warn";
  return "";
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const token = getToken();
  const url = new URL(path, location.origin);
  if (token) url.searchParams.set("token", token);
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error || `فشل الطلب (${response.status})`);
  }
  return data;
}

const ALLOWED_TAGS = new Set([
  "P", "BR", "HR", "B", "STRONG", "I", "EM", "U", "S", "DEL", "MARK", "SMALL",
  "CODE", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6",
  "A", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "SPAN", "DIV", "SUP", "SUB",
]);

function sanitize(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const dangerous = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT"]);
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (dangerous.has(child.tagName)) {
        child.remove();
        continue;
      }
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value || "";
        if (name.startsWith("on")) child.removeAttribute(attr.name);
        else if ((name === "href" || name === "src") && /^\s*(javascript|data):/i.test(value))
          child.removeAttribute(attr.name);
        else if (name !== "href" && name !== "title" && name !== "colspan" && name !== "rowspan" && name !== "class")
          child.removeAttribute(attr.name);
      }
      if (child.tagName === "A") {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer");
      }
      walk(child);
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

function markdownToHtml(markdown) {
  const text = String(markdown ?? "");
  if (window.marked && typeof window.marked.parse === "function") {
    try {
      return sanitize(window.marked.parse(text, { gfm: true, breaks: true }));
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function enhance(container) {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.querySelector(".copy-btn")) continue;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "نسخ";
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code")?.innerText ?? pre.innerText;
      navigator.clipboard?.writeText(code).then(
        () => {
          btn.textContent = "تم ✓";
          setTimeout(() => (btn.textContent = "نسخ"), 1200);
        },
        () => toast("تعذّر النسخ", "error"),
      );
    });
    pre.appendChild(btn);
  }
}

/* ===== بناء الرسائل ===== */

function nearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

function hideHero() {
  const hero = els.messages.querySelector(".hero");
  if (hero) hero.remove();
  if (els.hero) els.hero.remove();
}

function createMessage(role) {
  hideHero();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "🧑" : "🤖";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.dir = "auto";
  wrap.append(avatar, bubble);
  els.messages.appendChild(wrap);
  return { wrap, bubble };
}

function addUserMessage(text, source = "web") {
  const { wrap, bubble } = createMessage("user");
  const avatar = wrap.querySelector(".avatar");
  if (avatar) {
    avatar.textContent = source === "telegram" ? "📱" : source === "api" ? "🔗" : "🧑";
  }
  bubble.innerHTML = markdownToHtml(text);
  if (source && source !== "web") {
    const label = document.createElement("div");
    label.className = "msg-source";
    label.textContent = source === "telegram" ? "📱 من تيليجرام" : "🔗 مصدر خارجي";
    bubble.appendChild(label);
  }
  enhance(bubble);
  scrollToBottom();
  return wrap;
}

function addNotice(text) {
  const node = document.createElement("div");
  node.className = "msg";
  node.style.justifyContent = "center";
  node.innerHTML = `<div class="badge" dir="auto" style="margin:auto">${escapeHtml(text)}</div>`;
  els.messages.appendChild(node);
  scrollToBottom();
}

function addErrorMessage(text) {
  const { bubble } = createMessage("assistant");
  bubble.classList.add("error");
  bubble.innerHTML = `<b>❌ حدث خطأ</b><br><bdi>${escapeHtml(text)}</bdi>`;
  scrollToBottom();
}

function createToolCard(container, { id, name, hint }) {
  const card = document.createElement("div");
  card.className = "tool running";
  card.innerHTML = `
    <div class="tool-head" aria-expanded="false">
      <span aria-hidden="true">🛠️</span>
      <span class="t-name" dir="auto">${escapeHtml(name)}</span>
      <span class="t-hint">${escapeHtml(hint || "")}</span>
      <span class="t-status">جارٍ…</span>
      <span class="t-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>
    </div>
    <div class="tool-body"><pre dir="ltr"></pre></div>`;
  const head = card.querySelector(".tool-head");
  head.addEventListener("click", () => {
    head.setAttribute("aria-expanded", card.classList.toggle("open") ? "true" : "false");
  });
  container.appendChild(card);
  if (id) state.toolCards.set(id, card);
  return card;
}

function updateToolCard(card, { output, isError }) {
  if (!card) return;
  card.classList.remove("running");
  if (isError) card.classList.add("error");
  card.querySelector(".t-status").textContent = isError ? "خطأ" : "انتهى";
  const pre = card.querySelector(".tool-body pre");
  if (output) pre.textContent = output;
  if (isError) {
    card.classList.add("open");
    card.querySelector(".tool-head").setAttribute("aria-expanded", "true");
  }
  scrollToBottom();
}

function beginAssistantTurn() {
  const { wrap, bubble } = createMessage("assistant");
  const thinkingBox = document.createElement("details");
  thinkingBox.className = "thinking";
  thinkingBox.innerHTML = `<summary>🧠 سلسلة التفكير</summary><div class="thinking-body" dir="auto"></div>`;
  const md = document.createElement("div");
  md.className = "md";
  md.dir = "auto";
  const tools = document.createElement("div");
  tools.className = "tools";
  bubble.append(thinkingBox, md, tools);

  let raw = "";
  let thinking = "";
  let scheduled = false;
  let usage = null;
  let model = null;

  const render = () => {
    scheduled = false;
    md.innerHTML = markdownToHtml(raw);
    enhance(md);
    scrollToBottom();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  };

  const turn = {
    wrap,
    bubble,
    tools,
    get raw() {
      return raw;
    },
    setText(text) {
      raw = text || "";
      schedule();
    },
    appendText(delta) {
      raw += delta;
      schedule();
    },
    appendThinking(delta) {
      thinking += delta;
      thinkingBox.style.display = "";
      thinkingBox.querySelector(".thinking-body").textContent = thinking;
      scrollToBottom();
    },
    addTool(info) {
      return createToolCard(tools, info);
    },
    setUsage(u, m) {
      usage = u;
      model = m;
    },
    finalize() {
      render();
      thinkingBox.style.display = thinking ? "" : "none";
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      const parts = [];
      if (model) parts.push(`🧩 ${escapeHtml(model)}`);
      if (usage && usage.totalTokens) {
        parts.push(`🔢 ${usage.totalTokens} توكن`);
        if (usage.cost && usage.cost.total) parts.push(`💲 ${usage.cost.total.toFixed(4)}`);
      }
      if (parts.length) {
        meta.innerHTML = parts.join(" &nbsp;·&nbsp; ");
        bubble.appendChild(meta);
      }
    },
    removeIfEmpty() {
      if (!raw.trim() && !thinking.trim() && tools.children.length === 0) wrap.remove();
    },
  };
  return turn;
}

function renderTranscript(entries) {
  for (const entry of entries || []) {
    if (entry.role === "user") {
      addUserMessage(entry.text);
    } else if (entry.role === "assistant") {
      if (entry.text && entry.text.trim()) {
        const turn = beginAssistantTurn();
        turn.setText(entry.text);
        turn.finalize();
      }
    } else if (entry.role === "tool") {
      const turn = state.currentTurn || beginAssistantTurn();
      const card = turn.addTool({ name: entry.name, hint: "" });
      updateToolCard(card, { output: entry.output, isError: entry.isError });
      if (!state.currentTurn) {
        turn.finalize();
      }
    }
  }
  scrollToBottom(true);
}

/* ===== تحديث الواجهة ===== */

function setConnected(connected) {
  state.connected = connected;
  els.conn.classList.toggle("online", connected);
  els.conn.lastChild.textContent = connected ? " متصل" : " غير متصل";
}

function setStreaming(streaming) {
  state.streaming = streaming;
  els.sendBtn.classList.toggle("hidden", streaming);
  els.stopBtn.classList.toggle("hidden", !streaming);
  els.composerHint.textContent = streaming
    ? "جارٍ التوليد… يمكنك الإرسال لإضافة توجيه."
    : state.config?.syncWebTelegram
      ? "🔗 الجلسة مشتركة مع تيليجرام — الطلبات والردود تظهر في المكانين."
      : "";
}

function populateModels() {
  const select = els.modelSelect;
  select.innerHTML = "";
  const groups = new Map();
  for (const model of state.models) {
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider).push(model);
  }
  for (const [provider, models] of [...groups.entries()].sort()) {
    const group = document.createElement("optgroup");
    group.label = provider;
    for (const model of models) {
      const option = document.createElement("option");
      option.value = `${model.provider}/${model.id}`;
      option.textContent = model.name || model.id;
      group.appendChild(option);
    }
    select.appendChild(group);
  }
}

function populateThinking() {
  const select = els.thinkingSelect;
  select.innerHTML = "";
  const levels = state.current?.thinkingLevels?.length ? state.current.thinkingLevels : THINKING_ORDER;
  for (const level of levels) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = THINKING_LABELS.ar[level] || level;
    select.appendChild(option);
  }
}

function applyState(next) {
  state.current = next;
  if (!next) return;
  els.sessionBadge.textContent = next.title || (next.sessionId ? `جلسة ${String(next.sessionId).slice(0, 8)}` : "جلسة جديدة");
  els.sessionBadge.title = next.sessionFile || "";
  if (next.agent) applyAgent(next.agent);
  if (next.contextUsage !== undefined) {
    state.contextUsage = next.contextUsage;
    renderUsage();
  }
  const modelValue = `${next.provider}/${next.model}`;
  if ([...els.modelSelect.options].some((o) => o.value === modelValue)) {
    els.modelSelect.value = modelValue;
  }
  populateThinking();
  els.thinkingSelect.value = next.thinking;
  setStreaming(!!next.isStreaming && state.streaming);
}

function renderSessions() {
  els.sessions.innerHTML = "";
  if (!state.sessions.length) {
    els.sessions.innerHTML = `<div class="s-meta" style="padding:8px">لا توجد محادثات محفوظة بعد.</div>`;
    return;
  }
  for (const session of state.sessions) {
    const btn = document.createElement("button");
    btn.className = "session-item";
    const isTg = session.id.startsWith("tg:");
    const isShared = session.id === state.config?.sharedSessionId;
    const isActive = session.id === state.conversationId;
    btn.classList.toggle("active", isActive);
    const title = session.title || session.id;
    const icon = isShared ? "🔗" : isTg ? "📱" : "🌐";
    btn.innerHTML = `
      <span class="s-title" dir="auto">${icon} ${escapeHtml(title)}</span>
      <span class="s-meta">${escapeHtml(session.provider || "")}/${escapeHtml(session.model || "")}</span>`;
    btn.addEventListener("click", () => {
      if (!session.sessionFile) return;
      send({ type: "switch_session", sessionFile: session.sessionFile });
      els.sidebar.classList.remove("open");
    });
    els.sessions.appendChild(btn);
  }
}

const ROLE_LABELS = {
  leader: "القائد",
  planner: "المخطط",
  executor: "المنفذ",
  reviewer: "المراجع",
  researcher: "الباحث",
  custom: "مخصص",
};

const PERMISSION_META = {
  read: { label: "القراءة", icon: "📖", hint: "قراءة الملفات والبحث" },
  write: { label: "الكتابة", icon: "✍️", hint: "إنشاء وتعديل الملفات" },
  execute: { label: "التنفيذ", icon: "⚡", hint: "تشغيل الأوامر" },
  network: { label: "الشبكة", icon: "🌐", hint: "الويب والمصادر" },
  mcp: { label: "أدوات MCP", icon: "🔗", hint: "أدوات خوادم MCP" },
  delegate: { label: "التفويض", icon: "🔀", hint: "تفويض مهام لوكلاء" },
  approve: { label: "الموافقة", icon: "✅", hint: "اعتماد النتائج" },
};

function roleLabel(role) {
  return ROLE_LABELS[role] || role || "مخصص";
}

function agentDisplayName(id) {
  const agent = state.agents.find((item) => item.id === id);
  if (agent) return `${agent.emoji || "🤖"} ${agent.name}`;
  return id === "unknown" ? "غير معروف" : id;
}

function agentPermissions(agent) {
  return agent?.permissions || {};
}

function permissionChips(agent) {
  const perms = agentPermissions(agent);
  return Object.entries(PERMISSION_META)
    .filter(([key]) => perms[key])
    .map(([key, meta]) => `<span class="chip good">${meta.icon} ${meta.label}</span>`)
    .join("");
}

function applyAgent(agent) {
  if (!agent) return;
  state.agent = agent;
  if (els.agentBadge) {
    els.agentBadge.textContent = `${agent.emoji || "🤖"} ${agent.name || roleLabel(agent.role)}`;
    els.agentBadge.title = `${roleLabel(agent.role)} — ${agent.description || ""}`;
  }
  if (els.agentSelect && [...els.agentSelect.options].some((o) => o.value === agent.id)) {
    els.agentSelect.value = agent.id;
  }
}

function populateAgents() {
  const select = els.agentSelect;
  if (!select) return;
  const current = state.agent?.id || state.current?.agent?.id || null;
  select.innerHTML = "";
  if (!state.agents.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "لا يوجد وكلاء";
    select.appendChild(option);
    return;
  }
  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.id;
    const role = roleLabel(agent.role);
    const label = agent.name === role ? agent.name : `${agent.name} — ${role}`;
    option.textContent = `${agent.emoji || "🤖"} ${label}${agent.enabled === false ? " (معطّل)" : ""}`;
    if (agent.enabled === false) option.disabled = true;
    select.appendChild(option);
  }
  if (current && state.agents.some((a) => a.id === current && a.enabled !== false)) {
    select.value = current;
  } else if (state.agents[0]) {
    select.value = state.agents[0].id;
  }
}

function renderUsage() {
  const usage = state.usage;
  if (!usage) return;
  const daily = usage.daily || {};
  const weekly = usage.weekly || {};
  const dailyPercent = clampPercent(daily.percentTokens ?? 0);
  const weeklyPercent = clampPercent(weekly.percentTokens ?? 0);
  const dailyLevel = levelClass(dailyPercent);
  const weeklyLevel = levelClass(weeklyPercent);

  const dailyItem = els.uDailyBar?.closest(".u-item");
  const weeklyItem = els.uWeeklyBar?.closest(".u-item");
  dailyItem?.classList.remove("warn", "danger");
  weeklyItem?.classList.remove("warn", "danger");
  if (dailyLevel) dailyItem?.classList.add(dailyLevel);
  if (weeklyLevel) weeklyItem?.classList.add(weeklyLevel);

  if (els.uDailyBar) els.uDailyBar.style.width = `${dailyPercent}%`;
  if (els.uWeeklyBar) els.uWeeklyBar.style.width = `${weeklyPercent}%`;

  if (els.uDailyRemain) {
    els.uDailyRemain.textContent = daily.remainingTokens == null ? "غير محدود" : `متبقي ${fmtCompact(daily.remainingTokens)}`;
  }
  if (els.uWeeklyRemain) {
    els.uWeeklyRemain.textContent = weekly.remainingTokens == null ? "غير محدود" : `متبقي ${fmtCompact(weekly.remainingTokens)}`;
  }
  if (els.uDailyUsed) {
    els.uDailyUsed.textContent = `${fmtCompact(daily.tokens || 0)} توكن · ${fmtCost(daily.cost || 0)}`;
  }
  if (els.uWeeklyUsed) {
    els.uWeeklyUsed.textContent = `${fmtCompact(weekly.tokens || 0)} توكن · ${fmtCost(weekly.cost || 0)}`;
  }
  if (els.uDailyLimit) {
    els.uDailyLimit.textContent = daily.tokenLimit > 0 ? `الحد ${fmtCompact(daily.tokenLimit)}` : "بلا حد";
  }
  if (els.uWeeklyLimit) {
    els.uWeeklyLimit.textContent = weekly.tokenLimit > 0 ? `الحد ${fmtCompact(weekly.tokenLimit)}` : "بلا حد";
  }

  const context = state.contextUsage || state.current?.contextUsage || null;
  const tokens = Number(context?.tokens ?? 0);
  const windowSize = Number(context?.contextWindow ?? 0);
  const ctxPercent = context?.percent != null ? clampPercent(context.percent) : windowSize > 0 ? clampPercent((tokens / windowSize) * 100) : 0;
  if (els.uCtxBar) els.uCtxBar.style.width = `${ctxPercent}%`;
  if (els.uCtxRemain) {
    els.uCtxRemain.textContent = windowSize > 0 ? `متبقي ${fmtCompact(Math.max(0, windowSize - tokens))}` : "—";
  }
  if (els.uCtxText) {
    els.uCtxText.textContent = windowSize > 0 ? `${fmtCompact(tokens)} / ${fmtCompact(windowSize)} · ${Math.round(ctxPercent)}%` : "لا توجد بيانات سياق";
  }
  const ctxItem = els.uCtxBar?.closest(".u-item");
  ctxItem?.classList.remove("warn", "danger");
  const ctxLevel = levelClass(ctxPercent);
  if (ctxLevel) ctxItem?.classList.add(ctxLevel);
}

function showStatus() {
  const s = state.current || {};
  const agent = s.agent || state.agent;
  const usage = state.usage;
  const perms = agent?.permissions || {};
  const rows = [
    ["الوكيل", agent ? `${agent.emoji || "🤖"} ${agent.name} (${roleLabel(agent.role)})` : "—"],
    ["الصلاحيات", Object.entries(PERMISSION_META).filter(([k]) => perms[k]).map(([, m]) => `${m.icon} ${m.label}`).join(" · ") || "—"],
    ["النموذج", `${s.provider || "—"}/${s.model || "—"}`],
    ["التفكير", THINKING_LABELS.ar[s.thinking] || s.thinking || "—"],
    ["الجلسة", s.sessionId ? String(s.sessionId).slice(0, 12) : "جديدة"],
    ["عدد الرسائل", String(s.messageCount ?? 0)],
    ["الأدوات", (s.toolNames || []).slice(0, 15).join(", ") || "—"],
    ["المزامنة", state.config?.syncWebTelegram ? "🔗 الويب + تيليجرام" : "مستقلة"],
  ];
  if (usage) {
    rows.push([
      "استهلاك اليوم",
      `${fmtNumber(usage.daily?.tokens || 0)} توكن · ${fmtCost(usage.daily?.cost || 0)}${
        usage.daily?.remainingTokens != null ? ` · متبقي ${fmtNumber(usage.daily.remainingTokens)}` : ""
      }`,
    ]);
    rows.push([
      "استهلاك الأسبوع",
      `${fmtNumber(usage.weekly?.tokens || 0)} توكن · ${fmtCost(usage.weekly?.cost || 0)}${
        usage.weekly?.remainingTokens != null ? ` · متبقي ${fmtNumber(usage.weekly.remainingTokens)}` : ""
      }`,
    ]);
  }
  const context = s.contextUsage || state.contextUsage;
  if (context?.contextWindow) {
    rows.push([
      "سياق الجلسة",
      `${fmtNumber(context.tokens || 0)} / ${fmtNumber(context.contextWindow)} (${Math.round(context.percent || 0)}%)`,
    ]);
  }
  els.statusBody.innerHTML = rows
    .map(([k, v]) => `<div class="row"><span>${escapeHtml(k)}</span><code>${escapeHtml(v)}</code></div>`)
    .join("");
  els.statusModal.classList.remove("hidden");
}

/* ===== أحداث الخادم ===== */

function handleConversationEvent(event) {
  switch (event.type) {
    case "user_message":
      addUserMessage(event.text, event.source || "web");
      setStreaming(true);
      break;
    case "run_start":
      state.toolCards.clear();
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      break;
    case "text_delta":
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      state.currentTurn.appendText(event.delta);
      break;
    case "thinking_delta":
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      state.currentTurn.appendThinking(event.delta);
      break;
    case "tool_start": {
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      const card = state.currentTurn.addTool({ id: event.id, name: event.name, hint: hintFor(event.name, event.args) });
      if (card) state.toolCards.set(event.id, card);
      scrollToBottom();
      break;
    }
    case "tool_end": {
      const card = state.toolCards.get(event.id);
      updateToolCard(card, { output: event.output, isError: event.isError });
      break;
    }
    case "assistant_message": {
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      if (event.text) state.currentTurn.setText(event.text);
      state.currentTurn.setUsage(event.usage, event.model);
      if (event.errorMessage) {
        const { bubble } = createMessage("assistant");
        bubble.classList.add("error");
        bubble.innerHTML = `<b>❌ ${escapeHtml(event.errorMessage)}</b>`;
      }
      break;
    }
    case "settled":
    case "agent_settled": {
      if (state.currentTurn) {
        state.currentTurn.finalize();
        state.currentTurn.removeIfEmpty();
        state.currentTurn = null;
      }
      setStreaming(false);
      state.toolCards.clear();
      send({ type: "list_sessions" });
      send({ type: "get_usage" });
      scheduleControlRefresh();
      break;
    }
    case "error":
      addErrorMessage(event.message);
      if (state.currentTurn) {
        state.currentTurn.finalize();
        state.currentTurn = null;
      }
      setStreaming(false);
      break;
    case "compaction_start":
      addNotice("🗜️ جارٍ ضغط السياق…");
      break;
    case "compaction_end":
      addNotice(event.aborted ? "أُلغي ضغط السياق" : "✅ تم ضغط السياق");
      break;
    case "retry":
      addNotice(`↻ إعادة المحاولة ${event.attempt}/${event.maxAttempts}…`);
      break;
    case "retry_end":
      if (!event.success) addErrorMessage(event.finalError || "فشلت إعادة المحاولة");
      break;
    case "model_changed":
      if (state.current) {
        state.current.provider = event.provider;
        state.current.model = event.model;
      }
      els.modelSelect.value = `${event.provider}/${event.model}`;
      break;
    case "thinking_changed":
      if (state.current) state.current.thinking = event.level;
      els.thinkingSelect.value = event.level;
      break;
    case "agent_changed":
      if (event.agent) {
        applyAgent(event.agent);
        if (state.current) state.current.agent = event.agent;
        scheduleControlRefresh();
      }
      break;
    case "context_usage":
      state.contextUsage = event.usage || null;
      if (state.current) state.current.contextUsage = event.usage || null;
      renderUsage();
      break;
    case "session_ready":
      if (event.state) applyState(event.state);
      break;
    case "session_reset":
      els.messages.innerHTML = "";
      if (!event.transcript || !event.transcript.length) restoreHero();
      renderTranscript(event.transcript || []);
      if (event.state) applyState(event.state);
      state.currentTurn = null;
      state.toolCards.clear();
      setStreaming(false);
      const current = state.sessions.find((session) => session.id === state.conversationId);
      if (current) {
        current.title = null;
        current.sessionFile = event.state?.sessionFile || null;
      }
      renderSessions();
      send({ type: "list_sessions" });
      break;
    case "title_changed":
      if (event.name) {
        els.sessionBadge.textContent = event.name;
        const current = state.sessions.find((session) => session.id === state.conversationId);
        if (current) {
          current.title = event.name;
          renderSessions();
        }
      }
      break;
    default:
      break;
  }
}

function hintFor(name, args) {
  if (!args || typeof args !== "object") return "";
  const pick = (...keys) => {
    for (const k of keys) if (args[k] != null && args[k] !== "") return String(args[k]);
    return "";
  };
  let hint = "";
  if (["read", "write", "edit"].includes(name)) hint = pick("path", "file_path", "filePath");
  else if (name === "bash") hint = pick("command", "cmd");
  else if (name === "grep") hint = pick("pattern", "query");
  else if (["find", "glob"].includes(name)) hint = pick("pattern");
  else hint = Object.values(args).find((v) => typeof v === "string") || "";
  return hint.length > 120 ? `${hint.slice(0, 117)}…` : hint;
}

function applySyncBadge() {
  if (!els.syncBadge) return;
  const enabled = !!state.config?.syncWebTelegram;
  els.syncBadge.classList.toggle("hidden", !enabled);
  if (enabled) els.syncBadge.title = "هذه الجلسة مشتركة بين الويب وتيليجرام";
}

function handleServerMessage(message) {
  switch (message.type) {
    case "ready":
      state.conversationId = message.conversationId;
      localStorage.setItem("pi.conversation", message.conversationId);
      if (message.syncWebTelegram !== undefined) {
        state.config = {
          ...(state.config || {}),
          syncWebTelegram: !!message.syncWebTelegram,
          sharedSessionId: message.sharedSessionId || state.config?.sharedSessionId,
        };
      }
      applySyncBadge();
      state.models = message.models || state.models;
      state.sessions = message.sessions || [];
      state.agents = message.agents || state.agents;
      state.usage = message.usage || state.usage;
      state.contextUsage = message.state?.contextUsage || null;
      if (message.agent) applyAgent(message.agent);
      else if (message.state?.agent) applyAgent(message.state.agent);
      populateModels();
      populateAgents();
      renderSessions();
      renderUsage();
      els.messages.innerHTML = "";
      if (!message.transcript || !message.transcript.length) {
        els.messages.innerHTML = "";
        restoreHero();
      }
      renderTranscript(message.transcript || []);
      applyState(message.state);
      setConnected(true);
      break;
    case "state":
      applyState(message.state);
      break;
    case "models":
      state.models = message.models || [];
      populateModels();
      break;
    case "sessions":
      state.sessions = message.sessions || [];
      renderSessions();
      break;
    case "agents":
      state.agents = message.agents || [];
      populateAgents();
      scheduleControlRefresh();
      break;
    case "agent":
      applyAgent(message.agent);
      break;
    case "skills":
      state.skills = message.skills || state.skills;
      scheduleControlRefresh();
      break;
    case "extensions":
      if (state.control.overview) state.control.overview.extensions = message.extensions || [];
      scheduleControlRefresh();
      break;
    case "mcp":
      if (state.control.overview) state.control.overview.mcp = message.mcp || state.control.overview.mcp;
      scheduleControlRefresh();
      break;
    case "usage":
      state.usage = message.usage || state.usage;
      if (message.usage?.context) state.contextUsage = message.usage.context;
      renderUsage();
      if (state.control.open && state.control.tab === "usage") scheduleControlRefresh();
      break;
    case "user_echo":
      addUserMessage(message.text);
      setStreaming(true);
      state.currentTurn = null;
      break;
    case "notice":
      addNotice(message.message);
      break;
    case "error":
      addErrorMessage(message.message);
      break;
    case "event":
      handleConversationEvent(message.event);
      break;
    default:
      break;
  }
}

function restoreHero() {
  if (els.messages.querySelector(".hero")) return;
  els.messages.insertAdjacentHTML("afterbegin", HERO_HTML);
  els.hero = els.messages.querySelector(".hero");
  bindSuggestions(els.messages);
}

/* ===== WebSocket ===== */

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const token = getToken();
  const params = new URLSearchParams({ conversation: getConversationId() });
  if (token) params.set("token", token);
  return `${proto}://${location.host}/ws?${params.toString()}`;
}

let manualClose = false;

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.reconnectDelay = 1000;
    setConnected(true);
  });
  ws.addEventListener("message", (evt) => {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch {
      return;
    }
    handleServerMessage(data);
  });
  ws.addEventListener("close", () => {
    setConnected(false);
    if (manualClose) return;
    const delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 15000);
    setTimeout(async () => {
      await loadConfig();
      connect();
    }, delay);
  });
  ws.addEventListener("error", () => {
    ws.close();
  });
}

function send(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    toast("غير متصل بالخادم", "error");
    return false;
  }
  state.ws.send(JSON.stringify(message));
  return true;
}

function submitPrompt() {
  const text = els.input.value.trim();
  if (!text) return;
  if (!send({ type: "prompt", text })) return;
  els.input.value = "";
  autoResize();
  setStreaming(true);
}

/* ===== تفاعلات الواجهة ===== */

function autoResize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

function bindUi() {
  els.sendBtn.addEventListener("click", submitPrompt);
  els.stopBtn.addEventListener("click", () => send({ type: "abort" }));
  els.input.addEventListener("input", autoResize);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitPrompt();
    }
  });

  els.newSessionBtn.addEventListener("click", () => {
    send({ type: "new_session" });
    els.sidebar.classList.remove("open");
  });

  els.modelSelect.addEventListener("change", () => {
    const [provider, ...rest] = els.modelSelect.value.split("/");
    send({ type: "set_model", provider, model: rest.join("/") });
  });
  els.agentSelect.addEventListener("change", () => {
    const agentId = els.agentSelect.value;
    if (agentId) send({ type: "set_agent", agentId });
  });
  els.thinkingSelect.addEventListener("change", () => {
    send({ type: "set_thinking", level: els.thinkingSelect.value });
  });

  els.statusBtn.addEventListener("click", showStatus);
  els.statusClose.addEventListener("click", () => els.statusModal.classList.add("hidden"));
  els.statusModal.addEventListener("click", (e) => {
    if (e.target === els.statusModal) els.statusModal.classList.add("hidden");
  });

  els.compactBtn.addEventListener("click", () => send({ type: "compact" }));

  els.restartBtn.addEventListener("click", () => {
    if (!confirm("هل تريد إعادة تشغيل الخادم؟ ستنقطع الجلسة لثوانٍ ثم يعود تلقائياً.")) return;
    if (send({ type: "restart" })) {
      toast("♻️ جارٍ إعادة التشغيل… سيُعاد الاتصال تلقائياً.", "success");
    }
  });

  els.menuBtn.addEventListener("click", () => els.sidebar.classList.toggle("open"));
  els.sidebarClose.addEventListener("click", () => els.sidebar.classList.remove("open"));

  els.controlBtnSide.addEventListener("click", () => openControl("overview"));
  els.controlBtnTop.addEventListener("click", () => openControl("overview"));
  els.usageOpen.addEventListener("click", () => openControl("usage"));
  document.querySelectorAll("[data-usage-tab]").forEach((node) => {
    node.addEventListener("click", () => openControl("usage"));
  });
  els.controlClose.addEventListener("click", closeControl);
  els.controlCenter.addEventListener("click", (event) => {
    if (event.target === els.controlCenter) closeControl();
  });
  els.controlTabs.addEventListener("click", (event) => {
    const button = event.target.closest(".cc-tab");
    if (button) switchControlTab(button.dataset.tab);
  });
  els.controlReload.addEventListener("click", async () => {
    try {
      await apiFetch("/api/reload", { method: "POST" });
      send({ type: "reload_resources" });
      toast("تم إعادة تحميل الموارد والنماذج.", "success");
      await refreshControl();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  bindControlCenter();

  els.themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("pi.theme", next);
    els.themeBtn.dataset.mode = next === "dark" ? "dark" : "light";
  });

  bindSuggestions(document);
}

function bindSuggestions(root) {
  root.querySelectorAll(".suggestions button").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      els.input.value = btn.dataset.prompt || "";
      autoResize();
      submitPrompt();
    });
  });
}

async function loadConfig() {
  try {
    const token = getToken();
    const res = await fetch(`/api/config${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    if (res.ok) {
      state.config = await res.json();
      state.models = state.config.models || [];
      if (state.config.supervised && els.restartBtn) {
        els.restartBtn.classList.remove("hidden");
      }
      populateModels();
    }
  } catch {
    /* ignore */
  }
}

function initTheme() {
  const saved = localStorage.getItem("pi.theme") || "dark";
  document.documentElement.dataset.theme = saved;
  els.themeBtn.dataset.mode = saved === "dark" ? "dark" : "light";
}

/* ===== مركز التحكم ===== */

const SKILL_TEMPLATES = {
  review: {
    label: "مراجعة أمنية",
    description: "مراجعة أمنية للكود والملفات. استخدمها عند فحص الثغرات والصلاحيات والتعامل مع المدخلات.",
    instructions:
      "# مراجعة أمنية\n\n1. افحص نقاط الدخول والتحقق من المدخلات.\n2. ابحث عن تسريب الأسرار والمفاتيح.\n3. راجع الصلاحيات، تنفيذ الأوامر، ومسارات الملفات.\n4. صنّف النتائج: حرجة / مهمة / تحسين مع إصلاح مقترح.",
  },
  docs: {
    label: "توثيق احترافي",
    description: "كتابة وتحديث توثيق المشروع و README وأدلة الاستخدام بالعربية.",
    instructions:
      "# توثيق المشروع\n\n1. اقرأ بنية المشروع والملفات الأساسية.\n2. اكتب README يشمل: المزايا، التثبيت، التشغيل، الإعدادات، وأمثلة الاستخدام.\n3. أضف جداول للمتغيرات والأوامر.\n4. تحقّق من صحة الروابط والأوامر.",
  },
  data: {
    label: "تحليل بيانات",
    description: "تحليل ملفات CSV/JSON واستخراج المؤشرات وكتابة سكربتات بايثون.",
    instructions:
      "# تحليل بيانات\n\n1. افحص بنية البيانات وجودتها.\n2. استخدم pandas لتنظيف البيانات وتحليلها.\n3. أنتج ملخصاً بالمؤشرات والرسوم عند الحاجة.\n4. احفظ النتائج في ملفات واضحة.",
  },
  tests: {
    label: "اختبارات ومراجعة",
    description: "إنشاء اختبارات وتشغيلها ومراجعة التغطية وحالات الحافة.",
    instructions:
      "# الاختبارات\n\n1. حدّد إطار الاختبار المناسب للمشروع.\n2. اكتب اختبارات لحالات النجاح والفشل والحافة.\n3. شغّل الاختبارات وأصلح الأخطاء.\n4. لخّص التغطية وما تبقّى.",
  },
};

function controlOverview() {
  return state.control.overview;
}

function syncControlTabs() {
  document.querySelectorAll(".cc-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.control.tab);
  });
}

async function openControl(tab = "overview") {
  state.control.open = true;
  state.control.tab = tab || "overview";
  state.control.skillDraft = null;
  state.control.extensionDraft = null;
  state.control.agentDraft = null;
  state.control.providerDraft = null;
  state.control.keyFor = null;
  els.controlCenter.classList.remove("hidden");
  syncControlTabs();
  if (!state.control.overview) {
    els.controlBody.innerHTML = `<div class="cc-empty">⏳ جارٍ تحميل مركز التحكم…</div>`;
  } else {
    renderControl();
  }
  await refreshControl();
}

function closeControl() {
  state.control.open = false;
  els.controlCenter.classList.add("hidden");
}

function switchControlTab(tab) {
  state.control.tab = tab || "overview";
  state.control.skillDraft = null;
  state.control.extensionDraft = null;
  state.control.agentDraft = null;
  state.control.providerDraft = null;
  state.control.keyFor = null;
  syncControlTabs();
  renderControl();
}

function scheduleControlRefresh() {
  if (!state.control.open) return;
  clearTimeout(state.control.refreshTimer);
  state.control.refreshTimer = setTimeout(() => {
    refreshControl().catch(() => undefined);
  }, 450);
}

async function refreshControl() {
  state.control.loading = true;
  try {
    const data = await apiFetch("/api/overview");
    state.control.overview = data;
    state.agents = data.agents || state.agents;
    state.skills = data.skills || state.skills;
    state.usage = data.usage || state.usage;
    state.models = data.models || state.models;
    const currentAgent = state.current?.agent;
    if (currentAgent) {
      const fresh = (data.agents || []).find((agent) => agent.id === currentAgent.id);
      if (fresh) applyAgent(fresh);
    }
    populateModels();
    if (state.current) {
      const value = `${state.current.provider}/${state.current.model}`;
      if ([...els.modelSelect.options].some((option) => option.value === value)) els.modelSelect.value = value;
    }
    populateAgents();
    renderUsage();
    renderControl();
  } catch (err) {
    if (state.control.open) {
      els.controlBody.innerHTML = `<div class="cc-empty">⚠️ ${escapeHtml(err.message || "تعذّر تحميل البيانات")}</div>`;
    }
    toast(err.message || "تعذّر تحميل مركز التحكم", "error");
  } finally {
    state.control.loading = false;
  }
}

function renderControl() {
  const data = controlOverview();
  if (!data) return;
  const counts = data.counts || {};
  els.controlSubtitle.textContent = `${counts.skills || 0} مهارة · ${counts.agents || 0} وكيل · ${counts.providers || 0} مزوّد · ${counts.models || 0} نموذج · ${counts.extensions || 0} إضافة`;
  const scroll = els.controlBody.scrollTop;
  switch (state.control.tab) {
    case "skills":
      els.controlBody.innerHTML = renderSkillsTab(data);
      break;
    case "extensions":
      els.controlBody.innerHTML = renderExtensionsTab(data);
      break;
    case "mcp":
      els.controlBody.innerHTML = renderMcpTab(data);
      break;
    case "agents":
      els.controlBody.innerHTML = renderAgentsTab(data);
      break;
    case "providers":
      els.controlBody.innerHTML = renderProvidersTab(data);
      break;
    case "usage":
      els.controlBody.innerHTML = renderUsageTab(data);
      break;
    case "permissions":
      els.controlBody.innerHTML = renderPermissionsTab(data);
      break;
    default:
      els.controlBody.innerHTML = renderOverviewTab(data);
  }
  requestAnimationFrame(() => {
    els.controlBody.scrollTop = scroll;
  });
}

function ccStat(icon, value, label, sub = "", tab = "") {
  const action = tab ? ` data-action="go-tab" data-tab="${escapeHtml(tab)}" role="button" tabindex="0"` : "";
  return `<div class="cc-stat ${tab ? "clickable" : ""}"${action}><div class="cc-stat-icon">${icon}</div><div class="cc-stat-value">${escapeHtml(String(value))}</div><div class="cc-stat-label">${escapeHtml(label)}</div>${sub ? `<div class="cc-stat-sub">${escapeHtml(sub)}</div>` : ""}</div>`;
}

function usageKpi(title, agg) {
  const percent = clampPercent(agg?.percentTokens ?? 0);
  const level = levelClass(percent);
  const remaining = agg?.remainingTokens == null ? "بلا حد" : `متبقي ${fmtCompact(agg.remainingTokens)}`;
  return `<div class="usage-kpi ${level}">
    <div class="k-label">${escapeHtml(title)}</div>
    <div class="k-value">${fmtCompact(agg?.tokens || 0)}</div>
    <div class="k-sub">${remaining} · ${fmtCost(agg?.cost || 0)} · ${fmtNumber(agg?.requests || 0)} طلب</div>
    <div class="k-track"><i style="width:${percent}%"></i></div>
  </div>`;
}

function contextKpi(context) {
  const tokens = Number(context?.tokens || 0);
  const size = Number(context?.contextWindow || 0);
  const percent = context?.percent != null ? clampPercent(context.percent) : size > 0 ? clampPercent((tokens / size) * 100) : 0;
  const level = levelClass(percent);
  return `<div class="usage-kpi ${level}">
    <div class="k-label">🧠 سياق الجلسة</div>
    <div class="k-value">${size ? `${Math.round(percent)}%` : "—"}</div>
    <div class="k-sub">${size ? `${fmtNumber(tokens)} / ${fmtNumber(size)} توكن` : "لا توجد بيانات"}</div>
    <div class="k-track"><i style="width:${percent}%"></i></div>
  </div>`;
}

function chartHtml(series = []) {
  const max = Math.max(1, ...series.map((point) => Number(point.tokens) || 0));
  if (!series.length) return `<div class="cc-empty">لا توجد بيانات كافية بعد.</div>`;
  return `<div class="bar-chart">${series
    .map((point) => {
      const height = Math.max(3, ((Number(point.tokens) || 0) / max) * 100);
      return `<div class="bar-col" title="${escapeHtml(point.date)} · ${fmtNumber(point.tokens)} توكن · ${fmtCost(point.cost)}">
        <div class="bar-fill-wrap"><div class="bar-fill" style="height:${height}%"></div></div>
        <span class="bar-label">${escapeHtml(String(point.date).slice(5))}</span>
      </div>`;
    })
    .join("")}</div>`;
}

function breakdownHtml(list = [], labelKey = "provider", formatter = null) {
  if (!list.length) return `<div class="cc-empty">لا توجد بيانات هذا الأسبوع.</div>`;
  const max = Math.max(1, ...list.map((item) => Number(item.tokens) || 0));
  return list
    .map((item) => {
      const width = Math.max(2, ((Number(item.tokens) || 0) / max) * 100);
      const raw = item[labelKey];
      const label = formatter ? formatter(raw) : raw;
      return `<div class="breakdown-row">
        <span class="b-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        <span class="b-track"><i style="width:${width}%"></i></span>
        <span class="b-value">${fmtCompact(item.tokens)} · ${fmtCost(item.cost)}</span>
      </div>`;
    })
    .join("");
}

function renderOverviewTab(data) {
  const c = data.counts || {};
  const usage = data.usage || {};
  return `
    <div class="cc-note">
      <b>مرحباً بك في مركز التحكم.</b> من هنا تضيف المهارات، تنشئ وكلاء بصلاحيات مختلفة، تربط مزوّدي نماذج جدد، وتضبط حدود الاستهلاك اليومية والأسبوعية.
      التغييرات تُطبّق على الجلسات الجديدة؛ استخدم زر <b>«إعادة تحميل»</b> أعلى النافذة لتطبيق المهارات على الجلسة الحالية.
    </div>
    <div class="cc-grid">
      ${ccStat("🧠", c.skills || 0, "المهارات", `${c.userSkills || 0} قابلة للتعديل`, "skills")}
      ${ccStat("🤖", c.agents || 0, "الوكلاء", `${c.enabledAgents || 0} مفعّل`, "agents")}
      ${ccStat("🔌", c.providers || 0, "المزوّدون المفعّلون", `${c.allProviders || 0} مزوّد متاح`, "providers")}
      ${ccStat("🧩", c.models || 0, "النماذج", `${c.customProviders || 0} مزوّد مخصص`, "providers")}
      ${ccStat("🧱", c.extensions || 0, "الإضافات", `${c.prompts || 0} قالب أمر`, "extensions")}
      ${ccStat("🔗", c.mcp || 0, "خوادم MCP", `${c.mcpEnabled || 0} مفعّل`, "mcp")}
      ${ccStat("💬", c.sessions || 0, "المحادثات", "محفوظة في مساحة العمل")}
    </div>
    <div class="cc-section">
      <div class="cc-section-head">
        <div><h3 class="cc-section-title">نبض الاستهلاك</h3><p class="cc-section-desc">نظرة سريعة على استهلاك التوكنز والتكلفة، وما تبقّى من حدودك.</p></div>
        <div class="cc-section-actions"><button class="btn primary" data-action="go-tab" data-tab="usage">📈 التفاصيل والحدود</button></div>
      </div>
      <div class="usage-kpis">
        ${usageKpi("📅 اليوم", usage.daily)}
        ${usageKpi("🗓️ هذا الأسبوع", usage.weekly)}
        ${contextKpi(usage.context || state.contextUsage)}
      </div>
    </div>
    <div class="cc-section">
      <div class="cc-section-head"><div><h3 class="cc-section-title">آخر 14 يوماً</h3><p class="cc-section-desc">إجمالي التوكنز المستهلكة يومياً.</p></div></div>
      ${chartHtml(usage.series)}
    </div>
    <div class="cc-section">
      <div class="cc-section-head"><div><h3 class="cc-section-title">دليل سريع</h3><p class="cc-section-desc">ثلاث خطوات بسيطة لتوسيع مساحة عملك.</p></div></div>
      <div class="cc-list two">
        <div class="cc-item"><div class="cc-item-icon">🧠</div><div class="cc-item-main"><div class="cc-item-title">أضف مهارة</div><div class="cc-item-desc">اكتب تعليمات متخصصة ووصفاً يحدد متى يستخدمها الوكيل. تُحفظ في <code>~/.pi/agent/skills</code>.</div><div class="cc-chips"><button class="chip accent" data-action="go-tab" data-tab="skills">فتح المهارات ←</button></div></div></div>
        <div class="cc-item"><div class="cc-item-icon">🤖</div><div class="cc-item-main"><div class="cc-item-title">أنشئ وكيلاً</div><div class="cc-item-desc">اختر دوراً (قائد، مخطط، منفذ، مراجع…) وحدّد صلاحياته ونموذجه وتعليماته.</div><div class="cc-chips"><button class="chip accent" data-action="go-tab" data-tab="agents">فتح الوكلاء ←</button></div></div></div>
        <div class="cc-item"><div class="cc-item-icon">🔌</div><div class="cc-item-main"><div class="cc-item-title">اربط مزوّداً</div><div class="cc-item-desc">أضف endpoint متوافقاً مع OpenAI أو Anthropic أو Google، مع مفتاح API ونماذج.</div><div class="cc-chips"><button class="chip accent" data-action="go-tab" data-tab="providers">فتح المزوّدين ←</button></div></div></div>
        <div class="cc-item"><div class="cc-item-icon">🧱</div><div class="cc-item-main"><div class="cc-item-title">أضف إضافة</div><div class="cc-item-desc">أضف أداة أو أمراً جديداً عبر Extension جاهز، ثم أعد تحميل الجلسة.</div><div class="cc-chips"><button class="chip accent" data-action="go-tab" data-tab="extensions">فتح الإضافات ←</button></div></div></div>
      </div>
    </div>`;
}

function renderSkillsTab(data) {
  const skills = data.skills || [];
  const draft = state.control.skillDraft;
  const list = skills.length
    ? skills
        .map((skill) => {
          const editable = skill.editable;
          return `<div class="cc-item">
            <div class="cc-item-icon">🧠</div>
            <div class="cc-item-main">
              <div class="cc-item-title">${escapeHtml(skill.id)}
                ${editable ? `<span class="chip accent">قابلة للتعديل</span>` : `<span class="chip">${escapeHtml(skill.scopeLabel || skill.scope)}</span>`}
              </div>
              <div class="cc-item-desc">${escapeHtml(skill.description || "بلا وصف")}</div>
              <div class="cc-chips">
                <span class="chip ${skill.modelInvocation ? "good" : "warn"}">${skill.modelInvocation ? "استدعاء تلقائي" : "استدعاء يدوي"}</span>
                <span class="chip">${escapeHtml(skill.relativePath || skill.id)}</span>
                <span class="chip">${Math.max(1, Math.round((skill.size || 0) / 1024))}KB</span>
              </div>
            </div>
            <div class="cc-item-actions">
              ${editable ? `<button class="btn" data-action="edit-skill" data-id="${escapeHtml(skill.id)}">تعديل</button><button class="btn" data-action="delete-skill" data-id="${escapeHtml(skill.id)}">حذف</button>` : ""}
            </div>
          </div>`;
        })
        .join("")
    : `<div class="cc-empty">لا توجد مهارات بعد. ابدأ بإضافة مهارة جديدة من الزر أعلاه.</div>`;
  return `
    <div class="cc-section">
      <div class="cc-section-head">
        <div><h3 class="cc-section-title">🧠 المهارات (${skills.length})</h3><p class="cc-section-desc">المهارة = تعليمات متخصصة تُحمّل عند الحاجة. الوصف الجيد يحدد متى يستخدمها النموذج.</p></div>
        <div class="cc-section-actions"><button class="btn primary" data-action="new-skill">＋ مهارة جديدة</button></div>
      </div>
      ${draft ? skillForm(draft) : ""}
      <div class="cc-list two">${list}</div>
    </div>`;
}

function skillForm(draft) {
  return `<form class="cc-form" data-form="skill" data-editing="${draft.isNew ? "0" : "1"}">
    <div class="cc-form-grid">
      <label class="cc-field"><span>المعرّف (بالإنجليزية)</span><input name="id" value="${escapeHtml(draft.id || "")}" ${draft.isNew ? "" : "disabled"} placeholder="pdf-tools" pattern="[a-z0-9][a-z0-9-]*" required><small>حروف صغيرة وأرقام وشرطات.</small></label>
      <label class="cc-field"><span>قالب جاهز</span><select id="skillTemplate">${Object.entries(SKILL_TEMPLATES).map(([key, tpl]) => `<option value="${key}">${escapeHtml(tpl.label)}</option>`).join("")}</select><small>املأ الحقول تلقائياً ثم عدّلها.</small></label>
      <label class="cc-field wide"><span>الوصف (يحدد متى تُستخدم المهارة)</span><input name="description" value="${escapeHtml(draft.description || "")}" placeholder="مثال: استخراج النصوص والجداول من ملفات PDF..." required></label>
      <label class="cc-field wide"><span>التعليمات</span><textarea name="instructions" rows="8" placeholder="# العنوان&#10;&#10;1. ...">${escapeHtml(draft.instructions || "")}</textarea></label>
    </div>
    <div class="cc-form-actions">
      <button class="btn primary" type="submit">💾 حفظ المهارة</button>
      <button class="btn" type="button" data-action="skill-template">✨ تطبيق القالب</button>
      <button class="btn ghost" type="button" data-action="cancel-skill">إلغاء</button>
    </div>
  </form>`;
}

const EXTENSION_TEMPLATES = {
  command: {
    label: "أمر /hello",
    code: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify("Hello, " + (name || "world") + "!", "info");
    },
  });
}`,
  },
  tool: {
    label: "أداة hello_tool",
    code: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "hello_tool",
    label: "Hello Tool",
    description: "Returns a friendly greeting.",
    parameters: Type.Object({ name: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: "Hello, " + (params.name || "world") + "!" }],
        details: undefined,
      };
    },
  });
}`,
  },
  hook: {
    label: "مراقب استدعاءات الأدوات",
    code: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    ctx.ui.notify("Tool: " + event.toolName, "info");
  });
}`,
  },
};

function renderExtensionsTab(data) {
  const extensions = data.extensions || [];
  const draft = state.control.extensionDraft;
  const list = extensions.length
    ? extensions
        .map((extension) => {
          const editable = extension.editable;
          return `<div class="cc-item">
            <div class="cc-item-icon">🧱</div>
            <div class="cc-item-main">
              <div class="cc-item-title">${escapeHtml(extension.id)}
                ${editable ? `<span class="chip accent">قابلة للتعديل</span>` : `<span class="chip">${escapeHtml(extension.scopeLabel || extension.scope)}</span>`}
                <span class="chip">${extension.kind === "dir" ? "مجلد" : "ملف"}</span>
              </div>
              <div class="cc-item-desc">${escapeHtml(extension.relativePath || extension.file || "")}</div>
              <div class="cc-chips"><span class="chip">${Math.max(1, Math.round((extension.size || 0) / 1024))}KB</span><span class="chip">${escapeHtml(extension.scopeLabel || extension.scope)}</span></div>
            </div>
            <div class="cc-item-actions">
              ${editable ? `<button class="btn" data-action="edit-extension" data-id="${escapeHtml(extension.id)}">تعديل</button><button class="btn" data-action="delete-extension" data-id="${escapeHtml(extension.id)}">حذف</button>` : ""}
            </div>
          </div>`;
        })
        .join("")
    : `<div class="cc-empty">لا توجد إضافات مثبتة. أضف إضافة من قالب جاهز أو اكتب كودك.</div>`;
  return `
    <div class="cc-note">
      <b>الإضافات (Extensions)</b> تمنح Pi أدوات وأوامر وسلوكاً قابلاً للتنفيذ. الكود يعمل بصلاحيات العملية نفسها، لذلك لا تضف إلا كوداً تثق به. بعد الحفظ اضغط <b>«إعادة تحميل»</b> أعلى النافذة لتطبيق الإضافة على الجلسة الحالية. إذا سجّلت الإضافة أداة جديدة، أضف اسمها إلى حقل <b>«أدوات إضافية»</b> في تبويب الوكلاء ثم أعد التحميل.
    </div>
    <div class="cc-section">
      <div class="cc-section-head">
        <div><h3 class="cc-section-title">🧱 الإضافات (${extensions.length})</h3><p class="cc-section-desc">تُحفظ في <code>~/.pi/agent/extensions</code> وتُحمّل عند بدء الجلسة.</p></div>
        <div class="cc-section-actions"><button class="btn primary" data-action="new-extension">＋ إضافة جديدة</button></div>
      </div>
      ${draft ? extensionForm(draft) : ""}
      <div class="cc-list">${list}</div>
    </div>`;
}

function extensionForm(draft) {
  return `<form class="cc-form" data-form="extension" data-editing="${draft.isNew ? "0" : "1"}">
    <div class="cc-form-grid">
      <label class="cc-field"><span>المعرّف (اسم الملف)</span><input name="id" value="${escapeHtml(draft.id || "")}" ${draft.isNew ? "" : "disabled"} placeholder="my-extension" pattern="[a-z0-9][a-z0-9-]*" required><small>سيُحفظ كملف <code>my-extension.ts</code>.</small></label>
      <label class="cc-field"><span>قالب جاهز</span><select id="extensionTemplate">${Object.entries(EXTENSION_TEMPLATES).map(([key, template]) => `<option value="${key}">${escapeHtml(template.label)}</option>`).join("")}</select><small>املأ الكود ثم عدّله كما تشاء.</small></label>
      <label class="cc-field wide"><span>كود الإضافة (TypeScript / JavaScript)</span><textarea name="code" rows="18" spellcheck="false" style="direction:ltr;text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.78rem;line-height:1.6;min-height:300px">${escapeHtml(draft.code || "")}</textarea><small>يمكنك استيراد <code>typebox</code> و<code>@earendil-works/pi-coding-agent</code>.</small></label>
    </div>
    <div class="cc-form-actions">
      <button class="btn primary" type="submit">💾 حفظ الإضافة</button>
      <button class="btn" type="button" data-action="extension-template">✨ تطبيق القالب</button>
      <button class="btn ghost" type="button" data-action="cancel-extension">إلغاء</button>
    </div>
  </form>`;
}

function renderMcpTab(data) {
  const mcp = data.mcp || { servers: [] };
  const servers = mcp.servers || [];
  const list = servers.length
    ? servers
        .map((server) => {
          const args = (server.args || []).map((arg) => escapeHtml(arg)).join(" ");
          const target = server.type === "stdio" ? `${server.command || ""} ${args}`.trim() : server.url || "";
          return `<div class="cc-item">
            <div class="cc-item-icon">${server.type === "stdio" ? "💻" : "🌐"}</div>
            <div class="cc-item-main">
              <div class="cc-item-title">${escapeHtml(server.name)}
                <span class="chip ${server.enabled ? "good" : "bad"}">${server.enabled ? "مفعّل" : "معطّل"}</span>
                <span class="chip">${escapeHtml(server.type)}</span>
                <span class="chip">${escapeHtml(server.scope)}</span>
                <span class="chip accent">${escapeHtml(server.exposure || "codemode")}</span>
              </div>
              <div class="cc-item-desc">${server.description ? escapeHtml(server.description) : `<code dir="ltr">${escapeHtml(target)}</code>`}</div>
              <div class="cc-chips">
                ${(server.envKeys || []).length ? `<span class="chip">ENV: ${(server.envKeys || []).map((key) => escapeHtml(key)).join(", ")}</span>` : ""}
                ${(server.headerKeys || []).length ? `<span class="chip">Headers: ${(server.headerKeys || []).map((key) => escapeHtml(key)).join(", ")}</span>` : ""}
                ${server.hasOAuth ? `<span class="chip">OAuth</span>` : ""}
              </div>
            </div>
            <div class="cc-item-actions">
              <button class="btn" data-action="toggle-mcp" data-name="${escapeHtml(server.name)}" data-scope="${escapeHtml(server.scope)}" data-enabled="${server.enabled ? "0" : "1"}">${server.enabled ? "تعطيل" : "تفعيل"}</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="cc-empty">لا توجد خوادم MCP بعد. أضف خوادمك في <code>~/.pi/agent/mcp.json</code> ثم أعد التحميل.</div>`;
  return `
    <div class="cc-note">
      <b>خوادم MCP</b> تُقرأ من <code>~/.pi/agent/mcp.json</code> (وخادم المشروع من <code>.pi/mcp.json</code>). فعّل الخادم ثم اضغط <b>«إعادة تحميل»</b>. لا تظهر أدوات MCP إلا للوكلاء الذين يملكون صلاحية <b>أدوات MCP</b>. يدعم Pi النقل <b>Streamable HTTP</b> فقط للخوادم البعيدة، وليس SSE.
    </div>
    <div class="cc-section">
      <div class="cc-section-head">
        <div><h3 class="cc-section-title">🔗 خوادم MCP (${servers.length})</h3><p class="cc-section-desc">${mcp.enabled || 0} مفعّل · ${escapeHtml(mcp.path || "")}</p></div>
        <div class="cc-section-actions"><button class="btn" data-action="refresh">↻ تحديث</button></div>
      </div>
      <div class="cc-list">${list}</div>
    </div>`;
}

function agentDraftTemplate(roleId) {
  const data = controlOverview() || {};
  const roles = data.roles || [];
  const tpl = roles.find((role) => role.id === roleId) || roles.find((role) => role.id === "custom") || {
    id: "custom",
    name: "وكيل مخصص",
    emoji: "🧩",
    description: "",
    systemPrompt: "",
    permissions: { read: true, write: false, execute: false, network: false, delegate: false, approve: false },
    thinking: "medium",
  };
  return {
    isNew: true,
    id: "",
    name: tpl.name,
    role: tpl.id,
    emoji: tpl.emoji,
    description: tpl.description,
    systemPrompt: tpl.systemPrompt,
    permissions: { ...tpl.permissions },
    extraTools: [],
    model: null,
    thinking: tpl.thinking,
    enabled: true,
  };
}

function modelOptions(selected) {
  const models = controlOverview()?.models || state.models || [];
  const groups = new Map();
  for (const model of models) {
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider).push(model);
  }
  let html = `<option value="">— نفس نموذج الجلسة —</option>`;
  const known = new Set(models.map((model) => `${model.provider}/${model.id}`));
  if (selected && !known.has(selected)) {
    html += `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (غير متاح حالياً)</option>`;
  }
  for (const [provider, list] of [...groups.entries()].sort()) {
    html += `<optgroup label="${escapeHtml(provider)}">`;
    for (const model of list) {
      const value = `${model.provider}/${model.id}`;
      html += `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(model.name || model.id)}</option>`;
    }
    html += `</optgroup>`;
  }
  return html;
}

function thinkingSelectOptions(selected) {
  return THINKING_ORDER.map((level) => `<option value="${level}" ${level === selected ? "selected" : ""}>${escapeHtml(THINKING_LABELS.ar[level] || level)}</option>`).join("");
}

function roleSelectOptions(selected, roles = []) {
  return roles.map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === selected ? "selected" : ""}>${escapeHtml(role.emoji)} ${escapeHtml(role.name)}</option>`).join("");
}

function permissionToggles(permissions = {}) {
  return Object.entries(PERMISSION_META)
    .map(([key, meta]) => `<label class="perm-toggle"><input type="checkbox" name="perm_${key}" ${permissions[key] ? "checked" : ""}><span class="box"></span><span class="pt-label"><b>${meta.icon} ${meta.label}</b><small>${meta.hint}</small></span></label>`)
    .join("");
}

function renderAgentsTab(data) {
  const agents = data.agents || [];
  const draft = state.control.agentDraft;
  const list = agents.length
    ? agents
        .map(
          (agent) => `<div class="cc-item ${agent.enabled === false ? "dim" : ""}">
            <div class="cc-item-icon">${escapeHtml(agent.emoji || "🤖")}</div>
            <div class="cc-item-main">
              <div class="cc-item-title">${escapeHtml(agent.name)} <span class="chip accent">${escapeHtml(roleLabel(agent.role))}</span>${agent.enabled === false ? `<span class="chip bad">معطّل</span>` : `<span class="chip good">مفعّل</span>`}</div>
              <div class="cc-item-desc">${escapeHtml(agent.description || "بلا وصف")}</div>
              <div class="cc-chips">${permissionChips(agent)}</div>
              <div class="cc-item-meta"><span>🧩 ${escapeHtml(agent.model ? `${agent.model.provider}/${agent.model.model}` : "نموذج الجلسة")}</span><span>🧠 ${escapeHtml(THINKING_LABELS.ar[agent.thinking] || agent.thinking || "—")}</span><span>🛠️ ${(agent.tools || []).length} أداة</span></div>
            </div>
            <div class="cc-item-actions">
              <button class="btn" data-action="edit-agent" data-id="${escapeHtml(agent.id)}">تعديل</button>
              <button class="btn" data-action="duplicate-agent" data-id="${escapeHtml(agent.id)}">نسخ</button>
              <button class="btn" data-action="delete-agent" data-id="${escapeHtml(agent.id)}">حذف</button>
            </div>
          </div>`,
        )
        .join("")
    : `<div class="cc-empty">لا يوجد وكلاء. أضف وكيلك الأول.</div>`;
  return `
    <div class="cc-section">
      <div class="cc-section-head">
        <div><h3 class="cc-section-title">🤖 الوكلاء (${agents.length})</h3><p class="cc-section-desc">لكل وكيل دور وصلاحيات ونموذج. القائد يمكنه تفويض المهام للوكلاء الآخرين عبر أداة <code>delegate</code>.</p></div>
        <div class="cc-section-actions"><button class="btn primary" data-action="new-agent">＋ وكيل جديد</button></div>
      </div>
      ${draft ? agentForm(draft, data.roles || []) : ""}
      <div class="cc-list two">${list}</div>
    </div>`;
}

function agentForm(draft, roles) {
  const modelValue = draft.model ? `${draft.model.provider}/${draft.model.model}` : "";
  return `<form class="cc-form" data-form="agent" data-editing="${draft.isNew ? "0" : "1"}">
    <div class="cc-form-grid">
      <label class="cc-field"><span>الدور</span><select name="role" data-role-select>${roleSelectOptions(draft.role, roles)}</select></label>
      <label class="cc-field"><span>الاسم</span><input name="name" value="${escapeHtml(draft.name || "")}" required></label>
      <label class="cc-field"><span>الرمز</span><input name="emoji" value="${escapeHtml(draft.emoji || "🤖")}" maxlength="8"></label>
      <label class="cc-field"><span>المعرّف</span><input name="id" value="${escapeHtml(draft.id || "")}" ${draft.isNew ? "" : "disabled"} placeholder="executor-2" pattern="[a-z0-9][a-z0-9._-]*"></label>
      <label class="cc-field wide"><span>الوصف</span><input name="description" value="${escapeHtml(draft.description || "")}" placeholder="ماذا يفعل هذا الوكيل؟"></label>
      <label class="cc-field wide"><span>تعليمات النظام (System Prompt)</span><textarea name="systemPrompt" rows="6">${escapeHtml(draft.systemPrompt || "")}</textarea></label>
    </div>
    <div class="cc-section-title" style="margin:2px 0 0">🔐 الصلاحيات</div>
    <div class="perm-grid">${permissionToggles(draft.permissions || {})}</div>
    <div class="cc-form-grid">
      <label class="cc-field"><span>النموذج</span><select name="model">${modelOptions(modelValue)}</select></label>
      <label class="cc-field"><span>مستوى التفكير</span><select name="thinking">${thinkingSelectOptions(draft.thinking)}</select></label>
      <label class="cc-field"><span>أدوات إضافية</span><input name="extraTools" value="${escapeHtml((draft.extraTools || []).join(", "))}" placeholder="tool_name, another_tool"><small>أسماء أدوات إضافية من الإضافات المثبتة.</small></label>
      <div class="cc-field"><span>الحالة</span><label class="switch-row"><input type="checkbox" name="enabled" ${draft.enabled !== false ? "checked" : ""}><span class="box"></span><span>مفعّل</span></label></div>
    </div>
    <div class="cc-form-actions">
      <button class="btn primary" type="submit">💾 حفظ الوكيل</button>
      <button class="btn" type="button" data-action="apply-role">✨ تطبيق قالب الدور</button>
      <button class="btn ghost" type="button" data-action="cancel-agent">إلغاء</button>
    </div>
  </form>`;
}

function providerModelRow(model = {}) {
  return `<div class="model-row cc-form-grid" style="align-items:end;margin-top:9px;padding-top:9px;border-top:1px dashed var(--border)">
    <label class="cc-field"><span>معرّف النموذج</span><input data-field="id" value="${escapeHtml(model.id || "")}" placeholder="qwen2.5-coder:7b" required></label>
    <label class="cc-field"><span>الاسم</span><input data-field="name" value="${escapeHtml(model.name || "")}" placeholder="Qwen Coder"></label>
    <label class="cc-field"><span>Context</span><input data-field="contextWindow" type="number" min="1" value="${escapeHtml(model.contextWindow || 128000)}"></label>
    <label class="cc-field"><span>Max tokens</span><input data-field="maxTokens" type="number" min="1" value="${escapeHtml(model.maxTokens || 8192)}"></label>
    <div class="cc-field"><span>القدرات</span><span style="display:flex;gap:7px;flex-wrap:wrap"><label class="perm-inline"><input type="checkbox" data-field="reasoning" ${model.reasoning ? "checked" : ""}> تفكير</label><label class="perm-inline"><input type="checkbox" data-field="vision" ${model.vision ? "checked" : ""}> صور</label></span></div>
    <div class="cc-field" style="justify-content:end"><button type="button" class="btn" data-action="remove-model-row">× حذف</button></div>
  </div>`;
}

function renderProvidersTab(data) {
  const providers = data.providers || [];
  const draft = state.control.providerDraft;
  const shown = state.control.showAllProviders
    ? providers
    : providers.filter((provider) => provider.configured || provider.custom || provider.modelCount > 0);
  const list = shown.length
    ? shown
        .map((provider) => {
          const keyForm = state.control.keyFor === provider.id
            ? `<form class="cc-form" data-form="provider-key" data-id="${escapeHtml(provider.id)}" style="margin-top:9px">
                <label class="cc-field"><span>مفتاح API لـ ${escapeHtml(provider.name)}</span><input name="apiKey" type="password" autocomplete="off" placeholder="sk-..." required><small>يُحفظ في <code>auth.json</code> بصلاحيات 600.</small></label>
                <div class="cc-form-actions"><button class="btn primary" type="submit">💾 حفظ المفتاح</button><button class="btn ghost" type="button" data-action="cancel-key">إلغاء</button></div>
              </form>`
            : "";
          return `<div class="cc-item" style="display:block">
            <div style="display:flex;align-items:flex-start;gap:12px">
              <div class="cc-item-icon">${provider.custom ? "🔌" : "🏛️"}</div>
              <div class="cc-item-main">
                <div class="cc-item-title">${escapeHtml(provider.name || provider.id)}
                  ${provider.configured ? `<span class="chip good">مفعّل</span>` : `<span class="chip bad">غير مفعّل</span>`}
                  ${provider.custom ? `<span class="chip accent">مخصص</span>` : `<span class="chip">مدمج</span>`}
                </div>
                <div class="cc-item-desc">${provider.baseUrl ? escapeHtml(provider.baseUrl) : "عنوان افتراضي من Pi"}${provider.api ? ` · <code>${escapeHtml(provider.api)}</code>` : ""}</div>
                <div class="cc-chips"><span class="chip">🧩 ${provider.modelCount || 0} نموذج</span>${provider.keyPreview ? `<span class="chip good">🔑 ${escapeHtml(provider.keyPreview)}</span>` : provider.configured ? `<span class="chip good">🌍 ${escapeHtml(provider.authSource || "مفعّل")}</span>` : `<span class="chip warn">لا مفتاح</span>`}${provider.authSource ? `<span class="chip">${escapeHtml(provider.authSource)}</span>` : ""}</div>
              </div>
              <div class="cc-item-actions">
                <button class="btn" data-action="edit-provider" data-id="${escapeHtml(provider.id)}">تعديل</button>
                <button class="btn" data-action="provider-key" data-id="${escapeHtml(provider.id)}">🔑 مفتاح</button>
                ${provider.keyPreview ? `<button class="btn" data-action="clear-key" data-id="${escapeHtml(provider.id)}">مسح المفتاح</button>` : ""}
                ${provider.custom ? `<button class="btn" data-action="delete-provider" data-id="${escapeHtml(provider.id)}">حذف</button>` : ""}
              </div>
            </div>
            ${keyForm}
          </div>`;
        })
        .join("")
    : `<div class="cc-empty">لا توجد مزوّدات مفعّلة. أضف مزوّداً جديداً أو اعرض كل المزوّدين.</div>`;
  return `
    <div class="cc-section">
      <div class="cc-section-head">
        <div><h3 class="cc-section-title">🔌 مزوّدو النماذج (${data.counts?.providers || 0})</h3><p class="cc-section-desc">اربط OpenAI أو Anthropic أو Google أو أي endpoint متوافق. المفاتيح تُحفظ محلياً ولا تُعاد للواجهة.</p></div>
        <div class="cc-section-actions">
          <button class="btn" data-action="toggle-all-providers">${state.control.showAllProviders ? "إظهار المفعّلة" : "عرض كل المزوّدين"}</button>
          <button class="btn primary" data-action="new-provider">＋ مزوّد جديد</button>
        </div>
      </div>
      ${draft ? providerForm(draft, data.apis || []) : ""}
      <div class="cc-list">${list}</div>
    </div>`;
}

function providerForm(draft, apis) {
  const models = draft.models && draft.models.length ? draft.models : [{}];
  return `<form class="cc-form" data-form="provider" data-editing="${draft.isNew ? "0" : "1"}">
    <div class="cc-form-grid">
      <label class="cc-field"><span>المعرّف</span><input name="id" value="${escapeHtml(draft.id || "")}" ${draft.isNew ? "" : "disabled"} placeholder="ollama" pattern="[a-z0-9][a-z0-9._-]*" required></label>
      <label class="cc-field"><span>الاسم</span><input name="name" value="${escapeHtml(draft.name || "")}" placeholder="Ollama المحلي"></label>
      <label class="cc-field"><span>Base URL</span><input name="baseUrl" value="${escapeHtml(draft.baseUrl || "")}" placeholder="http://localhost:11434/v1" dir="ltr"></label>
      <label class="cc-field"><span>نوع API</span><select name="api">${(apis.length ? apis : [{ id: "openai-completions", label: "OpenAI Compatible" }]).map((api) => `<option value="${escapeHtml(api.id)}" ${api.id === (draft.api || "openai-completions") ? "selected" : ""}>${escapeHtml(api.label)}</option>`).join("")}</select></label>
      <label class="cc-field"><span>مفتاح API (اختياري)</span><input name="apiKey" type="password" autocomplete="off" placeholder="اتركه فارغاً للإبقاء على الحالي"><small>يدعم <code>$ENV_VAR</code> أو <code>!command</code>.</small></label>
      <div class="cc-field"><span>بدون مفتاح</span><label class="switch-row"><input type="checkbox" name="noKey" ${draft.noKey ? "checked" : ""}><span class="box"></span><span>endpoint محلي لا يحتاج مفتاحاً</span></label></div>
    </div>
    <div class="cc-section-title" style="margin:3px 0 0">🧩 النماذج</div>
    <div data-model-rows>${models.map((model) => providerModelRow(model)).join("")}</div>
    <div class="cc-form-actions">
      <button class="btn primary" type="submit">💾 حفظ المزوّد</button>
      <button class="btn" type="button" data-action="add-model-row">＋ نموذج</button>
      <button class="btn ghost" type="button" data-action="cancel-provider">إلغاء</button>
    </div>
  </form>`;
}

function renderUsageTab(data) {
  const usage = data.usage || {};
  const limits = data.limits || usage.limits || {};
  const context = usage.context || state.contextUsage;
  return `
    <div class="usage-kpis">
      ${usageKpi("📅 اليوم", usage.daily)}
      ${usageKpi("🗓️ هذا الأسبوع", usage.weekly)}
      ${contextKpi(context)}
    </div>
    <div class="cc-section">
      <div class="cc-section-head"><div><h3 class="cc-section-title">⚙️ حدود التوكنز</h3><p class="cc-section-desc">يُحسب اليوم من منتصف الليل، والأسبوع يبدأ الأحد. القيمة 0 تعني «بلا حد».</p></div></div>
      <form class="cc-form" data-form="limits">
        <div class="cc-form-grid">
          <label class="cc-field"><span>حد التوكنز اليومي</span><input name="dailyTokens" type="number" min="0" step="1000" value="${Number(limits.dailyTokens || 0)}"><small>مثال: 1000000 = مليون توكن.</small></label>
          <label class="cc-field"><span>حد التوكنز الأسبوعي</span><input name="weeklyTokens" type="number" min="0" step="1000" value="${Number(limits.weeklyTokens || 0)}"></label>
          <label class="cc-field"><span>حد التكلفة اليومي ($)</span><input name="dailyCost" type="number" min="0" step="0.01" value="${Number(limits.dailyCost || 0)}"></label>
          <label class="cc-field"><span>حد التكلفة الأسبوعي ($)</span><input name="weeklyCost" type="number" min="0" step="0.01" value="${Number(limits.weeklyCost || 0)}"></label>
        </div>
        <div class="cc-form-actions">
          <button class="btn primary" type="submit">💾 حفظ الحدود</button>
          <button class="btn" type="button" data-action="preset-limits" data-daily="1000000" data-weekly="5000000">1M / 5M</button>
          <button class="btn" type="button" data-action="preset-limits" data-daily="5000000" data-weekly="25000000">5M / 25M</button>
          <button class="btn" type="button" data-action="preset-limits" data-daily="0" data-weekly="0">بلا حدود</button>
        </div>
      </form>
    </div>
    <div class="cc-section">
      <div class="cc-section-head"><div><h3 class="cc-section-title">📈 آخر 14 يوماً</h3><p class="cc-section-desc">إجمالي التوكنز والتكلفة اليومية.</p></div></div>
      ${chartHtml(usage.series)}
    </div>
    <div class="cc-section">
      <div class="cc-section-head"><div><h3 class="cc-section-title">توزيع هذا الأسبوع</h3><p class="cc-section-desc">أين تذهب توكنزك؟</p></div></div>
      <div class="usage-breakdown">
        <div><div class="cc-section-title" style="font-size:.8rem;margin-bottom:9px">حسب المزوّد</div>${breakdownHtml(usage.byProvider, "provider")}</div>
        <div><div class="cc-section-title" style="font-size:.8rem;margin-bottom:9px">حسب النموذج</div>${breakdownHtml(usage.byModel, "model")}</div>
        <div><div class="cc-section-title" style="font-size:.8rem;margin-bottom:9px">حسب الوكيل</div>${breakdownHtml(usage.byAgent, "agent", agentDisplayName)}</div>
      </div>
    </div>
    <div class="cc-section">
      <div class="cc-section-head"><div><h3 class="cc-section-title">تفاصيل اليوم</h3></div></div>
      <div class="cc-grid">
        ${ccStat("⬇️", fmtNumber(usage.daily?.input || 0), "توكنات الإدخال", fmtCost(usage.daily?.cost || 0))}
        ${ccStat("⬆️", fmtNumber(usage.daily?.output || 0), "توكنات الإخراج", `${fmtNumber(usage.daily?.requests || 0)} طلب`)}
        ${ccStat("♻️", fmtNumber((usage.daily?.cacheRead || 0) + (usage.daily?.cacheWrite || 0)), "الكاش", "قراءة + كتابة")}
        ${ccStat("⏳", usage.daily?.remainingTokens == null ? "∞" : fmtNumber(usage.daily.remainingTokens), "المتبقي اليوم", usage.daily?.resetAt ? `يتجدد ${fmtDate(usage.daily.resetAt)}` : "")}
      </div>
    </div>`;
}

function renderPermissionsTab(data) {
  const agents = data.agents || [];
  const permissions = data.permissions || Object.entries(PERMISSION_META).map(([key, meta]) => ({ key, ...meta }));
  const rows = agents
    .map((agent) => {
      const perms = agent.permissions || {};
      return `<tr>
        <td><span class="m-agent"><span>${escapeHtml(agent.emoji || "🤖")}</span><span>${escapeHtml(agent.name)}<br><small style="color:var(--muted)">${escapeHtml(roleLabel(agent.role))}</small></span></span></td>
        ${permissions.map((permission) => `<td><button class="m-toggle ${perms[permission.key] ? "on" : ""}" data-action="toggle-perm" data-agent="${escapeHtml(agent.id)}" data-perm="${escapeHtml(permission.key)}" title="${escapeHtml(permission.hint || permission.label)}">${perms[permission.key] ? "✓" : ""}</button></td>`).join("")}
        <td><button class="btn" data-action="edit-agent" data-id="${escapeHtml(agent.id)}">تعديل</button></td>
      </tr>`;
    })
    .join("");
  return `
    <div class="cc-note">
      <b>كيف توزّع الصلاحيات؟</b> كل صف وكيل، وكل عمود صلاحية. اضغط المربع لتفعيلها أو تعطيلها فوراً. الصلاحيات تتحكم في الأدوات المتاحة للوكيل فعلياً (القراءة، الكتابة، التنفيذ، الشبكة، التفويض). التغييرات تُطبّق عند إنشاء الجلسة التالية أو بعد «إعادة تحميل».
    </div>
    <div class="cc-section">
      <div class="cc-section-head"><div><h3 class="cc-section-title">🔐 مصفوفة الصلاحيات</h3><p class="cc-section-desc">تحكم دقيق في ما يستطيع كل وكيل فعله.</p></div></div>
      <div class="matrix-wrap">
        <table class="matrix">
          <thead><tr><th>الوكيل</th>${permissions.map((permission) => `<th>${escapeHtml(permission.icon || "")} ${escapeHtml(permission.label)}</th>`).join("")}<th>إجراء</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="${permissions.length + 2}" class="cc-empty">لا يوجد وكلاء.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="cc-section">
      <div class="cc-section-head"><div><h3 class="cc-section-title">أدوار جاهزة</h3><p class="cc-section-desc">استخدمها كقالب عند إنشاء وكيل جديد.</p></div></div>
      <div class="cc-list two">
        ${(data.roles || []).map((role) => `<div class="cc-item"><div class="cc-item-icon">${escapeHtml(role.emoji)}</div><div class="cc-item-main"><div class="cc-item-title">${escapeHtml(role.name)} <span class="chip accent">${escapeHtml(role.id)}</span></div><div class="cc-item-desc">${escapeHtml(role.description)}</div><div class="cc-chips">${Object.entries(role.permissions || {}).filter(([, value]) => value).map(([key]) => `<span class="chip good">${escapeHtml(PERMISSION_META[key]?.icon || "")} ${escapeHtml(PERMISSION_META[key]?.label || key)}</span>`).join("")}</div></div></div>`).join("")}
      </div>
    </div>`;
}

/* ===== أحداث مركز التحكم ===== */

function bindControlCenter() {
  els.controlBody.addEventListener("click", onControlClick);
  els.controlBody.addEventListener("submit", onControlSubmit);
}

async function afterMutation(message) {
  if (message) toast(message, "success");
  await refreshControl();
}

async function onControlClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button || !els.controlBody.contains(button)) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  const data = controlOverview();
  try {
    switch (action) {
      case "go-tab":
        switchControlTab(button.dataset.tab);
        break;
      case "new-skill":
        state.control.skillDraft = { isNew: true, id: "", description: "", instructions: "" };
        renderControl();
        break;
      case "edit-skill": {
        const result = await apiFetch(`/api/skills/${encodeURIComponent(id)}`);
        if (result?.skill) state.control.skillDraft = { ...result.skill, isNew: false };
        renderControl();
        break;
      }
      case "delete-skill":
        if (!confirm(`حذف المهارة «${id}» نهائياً؟`)) break;
        await apiFetch(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
        await afterMutation("تم حذف المهارة.");
        break;
      case "cancel-skill":
        state.control.skillDraft = null;
        renderControl();
        break;
      case "new-extension":
        state.control.extensionDraft = { isNew: true, id: "", code: EXTENSION_TEMPLATES.command.code };
        renderControl();
        break;
      case "edit-extension": {
        const extension = (data?.extensions || []).find((item) => item.id === id);
        if (extension) state.control.extensionDraft = { ...extension, isNew: false };
        renderControl();
        break;
      }
      case "delete-extension":
        if (!confirm(`حذف الإضافة «${id}» نهائياً؟`)) break;
        await apiFetch(`/api/extensions/${encodeURIComponent(id)}`, { method: "DELETE" });
        await afterMutation("تم حذف الإضافة. أعد تحميل الجلسة لتطبيق التغيير.");
        break;
      case "cancel-extension":
        state.control.extensionDraft = null;
        renderControl();
        break;
      case "extension-template": {
        const select = document.querySelector("#extensionTemplate");
        const template = EXTENSION_TEMPLATES[select?.value];
        const form = els.controlBody.querySelector('form[data-form="extension"]');
        if (!template || !form) break;
        if (!form.elements.id.value) form.elements.id.value = select.value;
        form.elements.code.value = template.code;
        break;
      }
      case "skill-template": {
        const select = document.querySelector("#skillTemplate");
        const template = SKILL_TEMPLATES[select?.value];
        if (!template) break;
        const form = els.controlBody.querySelector('form[data-form="skill"]');
        if (!form) break;
        if (!form.elements.id.value) form.elements.id.value = select.value;
        if (!form.elements.description.value) form.elements.description.value = template.description;
        if (!form.elements.instructions.value) form.elements.instructions.value = template.instructions;
        break;
      }
      case "new-agent":
        state.control.agentDraft = agentDraftTemplate("executor");
        renderControl();
        break;
      case "edit-agent": {
        const agent = (data?.agents || []).find((item) => item.id === id);
        if (agent) {
          state.control.agentDraft = { ...agent, isNew: false, permissions: { ...agent.permissions } };
          state.control.tab = "agents";
          syncControlTabs();
        }
        renderControl();
        break;
      }
      case "duplicate-agent":
        await apiFetch(`/api/agents/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
        await afterMutation("تم نسخ الوكيل.");
        break;
      case "delete-agent":
        if (!confirm(`حذف الوكيل «${id}»؟`)) break;
        await apiFetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
        await afterMutation("تم حذف الوكيل.");
        break;
      case "cancel-agent":
        state.control.agentDraft = null;
        renderControl();
        break;
      case "apply-role": {
        const form = els.controlBody.querySelector('form[data-form="agent"]');
        const roleId = form?.querySelector('[name="role"]')?.value;
        const draft = state.control.agentDraft;
        if (!draft || !roleId) break;
        const template = (data?.roles || []).find((role) => role.id === roleId);
        if (!template) break;
        state.control.agentDraft = {
          ...draft,
          role: template.id,
          name: template.name,
          emoji: template.emoji,
          description: template.description,
          systemPrompt: template.systemPrompt,
          permissions: { ...template.permissions },
          thinking: template.thinking,
        };
        renderControl();
        break;
      }
      case "new-provider":
        state.control.providerDraft = {
          isNew: true,
          id: "",
          name: "",
          baseUrl: "",
          api: "openai-completions",
          apiKey: "",
          noKey: false,
          models: [{ id: "", name: "", contextWindow: 128000, maxTokens: 8192, reasoning: false, vision: false }],
        };
        renderControl();
        break;
      case "edit-provider": {
        const provider = (data?.providers || []).find((item) => item.id === id);
        if (!provider) break;
        state.control.providerDraft = {
          isNew: false,
          id: provider.id,
          name: provider.name || provider.id,
          baseUrl: provider.baseUrl || "",
          api: provider.api || "openai-completions",
          apiKey: "",
          noKey: provider.authSource === "models_json_key" && !provider.keyPreview,
          models: (provider.configModels || []).length
            ? provider.configModels.map((model) => ({
                ...model,
                contextWindow: model.contextWindow || 128000,
                maxTokens: model.maxTokens || 8192,
              }))
            : [{ id: "", name: "", contextWindow: 128000, maxTokens: 8192, reasoning: false, vision: false }],
        };
        state.control.keyFor = null;
        renderControl();
        break;
      }
      case "delete-provider":
        if (!confirm(`حذف المزوّد «${id}» وكل نماذجه؟`)) break;
        await apiFetch(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
        await afterMutation("تم حذف المزوّد.");
        break;
      case "cancel-provider":
        state.control.providerDraft = null;
        renderControl();
        break;
      case "add-model-row": {
        const draft = state.control.providerDraft;
        if (!draft) break;
        draft.models = [...(draft.models || []), { id: "", name: "", contextWindow: 128000, maxTokens: 8192, reasoning: false, vision: false }];
        renderControl();
        break;
      }
      case "remove-model-row": {
        const draft = state.control.providerDraft;
        if (!draft) break;
        const rows = [...els.controlBody.querySelectorAll(".model-row")];
        const index = rows.indexOf(button.closest(".model-row"));
        if (index >= 0) draft.models.splice(index, 1);
        if (!draft.models.length) draft.models.push({ id: "", name: "", contextWindow: 128000, maxTokens: 8192, reasoning: false, vision: false });
        renderControl();
        break;
      }
      case "provider-key":
        state.control.keyFor = id;
        renderControl();
        break;
      case "cancel-key":
        state.control.keyFor = null;
        renderControl();
        break;
      case "clear-key":
        if (!confirm(`مسح مفتاح «${id}»؟`)) break;
        await apiFetch(`/api/providers/${encodeURIComponent(id)}/key`, { method: "DELETE" });
        state.control.keyFor = null;
        await afterMutation("تم مسح المفتاح.");
        break;
      case "toggle-all-providers":
        state.control.showAllProviders = !state.control.showAllProviders;
        renderControl();
        break;
      case "toggle-mcp": {
        const name = button.dataset.name;
        const scope = button.dataset.scope || "user";
        const enabled = button.dataset.enabled === "1";
        await apiFetch(`/api/mcp/${encodeURIComponent(name)}`, { method: "PUT", body: { enabled, scope } });
        await afterMutation(enabled ? "تم تفعيل خادم MCP. أعد تحميل الجلسة لتطبيق التغيير." : "تم تعطيل خادم MCP. أعد تحميل الجلسة لتطبيق التغيير.");
        break;
      }
      case "refresh":
        await refreshControl();
        break;
      case "toggle-perm": {
        const agentId = button.dataset.agent;
        const perm = button.dataset.perm;
        const agent = (data?.agents || []).find((item) => item.id === agentId);
        if (!agent) break;
        const permissions = { ...agent.permissions, [perm]: !agent.permissions?.[perm] };
        const result = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: "PUT", body: { permissions } });
        const fresh = (result.agents || []).find((item) => item.id === agentId);
        if (fresh) {
          const index = (data?.agents || []).findIndex((item) => item.id === agentId);
          if (index >= 0) data.agents[index] = fresh;
          const stateIndex = state.agents.findIndex((item) => item.id === agentId);
          if (stateIndex >= 0) state.agents[stateIndex] = fresh;
          if (state.current?.agent?.id === agentId) applyAgent(fresh);
          populateAgents();
        }
        renderControl();
        break;
      }
      case "preset-limits": {
        const form = els.controlBody.querySelector('form[data-form="limits"]');
        if (!form) break;
        form.elements.dailyTokens.value = button.dataset.daily || "0";
        form.elements.weeklyTokens.value = button.dataset.weekly || "0";
        break;
      }
      default:
        break;
    }
  } catch (err) {
    toast(err.message || "تعذّر تنفيذ الإجراء", "error");
  }
}

async function onControlSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  try {
    if (kind === "skill") {
      const editing = state.control.skillDraft && !state.control.skillDraft.isNew;
      const body = {
        id: form.elements.id.value.trim(),
        description: form.elements.description.value.trim(),
        instructions: form.elements.instructions.value,
      };
      if (editing) {
        await apiFetch(`/api/skills/${encodeURIComponent(state.control.skillDraft.id)}`, { method: "PUT", body });
      } else {
        await apiFetch("/api/skills", { method: "POST", body });
      }
      state.control.skillDraft = null;
      await afterMutation(editing ? "تم تحديث المهارة." : "تمت إضافة المهارة.");
      return;
    }
    if (kind === "extension") {
      const editing = state.control.extensionDraft && !state.control.extensionDraft.isNew;
      const body = {
        id: form.elements.id.value.trim(),
        code: form.elements.code.value,
      };
      if (editing) {
        await apiFetch(`/api/extensions/${encodeURIComponent(state.control.extensionDraft.id)}`, { method: "PUT", body });
      } else {
        await apiFetch("/api/extensions", { method: "POST", body });
      }
      state.control.extensionDraft = null;
      await afterMutation(editing ? "تم تحديث الإضافة. أعد تحميل الجلسة لتطبيق التغيير." : "تمت إضافة الإضافة. أعد تحميل الجلسة لتطبيقها.");
      return;
    }
    if (kind === "agent") {
      const editing = state.control.agentDraft && !state.control.agentDraft.isNew;
      const permissions = {};
      for (const key of Object.keys(PERMISSION_META)) {
        permissions[key] = !!form.querySelector(`[name="perm_${key}"]`)?.checked;
      }
      const modelValue = form.elements.model.value;
      const body = {
        id: form.elements.id.value.trim() || undefined,
        name: form.elements.name.value.trim(),
        role: form.elements.role.value,
        emoji: form.elements.emoji.value.trim(),
        description: form.elements.description.value.trim(),
        systemPrompt: form.elements.systemPrompt.value,
        permissions,
        extraTools: form.elements.extraTools.value.split(",").map((item) => item.trim()).filter(Boolean),
        model: modelValue ? { provider: modelValue.split("/")[0], model: modelValue.split("/").slice(1).join("/") } : null,
        thinking: form.elements.thinking.value,
        enabled: !!form.elements.enabled?.checked,
      };
      if (editing) {
        await apiFetch(`/api/agents/${encodeURIComponent(state.control.agentDraft.id)}`, { method: "PUT", body });
      } else {
        await apiFetch("/api/agents", { method: "POST", body });
      }
      state.control.agentDraft = null;
      await afterMutation(editing ? "تم تحديث الوكيل." : "تم إنشاء الوكيل.");
      return;
    }
    if (kind === "provider") {
      const editing = state.control.providerDraft && !state.control.providerDraft.isNew;
      const rows = [...form.querySelectorAll(".model-row")];
      const models = rows
        .map((row) => ({
          id: row.querySelector('[data-field="id"]')?.value.trim(),
          name: row.querySelector('[data-field="name"]')?.value.trim(),
          contextWindow: Number(row.querySelector('[data-field="contextWindow"]')?.value) || 128000,
          maxTokens: Number(row.querySelector('[data-field="maxTokens"]')?.value) || 8192,
          reasoning: !!row.querySelector('[data-field="reasoning"]')?.checked,
          vision: !!row.querySelector('[data-field="vision"]')?.checked,
        }))
        .filter((model) => model.id);
      const body = {
        id: form.elements.id.value.trim() || undefined,
        name: form.elements.name.value.trim(),
        baseUrl: form.elements.baseUrl.value.trim(),
        api: form.elements.api.value,
        apiKey: form.elements.apiKey.value.trim(),
        noKey: !!form.elements.noKey?.checked,
        models,
      };
      if (editing) {
        await apiFetch(`/api/providers/${encodeURIComponent(state.control.providerDraft.id)}`, { method: "PUT", body });
      } else {
        await apiFetch("/api/providers", { method: "POST", body });
      }
      state.control.providerDraft = null;
      await afterMutation(editing ? "تم تحديث المزوّد." : "تمت إضافة المزوّد.");
      return;
    }
    if (kind === "provider-key") {
      const providerId = form.dataset.id;
      const apiKey = form.elements.apiKey.value.trim();
      await apiFetch(`/api/providers/${encodeURIComponent(providerId)}/key`, { method: "POST", body: { apiKey } });
      state.control.keyFor = null;
      await afterMutation("تم حفظ المفتاح.");
      return;
    }
    if (kind === "limits") {
      const body = {
        dailyTokens: Number(form.elements.dailyTokens.value) || 0,
        weeklyTokens: Number(form.elements.weeklyTokens.value) || 0,
        dailyCost: Number(form.elements.dailyCost.value) || 0,
        weeklyCost: Number(form.elements.weeklyCost.value) || 0,
      };
      const result = await apiFetch("/api/limits", { method: "PUT", body });
      state.usage = result.usage || state.usage;
      renderUsage();
      await afterMutation("تم حفظ الحدود.");
      return;
    }
  } catch (err) {
    toast(err.message || "تعذّر الحفظ", "error");
  }
}

async function main() {
  initTheme();
  bindUi();
  await loadConfig();
  connect();
}

main();
