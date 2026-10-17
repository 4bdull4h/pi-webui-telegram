/* مساعد Pi — منطق الواجهة العربية RTL */

// بصمة الإصدار تُستبدل بـmtime عند التقديم (انظر src/web-server.js).
console.info("[pi-webui] build", "__BUILD__");

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
  tabsBar: $("#tabsBar"),
  tabsBarWrap: $("#tabsBarWrap"),
  newTabBtn: $("#newTabBtn"),
  cmdPanel: $("#cmdPanel"),
  slashBtn: $("#slashBtn"),
  approvalsModal: $("#approvalsModal"),
  approvalsBody: $("#approvalsBody"),
  approvalsClose: $("#approvalsClose"),
  input: $("#input"),
  sendBtn: $("#sendBtn"),
  stopBtn: $("#stopBtn"),
  attachBtn: $("#attachBtn"),
  fileInput: $("#fileInput"),
  attachChips: $("#attachChips"),
  pathMenu: $("#pathMenu"),
  dropOverlay: $("#dropOverlay"),
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
  editorStatus: $("#editorStatus"),
  editorWidgets: $("#editorWidgets"),
  approvalQueue: $("#approvalQueue"),
  extUiDialog: $("#extUiDialog"),
  extUiTitle: $("#extUiTitle"),
  extUiBody: $("#extUiBody"),
  extUiClose: $("#extUiClose"),
  extUiKeysHint: $("#extUiKeysHint"),
  extUiTimer: $("#extUiTimer"),
  extUiRing: $("#extUiRing"),
  extUiRingWrap: $("#extUiRingWrap"),
  extUiLater: $("#extUiLater"),
  turnProgress: $("#turnProgress"),
  turnTimer: $("#turnTimer"),
  soundBtn: $("#soundBtn"),
  notifyBtn: $("#notifyBtn"),
  notifyBtnDot: $("#notifyBtnDot"),
  connBanner: $("#connBanner"),
  connBannerTitle: $("#connBannerTitle"),
  connBannerReason: $("#connBannerReason"),
  connBannerCount: $("#connBannerCount"),
  connBannerRetry: $("#connBannerRetry"),
  connBannerDiag: $("#connBannerDiag"),
  notifyBar: $("#notifyBar"),
  notifyBarRetry: $("#notifyBarRetry"),
  notifyBarClose: $("#notifyBarClose"),
  notifyPanel: $("#notifyPanel"),
  notifyPanelClose: $("#notifyPanelClose"),
  notifyMaster: $("#notifyMaster"),
  notifyVolume: $("#notifyVolume"),
  notifyVolumeLabel: $("#notifyVolumeLabel"),
  notifySoundList: $("#notifySoundList"),
  notifyPermState: $("#notifyPermState"),
  notifyConnLog: $("#notifyConnLog"),
  notifyConnClear: $("#notifyConnClear"),
  notifyExplain: $("#notifyExplain"),
  notifyExplainAllow: $("#notifyExplainAllow"),
  notifyExplainLater: $("#notifyExplainLater"),
  connDiagDialog: $("#connDiagDialog"),
  connDiagClose: $("#connDiagClose"),
  connDiagState: $("#connDiagState"),
  connDiagLog: $("#connDiagLog"),
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
  tabs: [],
  activeTabId: null,
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
  // C1: حوارات الامتدادات وحالة المحرر التي ترسلها الإضافات.
  extUi: {
    queue: [],
    current: null,
    options: [],
    activeIndex: 0,
    countdown: null,
    deadline: 0,
    titleTimer: null,
    titleBase: null,
    hiddenAt: 0,
    statuses: new Map(),
    widgets: new Map(),
    collapsedWidgets: new Set(),
  },
  // B2: مرفقات (رفع + معاينة) وقائمة إكمال المسارات (@).
  attachments: { items: [], seq: 0, uploading: false },
  // C3: بيانات الحدث الأخير المستخدمة في محتوى إشعارات النظام.
  alert: { startedAt: 0, reply: "", model: "", agent: "" },
  // C3: مراقب الاتصال (نبضة /health + تصنيف سبب الانقطاع).
  conn: {
    status: "online",
    reason: null,
    detail: "",
    fails: 0,
    attempt: 0,
    history: [],
    retryAt: 0,
    retryTimer: null,
    countdownTimer: null,
    hbTimer: null,
    latched: [],
    replayPending: false,
    lastCode: 0,
  },
  paths: { open: false, items: [], index: 0, start: 0, end: 0, request: 0, timer: null },
  // B3: لوحة أوامر / (محلية + خادمية).
  commands: {
    open: false,
    query: "",
    index: 0,
    filtered: [],
    items: [],
    loaded: false,
    loading: false,
    error: null,
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
  if (state.activeTabId) return state.activeTabId;
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("conversation");
  if (fromUrl) return fromUrl;
  if (state.config?.sharedSessionId) return state.config.sharedSessionId;
  return "shared:main";
}

/* ========================================================================
 * B1: تبويبات جلسات متوازية
 * كل تبويب = conversationId مستقل. التبويب الأول دائماً shared:main
 * (المشترك مع تيليجرام) ولا يُغلق. القائمة والمسودّات والعدّادات في localStorage.
 * ======================================================================== */

const TABS_STORAGE_KEY = "pi.tabs.v1";
let tabsPersistTimer = null;

function sharedTabId() {
  return state.config?.sharedSessionId || "shared:main";
}

function newTabId() {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `tab:${uuid}`;
}

function readStoredTabs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function tabById(id) {
  return state.tabs.find((tab) => tab.id === id) || null;
}

function activeTab() {
  return tabById(state.activeTabId);
}

function tabTitle(tab, index = state.tabs.indexOf(tab)) {
  if (tab.title) return tab.title;
  if (tab.id === sharedTabId()) return "الجلسة المشتركة";
  return `جلسة ${index + 1}`;
}

function ensureTab(id, fallbackTitle = "") {
  const clean = String(id || "").trim().slice(0, 120);
  if (!clean) return null;
  let tab = tabById(clean);
  if (!tab) {
    tab = { id: clean, title: fallbackTitle, custom: false, draft: "", unread: 0, busy: false };
    state.tabs.push(tab);
  }
  return tab;
}

function initTabs() {
  const shared = sharedTabId();
  const stored = readStoredTabs();
  const tabs = [];
  const add = (entry, fallbackTitle = "") => {
    const id = String(entry?.id || "").trim().slice(0, 120);
    if (!id || tabs.some((tab) => tab.id === id)) return;
    tabs.push({
      id,
      title: typeof entry?.title === "string" ? entry.title : fallbackTitle,
      custom: !!entry?.custom,
      draft: typeof entry?.draft === "string" ? entry.draft : "",
      unread: Math.max(0, Math.min(99, Number(entry?.unread) || 0)),
      busy: false,
    });
  };

  const storedTabs = Array.isArray(stored?.tabs) ? stored.tabs : [];
  const storedShared = storedTabs.find((tab) => tab.id === shared);
  add({ ...(storedShared || {}), id: shared, title: storedShared?.title || "الجلسة المشتركة" });
  for (const entry of storedTabs) {
    if (entry?.id === shared) continue;
    add(entry);
  }
  // رابط قديم ?conversation=...: يفتح كتبويب إضافي بدل تجاهله.
  const fromUrl = new URL(location.href).searchParams.get("conversation");
  if (fromUrl) add({ id: fromUrl, title: "" });
  // توافق خلفي: محادثة الويب المحفوظة سابقاً تصبح تبويباً بدل أن تضيع.
  if (!storedTabs.length) {
    try {
      const legacy = localStorage.getItem("pi.conversation");
      if (legacy && legacy !== shared) add({ id: legacy, title: "" });
    } catch {
      /* تخزين معطّل — تجاهل */
    }
  }

  const preferred = [
    typeof stored?.activeId === "string" ? stored.activeId : null,
    fromUrl,
    shared,
  ].find((id) => id && tabs.some((tab) => tab.id === id));

  state.tabs = tabs;
  state.activeTabId = preferred || tabs[0].id;
  state.conversationId = state.activeTabId;
  if (els.input) els.input.value = activeTab()?.draft || "";
  renderTabs();
  persistTabs(true);
}

function persistTabs(immediate = false) {
  const write = () => {
    try {
      const payload = {
        version: 1,
        activeId: state.activeTabId,
        tabs: state.tabs.map((tab) => ({
          id: tab.id,
          title: tab.title || "",
          custom: !!tab.custom,
          draft: tab.draft || "",
          unread: Number(tab.unread) || 0,
        })),
      };
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* تخزين ممتلئ أو معطّل — لا نكسر الواجهة */
    }
  };
  if (tabsPersistTimer) {
    clearTimeout(tabsPersistTimer);
    tabsPersistTimer = null;
  }
  if (immediate) write();
  else tabsPersistTimer = setTimeout(write, 250);
}

function saveActiveDraft() {
  const tab = activeTab();
  if (!tab || !els.input) return;
  tab.draft = els.input.value;
}

function renderTabs() {
  const box = els.tabsBar;
  if (!box) return;
  const scrollLeft = box.scrollLeft;
  box.replaceChildren();
  state.tabs.forEach((tab, index) => {
    const isActive = tab.id === state.activeTabId;
    const item = document.createElement("div");
    item.className = `tab${isActive ? " active" : ""}${tab.busy ? " busy" : ""}`;
    item.dataset.id = tab.id;
    item.dataset.index = String(index);
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", isActive ? "true" : "false");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab-title";
    button.title = `${tabTitle(tab, index)}\n${tab.id}\n(نقر مزدوج لإعادة التسمية)`;

    const icon = document.createElement("span");
    icon.className = "tab-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = tab.id === sharedTabId() ? "🔗" : "💬";

    const label = document.createElement("span");
    label.className = "tab-label";
    label.dir = "auto";
    label.textContent = tabTitle(tab, index);

    button.append(icon, label);
    if (tab.unread > 0) {
      const unread = document.createElement("span");
      unread.className = "tab-unread";
      unread.textContent = tab.unread > 9 ? "9+" : String(tab.unread);
      unread.title = `${tab.unread} رسالة/حدث جديد`;
      button.appendChild(unread);
    }
    if (tab.busy) {
      const busy = document.createElement("span");
      busy.className = "tab-busy-dot";
      busy.title = "جارٍ التوليد…";
      button.appendChild(busy);
    }

    button.addEventListener("click", () => switchTab(tab.id));
    button.addEventListener("dblclick", (event) => {
      event.preventDefault();
      renameTab(tab.id);
    });
    item.appendChild(button);

    if (tab.id !== sharedTabId()) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.title = "إغلاق التبويب";
      close.setAttribute("aria-label", `إغلاق ${tabTitle(tab, index)}`);
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });
      item.appendChild(close);
    }
    box.appendChild(item);
  });
  box.scrollLeft = scrollLeft;
  // إبقاء التبويب النشط مرئياً أفقياً على الشاشات الضيقة.
  box.querySelector(".tab.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function sendWatch() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const conversationIds = state.tabs.map((tab) => tab.id).filter((id) => id !== state.activeTabId);
  try {
    state.ws.send(JSON.stringify({ type: "watch", conversationIds }));
  } catch {
    /* ignore */
  }
}

function switchTab(id, options = {}) {
  const tab = tabById(id);
  if (!tab) return;
  if (id === state.activeTabId && !options.force) return;
  saveActiveDraft();
  state.activeTabId = id;
  state.conversationId = id;
  tab.unread = 0;
  // تنظيف عرض التبويب السابق فوراً (لا نعرض رسائل جلسة أخرى أثناء الربط).
  state.current = null;
  state.currentTurn = null;
  state.toolCards.clear();
  resetExtensionUI();
  closePathMenu();
  closeCommandPanel();
  if (els.messages) {
    els.messages.innerHTML = "";
    restoreHero();
  }
  if (els.input) els.input.value = tab.draft || "";
  if (els.sessionBadge) els.sessionBadge.textContent = tabTitle(tab, state.tabs.indexOf(tab));
  autoResize();
  setStreaming(!!tab.busy);
  renderTabs();
  renderSessions();
  persistTabs(true);
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    send({ type: "bind", conversationId: id });
    sendWatch();
  } else {
    connect();
  }
}

function addTab() {
  saveActiveDraft();
  const tab = {
    id: newTabId(),
    title: `جلسة ${state.tabs.length + 1}`,
    custom: true,
    draft: "",
    unread: 0,
    busy: false,
  };
  state.tabs.push(tab);
  switchTab(tab.id);
  requestAnimationFrame(() => els.input?.focus());
}

