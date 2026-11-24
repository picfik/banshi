import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STAGES = [
  {
    id: "source",
    title: "事项来源",
    steps: [
      { id: "source-register", title: "登记事项来源", guidance: "记录来文、来电、交办或其他事项来源及接收时间。" },
      { id: "source-verify", title: "核实事项信息", guidance: "核对事项主体、诉求、时限和所附材料是否完整。" },
    ],
  },
  {
    id: "processing",
    title: "办理流程",
    steps: [
      { id: "process-assign", title: "明确承办安排", guidance: "记录承办人员、办理分工和计划时限。" },
      { id: "process-handle", title: "开展办理并记录依据", guidance: "记录办理过程、适用依据和需进一步核实的问题。" },
      { id: "process-check", title: "复核办理情况", guidance: "核对办理记录、依据材料及尚未解决事项。" },
    ],
  },
  {
    id: "closure",
    title: "最终闭环",
    steps: [
      { id: "closure-feedback", title: "反馈办理结果", guidance: "记录结果反馈对象、时间、方式及反馈内容。" },
      { id: "closure-archive", title: "确认归档闭环", guidance: "由经办人员确认材料齐备，并由工作人员作最终人工确认。", requiresReview: true },
    ],
  },
];

const HANDLING_PATHS = [
  { id: "ordinary", title: "普通办理", procurement: false },
  { id: "direct-delegation", title: "直接委托", procurement: true },
  { id: "inquiry-comparison", title: "询价比价", procurement: true },
  { id: "open-tender", title: "公开招标", procurement: true },
  { id: "reverse-auction", title: "反向竞价", procurement: true },
];

const DEFAULT_PROCUREMENT_MODES = [
  {
    id: "direct-delegation",
    title: "直接委托",
    steps: [
      { id: "direct-need", title: "核对需求与适用依据", guidance: "记录需求、依据和经办核对情况。" },
      { id: "direct-approval", title: "履行内部审批并确认受托方", guidance: "记录本单位审批及委托对象确认情况。" },
      { id: "direct-contract", title: "签订合同或订单", guidance: "记录合同或订单办理情况及相关材料。" },
      { id: "direct-acceptance", title: "验收并归档办理材料", guidance: "记录验收、资料归档和后续事项。" },
    ],
  },
  {
    id: "inquiry-comparison",
    title: "询价比价",
    steps: [
      { id: "inquiry-need", title: "明确需求和询价范围", guidance: "记录需求、询价范围及经办核对情况。" },
      { id: "inquiry-quotes", title: "询价并记录报价", guidance: "记录询价对象、报价信息和相关依据。" },
      { id: "inquiry-compare", title: "比价并形成比较记录", guidance: "记录比较过程、结果及需要核实事项。" },
      { id: "inquiry-approval", title: "履行审批并确认供应方", guidance: "记录本单位审批和供应方确认情况。" },
      { id: "inquiry-contract", title: "签订合同或订单", guidance: "记录合同或订单办理情况。" },
      { id: "inquiry-acceptance", title: "验收并归档办理材料", guidance: "记录验收、资料归档和后续事项。" },
    ],
  },
  {
    id: "open-tender",
    title: "公开招标",
    steps: [
      { id: "tender-document", title: "准备采购文件和评审条件", guidance: "记录文件准备、需求核对和相关依据。" },
      { id: "tender-approval", title: "履行采购文件及程序审批", guidance: "记录本单位审批及文件确认情况。" },
      { id: "tender-publish", title: "发布信息并组织投标", guidance: "记录信息发布、投标组织和过程材料。" },
      { id: "tender-evaluate", title: "开标评审并记录过程", guidance: "记录开标评审过程、结果和需要核实事项。" },
      { id: "tender-result", title: "确认结果并办理通知", guidance: "记录结果确认、公示或通知等办理情况。" },
      { id: "tender-contract", title: "签订合同", guidance: "记录合同办理情况及相关材料。" },
      { id: "tender-acceptance", title: "验收并归档办理材料", guidance: "记录验收、资料归档和后续事项。" },
    ],
  },
  {
    id: "reverse-auction",
    title: "反向竞价",
    steps: [
      { id: "auction-need", title: "确认竞价标的和资格条件", guidance: "记录竞价标的、需求和条件核对情况。" },
      { id: "auction-approval", title: "履行方案审批并发布信息", guidance: "记录本单位审批及信息发布情况。" },
      { id: "auction-process", title: "组织竞价并记录过程", guidance: "记录竞价过程、报价和相关材料。" },
      { id: "auction-result", title: "确认竞价结果并履行审批", guidance: "记录结果核对、确认和审批情况。" },
      { id: "auction-contract", title: "签订合同或订单", guidance: "记录合同或订单办理情况。" },
      { id: "auction-acceptance", title: "验收并归档办理材料", guidance: "记录验收、资料归档和后续事项。" },
    ],
  },
];

