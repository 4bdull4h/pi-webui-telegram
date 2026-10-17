/**
 * تحويل أحداث RPC إلى الأحداث الموحّدة (نفس أسماء src/events.js) + طابور أحداث.
 * يعيد استخدام normalizeEvent للأحداث المتطابقة الشكل (الأدوات، الرسائل، الانضغاط، الإعادة).
 */
import { normalizeEvent } from "../events.js";

export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** طابور FIFO محدود الحجم، يُسقط الأقدم عند الامتلاء. */
export class EventQueue {
  constructor({ max = 200 } = {}) {
    this.max = Math.max(1, max);
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    return this.size;
  }

  replace(items) {
    this.items = Array.isArray(items) ? items.slice(-this.max) : [];
    return this.size;
  }

  drain() {
    const out = this.items;
    this.items = [];
    return out;
  }

  clear() {
    this.items = [];
  }

  snapshot() {
    return [...this.items];
  }
}

function queueTexts(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => (typeof item === "string" ? item : item?.text || "")).filter(Boolean);
}

/** وصف مختصر لحوار إضافة لعرضه في الواجهة. */
export function describeExtensionUI(request) {
  return {
    type: "extension_ui",
    requestId: request.id,
    method: request.method,
    title: request.title || request.message || "",
    message: request.message || "",
    placeholder: request.placeholder || "",
    prefill: request.prefill || "",
    options: Array.isArray(request.options) ? request.options : [],
    notifyType: request.notifyType || "info",
    statusKey: request.statusKey || null,
    statusText: request.statusText ?? null,
    widgetKey: request.widgetKey || null,
    widgetLines: Array.isArray(request.widgetLines) ? request.widgetLines : null,
    widgetPlacement: request.widgetPlacement || null,
    timeout: request.timeout ?? null,
    expectsResponse: DIALOG_METHODS.has(request.method),
  };
}

/**
 * يحوّل سجل RPC واحداً إلى صفر أو أكثر من الأحداث الموحّدة.
 * @param {object} record
 * @returns {Array<object>}
 */
export function normalizeRpcEvent(record) {
  if (!record || !record.type) return [];
  switch (record.type) {
    case "agent_start":
      return [{ type: "run_start" }];
    case "queue_update": {
      const steering = queueTexts(record.steering);
      const followUp = queueTexts(record.followUp);
      return [
        {
          type: "queue",
          steering: steering.length,
          followUp: followUp.length,
          steeringItems: steering,
          followUpItems: followUp,
        },
      ];
    }
    case "extension_ui_request":
      return [describeExtensionUI(record)];
    case "bash_execution_update":
      return [{ type: "bash_delta", id: record.id, delta: record.delta || "" }];
    case "agent_end":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "entry_appended":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      return [];
    default:
      // الأدوات، الرسائل، الانضغاط، إعادة المحاولة، مستوى التفكير، اسم الجلسة، الأخطاء.
      return normalizeEvent(record);
  }
}

export default { normalizeRpcEvent, EventQueue, describeExtensionUI, DIALOG_METHODS };
