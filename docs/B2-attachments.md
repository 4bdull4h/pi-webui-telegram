# المرحلة B2 — إرفاق الصور والملفات + `@file` مع إكمال المسارات

> تُنفَّذ مع `docs/PLAN-parity.md` (البند B2). لا تغيير على `telegram-bot.js` ولا على `extensions/**`.

## ما أُضيف

### الخادم

| المسار | الوصف |
|---|---|
| `POST /api/upload` | `multipart/form-data` (تحليل يدوي بلا تبعيات). حفظ في `data/uploads/<yyyy-mm-dd>/<uuid>-<safe-name>`. حد 25MB للملف و40MB للمجموع، ورفض المسارات الخطرة (`..`، محارف تحكّم، اسم فارغ). الرد: `{ok:true, files:[{id,path,name,size,mime,kind,url}]}` حيث `kind = "image" \| "file"` ويُستدل على الصور من بايتاتها (PNG/JPEG/WEBP/GIF) لا من `Content-Type`. |
| `GET /files/<id>` | معاينة **للصور فقط** (تُرفض أي صيغة أخرى بـ404)، مع حماية من الالتفاف (`^YYYY-MM-DD/<file>$` + تحقق البادئة) و`nosniff`. محمية برمز الواجهة `WEB_TOKEN` إن كان مفعّلاً. |
| `GET /api/files?q=<prefix>&limit=20` | إكمال مسارات نسبية داخل `config.workspace`، تجاهل `node_modules` و`.git`، حد أقصى 20، رفض `..` والمسارات المطلقة. الرد: `{ok:true, items:[{path,name,type}]}` والمجلدات تنتهي بـ `/`. |

`src/uploads.js` وحدة جديدة مستقلة (تحليل multipart + sniffing + الحفظ + القراءة الآمنة + الإكمال + تحقق الصور/المرفقات).

### WebSocket `prompt`

حقول اختيارية جديدة (تبقى الرسالة النصية وحدها تعمل حرفياً كما كانت):

```jsonc
{
  "type": "prompt",
  "text": "…",
  "images": [{ "data": "<base64 بلا data:>", "mimeType": "image/png" }],
  "attachments": [{ "path": "/abs/path", "name": "x.txt", "mime": "text/plain" }]
}
```

- الصور: يُقبل `png/jpeg/webp/gif` فقط (+`image/jpg` يُطبَّع)، بحد 10 صور و40MB مجموع و25MB للصورة، وأي صيغة أخرى تُرفض برسالة عربية واضحة. تُمرَّر إلى RPC/SDK كـ`ImageContent` (`{type:"image",data,mimeType}`) بلا بادئة `data:`.
- المرفقات غير المصوّرة: يُلحق بها سطر في نص الرسالة `📎 مرفقات: /abs/path1, /abs/path2` (بلا تضمين المحتوى) فيقرأها الوكيل بأداة `read`.
- مرفق صورة أُرسل كمسار فقط (بلا base64) يُحوَّل تلقائياً إلى `images` حتى لا يضيع بصمت.
- `attachments` تُتحقَّق: موجودة، ملف، داخل `config.workspace` أو `data/uploads`، وبحجم مسموح. رسالة نصية فارغة مع صورة فقط تُستبدل بـ`🖼️ صورة مرفقة`.

### تمرير الصور في طبقة المحادثة

- `src/rpc/conversation.js`: `prompt(text, {images})` → `{type:"prompt", message, images}` و`follow_up` كذلك.
- `src/pi-manager.js` (مسار SDK الافتراضي): `session.prompt(text, {images})` و`session.followUp(text, images)`.

### الواجهة (`public/`)

