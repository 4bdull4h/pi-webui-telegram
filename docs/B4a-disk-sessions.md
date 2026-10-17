# B4a — فتح جلسات الطرفية من الواجهة

## ما نُفّذ

### 1) وحدة قراءة القرص — `src/rpc/sessions.js`
- تكتشف ملفات الجلسات في `<config.agentDir>/sessions/**/*.jsonl` (افتراضياً `~/.pi/agent`) بعمق حتى 3 مستويات،
  وتتجاهل `.trash` وأي مجلد يبدأ بنقطة.
- لكل ملف تُرجع: `sessionFile, id, title, name, firstMessage, projectPath, projectName, updatedAt, size,
  messageCount, partial, cwd, version`.
  - المعرّف: من ترويسة `session` (أو من اسم الملف `<timestamp>_<uuid>.jsonl`).
  - اسم المشروع: فكّ ترميز مجلد الأب (`--home--asus--` ← `/home/asus`) مع تفضيل `cwd` من الترويسة.
  - الاسم: `session_info.name` (من `/name`) ثم أول رسالة مستخدم.
  - عدد الرسائل: عدّ رسائل `user`/`assistant` بحد أقصى **4000 سطر** لكل ملف، و`partial:true` إن تجاوزها.
- ترتيب تنازلي حسب `mtime`، وبحث نصي موحّد (`?q=` / `{q}`) في العنوان/المشروع/المعرّف.
- `trashSessionFile()` ينقل الملف إلى `<agentDir>/sessions/.trash/` (**نقل لا حذف**) مع حماية:
  رفض أي مسار خارج مجلد الجلسات، ورفض الملفات الموجودة في المهملات أصلاً.
- `isSessionFileInsideAgent()` للتحقق قبل التبديل.

### 2) رسائل WS جديدة — `src/web-server.js`
- `{type:"disk_sessions", q?, limit?}` ← `{type:"disk_sessions", sessions, total, matched, sessionsDir}`.
  **منفصلة تماماً** عن `list_sessions` (جلسات المدير/الواجهة) ولا تُعيد استخدام رسالة `sessions`.
- `{type:"disk_session_trash", sessionFile}` ← `notice` + `disk_session_trashed` أو `disk_session_trash_error`.
- `switch_session` صار يقبل `fromDisk:true`: عندها يتحقق الخادم أن المسار ملف جلسة حقيقي داخل مجلد الجلسات
  قبل التبديل، ويرسل إشعاراً. أي استخدام قديم للرسالة بدون `fromDisk` يبقى كما هو.

### 3) الواجهة — `public/app.js` + `index.html` + `styles.css`
- تبويبان صغيران أعلى قائمة المحادثات: **«هذه الواجهة»** (يعرض `state.sessions` كما هو) و**«الطرفية»**
  (جلسات القرص)، والاختيار محفوظ في `localStorage` (`piui.sessScope`).
- تبويب الطرفية: مربع بحث (مُهلة 250ms) + عدّاد `matched/total`، وكل صف يعرض الاسم، المشروع،
  عدد الرسائل (مع `+` عند العدّ الجزئي)، آخر تعديل نسبي، والحجم. النقر يفتح الجلسة عبر
  `{type:"switch_session", sessionFile, fromDisk:true}` مع إشعار `toast`.
- زر ⋯ لكل جلسة: فتح · **إعادة تسمية** (فتح الجلسة ثم `rpc set_session_name`) · **حذف** (تأكيد ثم نقل إلى `.trash`).

## لا كسر للسلوك القائم
- `list_sessions` و`renderSessions()` القديمة لم تتغير منطقياً؛ `renderSessions()` يوجّه إلى قائمة القرص فقط
  عند اختيار تبويب «الطرفية».
- لم يُعد تشغيل الخادم الحي أثناء التنفيذ، ولم تُحذف/تُعدّل أي جلسة حقيقية (الاختبار لا يلمس القرص الحقيقي إلا بالقراءة).

## التحقق
```
node --check src/rpc/sessions.js && node --check src/web-server.js && node --check public/app.js
node scripts/test-disk-sessions.mjs --self-test      # أو: npm run test:disk-sessions
node scripts/test-ui-cdp.mjs --self-test             # B1/B3: بلا انحدار
```

## اللقطات
- `docs/b4a-disk-sessions.png` — تبويب «الطرفية» مع 6 جلسات حقيقية.
- `docs/b4a-disk-search.png` — البحث (4 من 6) والعدّاد.
- `docs/b4a-disk-menu.png` — قائمة ⋯ (فتح / إعادة تسمية / حذف).

## المتبقي في B4
- `fork`/`clone`/`import` من الواجهة، واستعراض شجرة الجلسة (`get_tree`/`get_entries`) لملفات القرص.
