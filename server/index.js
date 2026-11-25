import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  isSupportedAttachmentName,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENT_TEXT_PREVIEW_CHARS,
} from "../shared/attachments.js";
import {
  addAudit,
  createCaseRecord,
  createProcurementSteps,
  createDataStore,
  getDefaultProcurementModes,
  getHandlingPaths,
  getCurrentStep,
  getStageConfig,
  isProcurementPath,
} from "./store.js";
import { createAiService } from "./ai.js";
import { createOssClient, objectKey } from "./oss.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function constantTimeEqual(left, right) {
  const leftHash = createHash("sha256").update(String(left)).digest();
  const rightHash = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function signSession(username, secret) {
  const payload = Buffer.from(JSON.stringify({ username, expires: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readSession(cookie, secret) {
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof session.username !== "string" || session.expires < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function cookieValue(header, name) {
  const pair = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

function safeFilename(filename) {
  return path.basename(filename).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "attachment";
}

async function removeTemporaryUpload(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function readTextPreview(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: MAX_ATTACHMENT_TEXT_PREVIEW_CHARS * 4 });
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
    if (text.length >= MAX_ATTACHMENT_TEXT_PREVIEW_CHARS) break;
  }
  return text.slice(0, MAX_ATTACHMENT_TEXT_PREVIEW_CHARS);
}

async function readOfficePreview(filePath, filename) {
  const extension = path.extname(filename).toLowerCase();
  const bytes = await readFile(filePath);
  if ([".docx", ".docm", ".dotx", ".dotm", ".docb"].includes(extension)) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value.slice(0, MAX_ATTACHMENT_TEXT_PREVIEW_CHARS).trim();
  }
  if ([".xlsx", ".xlsm", ".xlsb", ".xltx", ".xltm", ".xlam", ".xls", ".xlt", ".xla", ".csv", ".tsv"].includes(extension)) {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(bytes, { type: "buffer", cellDates: true });
    return workbook.SheetNames.slice(0, 20).map((name) => {
      const sheet = workbook.Sheets[name];
      return `【工作表：${name}】\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`;
    }).join("\n\n").slice(0, MAX_ATTACHMENT_TEXT_PREVIEW_CHARS).trim();
  }
  if ([".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppam", ".odp", ".odt", ".ods"].includes(extension)) {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bytes);
    const texts = [];
    for (const name of Object.keys(zip.files)) {
      if (!/(?:ppt\/slides\/slide\d+\.xml|word\/document\.xml|content\.xml)$/i.test(name)) continue;
      const xml = await zip.file(name)?.async("text");
      if (!xml) continue;
      const text = xml.replace(/<[^>]+>/g, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
      if (text) texts.push(text);
    }
    return texts.join("\n").slice(0, MAX_ATTACHMENT_TEXT_PREVIEW_CHARS).trim();
  }
  return "";
}

function publicSync(sync, data) {
  const attachmentFailure = data?.cases.some((record) =>
    record.steps.some((step) =>
      step.attachments.some((attachment) => attachment.syncStatus === "failed") ||
      (step.procurementSteps ?? []).some((procurementStep) =>
        (procurementStep.attachments ?? []).some((attachment) => attachment.syncStatus === "failed"),
      ),
    ),
  );
  if (sync.status === "success" && attachmentFailure) {
    return { status: "failed", message: "部分附件 OSS 同步失败；可重试同步", updatedAt: sync.updatedAt ?? null };
  }
  return { status: sync.status, message: sync.message, updatedAt: sync.updatedAt ?? null };
}

function publicAttachment(attachment) {
  const { extractedText, localPath, ...metadata } = attachment;
  return metadata;
}

function publicCase(record) {
  return {
    ...record,
    isImportant: Boolean(record.isImportant),
    isOnHold: Boolean(record.isOnHold),
    steps: record.steps.map((step) => ({
      ...step,
      attachments: step.attachments.map(publicAttachment),
      ...(Array.isArray(step.procurementSteps) ? {
        procurementSteps: step.procurementSteps.map((procurementStep) => ({
          ...procurementStep,
          attachments: (procurementStep.attachments ?? []).map(publicAttachment),
        })),
      } : {}),
    })),
  };
}

function allAttachments(record) {
  return record.steps.flatMap((step) => [
    ...step.attachments,
    ...(step.procurementSteps ?? []).flatMap((procurementStep) => procurementStep.attachments ?? []),
  ]);
}

function validateProcurementModes(input) {
  const defaults = getDefaultProcurementModes();
  if (!Array.isArray(input) || input.length !== defaults.length) {
    return { error: "必须为四种采购模式分别配置步骤" };
  }
  const supplied = new Map(input.map((mode) => [mode?.id, mode]));
  if (supplied.size !== defaults.length || defaults.some((mode) => !supplied.has(mode.id))) {
    return { error: "采购模式配置不完整或包含重复模式" };
  }
  const modes = [];
  for (const mode of defaults) {
    const value = supplied.get(mode.id);
    if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 50) {
      return { error: `${mode.title}至少需要 1 个步骤，最多 50 个步骤` };
    }
    const steps = [];
    for (const [index, step] of value.steps.entries()) {
      if (
        !step || typeof step.title !== "string" || !step.title.trim() || step.title.trim().length > 120 ||
        typeof step.guidance !== "string" || step.guidance.length > 2000
      ) {
        return { error: `${mode.title}第 ${index + 1} 步名称必填且说明不能超过 2000 个字符` };
      }
      steps.push({
        id: `${mode.id}-${index + 1}`,
        title: step.title.trim(),
        guidance: step.guidance.trim(),
      });
    }
    modes.push({ id: mode.id, title: mode.title, steps });
  }
  return { modes };
}

function searchCases(data, query) {
  const term = query.toLocaleLowerCase();
  const results = [];
  const addMatch = (record, step, field, value) => {
    if (typeof value !== "string" || !value) return;
    const index = value.toLocaleLowerCase().indexOf(term);
    if (index < 0) return;
    const start = Math.max(0, index - 55);
    const end = Math.min(value.length, index + term.length + 95);
    results.push({
      caseId: record.id,
      caseTitle: record.title,
      stepId: step?.id ?? null,
      stepTitle: step?.title ?? null,
      field,
      snippet: `${start > 0 ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`,
    });
  };

  for (const record of data.cases) {
    addMatch(record, null, "事项名称", record.title);
    addMatch(record, null, "事项说明", record.description);
    addMatch(record, null, "事项来源", record.source);
    const path = getHandlingPaths().find((item) => item.id === record.handlingPath);
    addMatch(record, null, "办理路径", path?.title);
    for (const step of record.steps) {
      addMatch(record, step, "办理步骤", step.title);
      addMatch(record, step, "办理提示", step.guidance);
      addMatch(record, step, "办理记录", step.note);
      for (const attachment of step.attachments) {
        addMatch(record, step, "材料名称", attachment.filename);
        addMatch(record, step, "材料文本", attachment.extractedText);
        if (attachment.analysis) {
          addMatch(record, step, "AI 材料摘要", attachment.analysis.summary);
          for (const [label, values] of [
            ["AI 关键信息", attachment.analysis.keyFacts],
            ["AI 待核对点", attachment.analysis.checks],
            ["AI 下一步建议", attachment.analysis.nextSteps],
            ["AI 注意事项", attachment.analysis.cautions],
            ["AI 人工核实项", attachment.analysis.humanVerification],
          ]) {
            for (const value of values ?? []) addMatch(record, step, label, value);
          }
        }
      }
      for (const procurementStep of step.procurementSteps ?? []) {
        addMatch(record, step, `采购步骤：${procurementStep.title}`, procurementStep.note);
        addMatch(record, step, "采购步骤名称", procurementStep.title);
        for (const attachment of procurementStep.attachments ?? []) {
          addMatch(record, step, "采购步骤材料", attachment.filename);
          addMatch(record, step, "采购步骤材料文本", attachment.extractedText);
        }
      }
    }
  }
  return results;
}

export async function createApp({
  dataStore,
  uploadDir,
  env = process.env,
  ossClientPromise = createOssClient(env),
  aiService = createAiService(env),
} = {}) {
  const resolvedUploadDir = uploadDir ?? env.UPLOAD_DIR ?? path.join(here, "uploads");
  await mkdir(resolvedUploadDir, { recursive: true });
  const stages = getStageConfig(env.WORKFLOW_STAGES_JSON);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  const sendError = (res, status, code, message) => res.status(status).json({ error: { code, message } });
  const getCase = (id) => dataStore.data.cases.find((record) => record.id === id);
  const getStep = (record, stepId) => record.steps.find((step) => step.id === stepId);

  async function syncJson() {
    const client = await ossClientPromise;
    const now = new Date().toISOString();
    if (!client) {
      dataStore.data.sync = { status: "not_configured", message: "OSS 未配置；数据仅保存在服务端本地", updatedAt: now };
      await dataStore.save();
      return;
    }
    dataStore.data.sync = { status: "syncing", message: "正在同步业务 JSON 到 OSS", updatedAt: now };
    await dataStore.save();
    try {
      const object = objectKey(env.OSS_PREFIX ?? "casework", "data/cases.json");
      const snapshot = { ...dataStore.data, sync: { status: "success", message: "OSS 同步成功", updatedAt: now } };
      await client.put(object, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
      dataStore.data.sync = snapshot.sync;
      await dataStore.save();
    } catch (error) {
      dataStore.data.sync = { status: "failed", message: "OSS 同步失败；服务端本地数据已保存，可重试", updatedAt: new Date().toISOString() };
      await dataStore.save();
      return error;
    }
    return null;
  }

  const authenticate = (req, res, next) => {
    const session = readSession(cookieValue(req.headers.cookie, "casework_session"), env.SESSION_SECRET);
    if (!session) return sendError(res, 401, "UNAUTHENTICATED", "请先登录");
    req.username = session.username;
    next();
  };

  app.post("/api/auth/login", (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!constantTimeEqual(username, env.AUTH_USERNAME) || !constantTimeEqual(password, env.AUTH_PASSWORD)) {
      return sendError(res, 401, "INVALID_CREDENTIALS", "用户名或密码不正确");
    }
    const token = signSession(username, env.SESSION_SECRET);
    const secure = env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `casework_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`);
    return res.json({ username });
  });

  app.post("/api/auth/logout", authenticate, (req, res) => {
    res.setHeader("Set-Cookie", "casework_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    res.status(204).end();
  });

  app.use("/api", authenticate);

  app.get("/api/config", (req, res) => {
    res.json({
      username: req.username,
      stages,
      handlingPaths: getHandlingPaths(),
      procurementModes: dataStore.data.settings.procurementModes,
      aiEnabled: aiService.enabled,
      fileLimitBytes: MAX_ATTACHMENT_SIZE_BYTES,
    });
  });

  app.get("/api/settings/procurement", (req, res) => {
    res.json({ modes: dataStore.data.settings.procurementModes });
  });

  app.put("/api/settings/procurement", async (req, res) => {
    const validated = validateProcurementModes(req.body?.modes);
    if (validated.error) return sendError(res, 400, "INVALID_PROCUREMENT_SETTINGS", validated.error);
    await dataStore.transaction(async (data) => {
      data.settings.procurementModes = validated.modes;
      addAudit(data, req.username, "procurement_settings_updated", null, {
        modes: validated.modes.map((mode) => ({ id: mode.id, stepCount: mode.steps.length })),
      });
      await dataStore.save();
      await syncJson();
    });
    res.json({
      modes: dataStore.data.settings.procurementModes,
      sync: publicSync(dataStore.data.sync, dataStore.data),
    });
  });

  app.get("/api/cases", (req, res) => {
    res.json({
      cases: [...dataStore.data.cases].sort((a, b) =>
        Number(Boolean(a.isOnHold)) - Number(Boolean(b.isOnHold)) ||
        Number(Boolean(b.isImportant)) - Number(Boolean(a.isImportant)) ||
        b.updatedAt.localeCompare(a.updatedAt),
      ).map(publicCase),
      sync: publicSync(dataStore.data.sync, dataStore.data),
    });
  });

  app.get("/api/search", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!query || query.length > 120) {
      return sendError(res, 400, "INVALID_SEARCH_QUERY", "请输入 1 至 120 个字符的搜索内容");
    }
    const results = searchCases(dataStore.data, query);
    res.json({ query, total: results.length, results: results.slice(0, 100) });
  });

  app.post("/api/cases", async (req, res) => {
    const { title, source, description = "" } = req.body ?? {};
    if (typeof title !== "string" || !title.trim() || title.trim().length > 160) {
      return sendError(res, 400, "INVALID_TITLE", "事项名称必填且不能超过 160 个字符");
    }
    if (typeof source !== "string" || !source.trim() || source.trim().length > 2000) {
      return sendError(res, 400, "INVALID_SOURCE", "事项来源必填且不能超过 2000 个字符");
    }
    if (typeof description !== "string" || description.length > 5000) {
      return sendError(res, 400, "INVALID_DESCRIPTION", "事项说明不能超过 5000 个字符");
    }
    const record = createCaseRecord({ title, source, description }, stages);
    await dataStore.transaction(async (data) => {
      record.createdBy = req.username;
      data.cases.push(record);
      addAudit(data, req.username, "case_created", record.id);
      await dataStore.save();
      await syncJson();
    });
    res.status(201).json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.get("/api/cases/:caseId", (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.patch("/api/cases/:caseId", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const title = req.body?.title;
    if (typeof title !== "string" || !title.trim() || title.trim().length > 160) {
      return sendError(res, 400, "INVALID_TITLE", "事项名称必填且不能超过 160 个字符");
    }
    const previousTitle = record.title;
    await dataStore.transaction(async (data) => {
      record.title = title.trim();
      record.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "case_renamed", record.id, { previousTitle, title: record.title });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.patch("/api/cases/:caseId/flags", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    if (
      typeof req.body?.isImportant !== "boolean" || typeof req.body?.isOnHold !== "boolean" ||
      (req.body.isImportant && req.body.isOnHold)
    ) {
      return sendError(res, 400, "INVALID_CASE_FLAGS", "事项重要和搁置状态必须是布尔值且只能选择一项");
    }
    await dataStore.transaction(async (data) => {
      record.isImportant = req.body.isImportant;
      record.isOnHold = req.body.isOnHold;
      record.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "case_flags_updated", record.id, {
        isImportant: record.isImportant,
        isOnHold: record.isOnHold,
      });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.put("/api/cases/:caseId/analysis", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const analysis = req.body?.analysis;
    const listFields = ["keyFacts", "checks", "nextSteps", "cautions", "humanVerification"];
    if (
      !analysis || typeof analysis !== "object" || typeof analysis.summary !== "string" ||
      typeof analysis.disclaimer !== "string" || typeof analysis.generatedAt !== "string" ||
      listFields.some((field) => !Array.isArray(analysis[field]) || analysis[field].some((item) => typeof item !== "string"))
    ) {
      return sendError(res, 400, "INVALID_ANALYSIS", "事项综合解读内容无效");
    }
    await dataStore.transaction(async (data) => {
      record.aiAnalysis = analysis;
      record.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "case_ai_analysis_saved", record.id, { generatedAt: analysis.generatedAt });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.patch("/api/cases/:caseId/steps/:stepId", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const step = getStep(record, req.params.stepId);
    if (!step) return sendError(res, 404, "STEP_NOT_FOUND", "未找到该办理步骤");
    if (step.status === "completed") return sendError(res, 409, "STEP_COMPLETED", "已完成步骤不能直接修改");
    if (getCurrentStep(record)?.id !== step.id) return sendError(res, 409, "STEP_NOT_CURRENT", "请先完成前序步骤");
    if (typeof req.body?.note !== "string" || req.body.note.length > 10000) {
      return sendError(res, 400, "INVALID_NOTE", "办理记录格式无效或超过 10000 个字符");
    }
    let handlingPath;
    if (req.body.handlingPath !== undefined) {
      if (step.id !== "process-assign") {
        return sendError(res, 400, "HANDLING_PATH_NOT_ALLOWED", "办理路径只能在“明确承办安排”步骤设置");
      }
      handlingPath = getHandlingPaths().find((item) => item.id === req.body.handlingPath);
      if (!handlingPath) return sendError(res, 400, "INVALID_HANDLING_PATH", "请选择有效的办理路径");
      const mode = dataStore.data.settings.procurementModes.find((item) => item.id === handlingPath.id);
      if (handlingPath.procurement && (!mode || mode.steps.length === 0)) {
        return sendError(res, 409, "PROCUREMENT_MODE_UNCONFIGURED", "该采购模式尚未配置办理步骤，请先到流程设置页完成配置");
      }
      const nestedSteps = getStep(record, "process-handle")?.procurementSteps ?? [];
      const hasProgress = nestedSteps.some((item) =>
        item.status === "completed" || item.note.trim() || item.attachments?.length,
      );
      if (record.handlingPath && record.handlingPath !== handlingPath.id && hasProgress) {
        return sendError(res, 409, "HANDLING_PATH_LOCKED", "采购办理已开始，不能更换办理路径；如需变更请按单位流程处理");
      }
    }
    await dataStore.transaction(async (data) => {
      step.note = req.body.note;
      if (handlingPath && record.handlingPath !== handlingPath.id) {
        record.handlingPath = handlingPath.id;
        const handleStep = getStep(record, "process-handle");
        handleStep.procurementSteps = handlingPath.procurement
          ? createProcurementSteps(data.settings.procurementModes.find((mode) => mode.id === handlingPath.id))
          : [];
      }
      record.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "step_note_updated", record.id, {
        stepId: step.id,
        ...(handlingPath ? { handlingPath: handlingPath.id } : {}),
      });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.post("/api/cases/:caseId/steps/:stepId/complete", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const step = getStep(record, req.params.stepId);
    if (!step) return sendError(res, 404, "STEP_NOT_FOUND", "未找到该办理步骤");
    const current = getCurrentStep(record);
    if (current?.id !== step.id) return sendError(res, 409, "STEP_NOT_CURRENT", "必须按顺序完成前序步骤后才能推进");
    if (!step.note.trim()) return sendError(res, 400, "NOTE_REQUIRED", "请先填写办理记录");
    if (step.id === "process-assign" && !record.handlingPath) {
      return sendError(res, 400, "HANDLING_PATH_REQUIRED", "请先选择办理路径");
    }
    if (step.id === "process-handle" && isProcurementPath(record.handlingPath)) {
      const procurementSteps = step.procurementSteps ?? [];
      if (procurementSteps.length === 0) {
        return sendError(res, 409, "PROCUREMENT_STEPS_NOT_CONFIGURED", "当前采购模式没有可办理步骤，请先检查模式配置");
      }
      const pending = procurementSteps.find((item) => item.status !== "completed");
      if (pending) {
        return sendError(res, 409, "PROCUREMENT_STEPS_INCOMPLETE", `请先按顺序完成采购步骤：“${pending.title}”`);
      }
    }
    if (step.requiresReview && step.humanReview?.decision !== "approved") {
      return sendError(res, 409, "REVIEW_REQUIRED", "最终闭环须先由工作人员人工确认");
    }
    await dataStore.transaction(async (data) => {
      step.status = "completed";
      step.completedAt = new Date().toISOString();
      step.completedBy = req.username;
      record.updatedAt = step.completedAt;
      addAudit(data, req.username, "step_completed", record.id, { stepId: step.id });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.post("/api/cases/:caseId/steps/:stepId/reopen", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const index = record.steps.findIndex((step) => step.id === req.params.stepId);
    if (index < 0) return sendError(res, 404, "STEP_NOT_FOUND", "未找到该办理步骤");
    if (req.body?.confirm !== true) return sendError(res, 400, "CONFIRM_REQUIRED", "重新打开步骤需要明确确认");
    if (record.steps[index].status !== "completed") return sendError(res, 409, "STEP_NOT_COMPLETED", "该步骤尚未完成");
    await dataStore.transaction(async (data) => {
      const reopened = record.steps.slice(index);
      for (const step of reopened) {
        step.status = "pending";
        step.completedAt = null;
        step.completedBy = null;
        step.humanReview = null;
        for (const procurementStep of step.procurementSteps ?? []) {
          procurementStep.status = "pending";
          procurementStep.completedAt = null;
          procurementStep.completedBy = null;
        }
      }
      record.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "step_reopened", record.id, {
        stepId: record.steps[index].id,
        resetSteps: reopened.map((step) => step.id),
      });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.patch("/api/cases/:caseId/procurement-steps/:procurementStepId", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const handleStep = getStep(record, "process-handle");
    const procurementStep = handleStep?.procurementSteps?.find((item) => item.id === req.params.procurementStepId);
    if (!procurementStep) return sendError(res, 404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    if (getCurrentStep(record)?.id !== "process-handle") {
      return sendError(res, 409, "PROCUREMENT_STAGE_NOT_CURRENT", "请先完成前序办理步骤");
    }
    const current = handleStep.procurementSteps.find((item) => item.status !== "completed");
    if (current?.id !== procurementStep.id) {
      return sendError(res, 409, "PROCUREMENT_STEP_NOT_CURRENT", "必须完成前一个采购步骤后才能记录此步骤");
    }
    if (typeof req.body?.note !== "string" || req.body.note.length > 10000) {
      return sendError(res, 400, "INVALID_NOTE", "采购步骤记录格式无效或超过 10000 个字符");
    }
    await dataStore.transaction(async (data) => {
      procurementStep.note = req.body.note;
      record.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "procurement_step_note_updated", record.id, {
        handlingPath: record.handlingPath,
        stepId: procurementStep.id,
      });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.post("/api/cases/:caseId/procurement-steps/:procurementStepId/complete", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const handleStep = getStep(record, "process-handle");
    const procurementStep = handleStep?.procurementSteps?.find((item) => item.id === req.params.procurementStepId);
    if (!procurementStep) return sendError(res, 404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    if (getCurrentStep(record)?.id !== "process-handle") {
      return sendError(res, 409, "PROCUREMENT_STAGE_NOT_CURRENT", "请先完成前序办理步骤");
    }
    const current = handleStep.procurementSteps.find((item) => item.status !== "completed");
    if (current?.id !== procurementStep.id) {
      return sendError(res, 409, "PROCUREMENT_STEP_NOT_CURRENT", "必须完成前一个采购步骤后才能推进");
    }
    if (!procurementStep.note.trim()) return sendError(res, 400, "NOTE_REQUIRED", "请先填写本采购步骤的办理记录");
    await dataStore.transaction(async (data) => {
      procurementStep.status = "completed";
      procurementStep.completedAt = new Date().toISOString();
      procurementStep.completedBy = req.username;
      record.updatedAt = procurementStep.completedAt;
      addAudit(data, req.username, "procurement_step_completed", record.id, {
        handlingPath: record.handlingPath,
        stepId: procurementStep.id,
      });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.post("/api/cases/:caseId/procurement-steps/:procurementStepId/reopen", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const handleStep = getStep(record, "process-handle");
    const procurementStep = handleStep?.procurementSteps?.find((item) => item.id === req.params.procurementStepId);
    if (!procurementStep) return sendError(res, 404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    if (req.body?.confirm !== true) return sendError(res, 400, "CONFIRM_REQUIRED", "退回采购步骤修改需要明确确认");
    if (procurementStep.status !== "completed") return sendError(res, 409, "PROCUREMENT_STEP_NOT_COMPLETED", "只有已完成的采购步骤可以退回修改");
    if (handleStep.status !== "completed" && getCurrentStep(record)?.id !== handleStep.id) {
      return sendError(res, 409, "PROCUREMENT_STAGE_NOT_CURRENT", "请先完成前序办理步骤");
    }

    await dataStore.transaction(async (data) => {
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
      record.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "procurement_step_reopened", record.id, {
        handlingPath: record.handlingPath,
        stepId: procurementStep.id,
        resetSteps: reopenedProcurementSteps.map((item) => item.id),
      });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.post("/api/cases/:caseId/steps/:stepId/review", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const step = getStep(record, req.params.stepId);
    if (!step) return sendError(res, 404, "STEP_NOT_FOUND", "未找到该办理步骤");
    if (!step.requiresReview) return sendError(res, 400, "REVIEW_NOT_REQUIRED", "此步骤不需要最终闭环确认");
    if (getCurrentStep(record)?.id !== step.id) return sendError(res, 409, "STEP_NOT_CURRENT", "请按顺序办理后再进行最终确认");
    const { decision, comment = "" } = req.body ?? {};
    if (!["approved", "returned"].includes(decision) || typeof comment !== "string" || comment.length > 3000) {
      return sendError(res, 400, "INVALID_REVIEW", "确认结果或说明无效");
    }
    if (decision === "returned" && !comment.trim()) {
      return sendError(res, 400, "REVIEW_COMMENT_REQUIRED", "退回时请填写原因");
    }
    await dataStore.transaction(async (data) => {
      step.humanReview = { decision, comment, reviewer: req.username, reviewedAt: new Date().toISOString() };
      record.updatedAt = step.humanReview.reviewedAt;
      addAudit(data, req.username, decision === "approved" ? "final_review_approved" : "final_review_returned", record.id, { stepId: step.id });
      await dataStore.save();
      await syncJson();
    });
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: resolvedUploadDir,
      filename: (_req, _file, callback) => callback(null, randomUUID()),
    }),
    limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES, files: 1 },
    fileFilter: (req, file, callback) => {
      if (!isSupportedAttachmentName(file.originalname)) {
        const error = new Error("不支持此文件格式，请选择文档或压缩文件");
        error.code = "UNSUPPORTED_FILE_TYPE";
        callback(error);
      } else {
        callback(null, true);
      }
    },
  });

  app.post("/api/cases/:caseId/steps/:stepId/attachments", (req, res, next) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const step = getStep(record, req.params.stepId);
    if (!step) return sendError(res, 404, "STEP_NOT_FOUND", "未找到该办理步骤");
    if (req.query.procurementStepId && (
      step.id !== "process-handle" ||
      !step.procurementSteps?.some((item) => item.id === req.query.procurementStepId)
    )) {
      return sendError(res, 404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    }
    if (step.status === "completed" || getCurrentStep(record)?.id !== step.id) {
      return sendError(res, 409, "STEP_NOT_CURRENT", "只有当前待办步骤可以上传材料");
    }
    next();
  }, upload.single("file"), async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) {
      if (req.file) await removeTemporaryUpload(req.file.path);
      return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    }
    const step = getStep(record, req.params.stepId);
    if (!step) {
      if (req.file) await removeTemporaryUpload(req.file.path);
      return sendError(res, 404, "STEP_NOT_FOUND", "未找到该办理步骤");
    }
    if (step.status === "completed" || getCurrentStep(record)?.id !== step.id) {
      if (req.file) await removeTemporaryUpload(req.file.path);
      return sendError(res, 409, "STEP_NOT_CURRENT", "只有当前待办步骤可以上传材料");
    }
    const procurementStepId = req.query.procurementStepId;
    const procurementStep = procurementStepId
      ? step.procurementSteps?.find((item) => item.id === procurementStepId)
      : null;
    if (procurementStepId && (step.id !== "process-handle" || !procurementStep)) {
      if (req.file) await removeTemporaryUpload(req.file.path);
      return sendError(res, 404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    }
    if (!req.file) return sendError(res, 400, "FILE_REQUIRED", "请选择要上传的材料");
    const id = req.file.filename;
    const filename = safeFilename(req.file.originalname);
    const diskPath = req.file.path;
    const contentType = req.file.mimetype || "application/octet-stream";
    const key = objectKey(env.OSS_PREFIX ?? "casework", `attachments/${record.id}/${id}`);
    let syncStatus = "not_configured";
    let syncMessage = "OSS 未配置；附件仅保存在服务端本地";
    let ossClient = null;
    try {
      ossClient = await ossClientPromise;
      if (ossClient) {
        await ossClient.putStream(key, createReadStream(diskPath), {
          contentLength: req.file.size,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "private, no-store",
            ...(contentType === "application/pdf" || contentType === "text/plain"
              ? {}
              : { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }),
          },
        });
        syncStatus = "success";
        syncMessage = "附件已同步到 OSS";
      }
    } catch {
      syncStatus = "failed";
      syncMessage = "附件 OSS 同步失败；本地副本已保存，可重试";
    }
    const attachment = {
      id,
      filename,
      contentType,
      size: req.file.size,
      objectKey: key,
      localPath: id,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.username,
      syncStatus,
      syncMessage,
      extractedText: contentType === "text/plain"
        ? await readTextPreview(diskPath)
        : await readOfficePreview(diskPath, filename).catch(() => ""),
      analysis: null,
    };
    await dataStore.transaction(async (data) => {
      (procurementStep ?? step).attachments.push(attachment);
      record.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "attachment_uploaded", record.id, {
        stepId: step.id,
        ...(procurementStep ? { procurementStepId: procurementStep.id } : {}),
        attachmentId: id,
      });
      await dataStore.save();
      await syncJson();
    });
    res.status(201).json({ attachment: publicAttachment(attachment), case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.get("/api/cases/:caseId/attachments/:attachmentId", async (req, res) => {
    const record = getCase(req.params.caseId);
    const attachment = record && allAttachments(record).find((item) => item.id === req.params.attachmentId);
    if (!attachment) return sendError(res, 404, "ATTACHMENT_NOT_FOUND", "未找到该材料");
    res.setHeader("Content-Type", attachment.contentType);
    res.setHeader(
      "Content-Disposition",
      `${attachment.contentType === "application/pdf" || attachment.contentType === "text/plain" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const stream = createReadStream(path.join(resolvedUploadDir, attachment.localPath));
    stream.on("error", (error) => {
      if (res.headersSent) return res.destroy(error);
      if (error.code === "ENOENT") {
        return sendError(res, 404, "ATTACHMENT_FILE_MISSING", "服务端本地附件副本不存在；请从备份恢复");
      }
      return sendError(res, 500, "ATTACHMENT_READ_FAILED", "服务端读取附件失败");
    });
    stream.pipe(res);
  });

  app.delete("/api/cases/:caseId/steps/:stepId/attachments/:attachmentId", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const step = getStep(record, req.params.stepId);
    const procurementStepId = req.query.procurementStepId;
    const procurementStep = procurementStepId
      ? step?.procurementSteps?.find((item) => item.id === procurementStepId)
      : null;
    if (procurementStepId && (!step || step.id !== "process-handle" || !procurementStep)) {
      return sendError(res, 404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    }
    const attachmentOwner = procurementStep ?? step;
    const attachment = attachmentOwner?.attachments.find((item) => item.id === req.params.attachmentId);
    if (!attachment) return sendError(res, 404, "ATTACHMENT_NOT_FOUND", "未找到该材料");
    if (req.body?.confirm !== true) return sendError(res, 400, "CONFIRM_REQUIRED", "删除材料需要明确确认");
    try {
      const client = await ossClientPromise;
      if (client && attachment.syncStatus === "success") await client.delete(attachment.objectKey);
    } catch {
      return sendError(res, 502, "OSS_DELETE_FAILED", "OSS 删除失败，材料记录未变更");
    }
    await dataStore.transaction(async (data) => {
      attachmentOwner.attachments = attachmentOwner.attachments.filter((item) => item.id !== attachment.id);
      record.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "attachment_deleted", record.id, {
        stepId: step.id,
        ...(procurementStep ? { procurementStepId: procurementStep.id } : {}),
        attachmentId: attachment.id,
      });
      await dataStore.save();
      await syncJson();
    });
    await unlink(path.join(resolvedUploadDir, attachment.localPath)).catch(() => {});
    res.json({ case: publicCase(record), sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.post("/api/cases/:caseId/steps/:stepId/attachments/:attachmentId/analyze", async (req, res) => {
    const record = getCase(req.params.caseId);
    if (!record) return sendError(res, 404, "CASE_NOT_FOUND", "未找到该事项");
    const step = getStep(record, req.params.stepId);
    if (!step) return sendError(res, 404, "STEP_NOT_FOUND", "未找到该办理步骤");
    const procurementStepId = req.query.procurementStepId;
    const procurementStep = procurementStepId
      ? step.procurementSteps?.find((item) => item.id === procurementStepId)
      : null;
    if (procurementStepId && (step.id !== "process-handle" || !procurementStep)) {
      return sendError(res, 404, "PROCUREMENT_STEP_NOT_FOUND", "未找到该采购步骤");
    }
    const attachmentOwner = procurementStep ?? step;
    const attachment = attachmentOwner.attachments.find((item) => item.id === req.params.attachmentId);
    if (!attachment) return sendError(res, 404, "ATTACHMENT_NOT_FOUND", "未找到该材料");
    try {
      const analysis = await aiService.analyze(attachment.extractedText, procurementStep ?? step);
      await dataStore.transaction(async (data) => {
        attachment.analysis = analysis;
        record.updatedAt = new Date().toISOString();
        addAudit(data, req.username, "attachment_analyzed", record.id, {
          stepId: step.id,
          ...(procurementStep ? { procurementStepId: procurementStep.id } : {}),
          attachmentId: attachment.id,
        });
        await dataStore.save();
        await syncJson();
      });
      res.json({ analysis, sync: publicSync(dataStore.data.sync, dataStore.data) });
    } catch (error) {
      if (error.code === "AI_NOT_CONFIGURED") return sendError(res, 503, error.code, "AI 未启用或配置不完整；请人工核对材料");
      if (error.code === "MATERIAL_NOT_PARSEABLE") return sendError(res, 422, error.code, error.message);
      sendError(res, 502, "AI_ANALYSIS_FAILED", "AI 分析失败；未生成分析结果，请稍后重试或人工核对");
    }
  });

  app.post("/api/sync/retry", async (req, res) => {
    await dataStore.transaction(async (data) => {
      const client = await ossClientPromise;
      if (!client) {
        data.sync = { status: "not_configured", message: "OSS 未配置；数据仅保存在服务端本地", updatedAt: new Date().toISOString() };
        await dataStore.save();
        return;
      }
      for (const record of data.cases) {
        for (const step of record.steps) {
          for (const attachment of [
            ...step.attachments,
            ...(step.procurementSteps ?? []).flatMap((procurementStep) => procurementStep.attachments ?? []),
          ]) {
            if (attachment.syncStatus === "success") continue;
            try {
              await client.putStream(attachment.objectKey, createReadStream(path.join(resolvedUploadDir, attachment.localPath)), {
                contentLength: attachment.size,
                headers: {
                  "Content-Type": attachment.contentType,
                  "Cache-Control": "private, no-store",
                  ...(attachment.contentType === "application/pdf" || attachment.contentType === "text/plain"
                    ? {}
                    : { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}` }),
                },
              });
              attachment.syncStatus = "success";
              attachment.syncMessage = "附件已同步到 OSS";
            } catch {
              attachment.syncStatus = "failed";
              attachment.syncMessage = "附件 OSS 同步失败；本地副本已保存，可重试";
            }
          }
        }
      }
      addAudit(data, req.username, "oss_sync_retried", null);
      await syncJson();
    });
    const failedAttachments = dataStore.data.cases.some((record) =>
      record.steps.some((step) =>
        step.attachments.some((attachment) => attachment.syncStatus !== "success") ||
        (step.procurementSteps ?? []).some((procurementStep) =>
          (procurementStep.attachments ?? []).some((attachment) => attachment.syncStatus !== "success"),
        ),
      ),
    );
    if (dataStore.data.sync.status !== "success" || failedAttachments) {
      const state = publicSync(dataStore.data.sync, dataStore.data);
      const code = failedAttachments ? "OSS_ATTACHMENT_SYNC_FAILED" : "OSS_SYNC_FAILED";
      return sendError(res, 502, code, state.message);
    }
    res.json({ sync: publicSync(dataStore.data.sync, dataStore.data) });
  });

  app.get("/api/audit", (req, res) => {
    res.json({ audit: dataStore.data.audit.slice(-500).reverse() });
  });

  app.get("/api/todos", (req, res) => {
    res.json({ todos: [...(dataStore.data.todos ?? [])].sort((a, b) =>
      Number(Boolean(a.isCompleted)) - Number(Boolean(b.isCompleted)) ||
      a.dueDate.localeCompare(b.dueDate) ||
      b.updatedAt.localeCompare(a.updatedAt),
    ) });
  });

  app.post("/api/todos", async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const dueDate = typeof req.body?.dueDate === "string" ? req.body.dueDate : "";
    const assignee = typeof req.body?.assignee === "string" ? req.body.assignee.trim() : "";
    if (!title || title.length > 160) return sendError(res, 400, "INVALID_TODO_TITLE", "事件名称必填且不能超过 160 个字符");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return sendError(res, 400, "INVALID_TODO_DUE_DATE", "请选择有效的截止日期");
    if (!assignee || assignee.length > 80) return sendError(res, 400, "INVALID_TODO_ASSIGNEE", "经办人必填且不能超过 80 个字符");
    if (req.body?.isCompleted !== undefined && typeof req.body.isCompleted !== "boolean") {
      return sendError(res, 400, "INVALID_TODO_STATUS", "待办完成状态必须为布尔值");
    }
    const now = new Date().toISOString();
    const isCompleted = req.body?.isCompleted === true;
    const todo = {
      id: randomUUID(),
      title,
      dueDate,
      assignee,
      isCompleted,
      completedAt: isCompleted ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    await dataStore.transaction(async (data) => {
      if (!Array.isArray(data.todos)) data.todos = [];
      data.todos.push(todo);
      addAudit(data, req.username, "todo_created", null, { todoId: todo.id, title, dueDate, assignee });
      await dataStore.save();
      await syncJson();
    });
    res.status(201).json({ todo });
  });

  app.patch("/api/todos/:todoId", async (req, res) => {
    const todo = dataStore.data.todos?.find((item) => item.id === req.params.todoId);
    if (!todo) return sendError(res, 404, "TODO_NOT_FOUND", "未找到该临时待办");
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const dueDate = typeof req.body?.dueDate === "string" ? req.body.dueDate : "";
    const assignee = typeof req.body?.assignee === "string" ? req.body.assignee.trim() : "";
    if (!title || title.length > 160) return sendError(res, 400, "INVALID_TODO_TITLE", "事件名称必填且不能超过 160 个字符");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return sendError(res, 400, "INVALID_TODO_DUE_DATE", "请选择有效的截止日期");
    if (!assignee || assignee.length > 80) return sendError(res, 400, "INVALID_TODO_ASSIGNEE", "经办人必填且不能超过 80 个字符");
    if (req.body?.isCompleted !== undefined && typeof req.body.isCompleted !== "boolean") {
      return sendError(res, 400, "INVALID_TODO_STATUS", "待办完成状态必须为布尔值");
    }
    await dataStore.transaction(async (data) => {
      if (req.body?.isCompleted !== undefined) {
        todo.isCompleted = req.body.isCompleted;
        todo.completedAt = req.body.isCompleted ? new Date().toISOString() : null;
      }
      todo.title = title;
      todo.dueDate = dueDate;
      todo.assignee = assignee;
      todo.updatedAt = new Date().toISOString();
      addAudit(data, req.username, "todo_updated", null, { todoId: todo.id, title, dueDate, assignee });
      await dataStore.save();
      await syncJson();
    });
    res.json({ todo });
  });

  app.delete("/api/todos/:todoId", async (req, res) => {
    const todo = dataStore.data.todos?.find((item) => item.id === req.params.todoId);
    if (!todo) return sendError(res, 404, "TODO_NOT_FOUND", "未找到该临时待办");
    await dataStore.transaction(async (data) => {
      data.todos = data.todos.filter((item) => item.id !== todo.id);
      addAudit(data, req.username, "todo_deleted", null, { todoId: todo.id, title: todo.title });
      await dataStore.save();
      await syncJson();
    });
    res.status(204).end();
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE" ? "单个文件最大 100 MB" : "文件上传请求无效";
      return sendError(res, 400, error.code, message);
    }
    if (error.code === "UNSUPPORTED_FILE_TYPE") return sendError(res, 400, error.code, error.message);
    if (error instanceof SyntaxError && "body" in error) return sendError(res, 400, "INVALID_JSON", "请求 JSON 格式无效");
    sendError(res, 500, "INTERNAL_ERROR", "服务暂时无法处理请求");
  });

  return app;
}

export async function startServer(env = process.env) {
  if (!env.AUTH_USERNAME || !env.AUTH_PASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("必须设置 AUTH_USERNAME、AUTH_PASSWORD，以及至少 32 个字符的 SESSION_SECRET");
  }
  const dataFile = path.resolve(env.DATA_DIR ?? path.join(here, "data"), "cases.json");
  const dataStore = createDataStore(dataFile);
  await dataStore.load();
  const app = await createApp({ dataStore, env });
  const port = Number(env.PORT ?? 3000);
  const host = env.HOST ?? "127.0.0.1";
  return app.listen(port, host, () => {
    console.log(`Casework API listening on ${host}:${port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