export function getStageConfig(rawConfig) {
  if (!rawConfig) return structuredClone(STAGES);
  let parsed;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    throw new Error("WORKFLOW_STAGES_JSON 不是有效 JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
    throw new Error("WORKFLOW_STAGES_JSON 必须是包含 1 至 20 个阶段的数组");
  }
  const stageIds = new Set();
  const stepIds = new Set();
  let stepCount = 0;
  const stages = parsed.map((stage) => {
    if (
      !stage || typeof stage.id !== "string" || !/^[a-z0-9-]{1,60}$/.test(stage.id) ||
      typeof stage.title !== "string" || !stage.title.trim() || stage.title.length > 100 ||
      !Array.isArray(stage.steps) || stage.steps.length === 0
    ) {
      throw new Error("WORKFLOW_STAGES_JSON 中阶段结构无效");
    }
    if (stageIds.has(stage.id)) throw new Error("WORKFLOW_STAGES_JSON 阶段 ID 不能重复");
    stageIds.add(stage.id);
    const steps = stage.steps.map((step) => {
      stepCount += 1;
      if (
        stepCount > 100 || !step || typeof step.id !== "string" || !/^[a-z0-9-]{1,60}$/.test(step.id) ||
        typeof step.title !== "string" || !step.title.trim() || step.title.length > 120 ||
        typeof step.guidance !== "string" || step.guidance.length > 2000 ||
        (step.requiresReview !== undefined && typeof step.requiresReview !== "boolean")
      ) {
        throw new Error("WORKFLOW_STAGES_JSON 中步骤结构无效（每个流程最多 100 步）");
      }
      if (stepIds.has(step.id)) throw new Error("WORKFLOW_STAGES_JSON 步骤 ID 不能重复");
      stepIds.add(step.id);
      return {
        id: step.id,
        title: step.title.trim(),
        guidance: step.guidance,
        ...(step.requiresReview ? { requiresReview: true } : {}),
      };
    });
    return { id: stage.id, title: stage.title.trim(), steps };
  });
  return stages;
}

export function getHandlingPaths() {
  return structuredClone(HANDLING_PATHS);
}

export function getDefaultProcurementModes() {
  return structuredClone(DEFAULT_PROCUREMENT_MODES);
}

export function isProcurementPath(pathId) {
  return HANDLING_PATHS.some((path) => path.id === pathId && path.procurement);
}

export function createProcurementSteps(mode) {
  return mode.steps.map((step) => ({
    id: randomUUID(),
    templateId: step.id,
    title: step.title,
    guidance: step.guidance,
    status: "pending",
    note: "",
    completedAt: null,
    completedBy: null,
    attachments: [],
  }));
}

export function createInitialData() {
  return {
    version: 1,
    cases: [],
    todos: [],
    audit: [],
    settings: { procurementModes: getDefaultProcurementModes() },
    sync: { status: "not_configured", message: "OSS 未配置" },
  };
}

export function createDataStore(filePath) {
  let queue = Promise.resolve();
  let data;

  async function load() {
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.cases) || !Array.isArray(parsed.audit)) {
        throw new Error("业务数据结构无效");
      }
      data = parsed;
      let migrated = false;
      if (!Array.isArray(data.todos)) {
        data.todos = [];
        migrated = true;
      }
      for (const todo of data.todos) {
        if (typeof todo.isCompleted !== "boolean") {
          todo.isCompleted = false;
          migrated = true;
        }
        if (todo.completedAt === undefined) {
          todo.completedAt = null;
          migrated = true;
        }
      }
      if (!data.settings) {
        data.settings = { procurementModes: getDefaultProcurementModes() };
        migrated = true;
      }
      if (!Array.isArray(data.settings.procurementModes)) {
        throw new Error("采购模式配置无效");
      }
      for (const record of data.cases) {
        const isOnHold = Boolean(record.isOnHold);
        const isImportant = Boolean(record.isImportant) && !isOnHold;
        if (record.isOnHold !== isOnHold || record.isImportant !== isImportant) {
          record.isOnHold = isOnHold;
          record.isImportant = isImportant;
          migrated = true;
        }
        if (record.handlingPath === undefined) {
          record.handlingPath = null;
          migrated = true;
        }
        const handleStep = record.steps?.find((step) => step.id === "process-handle");
        if (handleStep && !Array.isArray(handleStep.procurementSteps)) {
          handleStep.procurementSteps = [];
          migrated = true;
        }
        for (const procurementStep of handleStep?.procurementSteps ?? []) {
          if (!Array.isArray(procurementStep.attachments)) {
            procurementStep.attachments = [];
            migrated = true;
          }
        }
      }
      if (migrated) await save();
    } catch (error) {
      if (error.code === "ENOENT") {
        data = createInitialData();
        await save();
      } else {
        throw new Error(`业务 JSON 文件无法读取：${error.message}`);
      }
    }
    return data;
  }

  async function save() {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, filePath);
  }

  function transaction(operation) {
    const current = queue.then(async () => operation(data));
    queue = current.catch(() => {});
    return current;
  }

  return { load, save, transaction, get data() { return data; } };
}

export function addAudit(data, actor, action, caseId, detail = {}) {
  data.audit.push({ id: randomUUID(), actor, action, caseId, detail, at: new Date().toISOString() });
}

export function createCaseRecord(input, stages = STAGES) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: input.title.trim(),
    description: input.description.trim(),
    source: input.source.trim(),
    isImportant: false,
    isOnHold: false,
    createdAt: now,
    updatedAt: now,
    handlingPath: null,
    steps: stages.flatMap((stage) => stage.steps.map((step) => ({
      ...step,
      stageId: stage.id,
      stageTitle: stage.title,
      status: "pending",
      note: "",
      completedAt: null,
      completedBy: null,
      attachments: [],
      analysis: null,
      humanReview: null,
      ...(step.id === "process-handle" ? { procurementSteps: [] } : {}),
    }))),
  };
}

export function getCurrentStep(record) {
  return record.steps.find((step) => step.status !== "completed") ?? null;
}

