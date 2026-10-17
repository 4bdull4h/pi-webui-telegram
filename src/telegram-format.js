/** تحويل Markdown إلى HTML متوافق مع تيليجرام مع تقسيم آمن للرسائل الطويلة. */

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = escapeHtml(s);

  // روابط [نص](رابط)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  // عريض
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  // يتوسطه خط
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  // مائل
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<i>$2</i>");

  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

function renderCodeBlock(lines, lang) {
  const body = escapeHtml(lines.join("\n"));
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre><code${cls}>${body}</code></pre>`;
}

/** يحوّل نص Markdown إلى HTML تيليجرام (متوازن الوسوم). */
export function markdownToTelegramHtml(markdown) {
  const text = String(markdown ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // كتلة كود مسوّرة
    const fence = /^```([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const body = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // تخطّي الإغلاق
      out.push(renderCodeBlock(body, lang));
      continue;
    }

    // جدول Markdown (تيليجرام لا يدعم الجداول): نعرضه كأسطر مقروءة
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      const cells = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => renderInline(c.trim()));
      const header = cells(line);
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const row = cells(lines[i]);
        if (header.length > 1) {
          const parts = row.map((cell, idx) => `${header[idx] ? `<b>${header[idx]}:</b> ` : ""}${cell}`);
          out.push(`• ${parts.join(" — ")}`);
        } else {
          out.push(`• ${row.join(" — ")}`);
        }
        i += 1;
      }
      continue;
    }

    // اقتباس
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(renderInline(lines[i].replace(/^>\s?/, "")));
        i += 1;
      }
      out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
      continue;
    }

    // عنوان
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${renderInline(heading[2])}</b>`);
      i += 1;
      continue;
    }

    // فاصل أفقي
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("──────────");
      i += 1;
      continue;
    }

    // قائمة نقطية
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`• ${renderInline(bullet[1])}`);
      i += 1;
      continue;
    }

    // قائمة مرقّمة
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(`${numbered[1]}. ${renderInline(numbered[2])}`);
      i += 1;
      continue;
    }

    out.push(renderInline(line));
    i += 1;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * يقسّم Markdown إلى أجزاء لا تتجاوز الحد، دون كسر كتل الكود.
 * @returns {string[]}
 */
export function splitMarkdown(markdown, maxLength) {
  const text = String(markdown ?? "").replace(/\r\n/g, "\n");
  if (text.length <= maxLength) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  let inFence = false;
  let fenceLang = "";
  let fenceLines = [];

  const push = (segment) => {
    if (!segment) return;
    if (current && current.length + segment.length + 1 > maxLength) {
      chunks.push(current.replace(/\s+$/, ""));
      current = "";
    }
    current += (current ? "\n" : "") + segment;
  };

  const pushLongText = (segment) => {
    let rest = segment;
    while (rest.length > maxLength) {
      let cut = rest.lastIndexOf(" ", maxLength);
      if (cut < maxLength * 0.5) cut = maxLength;
      push(rest.slice(0, cut));
      chunks.push(current.replace(/\s+$/, ""));
      current = "";
      rest = rest.slice(cut).replace(/^\s+/, "");
    }
    if (rest) push(rest);
  };

  const flushFence = () => {
    const block = fenceLines.join("\n");
    if (block.length + 12 <= maxLength) {
      push(block);
      return;
    }
    // كتلة كود طويلة: نقسّمها إلى كتل مسوّرة أصغر
    const label = fenceLang ? `\`\`\`${fenceLang}` : "```";
    const closing = "```";
    const overhead = label.length + closing.length + 2;
    const limit = Math.max(32, maxLength - overhead);
    let buffer = "";
    const emit = () => {
      if (!buffer) return;
      if (current.trim()) chunks.push(current.replace(/\s+$/, ""));
      current = "";
      chunks.push(`${label}\n${buffer.replace(/\n$/, "")}\n${closing}`);
      buffer = "";
    };
    for (const line of fenceLines.slice(1, -1)) {
      if (buffer && buffer.length + line.length + 1 > limit) emit();
      buffer += (buffer ? "\n" : "") + line;
      if (buffer.length > limit) {
        emit();
      }
    }
    emit();
  };

  for (const line of lines) {
    if (!inFence) {
      const fence = /^```([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        inFence = true;
        fenceLang = fence[1] || "";
        fenceLines = [line];
        continue;
      }
      if (line.length > maxLength) pushLongText(line);
      else push(line);
    } else {
      fenceLines.push(line);
      if (/^```\s*$/.test(line)) {
        inFence = false;
        flushFence();
        fenceLines = [];
      }
    }
  }

  if (inFence && fenceLines.length) {
    fenceLines.push("```");
    flushFence();
  }
  if (current.trim()) chunks.push(current.replace(/\s+$/, ""));

  return chunks.length ? chunks : [""];
}

/** يحوّل Markdown إلى قائمة رسائل HTML جاهزة للإرسال. */
export function toTelegramMessages(markdown, maxLength = 3900) {
  return splitMarkdown(markdown, maxLength).map((part) => {
    const html = markdownToTelegramHtml(part);
    return html || "…";
  });
}

/** نص عادي بدون وسوم (للإشعارات الموجزة). */
export function toPlainText(markdown) {
  return String(markdown ?? "")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[*_~#>]/g, "")
    .trim();
}

export default { markdownToTelegramHtml, splitMarkdown, toTelegramMessages, toPlainText, escapeHtml };
