#!/usr/bin/env node
/**
 * VMware Workstation MCP server (stdio, JSON-RPC 2.0)
 *
 * Tools:
 *  - vmware_host_info
 *  - vmware_list_vms
 *  - vmware_vm_info
 *  - vmware_get_guest_ip
 *  - vmware_check_tools
 *  - vmware_list_snapshots
 *  - vmware_power
 *  - vmware_capture_screen
 *  - vmware_run_guest_command
 *  - vmware_detect_virtualization
 *
 * Guest-execution tools need guest credentials. Provide them per call or via
 * VMWARE_GUEST_USER / VMWARE_GUEST_PASSWORD in the MCP server environment.
 */
import readline from "node:readline";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const VMRUN =
  process.env.VMWARE_VMRUN ||
  "/mnt/c/Program Files (x86)/VMware/VMware Workstation/vmrun.exe";
const POWERSHELL = process.env.VMWARE_POWERSHELL || "powershell.exe";
const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT = 60_000;

function log(...args) {
  process.stderr.write(`[vmware-mcp] ${args.join(" ")}\n`);
}

function toWindowsPath(input) {
  const value = String(input || "");
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  const mnt = /^\/mnt\/([a-z])\/(.*)$/i.exec(value);
  if (mnt) return `${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, "\\")}`;
  try {
    return execFileSync("wslpath", ["-w", value], { encoding: "utf8" }).trim();
  } catch {
    return value;
  }
}

