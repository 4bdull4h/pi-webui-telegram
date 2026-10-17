# خطة: الويب بديل كامل عن الطرفية (RPC Bridge)

> القرارات المعتمدة من المستخدم: (ب) جسر RPC · حاسب + تيليجرام · تبويبات متوازية ·
> قراءة جلسات `~/.pi/agent/sessions` · موافقة أدوات (سماح/رفض/سماح دائماً) ·
> مستخدم واحد · تيليجرام يبقى متزامناً · تنفيذ كل المراحل · ضمّ كتم رسائل تيليجرام.

## المعمارية

```
Browser (public/app.js)
   │  WebSocket  (نفس البروتوكول الحالي + أنواع جديدة)
   ▼
WebServer (src/web-server.js)  ──►  SessionRegistry (src/rpc/registry.js)
   │                                    │  conversationId → RpcConversation
   ▼                                    ▼
TelegramBot (src/telegram-bot.js)   RpcClient (src/rpc/client.js)
                                        │  spawn: pi --mode rpc
                                        ▼
                                    pi child process (JSONL على stdin/stdout)
```

### وحدات جديدة

| ملف | المسؤولية |
|---|---|
| `src/rpc/client.js` | spawn + framing JSONL (تقسيم على `\n` فقط، تجريد `\r`) + ربط الطلبات بالردود عبر `id` + مهل + backpressure + إعادة تشغيل عند الانهيار |
| `src/rpc/conversation.js` | بديل `Conversation` الحالي بنفس الواجهة العامة (prompt/abort/newSession/switchSession/setModel/setThinking/setAgent/compact/getState/getTranscript/subscribe/dispose) |
| `src/rpc/events.js` | ترجمة أحداث RPC → الأحداث الموحّدة الحالية + أحداث جديدة |
| `src/rpc/registry.js` | سجل جلسات متعددة (تبويبات) + ربط جلسة واحدة بتيليجرام |
| `src/rpc/sessions.js` | اكتشاف جلسات القرص تحت `~/.pi/agent/sessions/**/*.jsonl` وقراءتها |

### عقد الأحداث (لا يُكسر)

الأحداث الحالية يجب أن تبقى بنفس الأسماء والحقول لأن `telegram-bot.js` و`public/app.js` يعتمدان عليها:
`user_message, run_start, text_delta, thinking_delta, tool_start, tool_update, tool_end,
assistant_message, settled, error, compaction_start, compaction_end, retry, retry_end,
model_changed, thinking_changed, agent_changed, context_usage, session_ready, session_reset,
title_changed, queue`

أحداث جديدة تُضاف لاحقاً: `queue_state, extension_ui, approval_request, tree, stats, diff`.

### تحويل أحداث RPC

| RPC | موحّد |
|---|---|
| `message_update.assistantMessageEvent.text_delta` | `text_delta` |
| `...thinking_delta` | `thinking_delta` |
| `tool_execution_start/update/end` | `tool_start/tool_update/tool_end` |
| `message_end` (assistant) | `assistant_message` |
| `agent_settled` | `settled` |
| `queue_update` | `queue` |
| `compaction_*`, `auto_retry_*`, `thinking_level_changed`, `session_info_changed` | كما هي |
| `extension_ui_request` | `extension_ui` (فئة فرعية) |

## المراحل

### A. الأساس (متسلسل)
- **A1** `src/rpc/client.js` + اختبار ذاتي (`node src/rpc/client.js --self-test`).
- **A2** `src/rpc/conversation.js` + `src/rpc/events.js` بنفس واجهة `Conversation`.
- **A3** تحويل `PiManager` لاستخدام الجسر، مع `FEATURE_RPC=1` للتبديل والعودة إلى SDK عند الفشل.

### B. الواجهة (متوازية)
- **B1** تبويبات جلسات متعددة + إبقاء واحدة «مشتركة مع تيليجرام».
- **B2** إرفاق صور (base64 عبر RPC `images`) وملفات (رفع ثم مسار) + `@file` + إكمال مسارات.
- **B3** لوحة `/` موحّدة من `get_commands` (أوامر + مهارات + قوالب).
- **B4** شجرة الجلسة + `fork/clone/resume/import/rename/delete`.
- **B5** `export_html` + `share` + نسخ آخر رد.
- **B6** عرض `diff` لتعديلات `edit/write` + طي مخرجات الأدوات.
- **B7** طابور الرسائل + `steer`/`followUp` + إزالة من الطابور.
- **B8** `get_session_stats` (توكنز/تكلفة لكل رد) + `!bash` + بحث في المحادثة.

### C. التفاعل
- **C1** جسر `extension_ui_request/response` (select/confirm/input/editor + notify/setStatus/setWidget).
- **C2** امتداد موافقة الأدوات: `select` بخيارات (سماح / رفض / **سماح دائماً**) + حفظ القواعد في `data/approvals.json`، ويُحمَّل تلقائياً في كل جلسة.

### D. تيليجرام
- **D1** وضع «الرسالة النهائية فقط»: رسالة واحدة تُحدَّث بصمت، تُستبدل بالنتيجة النهائية؛
  كتم الخطوات والوسيط؛ watchdog عند انقطاع الخادم؛ `TELEGRAM_NOTIFY_MODE=final|compact|live`.

## إدارة المخاطر
- الخادم يعمل تحت مشرف (`server.sh`). كل تغيير = `./server.sh restart` + فحص `/run/server.log`.
- خط أساس محفوظ في git (commit `baseline before RPC bridge`).
- `FEATURE_RPC=0` يعيد السلوك القديم فوراً.
- لا تُحذف ملفات الجلسات القديمة؛ القراءة فقط.

## معايير القبول العامة
1. الطرفية والويب يتشاركان نفس الجلسات على القرص.
2. فتح تبويبين وتشغيلهما معاً دون تداخل.
3. كل أمر في `rpc-commands.md` له طريق من الواجهة.
4. موافقة أداة تظهر في المتصفح وتُحترم في تيليجرام أيضاً.
5. لا تتغير رسائل تيليجرام الحالية إلا وفق D1.