function closeTab(id) {
  if (id === sharedTabId()) {
    toast("التبويب المشترك مع تيليجرام لا يُغلق.", "warn");
    return;
  }
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  const wasActive = state.activeTabId === id;
  state.tabs.splice(index, 1);
  if (wasActive) {
    const next = state.tabs[Math.max(0, index - 1)] || state.tabs[0];
    state.activeTabId = null;
    switchTab(next.id, { force: true });
  } else {
    renderTabs();
    persistTabs(true);
    sendWatch();
  }
}

function renameTab(id) {
  const tab = tabById(id);
  if (!tab) return;
  const current = tabTitle(tab, state.tabs.indexOf(tab));
  const value = window.prompt("اسم التبويب", current);
  if (value === null) return;
  const clean = String(value).trim().slice(0, 60);
  tab.title = clean || current;
  tab.custom = true;
  renderTabs();
  persistTabs(true);
}

/** حدث يصل لتبويب غير نشط (مراقبة): نحدّث العدّاد/الانشغال فقط. */
function handleBackgroundEvent(conversationId, event) {
  const tab = tabById(conversationId);
  if (!tab) return;
  switch (event.type) {
    case "run_start":
      tab.busy = true;
      break;
    case "assistant_message":
    case "settled":
    case "error":
      tab.busy = false;
      tab.unread = Math.min(99, (Number(tab.unread) || 0) + 1);
      SoundBus.play(event.type === "error" ? "error" : event.type === "settled" ? "done" : "message");
      if (event.type === "settled") {
        systemNotify("done", {
          title: L(`✅ انتهت المهمة في «${tab.title || "تبويب آخر"}»`, "✅ Task finished in another tab"),
          body: alertBody(L("اكتملت المهمة", "Task completed"), state.alert.reply),
          tag: `pi-done:${tab.id}`,
        });
      }
      break;
    case "title_changed":
      if (event.name && !tab.custom) tab.title = event.name;
      break;
    case "session_reset":
      if (!tab.custom) tab.title = "";
      break;
    default:
      break;
  }
  renderTabs();
  persistTabs();
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
  md.className = "md streaming";
  md.dir = "auto";
  const tools = document.createElement("div");
  tools.className = "tools";
  bubble.append(thinkingBox, md, tools);
  wrap.classList.add("generating");

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
      wrap.classList.remove("generating");
      md.classList.remove("streaming");
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
  if (streaming) startTurnTimer();
  else {
    stopTurnTimer();
    setTurnProgress("idle");
  }
  els.composerHint.textContent = streaming
    ? "جارٍ التوليد… يمكنك الإرسال لإضافة توجيه."
    : state.activeTabId === sharedTabId() && state.config?.syncWebTelegram
      ? "🔗 الجلسة مشتركة مع تيليجرام — الطلبات والردود تظهر في المكانين."
      : "اكتب / لعرض الأوامر والمهارات والقوالب.";
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
  state.alert.agent = `${agent.emoji || "🤖"} ${agent.name || agent.role || agent.id || ""}`.trim();
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
  const worst = Math.max(dailyPercent, weeklyPercent, ctxPercent);
  const worstLabel =
    worst === dailyPercent && dailyPercent > 0
      ? "حد اليوم"
      : worst === weeklyPercent && weeklyPercent > 0
        ? "حد الأسبوع"
        : "سياق الجلسة";
  maybeLimitAlert(worst, worstLabel);
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
      setTurnProgress("thinking");
      break;
    case "run_start":
      state.toolCards.clear();
      state.alert.startedAt = Date.now();
      state.alert.reply = "";
      setTurnProgress("thinking");
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      break;
    case "text_delta":
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      state.currentTurn.appendText(event.delta);
      setTurnProgress("streaming");
      break;
    case "thinking_delta":
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      state.currentTurn.appendThinking(event.delta);
      if (state.turnState !== "tool") setTurnProgress("thinking");
      break;
    case "tool_start": {
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      const card = state.currentTurn.addTool({ id: event.id, name: event.name, hint: hintFor(event.name, event.args) });
      if (card) state.toolCards.set(event.id, card);
      setTurnProgress("tool");
      scrollToBottom();
      break;
    }
    case "tool_update": {
      const card = state.toolCards.get(event.id);
      const status = card?.querySelector(".t-status");
      if (status && event.output) status.textContent = event.output;
      break;
    }
    case "tool_end": {
      const card = state.toolCards.get(event.id);
      updateToolCard(card, { output: event.output, isError: event.isError });
      if (event.isError) {
        noteAlertSnippet(event.output);
        SoundBus.play("toolFail");
      }
      if (state.streaming) setTurnProgress("streaming");
      break;
    }
    case "assistant_message": {
      if (!state.currentTurn) state.currentTurn = beginAssistantTurn();
      if (event.text) state.currentTurn.setText(event.text);
      state.currentTurn.setUsage(event.usage, event.model);
      noteAlertSnippet(event.text);
      if (event.model) state.alert.model = String(event.model);
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
      SoundBus.play("done");
      systemNotify("done", {
        title: L("✅ انتهت المهمة", "✅ Task finished"),
        body: alertBody(L("اكتملت المهمة بنجاح", "Task completed"), state.alert.reply),
        tag: "pi-done",
        onClick: () => scrollToBottom(true),
      });
      state.alert.startedAt = 0;
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
      noteAlertSnippet(event.message);
      SoundBus.play("error");
      systemNotify("error", {
        title: L("❌ خطأ", "❌ Error"),
        body: alertBody(L("فشلت المهمة", "Task failed"), event.message),
        tag: "pi-error",
        requireInteraction: true,
      });
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
      if (!event.success) {
        addErrorMessage(event.finalError || "فشلت إعادة المحاولة");
        noteAlertSnippet(event.finalError);
        SoundBus.play("error");
      }
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
      break;    case "session_ready":
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
      {
        const tab = activeTab();
        if (tab) {
          tab.busy = false;
          if (!tab.custom) tab.title = "";
          renderTabs();
          persistTabs(true);
        }
      }
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
        const tab = activeTab();
        if (tab && !tab.custom) {
          tab.title = event.name;
          renderTabs();
          persistTabs();
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
    case "ready": {
      state.conversationId = message.conversationId;
      const tab = ensureTab(message.conversationId, "");
      if (tab) {
        state.activeTabId = tab.id;
        tab.unread = 0;
        tab.busy = !!message.state?.isStreaming;
        if (message.state?.title && !tab.custom) tab.title = message.state.title;
      }
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
      if (tab) {
        // استعادة مسودة كل تبويب وحالة الانشغال/العدّاد بعد الربط.
        els.input.value = tab.draft || "";
        autoResize();
        setStreaming(!!message.state?.isStreaming);
      }
      renderTabs();
      persistTabs(true);
      sendWatch();
      setConnected(true);
      resetExtensionUI();
      replayLatchedApprovals();
      renderConnHistory();
      break;
    }
    case "state":
      applyState(message.state);
      if (Array.isArray(message.transcript)) {
        els.messages.innerHTML = "";
        if (!message.transcript.length) restoreHero();
        else renderTranscript(message.transcript);
      }
      break;
    case "models":
      state.models = message.models || [];
      populateModels();
      break;
    case "sessions":
      state.sessions = message.sessions || [];
      renderSessions();
      break;
    case "transcript": {
      // يُرسل بعد ready عند تأخر جاهزية الجسر — نطبّقه فقط إن كانت الواجهة فارغة.
      if (els.messages.querySelector(".msg") || !message.transcript?.length) break;
      els.messages.innerHTML = "";
      renderTranscript(message.transcript);
      break;
    }
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
      SoundBus.play("message");
      break;
    case "error":
      addErrorMessage(message.message);
      break;
    case "event":
      if (message.conversationId && message.conversationId !== state.conversationId) {
        handleBackgroundEvent(message.conversationId, message.event);
        break;
      }
      handleConversationEvent(message.event);
      break;
    case "rpc_result": {
      const pending = rpcPending.get(message.id);
      if (!pending) break;
      rpcPending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.data ?? null);
      break;
    }
    case "rpc_error": {
      const pending = rpcPending.get(message.id);
      if (!pending) break;
      rpcPending.delete(message.id);
      clearTimeout(pending.timer);
      pending.reject(new Error(message.message || "فشل أمر RPC"));
      break;
    }
    case "watching":
      break;
    case "extension_ui":
      handleExtensionUI(message.request);
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

/* ===== C1: حوارات الامتدادات (extension_ui) ===== */

const EXT_UI_KEYBOARD_HINT = "Enter للتأكيد · Esc للإلغاء · 1-9 اختيار سريع";

function extensionUiDialogOpen() {
  return !!state.extUi.current && !!els.extUiDialog?.open;
}

function resetExtensionUI() {
  const ui = state.extUi;
  if (ui.countdown) {
    clearInterval(ui.countdown);
    ui.countdown = null;
  }
  ui.queue = [];
  ui.current = null;
  ui.options = [];
  ui.activeIndex = 0;
  ui.deadline = 0;
  closeExtDialog();
  stopTitleFlash();
  if (els.extUiTimer) els.extUiTimer.textContent = "";
  els.extUiRingWrap?.classList.add("hidden");
  renderApprovalQueue();
}

function notifyToastKind(type) {
  if (type === "error") return "error";
  if (type === "warning" || type === "warn") return "warn";
  return "";
}

/* ===== C2: حوار أصلي + تنبيهات الوصول + حيوية ===== */

/** نص مترجم بسيط: العربية افتراضاً، الإنجليزية عند <html lang="en">. */
const L = (ar, en) => (document.documentElement.lang === "en" ? en : ar);
/* ===== إعدادات التنبيهات الموحّدة — تُحفظ كلها تحت مفتاح واحد ===== */
const NOTIFY_SETTINGS_KEY = "piweb.notify.settings";
const NOTIFY_DEFAULT_VOLUME = 70;
const NOTIFY_TYPE_IDS = ["approval", "done", "error", "toolFail", "disconnected", "reconnected", "message", "limit"];

/** يقرأ الإعدادات الموحّدة (ويهاجر مرة واحدة من مفاتيح C2/C3 القديمة). */
function readNotifySettings() {
  const fallback = { sound: true, volume: NOTIFY_DEFAULT_VOLUME, types: {} };
  try {
    const raw = localStorage.getItem(NOTIFY_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return fallback;
      const volume = Number(parsed.volume);
      return {
        sound: parsed.sound !== false,
        volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : NOTIFY_DEFAULT_VOLUME,
        types: parsed.types && typeof parsed.types === "object" ? { ...parsed.types } : {},
      };
    }
    const migrated = { ...fallback, types: {} };
    migrated.sound = localStorage.getItem("pi.extUi.sound") !== "off";
    const legacyVolume = Number(localStorage.getItem("pi.alert.volume"));
    if (Number.isFinite(legacyVolume) && localStorage.getItem("pi.alert.volume") !== null) {
      migrated.volume = Math.max(0, Math.min(100, legacyVolume));
    }
    for (const id of NOTIFY_TYPE_IDS) {
      if (localStorage.getItem(`pi.alert.sound.${id}`) === "off") migrated.types[id] = false;
    }
    return migrated;
  } catch {
    return fallback;
  }
}

/** يخزّن الإعدادات كاملة تحت `piweb.notify.settings`. */
function writeNotifySettings(next) {
  try {
    localStorage.setItem(NOTIFY_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* التخزين قد يكون معطّلاً */
  }
  return next;
}

/** يعدّل حقلاً/حقولاً ويحفظ. */
function patchNotifySettings(patch) {
  return writeNotifySettings({ ...readNotifySettings(), ...patch });
}

const SOUND_KEY = NOTIFY_SETTINGS_KEY;
const APPROVAL_TAG = "pi-ext-ui-approval";
const NOTIFY_BASE_TITLE = document.title;

function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function soundEnabled() {
  return readNotifySettings().sound;
}

function setSoundEnabled(enabled) {
  patchNotifySettings({ sound: !!enabled });
}

/** نغمة تنبيه الطلب — تُفوَّض إلى محرّك الأصوات الموحّد (C3). */
function playChime() {
  return SoundBus.play("approval");
}

function pendingApprovalCount() {
  return (state.extUi.current ? 1 : 0) + state.extUi.queue.length;
}

function approvalSummary(request) {
  const title = String(request?.title || request?.method || "");
  const detail =
    request?.message && request.message !== request.title ? String(request.message) : String(request?.preview || "");
  const line = detail.split("\n").find((part) => part.trim()) || "";
  const text = [title, line.trim()].filter(Boolean).join(" — ");
  return text.length > 130 ? `${text.slice(0, 127)}…` : text;
}

function startTitleFlash() {
  const ui = state.extUi;
  if (ui.titleTimer) return;
  ui.titleBase = ui.titleBase || document.title;
  const counter = pendingApprovalCount();
  const label = `(${counter}) ${L("🔐 موافقة مطلوبة", "🔐 Approval needed")}`;
  let shown = false;
  const tick = () => {
    shown = !shown;
    document.title = shown ? label : ui.titleBase;
  };
  tick();
  ui.titleTimer = setInterval(tick, 900);
}

function stopTitleFlash() {
  const ui = state.extUi;
  if (ui.titleTimer) {
    clearInterval(ui.titleTimer);
    ui.titleTimer = null;
  }
  document.title = ui.titleBase || NOTIFY_BASE_TITLE;
  ui.titleBase = null;
}

/** إشعار نظام للموافقة — دائمًا (ولو كانت الصفحة مرئية) مع tag ثابت لكل طلب. */
function notifyApproval(request) {
  const id = String(request?.id || "unknown");
  return systemNotify("approval", {
    title: L("🔐 موافقة مطلوبة", "🔐 Approval required"),
    body: alertBody(L("بانتظار موافقتك", "Waiting for your approval"), approvalSummary(request)),
    tag: `approval:${id}`,
    requireInteraction: true,
    onClick: () => {
      try {
        if (state.extUi.current?.id === request?.id) openExtDialog();
        else {
          const target = els.approvalQueue?.querySelector("[data-request-id]");
          target?.scrollIntoView({ block: "center" });
        }
      } catch {
        /* المتصفح قد يمنع التركيز */
      }
    },
  });
}

let notifyArmed = false;
/** عرض شرح مختصر مرة واحدة عند أول تفاعل، ثم طلب صلاحية الإشعارات. */
function armNotifications() {
  if (notifyArmed) return;
  notifyArmed = true;
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "default") {
      syncNotifyBar();
      return;
    }
    let explained = false;
    try {
      explained = localStorage.getItem(NOTIFY_EXPLAINED_KEY) === "1";
    } catch {
      explained = false;
    }
    if (explained) {
      void requestNotifyPermission();
      return;
    }
    const dialog = els.notifyExplain;
    if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else void requestNotifyPermission();
  } catch {
    /* تجاهل */
  }
}

document.addEventListener("pointerdown", armNotifications, { once: true, passive: true });

function announceApproval(request) {
  renderApprovalQueue();
  startTitleFlash();
  notifyApproval(request);
  SoundBus.play("approval");
  if (!reducedMotion()) {
    try {
      navigator.vibrate?.(90);
    } catch {
      /* الاهتزاز غير مدعوم */
    }
  }
}

function stickyToast(message) {
  if (!els.toasts) return;
  const node = document.createElement("div");
  node.className = "toast warn";
  node.textContent = message;
  node.style.cursor = "pointer";
  node.title = L("اضغط للإغلاق", "Click to dismiss");
  node.addEventListener("click", () => node.remove());
  els.toasts.appendChild(node);
}

/* ===== C3: محرّك أصوات موحّد + إشعارات نظام + مراقبة الاتصال ===== */

const NOTIFY_EXPLAINED_KEY = "pi.notify.explained";

/** جدول أنواع الأصوات (يُعرض في لوحة الإشعارات). */
const SOUND_TYPES = [
  { id: "approval", name: "موافقة مطلوبة", desc: "نغمتان صاعدتان حادّتان مكرّرتان 3 مرات — الأكثر إلحاحاً." },
  { id: "done", name: "انتهت المهمة", desc: "ثلاثية صاعدة هادئة (523→659→784)." },
  { id: "error", name: "فشل المهمة / خطأ نموذج", desc: "نزول منخفض بموجة sawtooth." },
  { id: "toolFail", name: "فشل أداة", desc: "نقرتان قصيرتان منخفضتان." },
  { id: "disconnected", name: "انقطاع الخادم", desc: "نبض منخفض متكرر 4 مرات." },
  { id: "reconnected", name: "عاد الاتصال", desc: "نغمة صاعدة ثم هادئة." },
  { id: "message", name: "رسالة جديدة", desc: "نقرة خفيفة جداً." },
  { id: "limit", name: "اقتراب الحد", desc: "نغمة تحذيرية متوسطة (الاستهلاك/السياق)." },
];

/**
 * بصمات صوتية مولّدة بـWebAudio (بلا ملفات صوت).
 * كل نغمة: { f: تردد، t: بداية (ث)، d: مدة، w: موجة، g: كسب نسبي، to: انزلاق ترددي }.
 */
const SOUND_PATTERNS = {
  approval: [0, 1, 2].flatMap((round) => {
    const base = round * 0.24;
    return [
      { f: 1046, t: base, d: 0.085, w: "square", g: 0.3 },
      { f: 1568, t: base + 0.1, d: 0.085, w: "square", g: 0.26 },
    ];
  }),
  done: [
    { f: 523, t: 0, d: 0.18, w: "sine", g: 0.48 },
    { f: 659, t: 0.15, d: 0.18, w: "sine", g: 0.46 },
    { f: 784, t: 0.3, d: 0.26, w: "sine", g: 0.4 },
  ],
  error: [
    { f: 330, t: 0, d: 0.18, w: "sawtooth", g: 0.34, to: 247 },
    { f: 247, t: 0.17, d: 0.2, w: "sawtooth", g: 0.32, to: 165 },
    { f: 165, t: 0.36, d: 0.3, w: "sawtooth", g: 0.3, to: 110 },
  ],
  toolFail: [
    { f: 220, t: 0, d: 0.07, w: "square", g: 0.26 },
    { f: 196, t: 0.11, d: 0.07, w: "square", g: 0.24 },
  ],
  disconnected: [0, 1, 2, 3].map((i) => ({ f: 196, t: i * 0.26, d: 0.13, w: "triangle", g: 0.32 })),
  reconnected: [
    { f: 523, t: 0, d: 0.2, w: "triangle", g: 0.36, to: 784 },
    { f: 659, t: 0.24, d: 0.26, w: "sine", g: 0.26, to: 587 },
  ],
  message: [{ f: 1175, t: 0, d: 0.045, w: "sine", g: 0.16 }],
  limit: [
    { f: 880, t: 0, d: 0.13, w: "triangle", g: 0.3 },
    { f: 660, t: 0.15, d: 0.18, w: "triangle", g: 0.28 },
  ],
};

/** محرّك الأصوات الموحّد: نصميم/توليد/كتم/مستوى + فتح AudioContext عند أول تفاعل. */
const SoundBus = {
  ctx: null,
  history: [],
  _retry: null,

  volume() {
    return Math.max(0, Math.min(100, Number(readNotifySettings().volume)));
  },

  setVolume(value) {
    const next = Math.max(0, Math.min(100, Number(value) || 0));
    patchNotifySettings({ volume: next });
    return next;
  },

  typeEnabled(id) {
    return readNotifySettings().types[id] !== false;
  },

  setTypeEnabled(id, enabled) {
    const settings = readNotifySettings();
    settings.types[id] = !!enabled;
    writeNotifySettings(settings);
  },

  /** يفتح/يستأنف AudioContext (سياسة المتصفح: يتطلب تفاعلاً). */
  unlock() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!SoundBus.ctx) SoundBus.ctx = new Ctx();
      if (SoundBus.ctx.state === "suspended") {
        SoundBus.ctx.resume().catch(() => {});
      }
      return SoundBus.ctx;
    } catch {
      return null;
    }
  },

  /** بصمة النوع (بيانات وصفية يستخدمها الاختبار والتشخيص). */
  plan(id) {
    return (SOUND_PATTERNS[id] || []).map((tone) => ({ ...tone }));
  },

  play(id) {
    if (!SOUND_PATTERNS[id]) return false;
    SoundBus.history.unshift({ id, t: Date.now() });
    SoundBus.history = SoundBus.history.slice(0, 40);
    if (!soundEnabled() || !SoundBus.typeEnabled(id)) return false;
    const volume = SoundBus.volume();
    if (volume <= 0) return false;
    const ctx = SoundBus.unlock();
    if (!ctx) return false;
    if (ctx.state === "suspended") {
      // إعادة محاولة تلقائية بعد أن يسمح المتصفح بالتشغيل.
      clearTimeout(SoundBus._retry);
      SoundBus._retry = setTimeout(() => SoundBus.play(id), 350);
      return false;
    }
    try {
      const master = (volume / 100) * 0.9;
      const now = ctx.currentTime + 0.02;
      for (const tone of SOUND_PATTERNS[id]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = tone.w || "sine";
        const t0 = now + (tone.t || 0);
        const dur = tone.d || 0.1;
        osc.frequency.setValueAtTime(tone.f, t0);
        if (tone.to) osc.frequency.exponentialRampToValueAtTime(Math.max(40, tone.to), t0 + dur);
        const peak = Math.max(0.0004, (tone.g ?? 0.3) * master);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.015, dur / 3));
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.03);
      }
      return true;
    } catch {
      return false;
    }
  },
};

