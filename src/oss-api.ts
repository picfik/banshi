import type { Analysis, CaseRecord, HandlingPath, ProcurementMode, ProcurementStep, Stage, Step, TemporaryTodo } from "./types";
import { getObjectKey, getOssClient, signOssObject } from "./oss";
import { ApiError } from "./api-error";
import { getDefaultAiPreferences, type AiPreferences } from "./ai";
import {
  isSupportedAttachmentName,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENT_TEXT_PREVIEW_CHARS,
} from "../shared/attachments.js";

type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  caseId: string | null;
  detail: Record<string, unknown>;
  at: string;
};
type StoredAttachment = CaseRecord["steps"][number]["attachments"][number] & {
  extractedText?: string;
  localPath?: string;
};
type StoredCase = CaseRecord & { createdBy?: string };
type StoredData = {
  version: 1;
  cases: StoredCase[];
  todos: TemporaryTodo[];
  audit: AuditEntry[];
  settings: { procurementModes: ProcurementMode[]; ai: AiPreferences };
  sync: { status: "success" | "failed" | "syncing" | "not_configured"; message: string; updatedAt: string | null };
};
type SyncStatus = StoredData["sync"];

const ACTOR = "用户";
const MAX_FILE_SIZE = MAX_ATTACHMENT_SIZE_BYTES;
const stages: Stage[] = [
  { id: "source", title: "事项来源", steps: [
    { id: "source-register", title: "登记事项来源", guidance: "记录来文、来电、交办或其他事项来源及接收时间。" },
    { id: "source-verify", title: "核实事项信息", guidance: "核对事项主体、诉求、时限和所附材料是否完整。" },
  ] },
  { id: "processing", title: "办理流程", steps: [
    { id: "process-assign", title: "明确承办安排", guidance: "记录承办人员、办理分工和计划时限。" },
    { id: "process-handle", title: "开展办理并记录依据", guidance: "记录办理过程、适用依据和需进一步核实的问题。" },
    { id: "process-check", title: "复核办理情况", guidance: "核对办理记录、依据材料及尚未解决事项。" },
  ] },
  { id: "closure", title: "最终闭环", steps: [
    { id: "closure-feedback", title: "反馈办理结果", guidance: "记录结果反馈对象、时间、方式及反馈内容。" },
    { id: "closure-archive", title: "确认归档闭环", guidance: "由经办人员确认材料齐备，并由工作人员作最终人工确认。", requiresReview: true },
  ] },
];
const handlingPaths: HandlingPath[] = [
  { id: "ordinary", title: "普通办理", procurement: false },
  { id: "direct-delegation", title: "直接委托", procurement: true },
  { id: "inquiry-comparison", title: "询价比价", procurement: true },
  { id: "open-tender", title: "公开招标", procurement: true },
  { id: "reverse-auction", title: "反向竞价", procurement: true },
];
const defaultModes: ProcurementMode[] = [
  { id: "direct-delegation", title: "直接委托", steps: [
    { id: "direct-need", title: "核对需求与适用依据", guidance: "记录需求、依据和经办核对情况。" },
    { id: "direct-approval", title: "履行内部审批并确认受托方", guidance: "记录本单位审批及委托对象确认情况。" },
    { id: "direct-contract", title: "签订合同或订单", guidance: "记录合同或订单办理情况及相关材料。" },
    { id: "direct-acceptance", title: "验收并归档办理材料", guidance: "记录验收、资料归档和后续事项。" },
  ] },
  { id: "inquiry-comparison", title: "询价比价", steps: [
    { id: "inquiry-need", title: "明确需求和询价范围", guidance: "记录需求、询价范围及经办核对情况。" },
    { id: "inquiry-quotes", title: "询价并记录报价", guidance: "记录询价对象、报价信息和相关依据。" },
    { id: "inquiry-compare", title: "比价并形成比较记录", guidance: "记录比较过程、结果及需要核实事项。" },
    { id: "inquiry-approval", title: "履行审批并确认供应方", guidance: "记录本单位审批和供应方确认情况。" },
    { id: "inquiry-contract", title: "签订合同或订单", guidance: "记录合同或订单办理情况。" },
    { id: "inquiry-acceptance", title: "验收并归档办理材料", guidance: "记录验收、资料归档和后续事项。" },
  ] },
  { id: "open-tender", title: "公开招标", steps: [
    { id: "tender-document", title: "准备采购文件和评审条件", guidance: "记录文件准备、需求核对和相关依据。" },
    { id: "tender-approval", title: "履行采购文件及程序审批", guidance: "记录本单位审批及文件确认情况。" },
    { id: "tender-publish", title: "发布信息并组织投标", guidance: "记录信息发布、投标组织和过程材料。" },
    { id: "tender-evaluate", title: "开标评审并记录过程", guidance: "记录开标评审过程、结果和需要核实事项。" },
    { id: "tender-result", title: "确认结果并办理通知", guidance: "记录结果确认、公示或通知等办理情况。" },
    { id: "tender-contract", title: "签订合同", guidance: "记录合同办理情况及相关材料。" },
    { id: "tender-acceptance", title: "验收并归档办理材料", guidance: "记录验收、资料归档和后续事项。" },
  ] },
  { id: "reverse-auction", title: "反向竞价", steps: [
    { id: "auction-need", title: "确认竞价标的和资格条件", guidance: "记录竞价标的、需求和条件核对情况。" },
    { id: "auction-approval", title: "履行方案审批并发布信息", guidance: "记录本单位审批及信息发布情况。" },
    { id: "auction-process", title: "组织竞价并记录过程", guidance: "记录竞价过程、报价和相关材料。" },
    { id: "auction-result", title: "确认竞价结果并履行审批", guidance: "记录结果核对、确认和审批情况。" },
    { id: "auction-contract", title: "签订合同或订单", guidance: "记录合同或订单办理情况。" },
    { id: "auction-acceptance", title: "验收并归档办理材料", guidance: "记录验收、资料归档和后续事项。" },
  ] },
];

