# C2 — حوار موافقة أصلي + حيوية الواجهة

> النطاق: `public/app.js`، `public/index.html`، `public/styles.css` فقط.
> لم يُلمس `src/**` ولا `extensions/**`، ولم يتغيّر بروتوكول `extension_ui` / `extension_ui_response`.

## ما تغيّر

### 1) `<dialog>` أصلي بدلاً من `div.modal`
- نافذة الموافقة (`select` / `confirm` / `input` / `editor`) أصبحت `<dialog id="extUiDialog">` تُفتح بـ`showModal()`،
  أي في **الطبقة العليا (top layer)** للمتصفح: لا يمكن دفنها تحت أي عنصر أو حجبها بـ`z-index`.
- الخلفية تُعتّم وتُموّه عبر `::backdrop` (blur 4px نهاراً / 6px ليلاً).
- `Esc` = إلغاء (عبر حدث `cancel` الأصلي + مسار `cancelExtensionDialog` الموحّد).
- النقر على `::backdrop` أو زر «إغلاق مؤقت» = إغلاق الواجهة **بلا أي رد**: الطلب يبقى معلّقاً في شريحة
  «⏳ بانتظار موافقة» أعلى المحرر، فلا يضيع الطلب بالخطأ.
- تركيز تلقائي على أول خيار، و`1..4` اختيار سريع، و`ArrowUp/Down` للتنقل، و`Enter` للتأكيد.
- خاتم عدّاد تنازلي SVG (`#extUiRing`) يعكس `request.timeout`، ويتحول للأحمر في آخر 5 ثوانٍ.
- `aria-modal="true"` + `aria-labelledby="extUiTitle"` + `aria-describedby="extUiBody"`.

### 2) الوصول حتى لو كانت الصفحة في الخلفية
- وميض عنوان الصفحة `(1) 🔐 موافقة مطلوبة` كل 900ms حتى تُحل الطلبات، ثم استعادة العنوان الأصلي.
- طلب صلاحية `Notification` عند أول تفاعل مؤشر فقط (لا تلقائياً).
- إشعار نظام عند وصول طلب **فقط إذا كان `document.hidden`**، مع `tag: "pi-ext-ui-approval"` لمنع التكرار،
  والنقر عليه ينفّذ `window.focus()` + إعادة `showModal()`.
- نغمة تنبيه WebAudio مولّدة (نغمتان قصيرتان، بلا ملفات صوت) + `navigator.vibrate(90)` على الهاتف.
- مفتاح كتم (`#soundBtn` في شريط الأدوات السفلي) محفوظ في `localStorage` تحت `pi.extUi.sound`، افتراضياً مفعّل.
- عند العودة بعد غياب > 45 ثانية مع طلب `select/confirm` معلّق: تنبيه ثابت (toast لا يختفي تلقائياً).

### 3) حيوية خفيفة
- نقط كتابة متحركة بجانب أفاتار الوكيل أثناء التوليد (`.msg.assistant.generating`).
- مؤشر `▍` وامض في نهاية النص المتدفق (`.md.streaming::after`).
- حركة دخول 160ms (`translateY + opacity`) للرسائل وبطاقات الأدوات وشريحة الموافقة.
- انتقال لوني لحالة الأداة: قيد التشغيل (accent) ← نجحت (success) / فشلت (danger).
- شريط تقدّم رقيق أعلى المحادثة (`#turnProgress`): `idle / thinking / streaming / tool` عبر `transform: scaleX` فقط.
- عدّاد مدة المهمة (`00:12`) بجانب زر الإيقاف (`#turnTimer`).
- `@media (prefers-reduced-motion: reduce)` يعطّل كل الحركات والنبضات.

### 4) ثنائية اللغة
دالة `L(ar, en)` تُرجع العربية افتراضاً والإنجليزية عندما يكون `<html lang="en">`؛ كل النصوص الجديدة تمر بها.

## التحقق (CDP على خادم مؤقت، المنفذ 8795، بيانات `/tmp`، بلا تيليجرام)

`node --check public/app.js` ✅ — `npm run check` ✅ — 26/26 فحص متصفح ناجح:

| الفحص | النتيجة |
|---|---|
| عنصر `<dialog>` + `open` + `:modal` (الطبقة العليا) | PASS |
| خياران مرسومان + تركيز على أول خيار | PASS |
| خاتم العدّاد يتناقص (20s → 18s، dashoffset يتغيّر) | PASS |
| وميض العنوان `(1) 🔐 موافقة مطلوبة` ثم استعادته | PASS |
| `Esc` يُغلق ويُرسل `{cancelled:true}` | PASS |
| اختيار سريع بـ`1`/`2` يُرسل `extension_ui_response` صحيحاً | PASS |
| `select` يُرسل `{"value":"B"}` | PASS |
| شريحة «⏳ بانتظار موافقة: …» + أزرار سريعة | PASS |
| إغلاق بـ`::backdrop` يُبقي الطلب معلّقاً وقابلاً للإجابة | PASS |
| إشعار نظام فقط عند `document.hidden` مع `tag` ثابت | PASS |
| تنبيه ثابت عند العودة بعد 45 ثانية | PASS |
| شريط التقدّم (`tool`) + عدّاد المدة `00:01` | PASS |
| نقط الكتابة + مؤشر `▍` | PASS |
| احترام `prefers-reduced-motion` | PASS |

### اللقطات (في `docs/`)
- `c2-approval-dark.png` — الحوار الأصلي لحظة وصول طلب `confirm` (ثيم داكن).
- `c2-approval-dialog-dark.png` — الحوار بعد فترة من العد التنازلي (ثيم داكن).
- `c2-approval-chip-dark.png` — شريحة «بانتظار موافقة» مع الأزرار السريعة بعد إغلاق الواجهة.
- `c2-approval-dialog-light-theme.png` — نفس الحوار في الثيم الفاتح.
- `c2-approval-return-notice.png` — تنبيه العودة بعد غياب > 45 ثانية.

## ملاحظات
- لم يُعد تشغيل خادم الإنتاج؛ كل الاختبار على منفذ مؤقت 8795.
- منطق الموافقة والبروتوكول كما هو: نفس رسائل `extension_ui` والرد `extension_ui_response`، ونفس `extension_ui_dismiss` عند انتهاء المهلة.