- زر 📎 في المحرر + `<input type=file multiple hidden>`.
- سحب وإفلات على كامل الصفحة مع طبقة إفلات (`.drop-overlay`).
- لصق صورة من الحافظة (`Ctrl+V`) عبر `paste`.
- شرائح (chips) معاينة قبل الإرسال: صورة مصغّرة/أيقونة + الاسم + الحجم + ✕ للحذف.
- عند الإرسال: رفع إلى `/api/upload` ثم `prompt` بالحقول الجديدة؛ تُحدَّث حالة المحرر (`جارٍ رفع المرفقات…`) ويُمنع الإرسال المزدوج.
- `@` في المحرر يفتح قائمة إكمال من `/api/files` (debounce 120ms، تنقّل ↑↓، `Enter`/`Tab` للإدراج، `Esc` للإغلاق، النقر للإدراج). الإدراج `@path `، ومع المجلد يُدرج `@dir/` ويواصل السبر.
- RTL والثيمين: كل الأنماط الجديدة تستخدم متغيرات الثيم فقط.

## الملفات المتغيرة

```
public/app.js            + منطق المرفقات وقائمة @ والإرسال
public/index.html        + زر الإرفاق، الشرائح، قائمة المسارات، طبقة الإفلات
public/styles.css        + أنماط .attach-chip/.path-menu/.drop-overlay
src/web-server.js        + /api/upload، /files/<id>، /api/files، composeWebPrompt
src/uploads.js           جديد
src/rpc/conversation.js  + تمرير images في prompt/follow_up
src/pi-manager.js        + تمرير images في prompt/followUp
scripts/test-attachments.mjs  جديد (اختبار ذاتي)
package.json             + test:attachments
```

## التحقق

```bash
node scripts/test-attachments.mjs --self-test          # يشغّل نموذجاً (deepseek-flash، vision)
node scripts/test-attachments.mjs --self-test --no-model-required
```

- يشغّل خادماً مؤقتاً على `PORT=8799` بـ`--no-telegram` و`DATA_DIR`/`WORKSPACE` معزولة في `/tmp`، ولا يلمس الخادم العامل.
- 31 فحصاً: الرفع، الاستجابة، المعاينة، رفض المسارات الخطرة، رفض غير الصور، الإكمال والاستثناءات، حد 26MB، وWS prompt بصورة.

### سجل الاختبار (تشغيل كامل بنموذج)

```
[test-attachments] مساحة عمل مؤقتة: /tmp/pi-attach-test-KQZCnp/ws
[test-attachments] الخادم يعمل على http://127.0.0.1:8799
[test-attachments] 
1) POST /api/upload — PNG + ملف نصي
  ✅ استجابة الرفع 200 و ok:true
  ✅ ملفان مرفوعان
  ✅ تصنيف الصورة image/png
  ✅ تصنيف الملف النصي text/plain
  ✅ url للمعاينة يبدأ بـ/files/
  ✅ مسار التخزين data/uploads/<yyyy-mm-dd>/…
  ✅ الحجم الفعلي مطابق
[test-attachments] 
2) GET /files/<id>
  ✅ معاينة الصورة 200
  ✅ content-type صحيح
  ✅ بايتات الصورة مطابقة
  ✅ ملف غير صورة لا يُقدَّم عبر /files/
  ✅ رفض مسار خطير: ..%2F..%2Fetc%2Fpasswd
  ✅ رفض مسار خطير: 2020-01-01%2F..%2F..%2Fetc%2Fpasswd
  ✅ رفض مسار خطير: %2Fetc%2Fpasswd
[test-attachments] 
3) GET /api/files
  ✅ ok:true
  ✅ يظهر notes.txt
  ✅ المجلدات تنتهي بـ /
  ✅ node_modules مستثنى
  ✅ /api/files?q=src/ يسرد المحتوى
  ✅ البادئة src/ap تُكمل src/app.js
  ✅ حد أقصى 20 نتيجة
  ✅ رفض ?q=.. بخطأ 400
[test-attachments] 
4) حد الحجم (26MB)
  ✅ 413 عند تجاوز 25MB
  ✅ رسالة عربية توضح الحد
[test-attachments] 
5) WS prompt — صورة + مرفق نصي
[test-attachments]    النموذج: deepseek/deepseek-flash (vision=true)
  ✅ الاتصال جاهز (ready)
  ✅ رفض صيغة صورة غير مدعومة برسالة عربية
  ✅ وصل user_message إلى الجلسة
  ✅ سطر المرفقات يحتوي المسار المطلق
  ✅ run_start وصل (قُبلت الصورة بلا خطأ mime)
  ✅ settled بلا خطأ بعد الصورة
[test-attachments]    رد الوكيل: أزرق

✅ PASS — كل فحوصات B2 نجحت
```