let data: StoredData | null = null;
let loading: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function syncStatus(status: SyncStatus): void {
  window.dispatchEvent(new CustomEvent("oss-sync-status", { detail: status }));
}

function newData(): StoredData {
  return {
    version: 1,
    cases: [],
    todos: [],
    audit: [],
    settings: { procurementModes: structuredClone(defaultModes), ai: getDefaultAiPreferences() },
    sync: { status: "syncing", message: "正在从 OSS 初始化数据", updatedAt: new Date().toISOString() },
  };
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return value.code === "NoSuchKey" || value.status === 404 || value.statusCode === 404;
}

async function readJson<T>(key: string): Promise<T> {
  const result = await getOssClient().get(getObjectKey(key));
  const content: unknown = result.content;
  const text = typeof content === "string"
    ? content
    : content instanceof Blob
      ? await content.text()
      : content instanceof ArrayBuffer || ArrayBuffer.isView(content)
        ? new TextDecoder().decode(content)
        : null;
  if (text === null) throw new Error(`OSS 对象内容无法读取：${key}`);
  return JSON.parse(text) as T;
}

async function writeJson(snapshot: StoredData): Promise<void> {
  await getOssClient().put(getObjectKey("data/cases.json"), new Blob(
    [JSON.stringify(snapshot, null, 2)],
    { type: "application/json; charset=utf-8" },
  ), { headers: { "Cache-Control": "no-store" } });
}

async function ensureLoaded(): Promise<void> {
  if (data) return;
  if (!loading) {
    loading = (async () => {
      try {
        const remote = await readJson<StoredData>("data/cases.json");
        if (!remote || remote.version !== 1 || !Array.isArray(remote.cases) || !Array.isArray(remote.audit)) {
          throw new Error("OSS 业务 JSON 结构无效；为避免覆盖数据，已停止加载");
        }
        remote.settings ??= {
          procurementModes: structuredClone(defaultModes),
          ai: getDefaultAiPreferences(),
        };
        if (!Array.isArray(remote.todos)) remote.todos = [];
        remote.todos.forEach((todo) => {
          todo.isCompleted = Boolean(todo.isCompleted);
          todo.completedAt = todo.completedAt ?? null;
        });
        remote.settings.ai ??= getDefaultAiPreferences();
        if (!Array.isArray(remote.settings.procurementModes)) throw new Error("OSS 采购路径配置无效");
        if (!isAiPreferences(remote.settings.ai)) throw new Error("OSS AI 服务配置无效");
        remote.cases.forEach((record) => {
          record.isOnHold = Boolean(record.isOnHold);
          record.isImportant = Boolean(record.isImportant) && !record.isOnHold;
          record.handlingPath ??= null;
          const processStep = record.steps?.find((step) => step.id === "process-handle");
          if (processStep && !Array.isArray(processStep.procurementSteps)) processStep.procurementSteps = [];
          for (const procurementStep of processStep?.procurementSteps ?? []) {
            if (!Array.isArray(procurementStep.attachments)) procurementStep.attachments = [];
          }
        });
        remote.sync = { status: "success", message: "已从 OSS 读取最新数据", updatedAt: new Date().toISOString() };
        data = remote;
        syncStatus(data.sync);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        data = newData();
        await save();
      }
    })().catch((error: unknown) => {
      loading = null;
      data = null;
      throw error;
    });
  }
  await loading;
}

function currentData(): StoredData {
  if (!data) throw new Error("OSS 数据尚未加载");
  return data;
}