/** فتح المحرّك عند أول تفاعل حقيقي (نقرة/لمسة/مفتاح). */
function unlockAudioOnce() {
  const ctx = SoundBus.unlock();
  if (ctx && ctx.state !== "suspended") {
    document.removeEventListener("pointerdown", unlockAudioOnce, true);
    document.removeEventListener("keydown", unlockAudioOnce, true);
  }
}
document.addEventListener("pointerdown", unlockAudioOnce, { capture: true, passive: true });
document.addEventListener("keydown", unlockAudioOnce, { capture: true });

/* --- إشعارات النظام --- */

function notifySupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

function notifyPermission() {
  if (!notifySupported()) return "unsupported";
  return Notification.permission;
}

/** نص جسم الإشعار الموحّد: الحالة · المدة · الوكيل/النموذج · مقتطف. */
function alertBody(status, snippet) {
  const parts = [status];
  const started = state.alert.startedAt || turnStartedAt || 0;
  if (started) {
    const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
    parts.push(seconds >= 60 ? `المدة ${formatClock(seconds)}` : `المدة ${seconds} ث`);
  }
  const model = state.alert.model || (state.current ? `${state.current.provider}/${state.current.model}` : "");
  const agent = state.alert.agent || agentDisplayName(state.current?.agent?.id || state.agent?.id || "");
  const who = [agent, model].filter(Boolean).join(" · ");
  if (who) parts.push(who);
  const text = String(snippet || state.alert.reply || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text) parts.push(text.length > 80 ? `${text.slice(0, 80)}…` : text);
  return parts.join(" · ");
}

/** إشعار نظام مع نقر يُركّز النافذة ويستدعي onClick. */
function systemNotify(kind, { title, body, tag, requireInteraction = false, onClick } = {}) {
  if (!notifySupported()) return null;
  if (Notification.permission !== "granted") {
    syncNotifyBar();
    return null;
  }
  try {
    const note = new Notification(title || L("مساعد Pi", "Pi assistant"), {
      body: body || "",
      tag: tag || `pi-${kind}`,
      renotify: !!tag,
      silent: true,
      requireInteraction: !!requireInteraction,
      dir: "rtl",
      lang: document.documentElement.lang || "ar",
      icon: "/favicon.svg",
    });
    note.onclick = () => {
      try {
        window.focus();
        onClick?.();
      } catch {
        /* المتصفح قد يمنع التركيز */
      }
      note.close();
    };
    return note;
  } catch {
    return null;
  }
}

async function requestNotifyPermission() {
  if (!notifySupported()) return "unsupported";
  if (Notification.permission !== "default") {
    syncNotifyBar();
    return Notification.permission;
  }
  try {
    localStorage.setItem(NOTIFY_EXPLAINED_KEY, "1");
  } catch {
    /* تجاهل */
  }
  try {
    const result = await Notification.requestPermission();
    syncNotifyBar();
    renderNotifyPermState();
    return result;
  } catch {
    syncNotifyBar();
    return Notification.permission;
  }
}

function syncNotifyBar() {
  if (!els.notifyBar) return;
  const denied = notifySupported() && Notification.permission === "denied";
  els.notifyBar.classList.toggle("hidden", !denied);
  els.notifyBtnDot?.classList.toggle("hidden", !denied);
}

