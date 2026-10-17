/** تحويل أحداث Pi الخام إلى أحداث موحّدة تفهمها الواجهة وتيليجرام. */

export function contentText(content, { includeThinking = false } = {}) {
  if (!content) return "";
  if (typeof content === "string") return content;
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text" && block.text) parts.push(block.text);
    else if (includeThinking && block.type === "thinking" && block.thinking) parts.push(block.thinking);
  }
  return parts.join("");
}

export function assistantText(message) {
  return contentText(message?.content, { includeThinking: false });
}

export function assistantThinking(message) {
  if (!message?.content || typeof message.content === "string") return "";
  return message.content
    .filter((b) => b?.type === "thinking" && b.thinking)
    .map((b) => b.thinking)
    .join("");
}

/** ملخّص نصي لنتيجة أداة. */
export function summarizeToolResult(result, max = 2000) {
  if (result == null) return "";
  let text = "";
  if (typeof result === "string") text = result;
  else if (typeof result === "object" && Array.isArray(result.content)) {
    text = result.content
      .map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
    if (!text && result.details) text = safeStringify(result.details);
  } else {
    text = safeStringify(result);
  }
  if (text.length > max) text = `${text.slice(0, max)}\n… (+${text.length - max})`;
  return text;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const TOOL_LABELS = {
  ar: {
    read: "قراءة ملف",
    write: "كتابة ملف",
    edit: "تعديل ملف",
    bash: "تنفيذ أمر",
    ls: "عرض المجلد",
    grep: "بحث في الملفات",
    find: "البحث عن ملفات",
    glob: "مطابقة ملفات",
    web_search: "بحث في الويب",
    web_fetch: "جلب صفحة",
    think: "تفكير",
    todo: "تنظيم المهام",
  },
  en: {
    read: "Reading file",
    write: "Writing file",
    edit: "Editing file",
    bash: "Running command",
    ls: "Listing folder",
    grep: "Searching files",
    find: "Finding files",
    glob: "Matching files",
    web_search: "Web search",
    web_fetch: "Fetching page",
    think: "Thinking",
    todo: "Planning tasks",
  },
};

export function toolLabel(name, lang = "ar") {
  const table = TOOL_LABELS[lang] || TOOL_LABELS.ar;
  return table[name] || name;
}

/** أهم وسيط للأداة، لعرضه بجانب اسمها. */
export function toolHint(name, args) {
  if (!args || typeof args !== "object") return "";
  const pick = (...keys) => {
    for (const k of keys) if (args[k] != null && args[k] !== "") return String(args[k]);
    return "";
  };
  let hint = "";
  switch (name) {
    case "read":
    case "write":
    case "edit":
      hint = pick("path", "file_path", "filePath");
      break;
    case "bash":
      hint = pick("command", "cmd");
      break;
    case "ls":
    case "list":
      hint = pick("path", "dir", "directory");
      break;
    case "grep":
      hint = pick("pattern", "query");
      break;
    case "find":
    case "glob":
      hint = pick("pattern", "glob");
      break;
    case "web_search":
      hint = pick("query", "q");
      break;
    case "web_fetch":
      hint = pick("url");
      break;
    default: {
      const first = Object.values(args).find((v) => typeof v === "string" && v.length < 120);
      hint = first ? String(first) : "";
    }
  }
  if (hint.length > 140) hint = `${hint.slice(0, 137)}…`;
  return hint;
}

/**
 * يحوّل حدث Pi الخام إلى صفر أو أكثر من الأحداث الموحّدة.
 * @returns {Array<object>}
 */
export function normalizeEvent(event) {
  if (!event || !event.type) return [];
  switch (event.type) {
    case "message_update": {
      const a = event.assistantMessageEvent;
      if (!a) return [];
      if (a.type === "text_delta") return [{ type: "text_delta", delta: a.delta || "" }];
      if (a.type === "thinking_delta") return [{ type: "thinking_delta", delta: a.delta || "" }];
      if (a.type === "toolcall_start") return [{ type: "tool_call_announced", id: a.id, name: a.toolName }];
      return [];
    }
    case "tool_execution_start":
      return [{ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args }];
    case "tool_execution_update":
      return [{ type: "tool_update", id: event.toolCallId, name: event.toolName, output: summarizeToolResult(event.partialResult, 800) }];
    case "tool_execution_end":
      return [
        {
          type: "tool_end",
          id: event.toolCallId,
          name: event.toolName,
          isError: !!event.isError,
          output: summarizeToolResult(event.result),
          durationMs: event.durationMs,
        },
      ];
    case "message_end": {
      const m = event.message;
      if (!m) return [];
      if (m.role === "assistant") {
        return [
          {
            type: "assistant_message",
            text: assistantText(m),
            thinking: assistantThinking(m),
            stopReason: m.stopReason,
            errorMessage: m.errorMessage,
            usage: m.usage,
            model: m.model,
          },
        ];
      }
      return [];
    }
    case "agent_settled":
      return [{ type: "settled", aborted: !!event.aborted }];
    case "compaction_start":
      return [{ type: "compaction_start", reason: event.reason }];
    case "compaction_end":
      return [
        {
          type: "compaction_end",
          aborted: !!event.aborted,
          summary: event.result?.summary,
          errorMessage: event.errorMessage,
        },
      ];
    case "auto_retry_start":
      return [{ type: "retry", attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: event.errorMessage }];
    case "auto_retry_end":
      return [{ type: "retry_end", success: !!event.success, finalError: event.finalError }];
    case "thinking_level_changed":
      return [{ type: "thinking_level", level: event.level }];
    case "session_info_changed":
      return [{ type: "title_changed", name: event.name }];
    case "queue_update":
      return [{ type: "queue", steering: event.steering?.length || 0, followUp: event.followUp?.length || 0 }];
    case "extension_error":
      return [{ type: "extension_error", error: event.error, path: event.extensionPath }];
    default:
      return [];
  }
}

/** يستخرج سجل الرسائل البسيط لعرضه عند فتح الواجهة. */
export function transcriptFromMessages(messages = []) {
  const out = [];
  for (const message of messages) {
    if (!message?.role) continue;
    if (message.role === "user") {
      const text = contentText(message.content, { includeThinking: false });
      if (text) out.push({ role: "user", text, timestamp: message.timestamp });
    } else if (message.role === "assistant") {
      const text = assistantText(message);
      const tools = Array.isArray(message.content)
        ? message.content
            .filter((b) => b?.type === "toolCall")
            .map((b) => ({ name: b.name, args: b.arguments }))
        : [];
      if (text || tools.length) out.push({ role: "assistant", text, tools, timestamp: message.timestamp });
    } else if (message.role === "toolResult") {
      out.push({
        role: "tool",
        name: message.toolName,
        isError: !!message.isError,
        output: summarizeToolResult(message, 1500),
        timestamp: message.timestamp,
      });
    }
  }
  return out;
}

export default { normalizeEvent, transcriptFromMessages, toolLabel, toolHint, assistantText, summarizeToolResult };