async function save(): Promise<SyncStatus> {
  const store = currentData();
  const operation = writeQueue.then(async () => {
    const now = new Date().toISOString();
    store.sync = { status: "syncing", message: "正在上传业务 JSON 到 OSS", updatedAt: now };
    syncStatus(store.sync);
    try {
      const snapshot: StoredData = {
        ...store,
        sync: { status: "success", message: "OSS 同步成功", updatedAt: new Date().toISOString() },
      };
      await writeJson(snapshot);
      store.sync = snapshot.sync;
      syncStatus(store.sync);
      return store.sync;
    } catch (error) {
      store.sync = { status: "failed", message: "OSS 同步失败；本次更改尚未确认写入", updatedAt: new Date().toISOString() };
      syncStatus(store.sync);
      throw new ApiError(
        `${store.sync.message}：${error instanceof Error ? error.message : String(error)}`,
        502,
        "OSS_SYNC_FAILED",
      );
    }
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function addAudit(action: string, caseId: string | null, detail: Record<string, unknown> = {}): void {
  currentData().audit.push({ id: crypto.randomUUID(), actor: ACTOR, action, caseId, detail, at: new Date().toISOString() });
}

function getCase(caseId: string): StoredCase {
  const record = currentData().cases.find((item) => item.id === caseId);
  if (!record) throw new ApiError("未找到该事项", 404, "CASE_NOT_FOUND");
  return record;
}

function getStep(record: StoredCase, stepId: string): Step {
  const step = record.steps.find((item) => item.id === stepId);
  if (!step) throw new ApiError("未找到该办理步骤", 404, "STEP_NOT_FOUND");
  return step;
}

function getAttachmentOwner(step: Step, procurementStepId: string | null): Step | ProcurementStep {
  if (!procurementStepId) return step;
  if (step.id !== "process-handle") error(404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
  const procurementStep = step.procurementSteps?.find((item) => item.id === procurementStepId);
  if (!procurementStep) error(404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
  procurementStep.attachments ??= [];
  return procurementStep;
}

function allStoredAttachments(record: StoredCase): StoredAttachment[] {
  return record.steps.flatMap((step) => [
    ...(step.attachments as StoredAttachment[]),
    ...(step.procurementSteps ?? []).flatMap((procurementStep) => (procurementStep.attachments ?? []) as StoredAttachment[]),
  ]);
}

function currentStep(record: StoredCase): Step | null {
  return record.steps.find((step) => step.status !== "completed") ?? null;
}

function publicCase(record: StoredCase): CaseRecord {
  return {
    ...record,
    steps: record.steps.map((step) => ({
      ...step,
      attachments: (step.attachments as StoredAttachment[]).map(({ extractedText: _text, localPath: _path, ...attachment }) => attachment),
      ...(Array.isArray(step.procurementSteps) ? {
        procurementSteps: step.procurementSteps.map((procurementStep) => ({
          ...procurementStep,
          attachments: ((procurementStep.attachments ?? []) as StoredAttachment[]).map(({ extractedText: _text, localPath: _path, ...attachment }) => attachment),
        })),
      } : {}),
    })),
  };
}

function publicCases() {
  return [...currentData().cases]
    .sort((a, b) =>
      Number(Boolean(a.isOnHold)) - Number(Boolean(b.isOnHold)) ||
      Number(Boolean(b.isImportant)) - Number(Boolean(a.isImportant)) ||
      b.updatedAt.localeCompare(a.updatedAt),
    )
    .map(publicCase);
}

function getSync() {
  return currentData().sync;
}

function requireCurrent(record: StoredCase, step: Step): void {
  if (step.status === "completed") throw new ApiError("已完成步骤不能直接修改", 409, "STEP_COMPLETED");
  if (currentStep(record)?.id !== step.id) throw new ApiError("请先完成前序步骤", 409, "STEP_NOT_CURRENT");
}

function createRecord(input: { title: string; source: string; description: string }): StoredCase {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), title: input.title.trim(), description: input.description.trim(),
    source: input.source.trim(), isImportant: false, isOnHold: false,
    createdAt: now, updatedAt: now, handlingPath: null, createdBy: ACTOR,
    steps: stages.flatMap((stage) => stage.steps.map((step) => ({
      ...step, stageId: stage.id, stageTitle: stage.title, status: "pending" as const, note: "",
      completedAt: null, completedBy: null, attachments: [], humanReview: null,
      ...(step.id === "process-handle" ? { procurementSteps: [] } : {}),
    }))),
  };
}

function createProcurementSteps(mode: ProcurementMode) {
  return mode.steps.map((step) => ({
    id: crypto.randomUUID(), templateId: step.id, title: step.title, guidance: step.guidance,
    status: "pending" as const, note: "", completedAt: null, completedBy: null,
    attachments: [],
  }));
}

function isProcurement(pathId: string | null): boolean {
  return handlingPaths.some((path) => path.id === pathId && path.procurement);
}

function error(status: number, code: string, message: string): never {
  throw new ApiError(message, status, code);
}

function isAiPreferences(value: unknown): value is AiPreferences {
  if (!value || typeof value !== "object") return false;
  const preferences = value as Record<string, unknown>;
  return ["aliyun", "tencent"].includes(String(preferences.provider)) &&
    typeof preferences.apiKey === "string" &&
    typeof preferences.model === "string" &&
    Boolean(preferences.model.trim());
}

function parseJsonBody(options: RequestInit): Record<string, unknown> {
  if (typeof options.body !== "string" || !options.body) return {};
  try {
    const parsed: unknown = JSON.parse(options.body);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return error(400, "INVALID_JSON", "请求 JSON 格式无效");
  }
}

function validateModes(input: unknown): ProcurementMode[] {
  if (!Array.isArray(input) || input.length !== defaultModes.length) return error(400, "INVALID_PROCUREMENT_SETTINGS", "必须为四种采购模式分别配置步骤");
  const supplied = new Map(input.map((mode) => [(mode as ProcurementMode)?.id, mode as ProcurementMode]));
  if (supplied.size !== defaultModes.length || defaultModes.some((mode) => !supplied.has(mode.id))) {
    return error(400, "INVALID_PROCUREMENT_SETTINGS", "采购模式配置不完整或包含重复模式");
  }
  return defaultModes.map((mode) => {
    const value = supplied.get(mode.id)!;
    if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 50) {
      return error(400, "INVALID_PROCUREMENT_SETTINGS", `${mode.title}至少需要 1 个步骤，最多 50 个步骤`);
    }
    return {
      ...mode,
      steps: value.steps.map((step, index) => {
        if (!step.title?.trim() || step.title.trim().length > 120 || typeof step.guidance !== "string" || step.guidance.length > 2000) {
          return error(400, "INVALID_PROCUREMENT_SETTINGS", `${mode.title}第 ${index + 1} 步名称必填且说明不能超过 2000 个字符`);
        }
        return { id: `${mode.id}-${index + 1}`, title: step.title.trim(), guidance: step.guidance.trim() };
      }),
    };
  });
}

function search(query: string) {
  const term = query.toLocaleLowerCase();
  const results: Array<{ caseId: string; caseTitle: string; stepId: string | null; stepTitle: string | null; field: string; snippet: string }> = [];
  const add = (record: StoredCase, step: Step | null, field: string, value: unknown) => {
    if (typeof value !== "string" || !value) return;
    const index = value.toLocaleLowerCase().indexOf(term);
    if (index < 0) return;
    const start = Math.max(0, index - 55);
    const end = Math.min(value.length, index + term.length + 95);
    results.push({
      caseId: record.id, caseTitle: record.title, stepId: step?.id ?? null, stepTitle: step?.title ?? null, field,
      snippet: `${start ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`,
    });
  };
  for (const record of currentData().cases) {
    add(record, null, "事项名称", record.title);
    add(record, null, "事项说明", record.description);
    add(record, null, "事项来源", record.source);
    add(record, null, "办理路径", handlingPaths.find((item) => item.id === record.handlingPath)?.title);
    for (const step of record.steps) {
      add(record, step, "办理步骤", step.title);
      add(record, step, "办理提示", step.guidance);
      add(record, step, "办理记录", step.note);
      for (const attachment of step.attachments as StoredAttachment[]) {
        add(record, step, "材料名称", attachment.filename);
        add(record, step, "材料文本", attachment.extractedText);
        if (attachment.analysis) {
          add(record, step, "AI 材料摘要", attachment.analysis.summary);
          for (const [label, values] of [["AI 关键信息", attachment.analysis.keyFacts], ["AI 待核对点", attachment.analysis.checks], ["AI 下一步建议", attachment.analysis.nextSteps], ["AI 注意事项", attachment.analysis.cautions], ["AI 人工核实项", attachment.analysis.humanVerification]] as const) {
            values?.forEach((value) => add(record, step, label, value));
          }
        }
      }
      for (const item of step.procurementSteps ?? []) {
        add(record, step, `采购步骤：${item.title}`, item.note);
        add(record, step, "采购步骤名称", item.title);
        for (const attachment of (item.attachments ?? []) as StoredAttachment[]) {
          add(record, step, "采购步骤材料", attachment.filename);
          add(record, step, "采购步骤材料文本", attachment.extractedText);
        }
      }
    }
  }
  return results;
}

function updateRecord(record: StoredCase): void {
  record.updatedAt = new Date().toISOString();
}

function setStepNote(record: StoredCase, step: Step, body: Record<string, unknown>): void {
  requireCurrent(record, step);
  if (typeof body.note !== "string" || body.note.length > 10000) error(400, "INVALID_NOTE", "办理记录格式无效或超过 10000 个字符");
  let selectedPath: HandlingPath | undefined;
  if (body.handlingPath !== undefined) {
    if (step.id !== "process-assign") error(400, "HANDLING_PATH_NOT_ALLOWED", "办理路径只能在“明确承办安排”步骤设置");
    selectedPath = handlingPaths.find((item) => item.id === body.handlingPath);
    if (!selectedPath) error(400, "INVALID_HANDLING_PATH", "请选择有效的办理路径");
    const mode = currentData().settings.procurementModes.find((item) => item.id === selectedPath!.id);
    if (selectedPath.procurement && (!mode || mode.steps.length === 0)) error(409, "PROCUREMENT_MODE_UNCONFIGURED", "该采购模式尚未配置办理步骤，请先到流程设置页完成配置");
    const nested = record.steps.find((item) => item.id === "process-handle")?.procurementSteps ?? [];
    if (record.handlingPath && record.handlingPath !== selectedPath.id && nested.some((item) =>
      item.status === "completed" || item.note.trim() || item.attachments?.length,
    )) {
      error(409, "HANDLING_PATH_LOCKED", "采购办理已开始，不能更换办理路径；如需变更请按单位流程处理");
    }
  }
  step.note = body.note;
  if (selectedPath && record.handlingPath !== selectedPath.id) {
    record.handlingPath = selectedPath.id;
    const process = record.steps.find((item) => item.id === "process-handle")!;
    process.procurementSteps = selectedPath.procurement
      ? createProcurementSteps(currentData().settings.procurementModes.find((mode) => mode.id === selectedPath!.id)!)
      : [];
  }
  updateRecord(record);
  addAudit("step_note_updated", record.id, { stepId: step.id, ...(selectedPath ? { handlingPath: selectedPath.id } : {}) });
}

async function handleApi(url: string, options: RequestInit): Promise<unknown> {
  await ensureLoaded();
  const parsedUrl = new URL(url, window.location.origin);
  const method = (options.method ?? "GET").toUpperCase();
  const segments = parsedUrl.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const body = parseJsonBody(options);
  const response = (record?: StoredCase) => ({ case: publicCase(record!), sync: getSync() });

  if (method === "GET" && segments.join("/") === "api/config") {
    const aiPreferences = currentData().settings.ai;
    return {
      username: ACTOR, stages, handlingPaths,
      procurementModes: currentData().settings.procurementModes,
      aiPreferences,
      aiEnabled: Boolean(aiPreferences.apiKey),
      fileLimitBytes: MAX_FILE_SIZE,
    };
  }
  if (method === "GET" && segments.join("/") === "api/cases") return { cases: publicCases(), sync: getSync() };
  if (method === "GET" && segments.join("/") === "api/audit") return { audit: [...currentData().audit].slice(-500).reverse() };
  if (method === "GET" && segments.join("/") === "api/todos") {
    return { todos: [...currentData().todos].sort((a, b) =>
      Number(Boolean(a.isCompleted)) - Number(Boolean(b.isCompleted)) ||
      a.dueDate.localeCompare(b.dueDate) ||
      b.updatedAt.localeCompare(a.updatedAt),
    ) };
  }
  if (method === "POST" && segments.join("/") === "api/todos") {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const dueDate = typeof body.dueDate === "string" ? body.dueDate : "";
    const assignee = typeof body.assignee === "string" ? body.assignee.trim() : "";
    if (!title || title.length > 160) error(400, "INVALID_TODO_TITLE", "事件名称必填且不能超过 160 个字符");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) error(400, "INVALID_TODO_DUE_DATE", "请选择有效的截止日期");
    if (!assignee || assignee.length > 80) error(400, "INVALID_TODO_ASSIGNEE", "经办人必填且不能超过 80 个字符");
    const now = new Date().toISOString();
    const todo: TemporaryTodo = { id: crypto.randomUUID(), title, dueDate, assignee, isCompleted: false, completedAt: null, createdAt: now, updatedAt: now };
    currentData().todos.push(todo);
    addAudit("todo_created", null, { todoId: todo.id, title, dueDate, assignee });
    return { todo, sync: await save() };
  }
  if (segments.length === 3 && segments[0] === "api" && segments[1] === "todos" && method === "PATCH") {
    const todo = currentData().todos.find((item) => item.id === segments[2]);
    if (!todo) error(404, "TODO_NOT_FOUND", "未找到该临时待办");
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const dueDate = typeof body.dueDate === "string" ? body.dueDate : "";
    const assignee = typeof body.assignee === "string" ? body.assignee.trim() : "";
    if (!title || title.length > 160) error(400, "INVALID_TODO_TITLE", "事件名称必填且不能超过 160 个字符");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) error(400, "INVALID_TODO_DUE_DATE", "请选择有效的截止日期");
    if (!assignee || assignee.length > 80) error(400, "INVALID_TODO_ASSIGNEE", "经办人必填且不能超过 80 个字符");
    if (body.isCompleted !== undefined && typeof body.isCompleted !== "boolean") error(400, "INVALID_TODO_STATUS", "待办完成状态必须为布尔值");
    if (body.isCompleted !== undefined) {
      todo.isCompleted = body.isCompleted;
      todo.completedAt = body.isCompleted ? new Date().toISOString() : null;
    }
    Object.assign(todo, { title, dueDate, assignee, updatedAt: new Date().toISOString() });
    addAudit("todo_updated", null, { todoId: todo.id, title, dueDate, assignee });
    return { todo, sync: await save() };
  }
  if (segments.length === 3 && segments[0] === "api" && segments[1] === "todos" && method === "DELETE") {
    const todo = currentData().todos.find((item) => item.id === segments[2]);
    if (!todo) error(404, "TODO_NOT_FOUND", "未找到该临时待办");
    currentData().todos = currentData().todos.filter((item) => item.id !== todo.id);
    addAudit("todo_deleted", null, { todoId: todo.id, title: todo.title });
    await save();
    return { ok: true };
  }
  if (method === "GET" && segments.join("/") === "api/search") {
    const query = (parsedUrl.searchParams.get("q") ?? "").trim();
    if (!query || query.length > 120) error(400, "INVALID_SEARCH_QUERY", "请输入 1 至 120 个字符的搜索内容");
    const results = search(query);
    return { query, total: results.length, results: results.slice(0, 100) };
  }
  if (segments[0] !== "api" || segments[1] !== "cases") {
    if (method === "GET" && segments.join("/") === "api/settings/procurement") return { modes: currentData().settings.procurementModes };
    if (method === "PUT" && segments.join("/") === "api/settings/procurement") {
      const modes = validateModes(body.modes);
      currentData().settings.procurementModes = modes;
      addAudit("procurement_settings_updated", null, { modes: modes.map((mode) => ({ id: mode.id, stepCount: mode.steps.length })) });
      return { modes, sync: await save() };
    }
    if (method === "PUT" && segments.join("/") === "api/settings/ai") {
      const input = {
        provider: body.provider,
        apiKey: body.apiKey,
        model: body.model,
      };
      if (!isAiPreferences(input)) {
        error(400, "INVALID_AI_SETTINGS", "请选择 AI 服务商并填写模型名称");
      }
      const previous = currentData().settings.ai;
      const ai = {
        provider: input.provider,
        apiKey: input.apiKey.trim(),
        model: input.model.trim(),
      };
      currentData().settings.ai = ai;
      const auditLength = currentData().audit.length;
      addAudit("ai_settings_updated", null, { provider: ai.provider, model: ai.model });
      try {
        const sync = await save();
        return { aiPreferences: ai, aiEnabled: Boolean(ai.apiKey), sync };
      } catch (reason) {
        currentData().settings.ai = previous;
        currentData().audit.length = auditLength;
        throw reason;
      }
    }
    if (method === "POST" && segments.join("/") === "api/sync/retry") {
      addAudit("oss_sync_retried", null);
      const sync = await save();
      return { sync };
    }
    error(404, "NOT_FOUND", "请求的功能不存在");
  }

  if (segments.length === 2 && method === "POST") {
    const title = body.title;
    const source = body.source;
    const description = body.description ?? "";
    if (typeof title !== "string" || !title.trim() || title.trim().length > 160) error(400, "INVALID_TITLE", "事项名称必填且不能超过 160 个字符");
    if (typeof source !== "string" || !source.trim() || source.trim().length > 2000) error(400, "INVALID_SOURCE", "事项来源必填且不能超过 2000 个字符");
    if (typeof description !== "string" || description.length > 5000) error(400, "INVALID_DESCRIPTION", "事项说明不能超过 5000 个字符");
    const record = createRecord({ title, source, description });
    currentData().cases.push(record);
    addAudit("case_created", record.id);
    return { case: publicCase(record), sync: await save() };
  }
  if (segments.length === 3 && method === "DELETE") {
    const record = getCase(segments[2]);
    const keys = [...new Set(allStoredAttachments(record).map((item) => item.objectKey))];
    const removableKeys = keys.filter((key) => !currentData().cases.some((other) =>
      other.id !== record.id && allStoredAttachments(other).some((item) => item.objectKey === key),
    ));
    const previousCases = currentData().cases;
    const auditLength = currentData().audit.length;
    currentData().cases = previousCases.filter((item) => item.id !== record.id);
    addAudit("case_deleted", record.id, { preservedSharedAttachments: keys.length - removableKeys.length });
    let sync: SyncStatus;
    try {
      sync = await save();
    } catch (reason) {
      currentData().cases = previousCases;
      currentData().audit.length = auditLength;
      throw reason;
    }
    const cleanupErrors: string[] = [];
    for (const key of removableKeys) {
      try {
        await getOssClient().delete(key);
      } catch (reason) {
        cleanupErrors.push(`${key}: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
    return {
      sync,
      deletedAttachmentCount: removableKeys.length - cleanupErrors.length,
      preservedAttachmentCount: keys.length - removableKeys.length,
      cleanupErrors,
    };
  }
  if (segments.length === 3 && method === "GET") {
    return response(getCase(segments[2]));
  }
  if (segments.length === 3 && method === "PATCH") {
    const record = getCase(segments[2]);
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160) {
      error(400, "INVALID_TITLE", "事项名称必填且不能超过 160 个字符");
    }
    const previousTitle = record.title;
    record.title = body.title.trim();
    updateRecord(record);
    addAudit("case_renamed", record.id, { previousTitle, title: record.title });
    return { case: publicCase(record), sync: await save() };
  }
  if (segments.length < 4) error(404, "NOT_FOUND", "请求的功能不存在");
  const record = getCase(segments[2]);
  const resource = segments[3];

  if (resource === "analysis" && segments.length === 4 && ["PUT", "PATCH"].includes(method)) {
    const analysis = body.analysis as Analysis | undefined;
    const listFields = ["keyFacts", "checks", "nextSteps", "cautions", "humanVerification"] as const;
    if (
      !analysis || typeof analysis !== "object" || typeof analysis.summary !== "string" ||
      typeof analysis.disclaimer !== "string" || typeof analysis.generatedAt !== "string" ||
      listFields.some((field) => !Array.isArray(analysis[field]) || analysis[field].some((item) => typeof item !== "string"))
    ) {
      error(400, "INVALID_ANALYSIS", "事项综合解读内容无效");
    }
    record.aiAnalysis = analysis;
    updateRecord(record);
    addAudit("case_ai_analysis_saved", record.id, { generatedAt: analysis.generatedAt });
    return { case: publicCase(record), sync: await save() };
  }

  if (resource === "flags" && segments.length === 4 && method === "PATCH") {
    if (
      typeof body.isImportant !== "boolean" || typeof body.isOnHold !== "boolean" ||
      (body.isImportant && body.isOnHold)
    ) {
      error(400, "INVALID_CASE_FLAGS", "事项重要和搁置状态必须是布尔值且只能选择一项");
    }
    record.isImportant = body.isImportant;
    record.isOnHold = body.isOnHold;
    updateRecord(record);
    addAudit("case_flags_updated", record.id, { isImportant: record.isImportant, isOnHold: record.isOnHold });
    return { case: publicCase(record), sync: await save() };
  }

  if (resource === "steps" && segments.length === 5 && method === "PATCH") {
    const step = getStep(record, segments[4]);
    setStepNote(record, step, body);
    return { case: publicCase(record), sync: await save() };
  }
  if (resource === "steps" && segments.length === 6 && segments[5] === "complete" && method === "POST") {
    const step = getStep(record, segments[4]);
    if (currentStep(record)?.id !== step.id) error(409, "STEP_NOT_CURRENT", "必须按顺序完成前序步骤后才能推进");
    if (!step.note.trim()) error(400, "NOTE_REQUIRED", "请先填写办理记录");
    if (step.id === "process-assign" && !record.handlingPath) error(400, "HANDLING_PATH_REQUIRED", "请先选择办理路径");
    if (step.id === "process-handle" && isProcurement(record.handlingPath)) {
      const pending = (step.procurementSteps ?? []).find((item) => item.status !== "completed");
      if (!step.procurementSteps?.length) error(409, "PROCUREMENT_STEPS_NOT_CONFIGURED", "当前采购模式没有可办理步骤，请先检查模式配置");
      if (pending) error(409, "PROCUREMENT_STEPS_INCOMPLETE", `请先按顺序完成采购步骤：“${pending.title}”`);
    }
    if (step.requiresReview && step.humanReview?.decision !== "approved") error(409, "REVIEW_REQUIRED", "最终闭环须先由工作人员人工确认");
    step.status = "completed";
    step.completedAt = new Date().toISOString();
    step.completedBy = ACTOR;
    record.updatedAt = step.completedAt;
    addAudit("step_completed", record.id, { stepId: step.id });
    return { case: publicCase(record), sync: await save() };
  }
  if (resource === "steps" && segments.length === 6 && segments[5] === "reopen" && method === "POST") {
    const index = record.steps.findIndex((step) => step.id === segments[4]);
    if (index < 0) error(404, "STEP_NOT_FOUND", "未找到该办理步骤");
    if (body.confirm !== true) error(400, "CONFIRM_REQUIRED", "重新打开步骤需要明确确认");
    if (record.steps[index].status !== "completed") error(409, "STEP_NOT_COMPLETED", "该步骤尚未完成");
    const reopened = record.steps.slice(index);
    for (const step of reopened) {
      step.status = "pending"; step.completedAt = null; step.completedBy = null; step.humanReview = null;
      for (const item of step.procurementSteps ?? []) { item.status = "pending"; item.completedAt = null; item.completedBy = null; }
    }
    updateRecord(record);
    addAudit("step_reopened", record.id, { stepId: record.steps[index].id, resetSteps: reopened.map((step) => step.id) });
    return { case: publicCase(record), sync: await save() };
  }
  if (resource === "steps" && segments.length === 6 && segments[5] === "review" && method === "POST") {
    const step = getStep(record, segments[4]);
    if (!step.requiresReview) error(400, "REVIEW_NOT_REQUIRED", "此步骤不需要最终闭环确认");
    if (currentStep(record)?.id !== step.id) error(409, "STEP_NOT_CURRENT", "请按顺序办理后再进行最终确认");
    const decision = body.decision;
    const comment = body.comment ?? "";
    if (!["approved", "returned"].includes(String(decision)) || typeof comment !== "string" || comment.length > 3000) error(400, "INVALID_REVIEW", "确认结果或说明无效");
    if (decision === "returned" && !comment.trim()) error(400, "REVIEW_COMMENT_REQUIRED", "退回时请填写原因");
    step.humanReview = { decision: decision as "approved" | "returned", comment, reviewer: ACTOR, reviewedAt: new Date().toISOString() };
    updateRecord(record);
    addAudit(decision === "approved" ? "final_review_approved" : "final_review_returned", record.id, { stepId: step.id });
    return { case: publicCase(record), sync: await save() };
  }
  if (resource === "procurement-steps" && segments.length === 5 && method === "PATCH") {
    const handleStep = record.steps.find((step) => step.id === "process-handle");
    const procurementStep = handleStep?.procurementSteps?.find((item) => item.id === segments[4]);
    if (!procurementStep) error(404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    if (currentStep(record)?.id !== "process-handle") error(409, "PROCUREMENT_STAGE_NOT_CURRENT", "请先完成前序办理步骤");
    if (handleStep?.procurementSteps?.find((item) => item.status !== "completed")?.id !== procurementStep.id) error(409, "PROCUREMENT_STEP_NOT_CURRENT", "必须完成前一个采购步骤后才能记录此步骤");
    if (typeof body.note !== "string" || body.note.length > 10000) error(400, "INVALID_NOTE", "采购步骤记录格式无效或超过 10000 个字符");
    procurementStep.note = body.note;
    updateRecord(record);
    addAudit("procurement_step_note_updated", record.id, { handlingPath: record.handlingPath, stepId: procurementStep.id });
    return { case: publicCase(record), sync: await save() };
  }
  if (resource === "procurement-steps" && segments.length === 6 && segments[5] === "complete" && method === "POST") {
    const handleStep = record.steps.find((step) => step.id === "process-handle");
    const procurementStep = handleStep?.procurementSteps?.find((item) => item.id === segments[4]);
    if (!procurementStep) error(404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    if (currentStep(record)?.id !== "process-handle") error(409, "PROCUREMENT_STAGE_NOT_CURRENT", "请先完成前序办理步骤");
    if (handleStep?.procurementSteps?.find((item) => item.status !== "completed")?.id !== procurementStep.id) error(409, "PROCUREMENT_STEP_NOT_CURRENT", "必须完成前一个采购步骤后才能推进");
    if (!procurementStep.note.trim()) error(400, "NOTE_REQUIRED", "请先填写本采购步骤的办理记录");
    procurementStep.status = "completed"; procurementStep.completedAt = new Date().toISOString(); procurementStep.completedBy = ACTOR;
    record.updatedAt = procurementStep.completedAt;
    addAudit("procurement_step_completed", record.id, { handlingPath: record.handlingPath, stepId: procurementStep.id });
    return { case: publicCase(record), sync: await save() };
  }
  if (resource === "procurement-steps" && segments.length === 6 && segments[5] === "reopen" && method === "POST") {
    const handleStep = record.steps.find((step) => step.id === "process-handle");
    const procurementStep = handleStep?.procurementSteps?.find((item) => item.id === segments[4]);
    if (!handleStep || !procurementStep) error(404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    if (body.confirm !== true) error(400, "CONFIRM_REQUIRED", "退回采购步骤修改需要明确确认");
    if (procurementStep.status !== "completed") error(409, "PROCUREMENT_STEP_NOT_COMPLETED", "只有已完成的采购步骤可以退回修改");
    if (handleStep.status !== "completed" && currentStep(record)?.id !== handleStep.id) {
      error(409, "PROCUREMENT_STAGE_NOT_CURRENT", "请先完成前序办理步骤");
    }
    const procurementSteps = handleStep.procurementSteps ?? [];
    const procurementIndex = procurementSteps.findIndex((item) => item.id === procurementStep.id);
    const reopenedProcurementSteps = procurementSteps.slice(procurementIndex);
    for (const item of reopenedProcurementSteps) {
      item.status = "pending";
      item.completedAt = null;
      item.completedBy = null;
    }
    if (handleStep.status === "completed") {
      const index = record.steps.findIndex((step) => step.id === handleStep.id);
      for (const step of record.steps.slice(index)) {
        step.status = "pending";
        step.completedAt = null;
        step.completedBy = null;
        step.humanReview = null;
      }
    }
    procurementStep.status = "pending";
    procurementStep.completedAt = null;
    procurementStep.completedBy = null;
    updateRecord(record);
    addAudit("procurement_step_reopened", record.id, {
      handlingPath: record.handlingPath,
      stepId: procurementStep.id,
      resetSteps: reopenedProcurementSteps.map((item) => item.id),
    });
    return { case: publicCase(record), sync: await save() };
  }
  if (resource === "steps" && segments.length === 6 && segments[5] === "attachments" && method === "POST") {
    const step = getStep(record, segments[4]);
    requireCurrent(record, step);
    const attachmentOwner = getAttachmentOwner(step, parsedUrl.searchParams.get("procurementStepId"));
    if (!(options.body instanceof FormData)) error(400, "FILE_REQUIRED", "请选择要上传的材料");
    const file = options.body.get("file");
    if (!(file instanceof File)) error(400, "FILE_REQUIRED", "请选择要上传的材料");
    if (!isSupportedAttachmentName(file.name)) error(400, "UNSUPPORTED_FILE_TYPE", "不支持此文件格式，请选择文档或压缩文件");
    if (file.size > MAX_FILE_SIZE) error(400, "LIMIT_FILE_SIZE", "单个文件最大 100 MB");
    const filename = file.name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "attachment";
    const shared = currentData().cases.flatMap(allStoredAttachments)
      .find((item) => item.filename === filename && item.size === file.size);
    const id = crypto.randomUUID();
    const key = shared?.objectKey ?? getObjectKey(`attachments/${record.id}/${id}`);
    if (!shared) {
      try {
        const client = getOssClient();
        const contentType = file.type || "application/octet-stream";
        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Cache-Control": "private, no-store",
        };
        if (contentType !== "application/pdf" && contentType !== "text/plain") {
          headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
        }
        const options = { headers };
        if (file.size >= 5 * 1024 * 1024) {
          await client.multipartUpload(key, file, options);
        } else {
          await client.put(key, file, options);
        }
      } catch (reason) {
        throw new ApiError(`附件上传到 OSS 失败：${reason instanceof Error ? reason.message : String(reason)}`, 502, "OSS_ATTACHMENT_SYNC_FAILED");
      }
    }
    const attachment: StoredAttachment = {
      id,
      filename,
      contentType: file.type || "application/octet-stream",
      size: file.size,
      objectKey: key,
      uploadedAt: new Date().toISOString(),
      uploadedBy: ACTOR,
      syncStatus: "success",
      syncMessage: shared ? "已关联 OSS 中的同名同大小附件，未重复上传" : "附件已同步到 OSS",
      extractedText: shared?.extractedText ?? (
        file.type === "text/plain"
          ? (await file.slice(0, MAX_ATTACHMENT_TEXT_PREVIEW_CHARS * 4).text()).slice(0, MAX_ATTACHMENT_TEXT_PREVIEW_CHARS)
          : ""
      ),
      analysis: shared?.analysis ?? null,
    };
    attachmentOwner.attachments.push(attachment);
    updateRecord(record);
    addAudit("attachment_uploaded", record.id, {
      stepId: step.id,
      ...(attachmentOwner !== step ? { procurementStepId: attachmentOwner.id } : {}),
      attachmentId: id,
    });
    return { attachment, case: publicCase(record), sync: await save() };
  }
  if (resource === "steps" && segments.length === 7 && segments[5] === "attachments" && method === "DELETE") {
    const step = getStep(record, segments[4]);
    const attachmentOwner = getAttachmentOwner(step, parsedUrl.searchParams.get("procurementStepId"));
    const attachment = attachmentOwner.attachments.find((item) => item.id === segments[6]);
    if (!attachment) error(404, "ATTACHMENT_NOT_FOUND", "未找到该材料");
    if (body.confirm !== true) error(400, "CONFIRM_REQUIRED", "删除材料需要明确确认");
    const referenceCount = currentData().cases.reduce((count, item) =>
      count + allStoredAttachments(item).filter((entry) => entry.objectKey === attachment.objectKey).length, 0);
    const referencedByOtherCase = currentData().cases.some((other) =>
      other.id !== record.id && allStoredAttachments(other).some((item) => item.objectKey === attachment.objectKey),
    );
    if (referencedByOtherCase) error(409, "ATTACHMENT_SHARED", "该附件还关联其他事项，不能删除");
    const sameCaseReferences = referenceCount - 1;
    const previousAttachments = attachmentOwner.attachments;
    const previousUpdatedAt = record.updatedAt;
    const auditLength = currentData().audit.length;
    attachmentOwner.attachments = attachmentOwner.attachments.filter((item) => item.id !== attachment.id);
    updateRecord(record);
    addAudit("attachment_deleted", record.id, {
      stepId: step.id,
      ...(attachmentOwner !== step ? { procurementStepId: attachmentOwner.id } : {}),
      attachmentId: attachment.id,
    });
    let sync: SyncStatus;
    try {
      sync = await save();
    } catch (reason) {
      attachmentOwner.attachments = previousAttachments;
      record.updatedAt = previousUpdatedAt;
      currentData().audit.length = auditLength;
      throw reason;
    }
    let cleanupError: string | null = null;
    if (sameCaseReferences === 0) {
      try {
        await getOssClient().delete(attachment.objectKey);
      } catch (reason) {
        cleanupError = reason instanceof Error ? reason.message : String(reason);
      }
    }
    return { case: publicCase(record), sync, cleanupError };
  }
  if (resource === "steps" && segments.length === 8 && segments[5] === "attachments" && segments[7] === "analyze" && method === "POST") {
    const step = getStep(record, segments[4]);
    const attachmentOwner = getAttachmentOwner(step, parsedUrl.searchParams.get("procurementStepId"));
    const attachment = attachmentOwner.attachments.find((item) => item.id === segments[6]) as StoredAttachment | undefined;
    if (!attachment) error(404, "ATTACHMENT_NOT_FOUND", "未找到该材料");
    if (!body.analysis || typeof body.analysis !== "object") error(400, "INVALID_ANALYSIS", "AI 分析结果无效");
    attachment.analysis = body.analysis as Analysis;
    if (typeof body.extractedText === "string") attachment.extractedText = body.extractedText.slice(0, 24000);
    updateRecord(record);
    addAudit("attachment_analyzed", record.id, {
      stepId: step.id,
      ...(attachmentOwner !== step ? { procurementStepId: attachmentOwner.id } : {}),
      attachmentId: attachment.id,
    });
    return { analysis: attachment.analysis, sync: await save() };
  }
  error(404, "NOT_FOUND", "请求的功能不存在");
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const result = await handleApi(url, options);
  return result as T;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export async function getAttachmentUrl(
  objectKey: string,
  options: { inline?: boolean } = {},
): Promise<string> {
  await ensureLoaded();
  return signOssObject(objectKey, options);
}