function renderNotifyPermState() {
  if (!els.notifyPermState) return;
  const permission = notifyPermission();
  const label =
    permission === "granted"
      ? L("✅ الإشعارات مسموحة", "✅ Notifications allowed")
      : permission === "denied"
        ? L("⛔ الإشعارات مرفوضة — فعّلها من إعدادات المتصفح", "⛔ Notifications blocked — enable them in browser settings")
        : permission === "unsupported"
          ? L("⚠️ هذا المتصفح لا يدعم الإشعارات", "⚠️ This browser does not support notifications")
          : L("🔔 لم تُطلب الصلاحية بعد", "🔔 Permission not requested yet");
  els.notifyPermState.innerHTML = `<span>${escapeHtml(label)}</span>`;
  if (permission === "default" || permission === "denied") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "c3-mini-btn";
    btn.textContent = L("إعادة الطلب", "Request again");
    btn.addEventListener("click", () => {
      const dialog = els.notifyExplain;
      if (permission === "default" && dialog && typeof dialog.showModal === "function") dialog.showModal();
      else void requestNotifyPermission();
    });
    els.notifyPermState.appendChild(btn);
  }
}

/* --- مراقبة الاتصال وتشخيص السبب --- */

const CONN_REASONS = {
  "server-restart": {
    title: "الخادم يُعاد تشغيله",
    text: "أغلق الخادم الاتصال من جهته (إعادة تشغيل أو صيانة). سنعيد الاتصال تلقائياً.",
  },
  network: {
    title: "لا يوجد اتصال بالشبكة",
    text: "جهازك غير متصل بالإنترنت الآن. سنعيد المحاولة فور عودة الشبكة.",
  },
  auth: {
    title: "فشل التحقق من الجلسة",
    text: "رمز الدخول غير صالح أو منتهٍ. أعد تحميل الصفحة أو افتح الرابط الذي يحتوي token.",
  },
  timeout: {
    title: "لا ردّ من الخادم",
    text: "الخادم لم يستجب خلال 5 ثوانٍ. قد يكون مشغولاً أو متوقفاً.",
  },
  unknown: {
    title: "انقطع الاتصال بالخادم",
    text: "سبب غير معروف. سنعيد المحاولة تلقائياً.",
  },
};

const CONN_KIND_LABELS = {
  open: "اتصال مفتوح",
  close: "انقطاع",
  heartbeat: "نبضة /health",
  retry: "محاولة إعادة",
  recover: "استعادة",
  offline: "المتصفح offline",
  online: "المتصفح online",
};

function logConn(kind, { code = null, reason = "", detail = "" } = {}) {
  state.conn.history.unshift({ t: Date.now(), kind, code, reason, detail });
  state.conn.history = state.conn.history.slice(0, 20);
  renderConnHistory();
}

function connReasonMeta(reason) {
  return CONN_REASONS[reason] || CONN_REASONS.unknown;
}

/** تصنيف سبب الانقطاع من رمز إغلاق WS + حالة الشبكة. */
function classifyClose(code) {
  const numeric = Number(code);
  if ([1001, 1012, 1013].includes(numeric) || numeric === 1000) return "server-restart";
  if (numeric === 1008 || numeric === 4401 || numeric === 4403) return "auth";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "network";
  return "unknown";
}

function renderConnBanner() {
  const banner = els.connBanner;
  if (!banner) return;
  const down = state.conn.status === "down";
  banner.classList.toggle("hidden", !down);
  document.body.classList.toggle("conn-down", down);
  if (!down) {
    stopConnCountdown();
    return;
  }
  const meta = connReasonMeta(state.conn.reason);
  banner.dataset.reason = state.conn.reason || "unknown";
  if (els.connBannerTitle) els.connBannerTitle.textContent = meta.title;
  if (els.connBannerReason) {
    els.connBannerReason.textContent = state.conn.detail ? `${meta.text} (${state.conn.detail})` : meta.text;
  }
  updateConnCountdown();
}

function updateConnCountdown() {
  if (!els.connBannerCount) return;
  if (state.conn.status !== "down") {
    els.connBannerCount.textContent = "";
    return;
  }
  const left = state.conn.retryAt ? Math.max(0, Math.ceil((state.conn.retryAt - Date.now()) / 1000)) : 0;
  els.connBannerCount.textContent = state.conn.retryAt ? `إعادة المحاولة خلال ${left}s` : "جارٍ المحاولة…";
}

function stopConnCountdown() {
  if (state.conn.countdownTimer) {
    clearInterval(state.conn.countdownTimer);
    state.conn.countdownTimer = null;
  }
  if (els.connBannerCount) els.connBannerCount.textContent = "";
}

function startConnCountdown() {
  stopConnCountdown();
  updateConnCountdown();
  state.conn.countdownTimer = setInterval(updateConnCountdown, 500);
}

function clearRetryTimers() {
  if (state.conn.retryTimer) {
    clearTimeout(state.conn.retryTimer);
    state.conn.retryTimer = null;
  }
  state.conn.retryAt = 0;
  stopConnCountdown();
}

function renderConnHistory() {
  const targets = [els.notifyConnLog, els.connDiagLog].filter(Boolean);
  if (!targets.length) return;
  const rows = state.conn.history.length
    ? state.conn.history
        .map((entry) => {
          const time = new Date(entry.t).toLocaleTimeString("en-GB", { hour12: false });
          const kind = CONN_KIND_LABELS[entry.kind] || entry.kind;
          const code = entry.code ? `#${entry.code}` : "—";
          const reason = entry.reason ? connReasonMeta(entry.reason).title : entry.detail || "—";
          return `<tr><td dir="ltr">${escapeHtml(time)}</td><td>${escapeHtml(kind)}</td><td dir="ltr">${escapeHtml(code)}</td><td>${escapeHtml(reason)}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="4" class="c3-empty">لا أحداث بعد</td></tr>`;
  const table = `<table class="c3-table"><thead><tr><th>الوقت</th><th>الحدث</th><th>الرمز</th><th>السبب</th></tr></thead><tbody>${rows}</tbody></table>`;
  for (const node of targets) node.innerHTML = table;
  if (els.connDiagState) {
    const meta = connReasonMeta(state.conn.reason);
    els.connDiagState.innerHTML =
      state.conn.status === "down"
        ? `<b>⚠️ ${escapeHtml(meta.title)}</b> — ${escapeHtml(meta.text)} · آخر رمز إغلاق: <code dir="ltr">${escapeHtml(String(state.conn.lastCode || "—"))}</code> · محاولة إعادة الاتصال #${state.conn.attempt}`
        : `<b>✅ متصل</b> — النبضة الدورية كل 15 ثانية عبر <code dir="ltr">/health</code> · ${escapeHtml(String(state.conn.history.length))} حدث في السجل`;
  }
}

function latchApprovals() {
  const current = state.extUi.current;
  if (current) state.conn.latched.push(current);
  for (const request of state.extUi.queue) state.conn.latched.push(request);
  state.conn.latched = state.conn.latched.slice(-5);
}

function replayLatchedApprovals() {
  if (!state.conn.replayPending) return;
  state.conn.replayPending = false;
  const latched = state.conn.latched.splice(0);
  if (!latched.length) return;
  for (const request of latched) {
    request.replayed = true;
    state.extUi.queue.push(request);
  }
  showNextExtensionDialog();
  renderApprovalQueue();
  startTitleFlash();
  stickyToast(L("🔄 أُعيد عرض طلب موافقة معلّق بعد إعادة الاتصال.", "🔄 Pending approval restored after reconnect."));
}

function scheduleReconnect(delayOverride) {
  if (manualClose) return;
  clearRetryTimers();
  const delay = Number.isFinite(delayOverride) ? delayOverride : Math.min(1000 * 2 ** state.conn.attempt, 30000);
  state.conn.attempt += 1;
  state.reconnectDelay = delay;
  state.conn.retryAt = Date.now() + delay;
  logConn("retry", { detail: `خلال ${Math.round(delay / 1000)}s` });
  startConnCountdown();
  state.conn.retryTimer = setTimeout(async () => {
    state.conn.retryTimer = null;
    state.conn.retryAt = 0;
    if (manualClose) return;
    try {
      await loadConfig();
    } catch {
      /* تجاهل: نُكمل محاولة الاتصال */
    }
    connect();
  }, delay);
}

async function probeReason() {
  if (state.conn.status !== "down") return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch("/health", { cache: "no-store", signal: controller.signal });
    if (res.ok) {
      state.conn.fails = 0;
      if (state.ws?.readyState !== WebSocket.OPEN) connect();
      return;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch {
    const reason = typeof navigator !== "undefined" && navigator.onLine === false ? "network" : "timeout";
    if (state.conn.reason === "unknown") {
      state.conn.reason = reason;
      renderConnBanner();
    }
  } finally {
    clearTimeout(timer);
  }
}

/** انتقال إلى حالة «منقطع»: شريط + صوت + إشعار + إعادة محاولة بتراجع أسّي. */
function connDown(reason, { code = null, detail = "" } = {}) {
  const wasDown = state.conn.status === "down";
  state.conn.status = "down";
  state.conn.reason = reason;
  state.conn.detail = detail;
  state.conn.lastCode = code ?? state.conn.lastCode;
  logConn("close", { code, reason, detail });
  latchApprovals();
  renderConnBanner();
  if (!wasDown) {
    SoundBus.play("disconnected");
    systemNotify("disconnected", {
      title: L(`⚠️ ${connReasonMeta(reason).title}`, `⚠️ ${connReasonMeta(reason).title}`),
      body: alertBody(connReasonMeta(reason).title, state.alert.reply),
      tag: "pi-connection",
      requireInteraction: true,
      onClick: () => els.connBannerDiag?.click(),
    });
  }
  scheduleReconnect();
  if (reason === "unknown") setTimeout(probeReason, 800);
}

/** عودة الاتصال: صوت + إشعار + إعادة bind + إعادة عرض موافقة معلّقة. */
function connUp() {
  const wasDown = state.conn.status === "down";
  state.conn.status = "online";
  state.conn.reason = null;
  state.conn.detail = "";
  state.conn.fails = 0;
  state.conn.attempt = 0;
  clearRetryTimers();
  logConn("open");
  renderConnBanner();
  renderConnHistory();
  if (!wasDown) return;
  logConn("recover");
  SoundBus.play("reconnected");
  systemNotify("reconnected", {
    title: L("✅ عاد الاتصال بالخادم", "✅ Server connection restored"),
    body: alertBody(L("متصل من جديد", "Back online"), state.alert.reply),
    tag: "pi-connection",
  });
  state.conn.replayPending = state.conn.latched.length > 0;
  send({ type: "bind", conversationId: getConversationId() });
  send({ type: "list_sessions" });
  send({ type: "get_usage" });
}

/** نبضة دورية كل 15 ثانية مع مهلة 5 ثوانٍ؛ فشلان متتاليان ⇒ منقطع. */
async function heartbeat() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch("/health", { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.conn.fails = 0;
    if (state.conn.status === "down" && typeof navigator !== "undefined" && navigator.onLine !== false) {
      if (state.ws?.readyState !== WebSocket.OPEN) {
        clearRetryTimers();
        connect();
      }
    }
    return true;
  } catch (error) {
    state.conn.fails += 1;
    logConn("heartbeat", { reason: navigator.onLine === false ? "network" : "timeout", detail: error?.name || "فشل" });
    if (state.conn.fails >= 2 && state.conn.status !== "down") {
      connDown(navigator.onLine === false ? "network" : "timeout", { detail: "فشل نبضة /health" });
    } else if (state.conn.fails >= 2 && state.conn.status === "down") {
      renderConnBanner();
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startHeartbeat() {
  if (state.conn.hbTimer) return;
  state.conn.hbTimer = setInterval(() => void heartbeat(), 15000);
}

/* --- لوحة الإشعارات --- */

function renderNotifySoundList() {
  if (!els.notifySoundList) return;
  const master = SoundBus.volume();
  els.notifySoundList.innerHTML = SOUND_TYPES.map(
    (type) => `
    <div class="c3-sound" data-type="${type.id}">
      <label class="c3-sound-check">
        <input type="checkbox" data-type-toggle="${type.id}" ${SoundBus.typeEnabled(type.id) ? "checked" : ""} ${soundEnabled() ? "" : "disabled"} />
      </label>
      <div class="c3-sound-text">
        <strong>${escapeHtml(type.name)}</strong>
        <span>${escapeHtml(type.desc)}</span>
      </div>
      <button class="c3-mini-btn" type="button" data-test-sound="${type.id}" ${master > 0 && soundEnabled() ? "" : "disabled"}>تجربة</button>
    </div>`,
  ).join("");
  if (els.notifyMaster) {
    els.notifyMaster.checked = soundEnabled();
  }
  if (els.notifyVolume) els.notifyVolume.value = String(master);
  if (els.notifyVolumeLabel) els.notifyVolumeLabel.textContent = `مستوى الصوت: ${master}%`;
}

function openNotifyPanel() {
  renderNotifySoundList();
  renderNotifyPermState();
  renderConnHistory();
  const dialog = els.notifyPanel;
  if (!dialog) return;
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.classList.remove("hidden");
    dialog.setAttribute("open", "");
  }
}

function closeNotifyPanel() {
  const dialog = els.notifyPanel;
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    dialog.classList.add("hidden");
  }
}

function openConnDiag() {
  renderConnHistory();
  const dialog = els.connDiagDialog;
  if (!dialog) return;
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.classList.remove("hidden");
    dialog.setAttribute("open", "");
  }
}

let limitAlertedAt = 0;
/** تنبيه اقتراب الحد (الاستهلاك/السياق) بحد أقصى مرة كل 5 دقائق. */
function maybeLimitAlert(percent, label) {
  if (!Number.isFinite(percent) || percent < 90) return;
  if (Date.now() - limitAlertedAt < 5 * 60 * 1000) return;
  limitAlertedAt = Date.now();
  SoundBus.play("limit");
  systemNotify("limit", {
    title: L("🟠 اقتراب الحد", "🟠 Approaching limit"),
    body: alertBody(`${label} ${Math.round(percent)}%`, state.alert.reply),
    tag: "pi-limit",
  });
}

/** مقتطف آخر رد/خطأ لتضمينه في الإشعار. */
function noteAlertSnippet(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean) state.alert.reply = clean;
}

/* --- إدارة عنصر dialog الأصلي --- */

function openExtDialog() {
  const dialog = els.extUiDialog;
  if (!dialog) return;
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
    dialog.classList.remove("hidden");
  }
  const first = els.extUiBody?.querySelector(".ui-option, .ui-field input, .ui-field textarea, .ui-btn");
  if (first && typeof first.focus === "function") first.focus();
  renderApprovalQueue();
}

function closeExtDialog() {
  const dialog = els.extUiDialog;
  if (!dialog) return;
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  renderApprovalQueue();
}

/** إغلاق الواجهة فقط (بلا أي رد) — يبقى الطلب معلّقاً في الشريحة. */
function dismissExtensionDialog() {
  if (!state.extUi.current) return;
  closeExtDialog();
}

function renderApprovalQueue() {
  const box = els.approvalQueue;
  if (!box) return;
  const request = state.extUi.current;
  if (!request) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  const total = pendingApprovalCount();
  box.innerHTML = "";
  box.classList.remove("hidden");

  const text = document.createElement("span");
  text.className = "aq-text";
  text.dir = "auto";
  text.textContent = `⏳ ${L("بانتظار موافقة", "Awaiting approval")}: ${approvalSummary(request)}`;
  text.title = approvalSummary(request);
  box.appendChild(text);

  if (total > 1) {
    const count = document.createElement("span");
    count.className = "aq-count";
    count.textContent = `+${total - 1}`;
    count.title = L(`${total} طلبات معلّقة`, `${total} pending requests`);
    box.appendChild(count);
  }

  const visible = !!els.extUiDialog?.open;
  if (!visible) {
    if (request.method === "select" || request.method === "confirm") {
      state.extUi.options.slice(0, 3).forEach((label, index) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `aq-btn${index === 0 ? " primary" : ""}`;
        btn.textContent = label;
        btn.dir = "auto";
        btn.addEventListener("click", () => chooseExtensionOption(index));
        box.appendChild(btn);
      });
    }
    const show = document.createElement("button");
    show.type = "button";
    show.className = "aq-btn";
    show.textContent = L("عرض", "Show");
    show.addEventListener("click", openExtDialog);
    box.appendChild(show);
  }
}