function toWslPath(input) {
  const value = String(input || "");
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replace(/\\/g, "/")}`;
  }
  return value;
}

function vmRoots() {
  const roots = [];
  if (process.env.VMWARE_VM_DIR) {
    roots.push(toWslPath(process.env.VMWARE_VM_DIR));
  }
  const usersRoot = "/mnt/c/Users";
  try {
    for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(usersRoot, entry.name, "Documents", "Virtual Machines");
      if (fs.existsSync(dir)) roots.push(dir);
    }
  } catch {
    /* ignore */
  }
  return [...new Set(roots)];
}

function walkVmx(dir, depth = 0) {
  const out = [];
  if (depth > 3) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkVmx(full, depth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".vmx")) {
      out.push(full);
    }
  }
  return out;
}

function parseVmx(file) {
  const text = fs.readFileSync(file, "utf8");
  const data = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#=]+?)\s*=\s*"(.*)"\s*$/.exec(line);
    if (!match) continue;
    data[match[1].trim()] = match[2];
  }
  return data;
}

function vmSummary(file) {
  const cfg = parseVmx(file);
  return {
    displayName: cfg.displayName || path.basename(file, ".vmx"),
    guestOS: cfg.guestOS || "",
    vmx: toWindowsPath(file),
    wslPath: file,
    memsizeMB: Number(cfg.memsize) || null,
    numvcpus: Number(cfg.numvcpus) || null,
    firmware: cfg.firmware || "",
    ethernet: {
      connectionType: cfg["ethernet0.connectionType"] || "",
      virtualDev: cfg["ethernet0.virtualDev"] || "",
      address: cfg["ethernet0.generatedAddress"] || cfg["ethernet0.address"] || "",
    },
    uuidBios: cfg["uuid.bios"] || "",
    uuidLocation: cfg["uuid.location"] || "",
    vmciId: cfg["vmci0.id"] || "",
    toolsSyncTime: cfg["tools.syncTime"] || "",
    snapshot: cfg["snapshot.current"] || "",
  };
}

function allVms() {
  const seen = new Set();
  const list = [];
  for (const root of vmRoots()) {
    for (const file of walkVmx(root)) {
      const key = file.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        list.push(vmSummary(file));
      } catch {
        /* ignore */
      }
    }
  }
  return list.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function resolveVmx(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("vmx مطلوب (مسار .vmx أو displayName).");
  const wsl = toWslPath(value);
  if (fs.existsSync(wsl) && wsl.toLowerCase().endsWith(".vmx")) {
    return { wsl, win: toWindowsPath(wsl), summary: vmSummary(wsl) };
  }
  const match = allVms().find(
    (vm) =>
      vm.displayName.toLowerCase() === value.toLowerCase() ||
      path.basename(vm.wslPath, ".vmx").toLowerCase() === value.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `لم يُعثر على الجهاز: ${value}. المتاح: ${allVms().map((vm) => vm.displayName).join(", ")}`,
    );
  }
  return { wsl: match.wslPath, win: match.vmx, summary: match };
}

function runFile(command, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          signal: error?.signal ?? null,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
          error: error ? String(error.message || error) : null,
        });
      },
    );
  });
}

function runVmrun(args, options) {
  return runFile(VMRUN, args, options);
}

function runPowerShell(script, options) {
  return runFile(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    options,
  );
}

function authArgs(user, password) {
  const u = user || process.env.VMWARE_GUEST_USER || "";
  const p = password || process.env.VMWARE_GUEST_PASSWORD || "";
  if (!u || !p) return { args: [], ok: false };
  return { args: ["-gu", u, "-gp", p], ok: true };
}

function parseJsonLoose(text) {
  const value = String(text || "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(value.slice(start, end + 1));
  }
  return JSON.parse(value);
}

function jsonContent(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function textContent(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function hostInfo() {
  const script = `
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$bb = Get-CimInstance Win32_BaseBoard
$bios = Get-CimInstance Win32_BIOS
[pscustomobject]@{
  Name = $env:COMPUTERNAME
  User = $env:USERNAME
  Manufacturer = $cs.Manufacturer
  Model = $cs.Model
  SystemFamily = $cs.SystemFamily
  TotalPhysicalMemory = $cs.TotalPhysicalMemory
  OS = $os.Caption
  OSVersion = $os.Version
  Build = $os.BuildNumber
  CPU = $cpu.Name
  BaseBoardManufacturer = $bb.Manufacturer
  BaseBoardProduct = $bb.Product
  BiosManufacturer = $bios.Manufacturer
  BiosVersion = $bios.SMBIOSBIOSVersion
  BiosSerial = $bios.SerialNumber
  IsVirtualized = $cs.HypervisorPresent
} | ConvertTo-Json -Compress -Depth 4
`.trim();
  const result = await runPowerShell(script);
  if (!result.ok) throw new Error(result.error || result.stderr || "PowerShell failed");
  return parseJsonLoose(result.stdout);
}

async function listVms() {
  const running = await runVmrun(["-T", "ws", "list"]);
  const runningPaths = running.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    runningCount: runningPaths.length,
    running: runningPaths,
    all: allVms(),
  };
}

async function vmInfo(input) {
  const vm = resolveVmx(input);
  const host = await hostInfo().catch(() => null);
  const cfg = parseVmx(vm.wsl);
  const selected = {};
  for (const key of [
    "displayName",
    "guestOS",
    "guestOSAltName",
    "firmware",
    "virtualHW.version",
    "memsize",
    "numvcpus",
    "cpuid.coresPerSocket",
    "ethernet0.connectionType",
    "ethernet0.virtualDev",
    "ethernet0.generatedAddress",
    "uuid.bios",
    "uuid.location",
    "vmci0.id",
    "tools.syncTime",
    "tools.remindInstall",
    "snapshot.current",
  ]) {
    if (cfg[key] !== undefined) selected[key] = cfg[key];
  }
  return {
    vm: vm.summary,
    vmxFields: selected,
    host,
  };
}

async function getGuestIp(input, wait) {
  const vm = resolveVmx(input);
  const args = ["-T", "ws", "getGuestIPAddress", vm.win];
  if (wait) args.push("-wait");
  const result = await runVmrun(args, { timeout: 90_000 });
  if (!result.ok) throw new Error(result.error || result.stderr || "getGuestIPAddress failed");
  return { vm: vm.summary.displayName, ip: result.stdout };
}

async function checkTools(input) {
  const vm = resolveVmx(input);
  const result = await runVmrun(["-T", "ws", "checkToolsState", vm.win]);
  if (!result.ok) throw new Error(result.error || result.stderr || "checkToolsState failed");
  return { vm: vm.summary.displayName, state: result.stdout };
}

async function listSnapshots(input) {
  const vm = resolveVmx(input);
  const result = await runVmrun(["-T", "ws", "listSnapshots", vm.win]);
  if (!result.ok) throw new Error(result.error || result.stderr || "listSnapshots failed");
  const snapshots = result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  return { vm: vm.summary.displayName, snapshots };
}

async function power(input, action, soft) {
  const vm = resolveVmx(input);
  const allowed = new Set(["start", "stop", "suspend", "reset"]);
  if (!allowed.has(action)) throw new Error(`action غير مدعوم: ${action}`);
  const args = ["-T", "ws", action, vm.win];
  if (soft && ["stop", "reset", "suspend"].includes(action)) args.push("soft");
  const result = await runVmrun(args, { timeout: 120_000 });
  if (!result.ok) throw new Error(result.error || result.stderr || `${action} failed`);
  return { vm: vm.summary.displayName, action, stdout: result.stdout };
}

async function captureScreen(input, output, user, password) {
  const vm = resolveVmx(input);
  const out = output
    ? toWslPath(output)
    : `/mnt/c/Users/Public/vmware-screen-${Date.now()}.png`;
  const auth = authArgs(user, password);
  const args = ["-T", "ws", ...auth.args, "captureScreen", vm.win, toWindowsPath(out)];
  const result = await runVmrun(args, { timeout: 60_000 });
  if (!result.ok) {
    return textContent(
      `تعذّر التقاط الشاشة. ${auth.ok ? "" : "يلزم اسم مستخدم وكلمة مرور للضيف. "}${result.error || result.stderr}`,
      true,
    );
  }
  if (!fs.existsSync(out)) {
    return textContent("تم تنفيذ الأمر لكن لم يُعثر على ملف الصورة.", true);
  }
  const data = fs.readFileSync(out).toString("base64");
  return {
    content: [
      { type: "text", text: `VM: ${vm.summary.displayName}\nScreenshot: ${out}` },
      { type: "image", data, mimeType: "image/png" },
    ],
  };
}

async function runGuestCommand(input, command, program, argsList, user, password, timeoutMs) {
  const vm = resolveVmx(input);
  const auth = authArgs(user, password);
  if (!auth.ok) {
    return textContent(
      "يلزم اسم مستخدم وكلمة مرور للضيف (user/password) أو VMWARE_GUEST_USER/VMWARE_GUEST_PASSWORD.",
      true,
    );
  }
  const programPath = program || "C:\\Windows\\System32\\cmd.exe";
  const finalArgs = Array.isArray(argsList) && argsList.length
    ? argsList.map(String)
    : ["/c", String(command || "cmd /c echo hello")];
  const result = await runVmrun(
    ["-T", "ws", ...auth.args, "runProgramInGuest", vm.win, programPath, ...finalArgs],
    { timeout: Number(timeoutMs) || 120_000 },
  );
  return jsonContent({
    vm: vm.summary.displayName,
    ok: result.ok,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  });
}

function guestDetectScript() {
  return `
