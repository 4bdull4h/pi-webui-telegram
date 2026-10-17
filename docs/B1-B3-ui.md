# B1 + B3 — تبويبات الجلسات ولوحة الأوامر

## ما نُفّذ

### تبويبات جلسات متوازية (B1)
- شريط تبويبات أعلى المحادثة (`#tabsBar`)، كل تبويب له معرّف مستقل `tab:<uuid>`.
- التبويب الأول يبقى `shared:main` ويُعلَّم بـ🔗 لأنه المشترك مع تيليجرام.
- التبديل يعيد الربط عبر WS `bind` ويستعيد الترانيسكربت والنموذج والتفكير والوكيل ومسودة النص.
- إضافة/إغلاق/إعادة تسمية، وحفظ القائمة في `localStorage`.

### لوحة أوامر / (B3)
- كتابة `/` في المحرر (أو زر `/`) تفتح لوحة بحث مبنية على `get_commands` من pi.
- تعرض: أوامر النظام · مهارات `/skill:name` · قوالب، مع بحث فوري وتنقّل بالأسهم و`Enter`/`Esc`.
- الأوامر المحلية (`/model`, `/thinking`, `/new`, `/compact`, `/stop`) تُنفَّذ عبر مساراتها الحالية.

### تمرير RPC عام
- رسالة WS: `{type:"rpc", id, command, data}` ← `{type:"rpc_result"}` أو `{type:"rpc_error"}`.
- قائمة أوامر مسموحة في `src/rpc/shared.js`: `get_commands, get_tree, get_entries, get_session_stats,
  fork, clone, switch_session, set_session_name, export_html, get_last_assistant_text, bash, abort_bash,
  steer, follow_up, clear_queue, set_steering_mode, set_follow_up_mode, set_auto_compaction,
  set_auto_retry, abort_retry, get_messages, cycle_model, cycle_thinking_level, set_thinking_level`.
- هذه هي البنية التي ستُبنى عليها B4–B8.

### منع كاش المتصفح
- كل ملفات `public/` تُقدَّم بـ`Cache-Control: no-store`، و`index.html` تُضاف إليه بصمة `?v=<mtime>`
  في وسوم `app.js` و`styles.css`، مع سطر `console.info("[pi-webui] build", …)` للتشخيص.

## اللقطات
- `docs/b1-tabs.png` — شريط التبويبات.
- `docs/b3-commands.png` و`docs/b3-commands-light.png` — لوحة الأوامر.

## المتبقي بعد هذه الحزمة
- **B4** شجرة الجلسة و`fork`/`clone`/`resume`/`import` + قراءة جلسات الطرفية من `~/.pi/agent/sessions`.
- **B5** تصدير HTML/JSONL و`share` ونسخ آخر رد.
- **B6** عرض `diff` لتعديلات `edit`/`write` وطي مخرجات الأدوات.
- **B7** طابور الرسائل و`steer`/`followUp`.
- **B8** إحصاءات التوكنز/التكلفة، `!bash`، والبحث داخل المحادثة.

## ملاحظة تشغيلية
تعديلات `src/**` تحتاج إعادة تشغيل الخادم؛ أما `public/**` فتُحدَّث بتحديث قسري للصفحة (`Ctrl+Shift+R`).