/* --- شريط التقدّم وعدّاد المدة --- */

function setTurnProgress(next) {
  const bar = els.turnProgress;
  state.turnState = next;
  if (!bar) return;
  bar.dataset.state = next;
  bar.setAttribute("aria-hidden", next === "idle" ? "true" : "false");
}

function formatClock(totalSeconds) {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

let turnTimerHandle = null;
let turnStartedAt = 0;

function startTurnTimer() {
  if (!els.turnTimer || turnTimerHandle) return;
  turnStartedAt = Date.now();
  const tick = () => {
    els.turnTimer.textContent = formatClock(Math.floor((Date.now() - turnStartedAt) / 1000));
  };
  tick();
  els.turnTimer.classList.remove("hidden");
  turnTimerHandle = setInterval(tick, 1000);
}

function stopTurnTimer() {
  if (turnTimerHandle) {
    clearInterval(turnTimerHandle);
    turnTimerHandle = null;
  }
  if (els.turnTimer) {
    els.turnTimer.classList.add("hidden");
    els.turnTimer.textContent = "00:00";
  }
}

function syncSoundButton() {
  const btn = els.soundBtn;
  if (!btn) return;
  const on = soundEnabled();
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on ? L("نغمة التنبيه: مفعّلة", "Alert sound: on") : L("نغمة التنبيه: مكتومة", "Alert sound: muted");
  btn.setAttribute("aria-label", btn.title);
}

function handleExtensionUI(request) {
  if (!request || typeof request !== "object" || !request.method) return;
  switch (request.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      state.extUi.queue.push(request);
      showNextExtensionDialog();
      announceApproval(request);
      return;
    case "notify":
      toast(request.message || request.title || "", notifyToastKind(request.notifyType));
      return;
    case "setStatus":
      setExtensionStatus(request.statusKey, request.statusText);
      return;
    case "setWidget":
      setExtensionWidget(request.widgetKey, request.widgetLines, request.widgetPlacement);
      return;
    case "setTitle":
      if (request.title) document.title = String(request.title);
      return;
    case "set_editor_text":
      if (typeof request.text === "string") {
        els.input.value = request.text;
        autoResize();
        els.input.focus();
      }
      return;
    default:
      return;
  }
}

function setExtensionStatus(key, text) {
  const id = key || "default";
  if (text === null || text === undefined || text === "") state.extUi.statuses.delete(id);
  else state.extUi.statuses.set(id, String(text));
  renderExtensionStatus();
}

function renderExtensionStatus() {
  if (!els.editorStatus) return;
  const values = [...state.extUi.statuses.values()].filter(Boolean);
  els.editorStatus.textContent = values.join("  ·  ");
  els.editorStatus.classList.toggle("hidden", values.length === 0);
}

function setExtensionWidget(key, lines, placement) {
  const id = key || "default";
  if (!Array.isArray(lines) || lines.length === 0) state.extUi.widgets.delete(id);
  else
    state.extUi.widgets.set(id, {
      lines: lines.map((line) => String(line)),
      placement: placement === "belowEditor" ? "belowEditor" : "aboveEditor",
    });
  renderExtensionWidgets();
}

function renderExtensionWidgets() {
  if (!els.editorWidgets) return;
  els.editorWidgets.innerHTML = "";
  const collapsed = state.extUi.collapsedWidgets;
  const entries = [...state.extUi.widgets.entries()].sort((a, b) => {
    const rank = (entry) => (entry[1].placement === "belowEditor" ? 1 : 0);
    return rank(a) - rank(b);
  });
  for (const [key, widget] of entries) {
    const panel = document.createElement("div");
    panel.className = `ext-widget${collapsed.has(key) ? " collapsed" : ""}`;
    panel.dataset.key = key;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "ext-widget-head";
    head.setAttribute("aria-expanded", String(!collapsed.has(key)));
    const title = document.createElement("span");
    title.className = "ext-widget-title";
    title.dir = "auto";
    title.textContent = `🔧 ${key}`;
    const chevron = document.createElement("span");
    chevron.className = "ext-widget-chevron";
    chevron.textContent = "▾";
    head.append(title, chevron);
    head.addEventListener("click", () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      renderExtensionWidgets();
    });

    const body = document.createElement("div");
    body.className = "ext-widget-body";
    const pre = document.createElement("pre");
    pre.dir = "auto";
    pre.textContent = widget.lines.join("\n");
    body.appendChild(pre);

    panel.append(head, body);
    els.editorWidgets.appendChild(panel);
  }
}

function showNextExtensionDialog() {
  const ui = state.extUi;
  if (ui.current) return;
  const request = ui.queue.shift();
  if (!request) return;
  ui.current = request;
  ui.options = [];
  ui.activeIndex = 0;
  renderExtensionDialog(request);
}

function renderExtensionDialog(request) {
  const body = els.extUiBody;
  if (!body || !els.extUiDialog) return;
  body.innerHTML = "";
  els.extUiTitle.textContent = request.title || request.message || "طلب من إضافة";
  els.extUiDialog.dataset.method = request.method;
  els.extUiKeysHint.textContent =
    request.method === "editor" ? "Ctrl+Enter للحفظ · Esc للإلغاء" : EXT_UI_KEYBOARD_HINT;

  const addMessage = (text) => {
    if (!text) return;
    const p = document.createElement("p");
    p.className = "ext-ui-msg";
    p.dir = "auto";
    p.textContent = text;
    body.appendChild(p);
  };

  if (request.method === "select" || request.method === "confirm") {
    if (request.message && request.message !== request.title) addMessage(request.message);
    const options =
      request.method === "confirm"
        ? ["نعم", "لا"]
        : Array.isArray(request.options) && request.options.length
          ? request.options.map((value) => String(value))
          : ["موافق", "إلغاء"];
    state.extUi.options = options;
    const list = document.createElement("div");
    list.className = "ui-options";
    options.forEach((label, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `ui-option${index === 0 ? " active" : ""}`;
      btn.dataset.index = String(index);
      if (/رفض|إلغاء|لا\b|deny|cancel|reject|block/i.test(label)) btn.dataset.tone = "deny";
      const key = document.createElement("span");
      key.className = "ui-key";
      key.textContent = String(index + 1);
      const text = document.createElement("span");
      text.className = "ui-label";
      text.dir = "auto";
      text.textContent = label;
      btn.append(key, text);
      btn.addEventListener("click", () => chooseExtensionOption(index));
      btn.addEventListener("focus", () => {
        state.extUi.activeIndex = index;
        updateActiveExtensionOption();
      });
      list.appendChild(btn);
    });
    body.appendChild(list);
  } else {
    if (request.message) addMessage(request.message);
    const field = document.createElement("div");
    field.className = "ui-field";
    const input =
      request.method === "editor" ? document.createElement("textarea") : document.createElement("input");
    input.value = request.prefill || "";
    input.dir = "auto";
    if (request.method === "editor") input.rows = 10;
    else {
      input.type = "text";
      input.placeholder = request.placeholder || "";
    }
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (request.method === "editor" && !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      submitExtensionInput();
    });
    field.appendChild(input);
    body.appendChild(field);

    const actions = document.createElement("div");
    actions.className = "ui-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ui-btn primary";
    save.textContent = request.method === "editor" ? "حفظ" : "تأكيد";
    save.addEventListener("click", () => submitExtensionInput());
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ui-btn ghost";
    cancel.textContent = "إلغاء";
    cancel.addEventListener("click", () => cancelExtensionDialog());
    actions.append(save, cancel);
    body.appendChild(actions);

    setTimeout(() => input.focus(), 0);
  }

  startExtensionCountdown(request);
  openExtDialog();
  if (request.method === "select" || request.method === "confirm") {
    setTimeout(() => {
      const first = els.extUiBody?.querySelector(".ui-option");
      if (first) first.focus();
      else els.extUiDialog?.focus();
    }, 0);
  }
}