> لون الرد على مربّع 16×16 أحادي غير مُتحقَّق منه في الاختبار (غير حتمي مع هذا النموذج). الإثبات الحاسم
> للوصول الفعلي للصورة هو جلسة الواجهة أدناه: صورة 64×64 حمراء عليها «π» ← رد الوكيل «أحمر» + مسار الملف المرفوع.

### تحقق الواجهة (متصفح حقيقي، خادم مؤقت على 8798)

| اللقطة | ما تُثبته |
|---|---|
| `docs/b2-ui-1-paste-chip.png` | لصق صورة من الحافظة (`ClipboardEvent` مع ملف PNG) ← شريحة معاينة بمسغّر 64×64 واسم عربي وحجم و✕ |
| `docs/b2-ui-2-path-menu.png` | كتابة `@src/` ← قائمة إكمال من `/api/files` فوق المحرر (RTL، مجلدات أولاً) |
| `docs/b2-ui-3-drop-file-chip.png` | سحب وإفلات ملف نصي (`DragEvent drop`) ← شريحة 📄 |
| `docs/b2-ui-4-transcript.png` | بعد الإرسال: السطر `📎 مرفقات: /tmp/…/notes-b2.txt` داخل رسالة المستخدم، والوكيل قرأ الملف وأجاب `pi-webui-telegram` |
| `docs/b2-ui-5-light-chips-menu.png` | الثيم الفاتح مع شريحتين وقائمة `@` |

سجل نصي من الجلسة (DOM عبر CDP):

```
paste PNG            → chips=1, text=""                        (شريحة صورة)
type "@src/"         → items=[📁src/rpc/ , ⌨️src/config.js , … ] (13 عنصراً)
ArrowDown ×2 + Enter → value="افتح الملف @src/control.js ", menuHidden=true, messages=0  (إدراج لا إرسال)
Esc                  → menuHidden=true
رفع + إرسال (صورة)   → bubbles=["ما لون الصورة المرفقة؟ أجب بكلمة واحدة، واذكر مسار الملف المرفق."]
                       رد الوكيل: "أحمر\n\nالمسار: /tmp/b2-ui/data/uploads/2026-10-17/b03fe2f3-…-لقطة-بي.png"
drop notes-b2.txt + إرسال →
                       bubbles=[…, "اقرأ الملف المرفق واذكر اسم المشروع فقط.\n\n📎 مرفقات: /tmp/b2-ui/data/uploads/2026-10-17/ade8be31-…-notes-b2.txt"]
                       رد الوكيل: "pi-webui-telegram", chips=0  (الشرائح تُفرَّغ بعد الإرسال)
إرسال نصي بلا مرفقات → bubbles=[…, "قل كلمة: تم"], input=""     (السلوك القديم سليم)
```

طلبات الشبكة في الجلسة: `POST /api/upload` ×2 → 200، `GET /api/files?q=src%2F&limit=20` → 200.
الأخطاء الوحيدة في الطرفية: 404 لملفات خط `Qumra` قديمة (سابقة لهذه المرحلة).

## ملاحظات تشغيلية

- **الواجهة الأمامية تُقدَّم من القرص فوراً، لكن الخادم العامل (8787) لم يُعَد تشغيله** حسب التعليمات:
  حتى `./server.sh restart` ستظهر أزرار الإرفاق و`@` لكن `/api/upload` و`/api/files` ستعيد 404
  (السلوك النصي القديم سليم). إعادة التشغيل مطلوبة لتفعيل الـAPI.
- تيليجرام لا يرسل `images`/`attachments`، ومسار `prompt` بلا مرفقات لم يتغير.
- حدود الرفع المعلنة للعميل مطابقة للخادم (25MB/ملف، 40MB/طلب، 20 ملفاً، 10 صور).