$ErrorActionPreference = "SilentlyContinue"
$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$bb = Get-CimInstance Win32_BaseBoard
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$tools = Get-Service VMTools
$reg = Get-ItemProperty "HKLM:\\SOFTWARE\\VMware, Inc.\\VMware Tools"
$gw = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Select-Object -First 1).NextHop
$pingText = ""
if ($gw) { $pingText = (ping -a $gw -n 1 2>&1) -join "\`n" }
$dnsText = ""
if ($gw) { $dnsText = (Resolve-DnsName $gw 2>&1 | Select-Object -First 4 | ForEach-Object { "$($_.NameHost) $($_.IPAddress)" }) -join "\`n" }
$shared = ""
try { $shared = (Get-SmbMapping 2>&1 | Out-String) } catch {}
[pscustomobject]@{
  ComputerName = $env:COMPUTERNAME
  User = $env:USERNAME
  Manufacturer = $cs.Manufacturer
  Model = $cs.Model
  HypervisorPresent = $cs.HypervisorPresent
  SystemFamily = $cs.SystemFamily
  BaseBoardManufacturer = $bb.Manufacturer
  BaseBoardProduct = $bb.Product
  BiosManufacturer = $bios.Manufacturer
  BiosVersion = $bios.SMBIOSBIOSVersion
  BiosSerial = $bios.SerialNumber
  CPU = $cpu.Name
  OS = $os.Caption
  OSVersion = $os.Version
  VMwareToolsStatus = $tools.Status
  VMwareToolsVersion = $reg.Version
  VMwareToolsInstallPath = $reg.InstallPath
  MAC = (Get-NetAdapter | Where-Object Status -eq "Up" | Select-Object -ExpandProperty MacAddress) -join ","
  Gateway = $gw
  GatewayPing = $pingText
  GatewayDns = $dnsText
  SmbMappings = $shared
} | ConvertTo-Json -Compress -Depth 5
`.trim();
}

async function detectVirtualization(input, user, password, timeoutMs) {
  const vm = resolveVmx(input);
  const auth = authArgs(user, password);
  if (!auth.ok) {
    return textContent(
      "يلزم اسم مستخدم وكلمة مرور للضيف (user/password) أو VMWARE_GUEST_USER/VMWARE_GUEST_PASSWORD.",
      true,
    );
  }
  const script = guestDetectScript();
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const guestFile = `C:\\Windows\\Temp\\vmware-mcp-${crypto.randomUUID()}.json`;
  const psCommand =
    `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe ` +
    `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  const command = `cmd.exe /c ${psCommand} > ${guestFile} 2>&1`;
  const run = await runVmrun(
    ["-T", "ws", ...auth.args, "runProgramInGuest", vm.win, "C:\\Windows\\System32\\cmd.exe", "/c", command],
    { timeout: Number(timeoutMs) || 180_000 },
  );
  const hostFile = `/mnt/c/Users/Public/vmware-detect-${Date.now()}.json`;
  const copy = await runVmrun([
    "-T",
    "ws",
    ...auth.args,
    "copyFileFromGuestToHost",
    vm.win,
    guestFile,
    toWindowsPath(hostFile),
  ]);
  let output = "";
  if (copy.ok && fs.existsSync(hostFile)) {
    output = fs.readFileSync(hostFile, "utf8");
    try {
      fs.unlinkSync(hostFile);
    } catch {
      /* ignore */
    }
  }
  if (!output) {
    return jsonContent({
      vm: vm.summary.displayName,
      ok: false,
      run,
      copy,
      note: "لم يُقرأ ملف النتيجة من الضيف. تحقق من الصلاحيات وVMware Tools.",
    });
  }
  let parsed = null;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = null;
  }
  return jsonContent({
    vm: vm.summary.displayName,
    ok: true,
    guest: parsed || output,
    hostFromVmx: vm.summary,
  });
}