function startExtensionCountdown(request) {
  const ui = state.extUi;
  if (ui.countdown) {
    clearInterval(ui.countdown);
    ui.countdown = null;
  }
  if (els.extUiTimer) els.extUiTimer.textContent = "";
  const timeout = Number(request.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    els.extUiRingWrap?.classList.add("hidden");
    return;
  }
  els.extUiRingWrap?.classList.remove("hidden");
  const circumference = 2 * Math.PI * 15;
  const paintRing = (left) => {
    const ratio = Math.max(0, Math.min(1, left / timeout));
    if (els.extUiRing) els.extUiRing.style.strokeDashoffset = String(circumference * (1 - ratio));
    els.extUiRingWrap?.classList.toggle("is-urgent", left > 0 && left <= 5000);
  };
  ui.deadline = Date.now() + timeout;
  const tick = () => {
    const left = Math.max(0, ui.deadline - Date.now());
    if (els.extUiTimer) els.extUiTimer.textContent = left > 0 ? String(Math.ceil(left / 1000)) : "";
    paintRing(left);
    if (left > 0) return;
    // pi نفسه يحلّ الحوار عند المهلة؛ نغلق محلياً وننظّف التتبّع على الخادم فقط.
    const id = ui.current?.id;
    if (id) send({ type: "extension_ui_dismiss", id });
    finishExtensionDialog();
  };
  paintRing(timeout);
  tick();
  ui.countdown = setInterval(tick, 250);
}

function updateActiveExtensionOption() {
  const buttons = els.extUiBody?.querySelectorAll(".ui-option") || [];
  buttons.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.index) === state.extUi.activeIndex);
  });
}

function chooseExtensionOption(index) {
  const ui = state.extUi;
  const request = ui.current;
  if (!request) return;
  const position = Number(index);
  if (!Number.isFinite(position) || position < 0 || position >= ui.options.length) return;
  if (request.method === "confirm") {
    resolveExtensionDialog({ confirmed: position === 0 });
    return;
  }
  resolveExtensionDialog({ value: ui.options[position] });
}

function submitExtensionInput() {
  const request = state.extUi.current;
  if (!request || (request.method !== "input" && request.method !== "editor")) return;
  const field = els.extUiBody?.querySelector(".ui-field input, .ui-field textarea");
  resolveExtensionDialog({ value: field ? field.value : "" });
}

function cancelExtensionDialog() {
  if (!state.extUi.current) return;
  resolveExtensionDialog({ cancelled: true });
}

function resolveExtensionDialog(payload) {
  const request = state.extUi.current;
  if (!request) return;
  if (!request.expectsResponse) {
    finishExtensionDialog();
    return;
  }
  send({ type: "extension_ui_response", id: request.id, ...payload });
  finishExtensionDialog();
}

function finishExtensionDialog() {
  const ui = state.extUi;
  if (ui.countdown) {
    clearInterval(ui.countdown);
    ui.countdown = null;
  }
  ui.current = null;
  ui.options = [];
  ui.activeIndex = 0;
  ui.deadline = 0;
  if (els.extUiTimer) els.extUiTimer.textContent = "";
  els.extUiRingWrap?.classList.add("hidden");
  closeExtDialog();
  setTimeout(() => {
    showNextExtensionDialog();
    renderApprovalQueue();
    if (!state.extUi.current) stopTitleFlash();
    else startTitleFlash();
  }, 60);
}

function onExtensionDialogKeydown(event) {
  if (!extensionUiDialogOpen()) return;
  const request = state.extUi.current;
  if (!request) return;
  const target = event.target;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelExtensionDialog();
    return;
  }

  if (event.key === "Enter") {
    if (request.method === "editor") {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        submitExtensionInput();
      }
      return; // Enter عادي = سطر جديد داخل المحرر
    }
    event.preventDefault();
    event.stopPropagation();
    if (request.method === "input") submitExtensionInput();
    else chooseExtensionOption(state.extUi.activeIndex);
    return;
  }

  if (!typing && /^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1;
    if (index < state.extUi.options.length) {
      event.preventDefault();
      event.stopPropagation();
      chooseExtensionOption(index);
    }
    return;
  }

  if (!typing && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    if (!state.extUi.options.length) return;
    event.preventDefault();
    event.stopPropagation();
    const total = state.extUi.options.length;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    state.extUi.activeIndex = (state.extUi.activeIndex + delta + total) % total;
    updateActiveExtensionOption();
  }
}

/* ===== B1: تمرير RPC عام (رسالة rpc/rpc_result/rpc_error) ===== */

let rpcSeq = 0;
const rpcPending = new Map();

/**
 * يرسل أمر RPC مسموحاً عبر WS وينتظر رده. لا يستخدمه أي مسار قديم،
 * لذلك تعطّله لا يؤثر على المحادثة العادية.
 */
function rpcCall(command, data = {}, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      reject(new Error("غير متصل بالخادم"));
      return;
    }
    const id = `ui-rpc-${++rpcSeq}`;
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`انتهت مهلة الأمر ${command}`));
    }, timeoutMs);
    rpcPending.set(id, { resolve, reject, timer });
    try {
      state.ws.send(JSON.stringify({ type: "rpc", id, command, data }));
    } catch (err) {
      rpcPending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function rejectPendingRpc(message) {
  for (const [id, pending] of rpcPending) {
    clearTimeout(pending.timer);
    rpcPending.delete(id);
    pending.reject(new Error(message));
  }
}

/* ========================================================================
 * B3: لوحة أوامر /
 * محلية: /model /thinking /new /compact /stop /approvals
 * خادمية: get_commands (أوامر إضافات + مهارات /skill:name + قوالب)
 * ======================================================================== */

const LOCAL_COMMANDS = [
  { name: "model", description: "تغيير النموذج الحالي (من قائمة النموذج بالأعلى)", source: "local", icon: "🧩" },
  { name: "thinking", description: "تغيير مستوى التفكير", source: "local", icon: "🧠" },
  { name: "new", description: "بدء جلسة جديدة في هذا التبويب", source: "local", icon: "✨" },
  { name: "compact", description: "ضغط السياق — أضف تعليمات بعد الأمر إن أردت", source: "local", icon: "🗜️", insert: true },
  { name: "stop", description: "إيقاف التوليد الحالي", source: "local", icon: "■" },
  { name: "approvals", description: "عرض وحذف قواعد موافقة الأدوات المحفوظة", source: "local", icon: "🔐" },
];

function isLocalCommand(name) {
  return LOCAL_COMMANDS.some((command) => command.name === name);
}

function commandGroup(command) {
  if (command.source === "skill") return "skill";
  if (command.source === "prompt") return "prompt";
  return "system";
}

function commandPool() {
  const locals = LOCAL_COMMANDS;
  const localNames = new Set(locals.map((command) => command.name));
  return [...locals, ...state.commands.items.filter((command) => !localNames.has(command.name))];
}

function filterCommands(query) {
  const q = String(query || "").trim().toLowerCase();
  return commandPool()
    .filter((command) => {
      if (!q) return true;
      const haystack = `${command.name} ${command.description || ""}`.toLowerCase();
      return haystack.includes(q);
    })
    .slice(0, 80);
}

async function loadCommands(force = false) {
  const cmds = state.commands;
  if (cmds.loading) return;
  if (cmds.loaded && !force) return;
  cmds.loading = true;
  cmds.error = null;
  renderCommandPanel();
  try {
    const data = await rpcCall("get_commands", {}, { timeoutMs: 60_000 });
    const list = Array.isArray(data?.commands) ? data.commands : [];
    cmds.items = list
      .map((command) => ({
        name: String(command?.name || "").trim(),
        description: String(command?.description || "").trim(),
        source: command?.source === "skill" ? "skill" : command?.source === "prompt" ? "prompt" : "extension",
        sourceInfo: command?.sourceInfo || null,
      }))
      .filter((command) => command.name);
    cmds.loaded = true;
  } catch (err) {
    cmds.error = err?.message || String(err);
    cmds.loaded = false;
  } finally {
    cmds.loading = false;
    if (cmds.open) renderCommandPanel();
  }
}

function slashToken() {
  const el = els.input;
  if (!el) return null;
  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret);
  const match = /^\/([^\s]*)$/.exec(before);
  if (!match) return null;
  return { query: match[1], caret };
}

function openCommandPanel() {
  state.commands.open = true;
  state.commands.query = slashToken()?.query ?? "";
  state.commands.index = 0;
  renderCommandPanel();
  void loadCommands();
}

function closeCommandPanel() {
  const cmds = state.commands;
  cmds.open = false;
  cmds.filtered = [];
  cmds.index = 0;
  if (els.cmdPanel) {
    els.cmdPanel.classList.add("hidden");
    els.cmdPanel.replaceChildren();
  }
}

function syncCommandPanel() {
  const token = slashToken();
  if (!token) {
    if (state.commands.open) closeCommandPanel();
    return;
  }
  const cmds = state.commands;
  if (!cmds.open || cmds.query !== token.query) cmds.index = 0;
  cmds.open = true;
  cmds.query = token.query;
  renderCommandPanel();
  void loadCommands();
}

function commandRow(command, index) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `cmd-item${index === state.commands.index ? " active" : ""}`;
  row.dataset.index = String(index);
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", index === state.commands.index ? "true" : "false");

  const icon = document.createElement("span");
  icon.className = "cmd-icon";
  icon.textContent =
    command.icon ||
    (command.source === "skill" ? "🧠" : command.source === "prompt" ? "📄" : command.source === "local" ? "⚙️" : "🧱");

  const main = document.createElement("span");
  main.className = "cmd-main";
  const name = document.createElement("span");
  name.className = "cmd-name";
  name.dir = "ltr";
  name.textContent = `/${command.name}`;
  main.appendChild(name);
  if (command.description) {
    const description = document.createElement("span");
    description.className = "cmd-desc";
    description.dir = "auto";
    description.textContent = command.description;
    main.appendChild(description);
  }

  const hint = document.createElement("span");
  hint.className = "cmd-hint";
  hint.textContent = command.source === "local" ? "محلي" : command.source === "skill" ? "مهارة" : command.source === "prompt" ? "قالب" : "إضافة";

  row.append(icon, main, hint);
  row.addEventListener("mousedown", (event) => {
    event.preventDefault();
    chooseCommand(index);
  });
  return row;
}

function renderCommandPanel() {
  const panel = els.cmdPanel;
  if (!panel) return;
  const cmds = state.commands;
  if (!cmds.open) {
    panel.classList.add("hidden");
    panel.replaceChildren();
    return;
  }

  const filtered = filterCommands(cmds.query);
  cmds.filtered = filtered;
  if (cmds.index >= filtered.length) cmds.index = Math.max(0, filtered.length - 1);

  panel.replaceChildren();

  const head = document.createElement("div");
  head.className = "cmd-head";
  const title = document.createElement("span");
  title.textContent = cmds.query ? `أوامر تطابق «${cmds.query}»` : "الأوامر المتاحة";
  const keys = document.createElement("span");
  keys.className = "cmd-keys";
  keys.textContent = "↑↓ تنقّل · Enter اختيار · Esc إغلاق";
  head.append(title, keys);
  panel.appendChild(head);

  const groupLabels = [
    ["system", "⚙️ أوامر النظام"],
    ["skill", "🧠 مهارات /skill:name"],
    ["prompt", "📄 قوالب الأوامر"],
  ];

  let rowIndex = 0;
  for (const [group, label] of groupLabels) {
    const items = filtered.filter((command) => commandGroup(command) === group);
    if (!items.length) continue;
    const groupHead = document.createElement("div");
    groupHead.className = "cmd-group";
    groupHead.textContent = label;
    panel.appendChild(groupHead);
    for (const command of items) {
      panel.appendChild(commandRow(command, rowIndex));
      rowIndex += 1;
    }
  }

  if (!filtered.length && !cmds.loading) {
    const empty = document.createElement("div");
    empty.className = "cmd-empty";
    empty.textContent = cmds.error ? `⚠️ ${cmds.error}` : "لا توجد أوامر مطابقة.";
    panel.appendChild(empty);
  }
  if (cmds.loading) {
    const loading = document.createElement("div");
    loading.className = "cmd-empty";
    loading.textContent = "⏳ جارٍ تحميل أوامر pi (الإضافات والمهارات والقوالب)…";
    panel.appendChild(loading);
  } else if (cmds.error && filtered.length) {
    const error = document.createElement("div");
    error.className = "cmd-empty";
    error.textContent = `⚠️ ${cmds.error}`;
    panel.appendChild(error);
  }

  panel.classList.remove("hidden");
  panel.querySelector(".cmd-item.active")?.scrollIntoView?.({ block: "nearest" });
}

