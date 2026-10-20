# Pi Web UI + Telegram — واجهة عربية لوكيل Pi

واجهة ويب عربية (RTL) وبوت تيليجرام لتشغيل وكيل **Pi** البرمجي: قراءة الملفات، تنفيذ الأوامر، تحرير الكود، وإدارة الجلسات — من المتصفح أو من تيليجرام.

> Made by **[@coder480](https://t.me/coder480)**

---

## المتطلبات

- **Node.js ≥ 22**
- **Pi** مثبّت على الجهاز ([pi.dev](https://pi.dev)) — يُستخدم محرّك الوكيل
- (اختياري) بوت تيليجرام من [@BotFather](https://t.me/BotFather)

## التثبيت السريع

```bash
# من npm (بعد النشر)
npm install -g pi-webui-telegram
pi-webui setup
pi-webui start
```

أو من المصدر:

```bash
git clone <repo-url> pi-webui-telegram
cd pi-webui-telegram
npm install
npm run setup     # معالج التثبيت (عربي/إنجليزي)
npm start
```

المعالج يسألك:

1. **لغة التثبيت** (العربية أو English)
2. **اسم المساعد** الذي يظهر في الواجهة والبوت
3. مجلد العمل والمنفذ والنموذج الافتراضي
4. **توكن بوت تيليجرام** (اختياري) — يتحقق منه عبر `getMe`
5. **معرّف تيليجرام (Telegram ID)** — اختياري، ويشرح خطوات الحصول عليه
6. إنشاء **خدمة systemd** تلقائياً (Linux)

ثم يفتح الواجهة على `http://localhost:8787`.

## الحصول على Telegram ID

1. افتح تيليجرام وابحث عن **@userinfobot**
2. أرسل له `/start`
3. سيردّ برقمك — انسخه وألصقه في المعالج
4. بديل: **@RawDataBot** ← أرسل أي رسالة ← اقرأ `"from": { "id": ... }`

> بدون معرّف، يرفض البوت الجميع (حماية افتراضية `fail-closed`)، لكن الواجهة تعمل بشكل طبيعي.

## التشغيل كخدمة

المعالج يولّد الخدمة في `~/.config/systemd/user/pi-webui.service`:

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-webui
systemctl --user status pi-webui
journalctl --user -u pi-webui -f
```

## الإعدادات

كل الإعدادات في ملف `.env` (صلاحيات `600`) وتُنشأ من `.env.example`. أهمها:

| المتغير | الافتراضي | الوصف |
|---|---|---|
| `ASSISTANT_NAME` | مساعد Pi | الاسم في الواجهة والبوت |
| `SUPPORT_HANDLE` | @coder480 | معرّف الدعم في `/help` |
| `HOST` / `PORT` | 0.0.0.0 / 8787 | خادم الويب |
| `WEB_TOKEN` | — | حماية اختيارية للواجهة |
| `WORKSPACE` | مجلد المستخدم | مساحة عمل الوكيل |
| `PI_WEBUI_HOME` | `~/.pi-webui` عند التثبيت العام | مجلد `.env` و`data` (مستقل عن الحزمة) |
| `DEFAULT_PROVIDER` / `DEFAULT_MODEL` | deepseek / deepseek-flash | النموذج الافتراضي |
| `TELEGRAM_BOT_TOKEN` | — | توكن البوت |
| `TELEGRAM_ALLOWED_USERS` | — | معرّفات مسموح لها (فارغ = رفض الجميع) |
| `TELEGRAM_ALLOWED_CHATS` | — | محادثات مسموح لها |
| `TELEGRAM_NOTIFY_MODE` | final | final / compact / live |

## المزايا

- واجهة RTL كاملة، وضعان داكن وفاتح، طي الشريط الجانبي وحفظ التفضيل.
- بثّ مباشر للردود، سلسلة تفكير قابلة للطي، ومجموعة خطوات أدوات مضغوطة.
- Markdown كامل: جداول، اقتباسات، كتل كود مع نسخ.
- جلسات متعددة، تفريع/نسخ، شجرة جلسة، تصدير HTML، بحث في النصوص.
- مرفقات وإكمال مسارات `@`، أوامر `/`، طابور رسائل.
- بوت تيليجرام: أزرار، بثّ، إيقاف، جلسات، مزامنة مع الويب.
- مركز تحكم للمهارات والوكلاء والمزوّدين والصلاحيات والاستهلاك.

## الأمان والخصوصية

- التوكن ومعرّفات تيليجرام تُحفظ **محلياً فقط** في `.env` ولا تُرسل لأي جهة.
- `.env` و`data/` و`.run/` مستثناة من git ومن حزمة النشر.
- قوائم السماح فارغة = رفض الجميع (وليس السماح للجميع).
- لا تشارك ملف `.env` أو مجلد `data/` مع أحد.

## English quick start

```bash
npm install -g pi-webui-telegram
pi-webui setup --lang=en
pi-webui start
```

The installer asks for your assistant name, workspace, port, model, optional Telegram bot token and numeric Telegram ID, then generates `.env` and an optional systemd user service.

---

## الترخيص

MIT © [@coder480](https://t.me/coder480)