const TOOLS = {
  vmware_host_info: {
    name: "vmware_host_info",
    description: "معلومات جهاز Windows المضيف الذي يشغّل VMware Workstation (الاسم، الطراز، النظام، الذاكرة، المعالج).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => jsonContent(await hostInfo()),
  },
  vmware_list_vms: {
    name: "vmware_list_vms",
    description: "عرض الأجهزة الافتراضية التي تعمل وكل أجهزة VMware Workstation الموجودة.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => jsonContent(await listVms()),
  },
  vmware_vm_info: {
    name: "vmware_vm_info",
    description: "معلومات جهاز افتراضي محدد من ملف .vmx مع بيانات المضيف (يتعرف على المضيف من الـ VM).",
    inputSchema: {
      type: "object",
      properties: { vmx: { type: "string", description: "مسار .vmx أو displayName" } },
      required: ["vmx"],
      additionalProperties: false,
    },
    handler: async (args) => jsonContent(await vmInfo(args.vmx)),
  },
  vmware_get_guest_ip: {
    name: "vmware_get_guest_ip",
    description: "الحصول على عنوان IP للضيف عبر VMware Tools (لا يحتاج بيانات دخول).",
    inputSchema: {
      type: "object",
      properties: {
        vmx: { type: "string" },
        wait: { type: "boolean", description: "انتظار ظهور IP" },
      },
      required: ["vmx"],
      additionalProperties: false,
    },
    handler: async (args) => jsonContent(await getGuestIp(args.vmx, !!args.wait)),
  },
  vmware_check_tools: {
    name: "vmware_check_tools",
    description: "حالة VMware Tools داخل الجهاز الافتراضي.",
    inputSchema: {
      type: "object",
      properties: { vmx: { type: "string" } },
      required: ["vmx"],
      additionalProperties: false,
    },
    handler: async (args) => jsonContent(await checkTools(args.vmx)),
  },
  vmware_list_snapshots: {
    name: "vmware_list_snapshots",
    description: "عرض لقطات (snapshots) الجهاز الافتراضي.",
    inputSchema: {
      type: "object",
      properties: { vmx: { type: "string" } },
      required: ["vmx"],
      additionalProperties: false,
    },
    handler: async (args) => jsonContent(await listSnapshots(args.vmx)),
  },
  vmware_power: {
    name: "vmware_power",
    description: "تشغيل/إيقاف/تعليق/إعادة تشغيل جهاز افتراضي (start, stop, suspend, reset).",
    inputSchema: {
      type: "object",
      properties: {
        vmx: { type: "string" },
        action: { type: "string", enum: ["start", "stop", "suspend", "reset"] },
        soft: { type: "boolean", description: "إيقاف/إعادة تشغيل لطيف عبر VMware Tools" },
      },
      required: ["vmx", "action"],
      additionalProperties: false,
    },
    handler: async (args) => jsonContent(await power(args.vmx, args.action, !!args.soft)),
  },
  vmware_capture_screen: {
    name: "vmware_capture_screen",
    description: "التقاط صورة شاشة للجهاز الافتراضي (يتطلب بيانات دخول الضيف غالباً).",
    inputSchema: {
      type: "object",
      properties: {
        vmx: { type: "string" },
        output: { type: "string", description: "مسار حفظ الصورة على المضيف (اختياري)" },
        user: { type: "string" },
        password: { type: "string" },
      },
      required: ["vmx"],
      additionalProperties: false,
    },
    handler: async (args) => captureScreen(args.vmx, args.output, args.user, args.password),
  },
  vmware_run_guest_command: {
    name: "vmware_run_guest_command",
    description: "تشغيل أمر داخل ضيف Windows عبر VMware Tools. يتطلب بيانات دخول الضيف.",
    inputSchema: {
      type: "object",
      properties: {
        vmx: { type: "string" },
        command: { type: "string", description: "أمر cmd.exe" },
        program: { type: "string", description: "برنامج اختياري بدل cmd.exe" },
        args: { type: "array", items: { type: "string" }, description: "وسائط البرنامج" },
        user: { type: "string" },
        password: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["vmx"],
      additionalProperties: false,
    },
    handler: async (args) =>
      runGuestCommand(args.vmx, args.command, args.program, args.args, args.user, args.password, args.timeoutMs),
  },
  vmware_detect_virtualization: {
    name: "vmware_detect_virtualization",
    description:
      "جمع بصمات من داخل ضيف Windows: هل هو VMware، بيانات BIOS/اللوحة، VMware Tools، MAC، والبوابة ومحاولة كشف اسم المضيف عبر NetBIOS/DNS. يتطلب بيانات دخول الضيف.",
    inputSchema: {
      type: "object",
      properties: {
        vmx: { type: "string" },
        user: { type: "string" },
        password: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["vmx"],
      additionalProperties: false,
    },
    handler: async (args) => detectVirtualization(args.vmx, args.user, args.password, args.timeoutMs),
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = message;
  try {
    if (method === "initialize") {
      return result(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "vmware-mcp", version: "1.0.0" },
      });
    }
    if (method === "notifications/initialized") return;
    if (method === "ping") return result(id, {});
    if (method === "tools/list") {
      return result(id, {
        tools: Object.values(TOOLS).map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    }
    if (method === "tools/call") {
      const tool = TOOLS[params?.name];
      if (!tool) return error(id, -32602, `أداة غير معروفة: ${params?.name}`);
      const value = await tool.handler(params?.arguments || {});
      return result(id, value);
    }
    if (method === "resources/list") return result(id, { resources: [] });
    if (method === "prompts/list") return result(id, { prompts: [] });
    if (id !== undefined) error(id, -32601, `method غير مدعوم: ${method}`);
  } catch (err) {
    if (id !== undefined) error(id, -32603, err?.message || String(err));
    log("error:", err?.stack || err?.message || String(err));
  }
});