function chooseCommand(index) {
  const cmds = state.commands;
  const command = cmds.filtered[index];
  if (!command) return;
  const el = els.input;
  const token = slashToken();
  const rest = token ? el.value.slice(token.caret) : "";

  // الأوامر التي تقبل وسائط (مثل /compact تعليمات) تبقى في المحرر.
  if (command.insert) {
    el.value = `/${command.name} ${rest}`;
    const caret = command.name.length + 2;
    el.focus();
    el.setSelectionRange(caret, caret);
    autoResize();
    saveActiveDraft();
    persistTabs();
    closeCommandPanel();
    return;
  }

  if (command.source === "local") {
    if (token) {
      el.value = rest;
      autoResize();
    }
    saveActiveDraft();
    closeCommandPanel();
    closePathMenu();
    runLocalCommand(command.name, "");
    return;
  }

  el.value = `/${command.name} ${rest}`;
  const caret = command.name.length + 2;
  el.focus();
  el.setSelectionRange(caret, caret);
  autoResize();
  saveActiveDraft();
  persistTabs();
  closeCommandPanel();
}

function handleCommandKey(event) {
  const cmds = state.commands;
  if (!cmds.open) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!cmds.filtered.length) return false;
    event.preventDefault();
    const total = cmds.filtered.length;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    cmds.index = (cmds.index + delta + total) % total;
    renderCommandPanel();
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    if (cmds.filtered.length) chooseCommand(cmds.index);
    else closeCommandPanel();
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeCommandPanel();
    return true;
  }
  return false;
}

function runLocalCommand(name, args = "") {
  switch (name) {
    case "new":
      send({ type: "new_session" });
      break;
    case "stop":
      send({ type: "abort" });
      break;
    case "compact":
      if (args.trim()) void compactWithInstructions(args.trim());
      else send({ type: "compact" });
      break;
    case "model":
      els.modelSelect?.focus();
      toast("اختر النموذج من قائمة «النموذج» أعلى الصفحة.", "success");
      break;
    case "thinking":
      els.thinkingSelect?.focus();
      toast("اختر مستوى التفكير من القائمة العلوية.", "success");
      break;
    case "approvals":
      void openApprovals();
      break;
    default:
      break;
  }
}

/** /compact مع تعليمات: تُمرَّر عبر RPC الجديد بحقل customInstructions. */
async function compactWithInstructions(instructions) {
  addNotice("🗜️ جارٍ ضغط السياق بالتعليمات المخصّصة…");
  try {
    const result = await rpcCall("compact", { customInstructions: instructions }, { timeoutMs: 10 * 60_000 });
    const before = Number(result?.tokensBefore);
    const after = Number(result?.estimatedTokensAfter);
    const detail = Number.isFinite(before) && Number.isFinite(after) ? ` (${fmtCompact(before)} ← ${fmtCompact(after)})` : "";
    addNotice(`✅ تم ضغط السياق${detail}`);
  } catch (err) {
    addErrorMessage(err?.message || "تعذّر ضغط السياق");
  }
}

/* ===== C2/B3: إدارة قواعد الموافقة المحفوظة ===== */

async function openApprovals() {
  if (!els.approvalsModal) return;
  els.approvalsModal.classList.remove("hidden");
  els.approvalsBody.innerHTML = `<div class="cc-empty">⏳ جارٍ تحميل القواعد…</div>`;
  await refreshApprovals();
}

function closeApprovals() {
  els.approvalsModal?.classList.add("hidden");
}

async function refreshApprovals() {
  const body = els.approvalsBody;
  if (!body) return;
  try {
    const data = await apiFetch("/api/approvals");
    const rules = Array.isArray(data?.rules) ? data.rules : [];
    body.replaceChildren();

    const note = document.createElement("p");
    note.className = "approvals-note";
    note.dir = "auto";
    note.textContent = rules.length
      ? "هذه القواعد تُطبَّق تلقائياً في كل جلسة جديدة. حذف القاعدة يعيد السؤال عند الاستخدام التالي."
      : "لا توجد قواعد محفوظة بعد. ستظهر هنا عند اختيار «سماح دائماً» في حوار الموافقة.";
    body.appendChild(note);

    if (rules.length) {
      const list = document.createElement("div");
      list.className = "approvals-list";
      for (const rule of rules) {
        const row = document.createElement("div");
        row.className = "approvals-row";
        const info = document.createElement("div");
        info.className = "approvals-info";
        const tool = document.createElement("b");
        tool.dir = "ltr";
        tool.textContent = rule.tool;
        const pattern = document.createElement("code");
        pattern.dir = "ltr";
        pattern.textContent = rule.pattern === "*" ? "* (كل الأوامر)" : rule.pattern;
        info.append(tool, pattern);
        if (rule.createdAt) {
          const when = document.createElement("small");
          when.textContent = fmtDate(rule.createdAt);
          info.appendChild(when);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn";
        remove.textContent = "حذف";
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try {
            await apiFetch("/api/approvals", {
              method: "DELETE",
              body: { tool: rule.tool, pattern: rule.pattern },
            });
            toast("تم حذف القاعدة.", "success");
            await refreshApprovals();
          } catch (err) {
            remove.disabled = false;
            toast(err?.message || "تعذّر حذف القاعدة", "error");
          }
        });
        row.append(info, remove);
        list.appendChild(row);
      }
      body.appendChild(list);

      const actions = document.createElement("div");
      actions.className = "approvals-actions";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "btn danger";
      clear.textContent = "🗑️ حذف كل القواعد";
      clear.addEventListener("click", async () => {
        if (!window.confirm("حذف كل قواعد الموافقة المحفوظة؟")) return;
        clear.disabled = true;
        try {
          await apiFetch("/api/approvals", { method: "DELETE", body: {} });
          toast("تم حذف كل القواعد.", "success");
          await refreshApprovals();
        } catch (err) {
          clear.disabled = false;
          toast(err?.message || "تعذّر حذف القواعد", "error");
        }
      });
      actions.appendChild(clear);
      body.appendChild(actions);
    }

    const path = document.createElement("small");
    path.className = "approvals-path";
    path.dir = "ltr";
    path.textContent = data?.path || "";
    body.appendChild(path);
  } catch (err) {
    body.innerHTML = `<div class="cc-empty">⚠️ ${escapeHtml(err?.message || "تعذّر تحميل القواعد")}</div>`;
  }
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
    connUp();
    startHeartbeat();
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
  ws.addEventListener("close", (evt) => {
    setConnected(false);
    rejectPendingRpc("انقطع الاتصال بالخادم");
    closeCommandPanel();
    // الخادم يلغي حوارات هذا الاتصال عند الانقطاع؛ نحفظ نسخة لعرضها بعد العودة.
    resetExtensionUI();
    if (manualClose) return;
    connDown(classifyClose(evt?.code), {
      code: evt?.code ?? 1006,
      detail: evt?.reason || `رمز إغلاق ${evt?.code ?? 1006}`,
    });
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

let submitting = false;

function submitPrompt() {
  const text = els.input.value.trim();
  const items = [...state.attachments.items];
  if (submitting || (!text && !items.length)) return;

  // B3: أوامر محلية (/new /stop /compact …) تُنفَّذ عبر مساراتها الحالية.
  if (!items.length && text.startsWith("/")) {
    const match = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (match && isLocalCommand(match[1])) {
      const name = match[1];
      const args = (match[2] || "").trim();
      els.input.value = "";
      saveActiveDraft();
      autoResize();
      closeCommandPanel();
      closePathMenu();
      runLocalCommand(name, args);
      return;
    }
  }

  if (!items.length) {
    if (!send({ type: "prompt", text })) return;
    els.input.value = "";
    saveActiveDraft();
    persistTabs();
    closePathMenu();
    closeCommandPanel();
    autoResize();
    setStreaming(true);
    return;
  }
  void submitWithAttachments(text, items);
}

/* ===== B2: المرفقات (رفع ثم إرسال) ===== */

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} كB`;
  return `${(n / (1024 * 1024)).toFixed(1)} مB`;
}

function apiUrl(path) {
  const token = getToken();
  if (!token) return path;
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function fileKind(file) {
  return IMAGE_MIMES.has(String(file?.type || "").toLowerCase()) ? "image" : "file";
}

function addFiles(list) {
  const incoming = Array.from(list || []);
  if (!incoming.length) return;
  let total = state.attachments.items.reduce((sum, item) => sum + item.size, 0);
  for (const file of incoming) {
    if (!file || !file.size) continue;
    if (state.attachments.items.length >= MAX_ATTACHMENTS) {
      toast(`الحد الأقصى ${MAX_ATTACHMENTS} مرفقاً`, "error");
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast(`الملف «${file.name}» أكبر من 25MB`, "error");
      continue;
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      toast("مجموع حجم المرفقات يتجاوز 40MB", "error");
      break;
    }
    total += file.size;
    const kind = fileKind(file);
    state.attachments.items.push({
      id: ++state.attachments.seq,
      file,
      name: file.name || (kind === "image" ? "صورة" : "ملف"),
      size: file.size,
      mime: String(file.type || ""),
      kind,
      preview: kind === "image" ? URL.createObjectURL(file) : null,
    });
  }
  renderAttachments();
  autoResize();
}

function renderAttachments() {
  const box = els.attachChips;
  if (!box) return;
  const items = state.attachments.items;
  box.classList.toggle("hidden", items.length === 0);
  els.attachBtn?.classList.toggle("has-items", items.length > 0);
  box.replaceChildren();
  for (const item of items) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.dataset.id = String(item.id);
    chip.title = `${item.name} · ${humanSize(item.size)}`;
    if (item.preview) {
      const img = document.createElement("img");
      img.className = "attach-thumb";
      img.src = item.preview;
      img.alt = item.name;
      chip.appendChild(img);
    } else {
      const ico = document.createElement("span");
      ico.className = "attach-ico";
      ico.textContent = "📄";
      chip.appendChild(ico);
    }
    const meta = document.createElement("span");
    meta.className = "attach-meta";
    const nameEl = document.createElement("b");
    nameEl.dir = "auto";
    nameEl.textContent = item.name;
    const sizeEl = document.createElement("i");
    sizeEl.textContent = humanSize(item.size);
    meta.append(nameEl, sizeEl);
    chip.appendChild(meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attach-remove";
    remove.title = "إزالة";
    remove.setAttribute("aria-label", `إزالة ${item.name}`);
    remove.textContent = "✕";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeAttachment(item.id);
    });
    chip.appendChild(remove);
    box.appendChild(chip);
  }
}

function removeAttachment(id) {
  const index = state.attachments.items.findIndex((item) => item.id === id);
  if (index === -1) return;
  const [item] = state.attachments.items.splice(index, 1);
  if (item?.preview) URL.revokeObjectURL(item.preview);
  renderAttachments();
}

function clearAttachments() {
  for (const item of state.attachments.items) {
    if (item.preview) URL.revokeObjectURL(item.preview);
  }
  state.attachments.items = [];
  renderAttachments();
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("تعذّر قراءة الملف"));
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(items) {
  const form = new FormData();
  for (const item of items) form.append("files", item.file, item.name);
  const res = await fetch(apiUrl("/api/upload"), { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `تعذّر رفع المرفقات (${res.status})`);
  return Array.isArray(data.files) ? data.files : [];
}

async function submitWithAttachments(text, items) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    toast("غير متصل بالخادم", "error");
    return;
  }
  submitting = true;
  state.attachments.uploading = true;
  els.sendBtn.disabled = true;
  els.composerHint.textContent = "⏳ جارٍ رفع المرفقات…";
  try {
    const uploaded = await uploadFiles(items);
    const images = [];
    const attachments = [];
    for (let index = 0; index < uploaded.length; index += 1) {
      const file = uploaded[index];
      const item = items[index];
      attachments.push({ path: file.path, name: file.name, mime: file.mime || item?.mime || "" });
      if (file.kind === "image" && item?.file) {
        images.push({ data: await readBase64(item.file), mimeType: file.mime });
      }
    }
    const message = { type: "prompt", text };
    if (images.length) message.images = images;
    if (attachments.length) message.attachments = attachments;
    if (!send(message)) return;
    els.input.value = "";
    saveActiveDraft();
    persistTabs();
    closePathMenu();
    closeCommandPanel();
    clearAttachments();
    autoResize();
    setStreaming(true);
  } catch (err) {
    toast(err?.message || "تعذّر رفع المرفقات", "error");
  } finally {
    submitting = false;
    state.attachments.uploading = false;
    els.sendBtn.disabled = false;
    if (!state.streaming) setStreaming(false);
  }
}

/* ===== B2: إكمال المسارات بـ @ ===== */

function fileIcon(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext)) return "🖼️";
  if (["js", "mjs", "ts", "tsx", "jsx", "py", "rs", "go", "sh"].includes(ext)) return "⌨️";
  if (["json", "yaml", "yml", "toml", "env"].includes(ext)) return "⚙️";
  if (["md", "txt", "log", "csv"].includes(ext)) return "📃";
  return "📄";
}

function closePathMenu() {
  state.paths.open = false;
  state.paths.items = [];
  state.paths.index = 0;
  // إبطال أي رد قادم من طلب إكمال سابق حتى لا يُعيد فتح القائمة.
  state.paths.request += 1;
  if (state.paths.timer) {
    clearTimeout(state.paths.timer);
    state.paths.timer = null;
  }
  if (els.pathMenu) {
    els.pathMenu.classList.add("hidden");
    els.pathMenu.replaceChildren();
  }
}

function tokenAtCaret() {
  const el = els.input;
  if (!el) return null;
  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret);
  const match = /(^|[\s(\[{])@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2];
  return { start: caret - query.length - 1, end: caret, query };
}

function updatePathCompletion() {
  const token = tokenAtCaret();
  if (!token) {
    closePathMenu();
    return;
  }
  if (state.paths.timer) clearTimeout(state.paths.timer);
  const requestId = ++state.paths.request;
  state.paths.timer = setTimeout(async () => {
    state.paths.timer = null;
    try {
      const res = await fetch(apiUrl(`/api/files?q=${encodeURIComponent(token.query)}&limit=20`));
      const data = await res.json().catch(() => ({}));
      if (requestId !== state.paths.request) return;
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        closePathMenu();
        return;
      }
      state.paths.open = true;
      state.paths.items = items;
      state.paths.index = 0;
      state.paths.start = token.start;
      state.paths.end = token.end;
      renderPathMenu();
    } catch {
      closePathMenu();
    }
  }, 120);
}

function renderPathMenu() {
  const box = els.pathMenu;
  if (!box) return;
  box.replaceChildren();
  state.paths.items.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `path-item${index === state.paths.index ? " active" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === state.paths.index ? "true" : "false");
    const ico = document.createElement("span");
    ico.className = "path-ico";
    ico.textContent = item.type === "dir" ? "📁" : fileIcon(item.name);
    const label = document.createElement("span");
    label.className = "path-name";
    label.dir = "auto";
    label.textContent = item.path;
    row.append(ico, label);
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      insertPath(index);
    });
    box.appendChild(row);
  });
  box.classList.remove("hidden");
  box.children[state.paths.index]?.scrollIntoView?.({ block: "nearest" });
}

function movePathSelection(delta) {
  const total = state.paths.items.length;
  if (!total) return;
  state.paths.index = (state.paths.index + delta + total) % total;
  renderPathMenu();
}

function insertPath(index) {
  const item = state.paths.items[index ?? state.paths.index];
  if (!item) return;
  const el = els.input;
  const start = state.paths.start;
  const end = state.paths.end;
  const isDir = item.type === "dir";
  const insertion = `@${item.path}${isDir ? "" : " "}`;
  el.value = el.value.slice(0, start) + insertion + el.value.slice(end);
  const caret = start + insertion.length;
  el.focus();
  el.setSelectionRange(caret, caret);
  autoResize();
  if (isDir) updatePathCompletion();
  else closePathMenu();
}

function handlePathKey(event) {
  if (!state.paths.open) return false;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    movePathSelection(1);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    movePathSelection(-1);
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    insertPath();
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePathMenu();
    return true;
  }
  return false;
}

/* ===== تفاعلات الواجهة ===== */

function autoResize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

function bindUi() {
  els.sendBtn.addEventListener("click", submitPrompt);
  els.stopBtn.addEventListener("click", () => send({ type: "abort" }));
  els.input.addEventListener("input", () => {
    autoResize();
    saveActiveDraft();
    persistTabs();
    syncCommandPanel();
    if (!state.commands.open) updatePathCompletion();
  });
  els.input.addEventListener("keydown", (e) => {
    if (handleCommandKey(e)) return;
    if (handlePathKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitPrompt();
    }
  });
  els.input.addEventListener("blur", () => {
    // إغلاق القوائم بعد فوات حدث النقر (mousedown يمنع فقد التركيز أصلاً).
    setTimeout(() => {
      closePathMenu();
      if (state.commands.open) closeCommandPanel();
    }, 120);
  });

  // B2: الإرفاق (زر + سحب وإفلات + لصق صورة)
  els.attachBtn?.addEventListener("click", () => els.fileInput?.click());
  els.fileInput?.addEventListener("change", () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = "";
  });
  els.input.addEventListener("paste", (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });

  let dragDepth = 0;
  const showDrop = (on) => els.dropOverlay?.classList.toggle("hidden", !on);
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  document.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    showDrop(true);
  });
  document.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showDrop(false);
  });
  document.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    showDrop(false);
    addFiles(event.dataTransfer?.files);
    els.input?.focus();
  });
  document.addEventListener("mousedown", (event) => {
    if (state.commands.open && !els.cmdPanel?.contains(event.target) && !els.input?.contains(event.target)) {
      closeCommandPanel();
    }
    if (!state.paths.open) return;
    if (els.pathMenu?.contains(event.target) || els.input?.contains(event.target)) return;
    closePathMenu();
  });

  els.newSessionBtn.addEventListener("click", () => {
    // B1: «محادثة جديدة» تفتح تبويباً مستقلاً؛ الجلسة المشتركة مع تيليجرام تبقى كما هي.
    addTab();
    els.sidebar.classList.remove("open");
  });

  els.newTabBtn?.addEventListener("click", () => addTab());

  els.slashBtn?.addEventListener("click", () => {
    const el = els.input;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    if (!el.value.startsWith("/")) {
      el.value = `/${el.value}`;
      el.setSelectionRange(caret + 1, caret + 1);
    }
    el.focus();
    autoResize();
    saveActiveDraft();
    syncCommandPanel();
  });

  els.approvalsClose?.addEventListener("click", closeApprovals);
  els.approvalsModal?.addEventListener("click", (event) => {
    if (event.target === els.approvalsModal) closeApprovals();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.approvalsModal && !els.approvalsModal.classList.contains("hidden")) {
      closeApprovals();
      return;
    }
    // Alt+T = تبويب جديد (لا يتعارض مع الكتابة داخل المحرر).
    if (event.altKey && (event.key === "t" || event.key === "T")) {
      event.preventDefault();
      addTab();
    }
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

  // C1: حوار الامتدادات — Esc/Enter/الأرقام + زر الإغلاق.
  els.extUiDialog?.addEventListener("keydown", onExtensionDialogKeydown);
  els.extUiClose?.addEventListener("click", () => cancelExtensionDialog());
  els.extUiLater?.addEventListener("click", dismissExtensionDialog);
  // Esc الأصلي: نمنع الإغلاق التلقائي ونمرّره إلى مسار الإلغاء الموحّد.
  els.extUiDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelExtensionDialog();
  });
  // النقر على ::backdrop يغلق الواجهة فقط ويُبقي الطلب معلّقاً في الشريحة.
  els.extUiDialog?.addEventListener("click", (event) => {
    if (event.target === els.extUiDialog) dismissExtensionDialog();
  });

  if (els.soundBtn) {
    syncSoundButton();
    els.soundBtn.addEventListener("click", () => {
      setSoundEnabled(!soundEnabled());
      syncSoundButton();
      if (els.notifyMaster) els.notifyMaster.checked = soundEnabled();
      renderNotifySoundList();
      if (soundEnabled()) SoundBus.play("message");
    });
  }

  /* --- C3: لوحة الإشعارات + شريط الانقطاع + مراقبة الاتصال --- */
  els.notifyBtn?.addEventListener("click", openNotifyPanel);
  els.notifyPanelClose?.addEventListener("click", closeNotifyPanel);
  els.notifyPanel?.addEventListener("click", (event) => {
    if (event.target === els.notifyPanel) closeNotifyPanel();
  });
  els.notifyMaster?.addEventListener("change", () => {
    setSoundEnabled(!!els.notifyMaster.checked);
    syncSoundButton();
    renderNotifySoundList();
  });
  els.notifyVolume?.addEventListener("input", () => {
    const value = SoundBus.setVolume(els.notifyVolume.value);
    if (els.notifyVolumeLabel) els.notifyVolumeLabel.textContent = `مستوى الصوت: ${value}%`;
  });
  els.notifySoundList?.addEventListener("click", (event) => {
    const testBtn = event.target.closest("[data-test-sound]");
    if (!testBtn) return;
    SoundBus.play(testBtn.dataset.testSound);
  });
  els.notifySoundList?.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-type-toggle]");
    if (!toggle) return;
    SoundBus.setTypeEnabled(toggle.dataset.typeToggle, !!toggle.checked);
  });
  els.notifyConnClear?.addEventListener("click", () => {
    state.conn.history = [];
    renderConnHistory();
    toast(L("مُسح سجل الاتصال", "Connection log cleared"));
  });

  els.notifyExplainAllow?.addEventListener("click", async () => {
    els.notifyExplain?.close?.();
    await requestNotifyPermission();
    renderNotifyPermState();
  });
  els.notifyExplainLater?.addEventListener("click", () => {
    try {
      localStorage.setItem(NOTIFY_EXPLAINED_KEY, "1");
    } catch {
      /* تجاهل */
    }
    els.notifyExplain?.close?.();
  });
  els.notifyExplain?.addEventListener("cancel", () => {
    try {
      localStorage.setItem(NOTIFY_EXPLAINED_KEY, "1");
    } catch {
      /* تجاهل */
    }
  });
  els.notifyBarRetry?.addEventListener("click", () => {
    const dialog = els.notifyExplain;
    if (notifyPermission() === "default" && dialog && typeof dialog.showModal === "function") dialog.showModal();
    else void requestNotifyPermission();
  });
  els.notifyBarClose?.addEventListener("click", () => els.notifyBar?.classList.add("hidden"));

  els.connBannerRetry?.addEventListener("click", () => {
    clearRetryTimers();
    state.conn.attempt = 0;
    logConn("retry", { detail: "يدوي" });
    try {
      state.ws?.close();
    } catch {
      /* تجاهل */
    }
    connect();
    void heartbeat();
  });
  els.connBannerDiag?.addEventListener("click", openConnDiag);
  els.connDiagClose?.addEventListener("click", () => els.connDiagDialog?.close?.());
  els.connDiagDialog?.addEventListener("click", (event) => {
    if (event.target === els.connDiagDialog) els.connDiagDialog.close?.();
  });

  window.addEventListener("offline", () => {
    logConn("offline", { reason: "network" });
    if (state.conn.status !== "down") connDown("network", { detail: "navigator.onLine=false" });
    else {
      state.conn.reason = "network";
      renderConnBanner();
    }
  });
  window.addEventListener("online", () => {
    logConn("online");
    if (state.conn.status === "down") {
      state.conn.fails = 0;
      clearRetryTimers();
      state.conn.attempt = 0;
      try {
        state.ws?.close();
      } catch {
        /* تجاهل */
      }
      connect();
    }
    void heartbeat();
  });

  syncNotifyBar();
  renderConnHistory();
  startHeartbeat();

  // تنبيه ثابت عند العودة بعد غياب طويل وطلب معلّق.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      state.extUi.hiddenAt = Date.now();
      return;
    }
    const hiddenFor = state.extUi.hiddenAt ? Date.now() - state.extUi.hiddenAt : 0;
    state.extUi.hiddenAt = 0;
    const request = state.extUi.current;
    if (request && hiddenFor > 45_000 && (request.method === "select" || request.method === "confirm")) {
      stickyToast(
        L(
          `⏳ لا يزال هناك طلب بانتظار موافقتك (${Math.round(hiddenFor / 1000)}ث) — ${approvalSummary(request)}`,
          `⏳ A request is still awaiting your approval (${Math.round(hiddenFor / 1000)}s) — ${approvalSummary(request)}`,
        ),
      );
    }
    renderApprovalQueue();
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

/* خطّاف اختبار (بيئة الاختبار فقط — يُفعّل بـ?soundtest=1) */
try {
  if (new URLSearchParams(location.search).has("soundtest")) {
    window.__soundBus = SoundBus;
    window.__conn = state.conn;
    window.__soundTypes = SOUND_TYPES.map((type) => type.id);
    window.__test = {
      event: (payload) => handleConversationEvent(payload),
      approve: (request) => announceApproval(request),
      classify: (code) => classifyClose(code),
      connDown: (reason, opts) => connDown(reason, opts),
      conn: state.conn,
      sound: SoundBus,
    };
  }
} catch {
  /* تجاهل */
}

async function main() {
  initTheme();
  bindUi();
  await loadConfig();
  initTabs();
  connect();
}

main();
