import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import JSZip from "jszip";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { api, getAttachmentUrl, jsonBody } from "./api";
import { aiProviders, analyzeAttachment, getDefaultAiPreferences, type AiPreferences } from "./ai";
import type { Attachment, CaseRecord, HandlingPath, ProcurementMode, ProcurementStep, Stage, Step, SyncStatus, TemporaryTodo } from "./types";
import { MAX_ATTACHMENT_SIZE_BYTES, SUPPORTED_ATTACHMENT_EXTENSIONS } from "../shared/attachments.js";

type CaseResponse = { case: CaseRecord; sync: SyncStatus };
type CasesResponse = { cases: CaseRecord[]; sync: SyncStatus };
type SearchResult = {
  caseId: string;
  caseTitle: string;
  stepId: string | null;
  stepTitle: string | null;
  field: string;
  snippet: string;
};
type ConfigResponse = {
  username: string;
  stages: Stage[];
  handlingPaths: HandlingPath[];
  procurementModes: ProcurementMode[];
  aiPreferences: AiPreferences;
  aiEnabled: boolean;
  fileLimitBytes: number;
};
type AuditEntry = { id: string; actor: string; action: string; caseId: string; detail: Record<string, unknown>; at: string };

function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusLabel(status: SyncStatus["status"]): string {
  return {
    success: "OSS 同步成功",
    failed: "OSS 同步失败",
    syncing: "同步中",
    not_configured: "OSS 未配置",
  }[status];
}

function getCaseProgress(record: CaseRecord) {
  const procurementSteps = record.steps.find((step) => step.id === "process-handle")?.procurementSteps ?? [];
  const done = record.steps.filter((step) => step.status === "completed").length +
    procurementSteps.filter((step) => step.status === "completed").length;
  const total = record.steps.length + procurementSteps.length;
  return { done, total, percent: total > 0 ? Math.round(done / total * 100) : 0 };
}

function getCaseCategory(record: CaseRecord) {
  if (record.isOnHold) return "held";
  const progress = getCaseProgress(record);
  if (progress.done === 0) return "pending";
  if (progress.done === progress.total) return "completed";
  return "handling";
}

function App() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCase, setSelectedCase] = useState<CaseRecord | null>(null);
  const [sync, setSync] = useState<SyncStatus>({ status: "not_configured", message: "等待加载", updatedAt: null });
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [procurementNoteDraft, setProcurementNoteDraft] = useState("");
  const [settingsPage, setSettingsPage] = useState<"procurement" | "ai" | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [auditChecklistOpen, setAuditChecklistOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ targetId: string; message: string } | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState("");
  const [caseFilter, setCaseFilter] = useState<"all" | "pending" | "handling" | "completed" | "held">("all");
  const [todos, setTodos] = useState<TemporaryTodo[]>([]);
  const [todoOpen, setTodoOpen] = useState(false);
  const [todoEditing, setTodoEditing] = useState<TemporaryTodo | null>(null);
  const [todoReminderOpen, setTodoReminderOpen] = useState(false);
  const [todoFilter, setTodoFilter] = useState<"pending" | "completed">("pending");
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  const [hiddenAnalysisIds, setHiddenAnalysisIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("banshi-hidden-analysis") ?? "[]") as string[];
    } catch {
      return [];
    }
  });

  const currentStep = useMemo(
    () => selectedCase?.steps.find((step) => step.status !== "completed") ?? null,
    [selectedCase],
  );
  const activeStep = selectedCase
    ? selectedCase.steps.find((step) => step.id === selectedStepId) ?? currentStep
    : null;
  const currentProcurementStep = activeStep?.procurementSteps?.find((step) => step.status !== "completed") ?? null;
  const selectedHandlingPath = config?.handlingPaths.find((path) =>
    path.id === (activeStep?.id === "process-assign" ? pathDraft : selectedCase?.handlingPath),
  );

  const handleError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : "操作失败，请重试");
  }, []);

  const refreshCases = useCallback(async (caseId: string | null) => {
    const result = await api<CasesResponse>("/api/cases");
    setCases(result.cases);
    setSync(result.sync);
    if (caseId) {
      const detail = await api<CaseResponse>(`/api/cases/${caseId}`);
      setSelectedCase(detail.case);
      setSelectedId(detail.case.id);
      setSync(detail.sync);
      const firstPending = detail.case.steps.find((step) => step.status !== "completed");
      setSelectedStepId((current) => {
        const selected = detail.case.steps.find((step) => step.id === current);
        return selected && selected.status !== "completed"
          ? selected.id
          : firstPending?.id ?? detail.case.steps.at(-1)?.id ?? null;
      });
    } else {
      setSelectedCase(null);
      setSelectedId(null);
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await api<ConfigResponse>("/api/config");
      setConfig(cfg);
      const todoResult = await api<{ todos: TemporaryTodo[] }>("/api/todos");
      setTodos(todoResult.todos);
      await refreshCases(null);
      setError("");
    } catch (reason) {
      handleError(reason);
    } finally {
      setLoading(false);
    }
  }, [handleError, refreshCases]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    const handleSelection = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      if (!text) {
        setSelectionMenu(null);
        return;
      }
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return;
      const rect = range.getBoundingClientRect();
      setSelectionMenu({
        text: text.slice(0, 160),
        x: Math.min(window.innerWidth - 150, Math.max(8, rect.left + rect.width / 2)),
        y: Math.max(8, rect.bottom + 8),
      });
    };
    document.addEventListener("mouseup", handleSelection);
    document.addEventListener("keyup", handleSelection);
    return () => {
      document.removeEventListener("mouseup", handleSelection);
      document.removeEventListener("keyup", handleSelection);
    };
  }, []);

  useEffect(() => {
    if (todos.length === 0) return;
    const checkReminders = () => {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const due = todos.filter((todo) => {
        if (todo.isCompleted) return false;
        const due = new Date(`${todo.dueDate}T23:59:59`);
        const remainingDays = Math.ceil((due.getTime() - now.getTime()) / 86400000);
        return remainingDays >= 0 && remainingDays <= 3;
      });
      if (due.length === 0) return;
      const remindedKey = `banshi-todo-reminded-${today}`;
      const alreadyReminded = JSON.parse(localStorage.getItem(remindedKey) ?? "[]") as string[];
      const newReminders = due.filter((todo) => !alreadyReminded.includes(todo.id));
      if (newReminders.length === 0) return;
      localStorage.setItem(remindedKey, JSON.stringify([...alreadyReminded, ...newReminders.map((todo) => todo.id)]));
      setTodoReminderOpen(true);
    };
    checkReminders();
    const timer = window.setInterval(checkReminders, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [todos]);

  useEffect(() => {
    const onlineChange = () => setOnline(navigator.onLine);
    const syncChange = (event: Event) => setSync((event as CustomEvent<SyncStatus>).detail);
    const installAvailable = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("online", onlineChange);
    window.addEventListener("offline", onlineChange);
    window.addEventListener("oss-sync-status", syncChange);
    window.addEventListener("beforeinstallprompt", installAvailable);
    return () => {
      window.removeEventListener("online", onlineChange);
      window.removeEventListener("offline", onlineChange);
      window.removeEventListener("oss-sync-status", syncChange);
      window.removeEventListener("beforeinstallprompt", installAvailable);
    };
  }, []);

  useEffect(() => {
    setNoteDraft(activeStep?.note ?? "");
  }, [activeStep?.id, activeStep?.note]);

  useEffect(() => {
    setPathDraft(selectedCase?.handlingPath ?? "");
  }, [selectedCase?.id, selectedCase?.handlingPath, activeStep?.id]);

  useEffect(() => {
    setProcurementNoteDraft(currentProcurementStep?.note ?? "");
  }, [currentProcurementStep?.id, currentProcurementStep?.note]);

  useEffect(() => {
    if (
      !selectedCase || !activeStep || activeStep.status === "completed" || !online ||
      (noteDraft === activeStep.note && (activeStep.id !== "process-assign" || pathDraft === (selectedCase.handlingPath ?? "")))
    ) return;

    setAutoSaveStatus("正在实时保存…");
    const timer = window.setTimeout(() => {
      void api<CaseResponse>(`/api/cases/${selectedCase.id}/steps/${activeStep.id}`, {
        method: "PATCH",
        body: jsonBody({
          note: noteDraft,
          ...(activeStep.id === "process-assign" ? { handlingPath: pathDraft } : {}),
        }),
      }).then((result) => {
        setSelectedCase(result.case);
        setSync(result.sync);
        setAutoSaveStatus("已实时保存");
      }).catch((reason) => {
        setAutoSaveStatus(reason instanceof Error ? `保存失败：${reason.message}` : "保存失败，请检查网络");
      });
    }, 700);

    return () => window.clearTimeout(timer);
  }, [selectedCase, activeStep, noteDraft, pathDraft, online]);

  useEffect(() => {
    if (
      !selectedCase || !currentProcurementStep || currentProcurementStep.status === "completed" || !online ||
      procurementNoteDraft === currentProcurementStep.note
    ) return;

    setAutoSaveStatus("正在实时保存…");
    const timer = window.setTimeout(() => {
      void api<CaseResponse>(
        `/api/cases/${selectedCase.id}/procurement-steps/${currentProcurementStep.id}`,
        { method: "PATCH", body: jsonBody({ note: procurementNoteDraft }) },
      ).then((result) => {
        setSelectedCase(result.case);
        setSync(result.sync);
        setAutoSaveStatus("已实时保存");
      }).catch((reason) => {
        setAutoSaveStatus(reason instanceof Error ? `保存失败：${reason.message}` : "保存失败，请检查网络");
      });
    }, 700);

    return () => window.clearTimeout(timer);
  }, [selectedCase, currentProcurementStep, procurementNoteDraft, online]);

  async function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<CaseResponse>("/api/cases", {
        method: "POST",
        body: jsonBody({
          title: form.get("title"),
          source: form.get("source"),
          description: form.get("description"),
        }),
      });
      setCreateOpen(false);
      await refreshCases(result.case.id);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function selectCase(record: CaseRecord) {
    setBusy(true);
    setError("");
    try {
      const result = await api<CaseResponse>(`/api/cases/${record.id}`);
      setSelectedId(record.id);
      setSelectedCase(result.case);
      setSync(result.sync);
      setSelectedStepId(result.case.steps.find((step) => step.status !== "completed")?.id ?? result.case.steps.at(-1)?.id ?? null);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function runStepAction(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refreshCases(selectedId);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function completeStep() {
    if (!selectedCase || !activeStep) return;
    if (!window.confirm(`确认完成“${activeStep.title}”？完成后才能进入下一步。`)) return;
    await runStepAction(async () => {
      if (
        noteDraft !== activeStep.note ||
        (activeStep.id === "process-assign" && pathDraft !== (selectedCase.handlingPath ?? ""))
      ) {
        await api(`/api/cases/${selectedCase.id}/steps/${activeStep.id}`, {
          method: "PATCH",
          body: jsonBody({
            note: noteDraft,
            ...(activeStep.id === "process-assign" ? { handlingPath: pathDraft } : {}),
          }),
        });
      }
      await api(`/api/cases/${selectedCase.id}/steps/${activeStep.id}/complete`, { method: "POST", body: "{}" });
    });
  }

  async function completeProcurementStep() {
    if (!selectedCase || !currentProcurementStep) return;
    if (!window.confirm(`确认完成采购步骤“${currentProcurementStep.title}”？`)) return;
    await runStepAction(async () => {
      if (procurementNoteDraft !== currentProcurementStep.note) {
        await api(`/api/cases/${selectedCase.id}/procurement-steps/${currentProcurementStep.id}`, {
          method: "PATCH",
          body: jsonBody({ note: procurementNoteDraft }),
        });
      }
      await api(`/api/cases/${selectedCase.id}/procurement-steps/${currentProcurementStep.id}/complete`, {
        method: "POST",
        body: "{}",
      });
    });
  }

  async function reopenProcurementStep(step: ProcurementStep) {
    if (!selectedCase) return;
    if (!window.confirm(`将采购步骤“${step.title}”退回修改？原办理记录和附件会保留；如后续流程已完成，也会重新打开后续主流程步骤。`)) return;
    await runStepAction(() => api(
      `/api/cases/${selectedCase.id}/procurement-steps/${step.id}/reopen`,
      { method: "POST", body: jsonBody({ confirm: true }) },
    ));
  }

  async function saveProcurementModes(modes: ProcurementMode[]) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ modes: ProcurementMode[]; sync: SyncStatus }>("/api/settings/procurement", {
        method: "PUT",
        body: jsonBody({ modes }),
      });
      setConfig((current) => current ? { ...current, procurementModes: result.modes } : current);
      setSync(result.sync);
      setSettingsPage(null);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function reviewStep(decision: "approved" | "returned") {
    if (!selectedCase || !activeStep) return;
    const comment = decision === "returned" ? window.prompt("请填写退回原因") : (window.prompt("确认意见（可留空）") ?? "");
    if (comment === null) return;
    await runStepAction(() => api(`/api/cases/${selectedCase.id}/steps/${activeStep.id}/review`, {
      method: "POST",
      body: jsonBody({ decision, comment }),
    }));
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>, procurementStepId?: string) {
    if (!selectedCase || !activeStep) return;
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    input.value = "";
    const caseId = selectedCase.id;
    const stepId = activeStep.id;
    const targetId = procurementStepId ? `${caseId}:procurement:${procurementStepId}` : `${caseId}:step:${stepId}`;
    const uploadUrl = procurementStepId
      ? `/api/cases/${caseId}/steps/${stepId}/attachments?procurementStepId=${encodeURIComponent(procurementStepId)}`
      : `/api/cases/${caseId}/steps/${stepId}/attachments`;
    let uploadedCount = 0;
    const failures: string[] = [];

    setBusy(true);
    setError("");
    setUploadStatus({ targetId, message: "" });
    try {
      for (const [index, file] of files.entries()) {
        setUploadStatus({ targetId, message: `正在上传 ${index + 1}/${files.length}：${file.name}` });
        if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
          failures.push(`${file.name}：超过 100 MB`);
          continue;
        }
        const body = new FormData();
        body.set("file", file);
        try {
          await api(uploadUrl, { method: "POST", body });
          uploadedCount += 1;
        } catch (reason) {
          failures.push(`${file.name}：${reason instanceof Error ? reason.message : "上传失败"}`);
        }
      }
      if (uploadedCount > 0) {
        const refreshed = await api<CasesResponse>("/api/cases");
        setCases(refreshed.cases);
        setSync(refreshed.sync);
        const updatedCase = refreshed.cases.find((record) => record.id === caseId);
        if (updatedCase) {
          setSelectedCase((current) => current?.id === caseId ? updatedCase : current);
        }
      }
      setUploadStatus({ targetId, message: `上传完成：成功 ${uploadedCount} 个，失败 ${failures.length} 个` });
      if (failures.length > 0) {
        const shownFailures = failures.slice(0, 3).join("；");
        setError(`以下附件上传失败：${shownFailures}${failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : ""}`);
      }
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAttachment(attachmentId: string, procurementStepId?: string) {
    if (!selectedCase || !activeStep) return;
    if (!window.confirm("确定删除此材料？如仍关联其他事项，删除将被拒绝。此操作会写入审计记录。")) return;
    const procurementQuery = procurementStepId ? `?procurementStepId=${encodeURIComponent(procurementStepId)}` : "";
    setBusy(true);
    setError("");
    try {
      const result = await api<{ cleanupError: string | null }>(
        `/api/cases/${selectedCase.id}/steps/${activeStep.id}/attachments/${attachmentId}${procurementQuery}`,
        { method: "DELETE", body: jsonBody({ confirm: true }) },
      );
      await refreshCases(selectedId);
      if (result.cleanupError) {
        setError(`材料记录已删除，但 OSS 附件未能清理：${result.cleanupError}`);
      }
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function analyzeCaseAttachment(attachment: Attachment, procurementStepId?: string) {
    if (!selectedCase || !activeStep || !config?.aiEnabled) {
      setError("请先在 AI 设置中选择服务并填写 API Key");
      return;
    }
    const canAnalyze = attachment.contentType === "application/pdf" ||
      attachment.contentType === "text/plain" ||
      [".docx", ".docm", ".dotx", ".dotm", ".docb", ".xlsx", ".xlsm", ".xlsb", ".xltx", ".xltm", ".xlam", ".xls", ".xlt", ".xla", ".csv", ".tsv", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppam", ".odp", ".odt", ".ods", ".rtf", ".html", ".htm", ".xml"]
        .includes(attachment.filename.slice(attachment.filename.lastIndexOf(".")).toLowerCase());
    if (!canAnalyze) {
      setError("该文件格式暂不支持 AI 解读；Office 文档请使用 .docx/.xlsx/.pptx 等格式");
      return;
    }
    if (!window.confirm("附件文本将发送给当前选择的 AI 服务进行分析。请确认已获授权，且材料符合单位的数据处理要求。")) return;
    await runStepAction(async () => {
      const procurementStep = procurementStepId
        ? activeStep.procurementSteps?.find((item) => item.id === procurementStepId)
        : null;
      const analysisStep = procurementStep ? { ...activeStep, title: procurementStep.title, guidance: procurementStep.guidance } : activeStep;
      const result = await analyzeAttachment(attachment, analysisStep, config.aiPreferences);
      const procurementQuery = procurementStepId ? `?procurementStepId=${encodeURIComponent(procurementStepId)}` : "";
      await api(`/api/cases/${selectedCase.id}/steps/${activeStep.id}/attachments/${attachment.id}/analyze${procurementQuery}`, {
        method: "POST",
        body: jsonBody(result),
      });
    });
  }

  async function renameCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCase) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<CaseResponse>(`/api/cases/${selectedCase.id}`, {
        method: "PATCH",
        body: jsonBody({ title: form.get("title") }),
      });
      setRenameOpen(false);
      await refreshCases(result.case.id);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function updateCaseFlags(patch: Partial<Pick<CaseRecord, "isImportant" | "isOnHold">>) {
    if (!selectedCase) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<CaseResponse>(`/api/cases/${selectedCase.id}/flags`, {
        method: "PATCH",
        body: jsonBody({
          isImportant: patch.isOnHold === true ? false : patch.isImportant ?? Boolean(selectedCase.isImportant),
          isOnHold: patch.isImportant === true ? false : patch.isOnHold ?? Boolean(selectedCase.isOnHold),
        }),
      });
      await refreshCases(result.case.id);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCase() {
    if (!selectedCase || !window.confirm(`确定删除事项“${selectedCase.title}”？仍被其他事项引用的附件会保留在 OSS。`)) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ preservedAttachmentCount: number; cleanupErrors: string[] }>("/api/cases/" + selectedCase.id, {
        method: "DELETE",
      });
      await refreshCases(null);
      if (result.cleanupErrors.length) {
        setError(`事项已删除，但有 ${result.cleanupErrors.length} 个未被引用的附件未能从 OSS 清理；可在 OSS 控制台检查。`);
      } else if (result.preservedAttachmentCount) {
        setError(`事项已删除；${result.preservedAttachmentCount} 个仍被其他事项引用的附件已保留。`);
      }
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function saveAiSettings(preferences: AiPreferences) {
    setBusy(true);
    setError("");
    try {
      const result = await api<Pick<ConfigResponse, "aiPreferences" | "aiEnabled"> & { sync: SyncStatus }>("/api/settings/ai", {
        method: "PUT",
        body: jsonBody(preferences),
      });
      setConfig((current) => current ? {
        ...current,
        aiPreferences: result.aiPreferences,
        aiEnabled: result.aiEnabled,
      } : current);
      setSync(result.sync);
      setSettingsPage(null);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function reopenStep(step: Step) {
    if (!selectedCase || !window.confirm(`重新打开“${step.title}”并将其后续步骤退回待办？此操作会写入审计记录。`)) return;
    setSelectedStepId(step.id);
    await runStepAction(() => api(`/api/cases/${selectedCase.id}/steps/${step.id}/reopen`, {
      method: "POST",
      body: jsonBody({ confirm: true }),
    }));
  }

  async function retrySync() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ sync: SyncStatus }>("/api/sync/retry", { method: "POST", body: "{}" });
      setSync(result.sync);
      await refreshCases(selectedId);
    } catch (reason) {
      handleError(reason);
      try {
        const result = await api<CasesResponse>("/api/cases");
        setSync(result.sync);
        setCases(result.cases);
        if (selectedId) await refreshCases(selectedId);
      } catch {
        // The original sync error is already shown.
      }
    } finally {
      setBusy(false);
    }
  }

  async function addSelectedTextTodo(text: string) {
    const now = new Date();
    const dueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ todo: TemporaryTodo }>("/api/todos", {
        method: "POST",
        body: jsonBody({
          title: text,
          dueDate,
          assignee: config?.username ?? "待分配",
        }),
      });
      setTodos((current) => [...current, result.todo]);
      setSelectionMenu(null);
      window.getSelection()?.removeAllRanges();
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function saveTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      title: form.get("title"),
      dueDate: form.get("dueDate"),
      assignee: form.get("assignee"),
      isCompleted: todoEditing?.isCompleted ?? false,
    };
    setBusy(true);
    setError("");
    try {
      const result = todoEditing
        ? await api<{ todo: TemporaryTodo }>(`/api/todos/${todoEditing.id}`, { method: "PATCH", body: jsonBody(payload) })
        : await api<{ todo: TemporaryTodo }>("/api/todos", { method: "POST", body: jsonBody(payload) });
      setTodos((current) => todoEditing
        ? current.map((todo) => todo.id === todoEditing.id ? result.todo : todo)
        : [...current, result.todo]);
      setTodoEditing(null);
      setTodoOpen(false);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function toggleTodoCompleted(todo: TemporaryTodo) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ todo: TemporaryTodo }>(`/api/todos/${todo.id}`, {
        method: "PATCH",
        body: jsonBody({
          title: todo.title,
          dueDate: todo.dueDate,
          assignee: todo.assignee,
          isCompleted: !todo.isCompleted,
        }),
      });
      setTodos((current) => current.map((item) => item.id === todo.id ? result.todo : item));
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTodo(todo: TemporaryTodo) {
    if (!window.confirm(`确定删除临时待办“${todo.title}”？`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/todos/${todo.id}`, { method: "DELETE" });
      setTodos((current) => current.filter((item) => item.id !== todo.id));
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function showAudit() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ audit: AuditEntry[] }>("/api/audit");
      setAudit(result.audit);
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function searchGlobal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    setSearching(true);
    setError("");
    try {
      const result = await api<{ total: number; results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(query)}`);
      setSearchResults(result.results);
      setSearchOpen(true);
    } catch (reason) {
      handleError(reason);
    } finally {
      setSearching(false);
    }
  }

  async function openSearchResult(result: SearchResult) {
    const record = cases.find((item) => item.id === result.caseId);
    if (!record) return;
    await selectCase(record);
    if (result.stepId) setSelectedStepId(result.stepId);
    setSearchOpen(false);
  }

  async function openAttachment(objectKey: string) {
    const previewWindow = window.open("about:blank", "_blank");
    if (previewWindow) previewWindow.opener = null;
    try {
      const url = await getAttachmentUrl(objectKey);
      if (previewWindow) previewWindow.location.href = url;
    } catch (reason) {
      previewWindow?.close();
      handleError(reason);
    }
  }

  function renderAttachmentList(attachments: Attachment[], procurementStepId?: string) {
    if (attachments.length === 0) return null;
    return (
      <div className="attachment-list">
        {attachments.map((attachment) => {
          const canAnalyze = attachment.contentType === "application/pdf" ||
            attachment.contentType === "text/plain" ||
            [".docx", ".docm", ".dotx", ".dotm", ".docb", ".xlsx", ".xlsm", ".xlsb", ".xltx", ".xltm", ".xlam", ".xls", ".xlt", ".xla", ".csv", ".tsv", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppam", ".odp", ".odt", ".ods", ".rtf", ".html", ".htm", ".xml"]
              .includes(attachment.filename.slice(attachment.filename.lastIndexOf(".")).toLowerCase());
          const sizeLabel = attachment.size >= 1024 * 1024
            ? `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`
            : `${(attachment.size / 1024).toFixed(0)} KB`;
          return (
            <article className="attachment-card" key={attachment.id}>
              <span className="file-icon">{attachment.contentType === "application/pdf" ? "PDF" : "文件"}</span>
              <div className="attachment-info">
                <button className="attachment-link" type="button" onClick={() => void openAttachment(attachment.objectKey)}>{attachment.filename}</button>
                <small>{sizeLabel} · {attachment.syncMessage}</small>
              </div>
              <div className="attachment-actions">
                <button className="text-button" disabled={busy || !online || !config?.aiEnabled || !canAnalyze} title={!canAnalyze ? "AI 解读支持 PDF、TXT 和常用 Office 文档" : config?.aiEnabled ? "使用配置的 AI 解读附件" : "请先配置 AI 服务"} onClick={() => void analyzeCaseAttachment(attachment, procurementStepId)}>{canAnalyze ? attachment.analysis ? "重新解读" : "AI 解读" : "暂不可解读"}</button>
                <button className="icon-button danger-icon" aria-label="删除材料" disabled={busy || !online} onClick={() => void deleteAttachment(attachment.id, procurementStepId)}>×</button>
              </div>
              {attachment.analysis && (
                <AnalysisCard
                  analysis={attachment.analysis}
                  visible={!hiddenAnalysisIds.includes(attachment.id)}
                  onToggle={() => {
                    setHiddenAnalysisIds((current) => {
                      const next = current.includes(attachment.id)
                        ? current.filter((id) => id !== attachment.id)
                        : [...current, attachment.id];
                      localStorage.setItem("banshi-hidden-analysis", JSON.stringify(next));
                      return next;
                    });
                  }}
                />
              )}
            </article>
          );
        })}
      </div>
    );
  }

  if (loading) return <main className="loading-screen"><span className="spinner" />正在加载工作台…</main>;

  if (settingsPage && config) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="brand"><div className="brand-mark">事</div><div><strong>办事流程台账</strong><span>流程设置</span></div></div>
          <div className="top-actions">
            <span className="user-chip">OSS 直连</span>
            <button className="secondary" onClick={() => setSettingsPage(null)}>返回事项台账</button>
          </div>
        </header>
        {settingsPage === "procurement" ? (
          <ProcurementSettings
            modes={config.procurementModes}
            busy={busy}
            online={online}
            onSave={(modes) => void saveProcurementModes(modes)}
            onCancel={() => setSettingsPage(null)}
          />
        ) : (
          <AiSettings
            initial={config.aiPreferences}
            busy={busy}
            onSave={saveAiSettings}
            onCancel={() => setSettingsPage(null)}
          />
        )}
        {error && <div className="settings-error" role="alert">{error}</div>}
      </div>
    );
  }

  const phaseProgress = selectedCase && config ? config.stages.map((stage) => {
    const stageSteps = selectedCase.steps.filter((step) => step.stageId === stage.id);
    return { ...stage, done: stageSteps.filter((step) => step.status === "completed").length, total: stageSteps.length };
  }) : [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">事</div>
          <div><strong>办事流程台账</strong><span>来源 · 办理 · 闭环</span></div>
        </div>
        <div className="global-search-wrap">
          <form className="global-search" role="search" onSubmit={(event) => void searchGlobal(event)}>
            <span aria-hidden="true">⌕</span>
            <input aria-label="全域搜索" placeholder="搜索事项、办理记录、采购步骤和材料…" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setSearchOpen(false); }} />
            <button disabled={searching || !searchQuery.trim()}>{searching ? "搜索中…" : "搜索"}</button>
          </form>
          {searchOpen && (
            <div className="search-results-panel">
              <div className="search-results-head"><strong>搜索结果</strong><span>{searchResults.length ? `显示 ${searchResults.length} 条` : "没有匹配内容"}</span><button type="button" onClick={() => setSearchOpen(false)}>关闭</button></div>
              {searchResults.map((result, index) => (
                <button className="search-result" key={`${result.caseId}-${result.stepId}-${result.field}-${index}`} onClick={() => void openSearchResult(result)}>
                  <strong>{result.caseTitle}</strong>
                  <span>{result.stepTitle ? `${result.stepTitle} · ` : ""}{result.field}</span>
                  <small>{result.snippet}</small>
                </button>
              ))}
              {searchResults.length === 0 && <p className="search-empty">试试事项名称、办理记录、采购步骤名称或材料文本中的关键词。</p>}
            </div>
          )}
        </div>
        <div className="top-actions">
          {!online && <span className="offline-pill">离线 · 仅可查看已打开页面</span>}
          <span className={`sync-pill ${sync.status}`}><i />{statusLabel(sync.status)}</span>
          {(sync.status === "failed" || cases.some((record) => record.steps.some((step) => step.attachments.some((attachment) => attachment.syncStatus === "failed")))) && <button className="quiet-button" onClick={retrySync} disabled={busy}>重试同步</button>}
          {installPrompt && <button className="quiet-button" onClick={() => void installPrompt.prompt()}>安装应用</button>}
          <button className="quiet-button" onClick={() => { setTodoEditing(null); setTodoOpen(true); }}>临时待办（{todos.filter((todo) => !todo.isCompleted).length}/{todos.filter((todo) => todo.isCompleted).length}）</button>
          <button className="quiet-button" onClick={() => setSettingsPage("procurement")}>采购路径设置</button>
          <button className="quiet-button" onClick={() => setSettingsPage("ai")}>AI 设置</button>
          <span className="user-chip">OSS 直连</span>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <div className="sidebar-head">
            <div><p className="eyebrow">工作事项</p><h2>事项台账</h2></div>
            <button aria-label="新建事项" className="icon-button" disabled={!online} onClick={() => setCreateOpen(true)}>＋</button>
          </div>
          <button className="new-case-button" disabled={!online} onClick={() => setCreateOpen(true)}>＋ 新建办事事项</button>
          {cases.length === 0 ? (
            <div className="empty-sidebar"><span>▤</span><strong>还没有事项</strong><p>创建第一条事项，按步骤记录办理过程。</p></div>
          ) : (
            <>
              <div className="case-filter-tabs" aria-label="事项状态筛选">
                {([
                  ["all", "全部"],
                  ["handling", "办理中"],
                  ["pending", "未办理"],
                  ["completed", "已完成"],
                  ["held", "搁置"],
                ] as const).map(([value, label]) => {
                  const count = value === "all" ? cases.length : cases.filter((record) => getCaseCategory(record) === value).length;
                  return <button key={value} className={caseFilter === value ? "active" : ""} onClick={() => setCaseFilter(value)}>{label}<span>{count}</span></button>;
                })}
              </div>
              <div className="case-list">
                {cases.filter((record) => caseFilter === "all" || getCaseCategory(record) === caseFilter).map((record) => {
                  const progress = getCaseProgress(record);
                  return (
                    <button key={record.id} className={`case-card ${record.id === selectedId ? "selected" : ""}`} onClick={() => void selectCase(record)}>
                      <span className="case-card-title">{record.title}</span>
                      <span className="case-card-source">{record.source}</span>
                      {(record.isImportant || record.isOnHold) && (
                        <span className="case-card-badges">
                          {record.isImportant && <span className="case-badge important">★ 重要</span>}
                          {record.isOnHold && <span className="case-badge on-hold">搁置</span>}
                        </span>
                      )}
                      <span className="case-progress"><span style={{ width: `${progress.percent}%` }} /></span>
                      <span className="case-card-foot"><span>{progress.done === progress.total ? "已闭环" : `已完成 ${progress.done}/${progress.total} 步`}</span><span>{progress.percent}%</span></span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <button className="audit-link" onClick={() => void showAudit()}>查看操作审计记录 <span>↗</span></button>
        </aside>

        <section className="main-panel">
          {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}
          {!selectedCase ? (
            <div className="welcome-panel">
              <div className="welcome-art"><span>01</span><span>02</span><span>03</span><b>→</b></div>
              <p className="eyebrow">规范记录 · 按序推进 · 人工确认</p>
              <h1>让每一项办理<br />都有依据、有记录、有闭环。</h1>
              <p className="welcome-copy">创建事项后，依次完成来源登记、过程办理和最终闭环。系统会检查步骤顺序，并记录材料、人工确认与操作审计。</p>
              <button className="primary" disabled={!online} onClick={() => setCreateOpen(true)}>创建一项办事事项 <span>→</span></button>
              <div className="disclaimer-strip">AI 仅用于辅助整理材料，不作审批或权威合规结论。工作人员须独立核实并作出最终决定。</div>
            </div>
          ) : (
            <div className="case-workspace">
              <div className="case-heading">
                <div>
                  <div className="breadcrumb">事项台账 <span>/</span> {selectedCase.title}</div>
                  <h1>{selectedCase.title}</h1>
                  <p>{selectedCase.description || "暂无事项说明"}</p>
                </div>
                <div className="case-actions">
                  <div className="completion-badge">
                    <strong>{getCaseProgress(selectedCase).percent}%</strong>
                    <span>整体进度</span>
                  </div>
                  <div className="case-action-buttons">
                    <button className="secondary" onClick={() => setAuditChecklistOpen(true)}>生成送审清单</button>
                    <button className="secondary" disabled={busy || !online} onClick={() => setRenameOpen(true)}>修改名称</button>
                    <button className="secondary" disabled={busy || !online} onClick={() => void updateCaseFlags({ isImportant: !selectedCase.isImportant })}>{selectedCase.isImportant ? "★ 已置顶" : "设为重要并置顶"}</button>
                    <button className="secondary" disabled={busy || !online} onClick={() => void updateCaseFlags({ isOnHold: !selectedCase.isOnHold })}>{selectedCase.isOnHold ? "恢复办理" : "设为搁置并置底"}</button>
                    <button className="danger-button" disabled={busy || !online} onClick={() => void deleteCase()}>删除事项</button>
                  </div>
                </div>
              </div>
              {(selectedCase.isImportant || selectedCase.isOnHold) && (
                <div className="case-status-badges">
                  {selectedCase.isImportant && <span className="case-badge important">★ 重要事项（列表置顶）</span>}
                  {selectedCase.isOnHold && <span className="case-badge on-hold">搁置事项（列表置底）</span>}
                </div>
              )}
              <div className="source-card"><span className="source-icon">↳</span><div><span>事项来源</span><strong>{selectedCase.source}</strong></div>{selectedHandlingPath && <span className="path-chip">路径：{selectedHandlingPath.title}</span>}<small>建档于 {formatTime(selectedCase.createdAt)}</small></div>

              <div className="stage-overview">
                {phaseProgress.map((stage, index) => (
                  <div key={stage.id} className={`stage-progress ${stage.done === stage.total ? "complete" : stage.done ? "active" : ""}`}>
                    <span className="stage-number">{stage.done === stage.total ? "✓" : `0${index + 1}`}</span>
                    <span className="stage-name">{stage.title}</span>
                    <span className="stage-count">{stage.done}/{stage.total}</span>
                    {index < phaseProgress.length - 1 && <span className="stage-line" />}
                  </div>
                ))}
              </div>

              <div className="work-columns">
                <section className="steps-panel">
                  <div className="section-title"><div><p className="eyebrow">办理路径</p><h2>步骤清单</h2></div><span>{getCaseProgress(selectedCase).done} / {getCaseProgress(selectedCase).total} 已完成</span></div>
                  {phaseProgress.map((stage) => (
                    <div className="step-stage" key={stage.id}>
                      <h3>{stage.title}<span>{stage.done === stage.total ? "已完成" : `${stage.done}/${stage.total}`}</span></h3>
                      {selectedCase.steps.filter((step) => step.stageId === stage.id).map((step, index) => {
                        const isCurrent = currentStep?.id === step.id;
                        const isActive = activeStep?.id === step.id;
                        return (
                          <button key={step.id} className={`step-row ${isActive ? "active" : ""} ${step.status === "completed" ? "done" : ""} ${!isCurrent && step.status !== "completed" ? "locked" : ""}`} onClick={() => setSelectedStepId(step.id)}>
                            <span className="step-mark">{step.status === "completed" ? "✓" : `${index + 1}`}</span>
                            <span className="step-copy"><strong>{step.title}</strong><small>{step.status === "completed" ? `由 ${step.completedBy} 完成` : isCurrent ? "当前待办" : "等待前序步骤完成"}</small></span>
                            {isCurrent && <span className="current-dot" />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </section>

                <section className="detail-panel">
                  {activeStep ? (
                    <>
                      <div className="detail-head">
                        <div><p className="eyebrow">{activeStep.stageTitle} · {activeStep.status === "completed" ? "已完成" : "当前步骤"}</p><h2>{activeStep.title}</h2></div>
                        {activeStep.status === "completed" && <span className="completed-label">✓ 已完成</span>}
                      </div>
                      <div className="guidance-box"><span>办理提示</span><p>{activeStep.guidance}</p></div>
                      {activeStep.id === "process-assign" && activeStep.status !== "completed" && (
                        <div className="path-selector">
                          <label className="field-label" htmlFor="handling-path">办理路径 <span>必选，采购路径确定后将按配置逐步办理</span></label>
                          <select id="handling-path" value={pathDraft} disabled={busy || !online} onChange={(event) => setPathDraft(event.target.value)}>
                            <option value="">请选择办理路径</option>
                            {config?.handlingPaths.map((path) => (
                              <option key={path.id} value={path.id}>{path.title}{path.procurement ? "（采购模式）" : ""}</option>
                            ))}
                          </select>
                          {selectedHandlingPath?.procurement && <p className="path-hint">已选择采购模式；进入“开展办理并记录依据”后，系统将严格按该模式配置的步骤逐项记录。</p>}
                        </div>
                      )}
                      {activeStep.id === "process-handle" && selectedHandlingPath?.procurement && (
                        <section className="procurement-flow">
                          <div className="procurement-flow-head">
                            <div><p className="eyebrow">采购模式 · {selectedHandlingPath.title}</p><h3>采购办理步骤</h3></div>
                            <span>{activeStep.procurementSteps?.filter((step) => step.status === "completed").length ?? 0} / {activeStep.procurementSteps?.length ?? 0} 已完成</span>
                          </div>
                          <p className="procurement-warning">按当前已保存的步骤顺序办理；每步必须填写记录并完成后才能进入下一步。示例步骤不代表法定或单位正式流程，请在“采购路径设置”中按本单位制度调整。</p>
                          <ol className="procurement-step-list">
                            {(activeStep.procurementSteps ?? []).map((step, index) => (
                              <li key={step.id} className={step.status === "completed" ? "done" : step.id === currentProcurementStep?.id && currentStep?.id === activeStep.id ? "current" : ""}>
                                <span className="procurement-step-mark">{step.status === "completed" ? "✓" : index + 1}</span>
                                <div className="procurement-step-body">
                                  <div className="procurement-step-title">
                                    <div><strong>{step.title}</strong><small>{step.status === "completed" ? `由 ${step.completedBy} 完成 · ${formatTime(step.completedAt)}` : step.guidance}</small></div>
                                    {step.status === "completed" && <button className="text-button procurement-reopen-button" disabled={busy || !online} onClick={() => void reopenProcurementStep(step)}>退回修改</button>}
                                  </div>
                                  <div className="materials-head"><div><h3>本步骤相关附件</h3><span>可多选并自动上传；单个文件最大 100 MB</span></div><span>{step.attachments?.length ?? 0} 份</span></div>
                                  <div className="upload-row">
                                    <input
                                      type="file"
                                      accept={SUPPORTED_ATTACHMENT_EXTENSIONS.join(",")}
                                      multiple
                                      disabled={busy || !online || currentStep?.id !== activeStep.id || activeStep.status === "completed"}
                                      onChange={(event) => void uploadFiles(event, step.id)}
                                    />
                                  </div>
                                  {uploadStatus?.targetId === `${selectedCase?.id}:procurement:${step.id}` && uploadStatus.message && <p className="hint-text upload-status" role="status">{uploadStatus.message}</p>}
                                  {renderAttachmentList(step.attachments ?? [], step.id)}
                                </div>
                              </li>
                            ))}
                          </ol>
                          {currentStep?.id === activeStep.id && currentProcurementStep && (
                            <div className="procurement-record">
                              <label className="field-label" htmlFor="procurement-note">本采购步骤记录 <span>必填后方可推进</span></label>
                              <textarea id="procurement-note" rows={4} maxLength={10000} disabled={busy || !online} value={procurementNoteDraft} onChange={(event) => setProcurementNoteDraft(event.target.value)} placeholder="记录本步骤实际办理情况、依据及待核实事项…" />
                              {autoSaveStatus && <p className="hint-text" role="status">{autoSaveStatus}</p>}
                              <div className="procurement-actions">
                                <button className="primary" disabled={busy || !online || !procurementNoteDraft.trim()} onClick={() => void completeProcurementStep()}>完成本步并进入下一步 →</button>
                              </div>
                            </div>
                          )}
                          {activeStep.procurementSteps?.length && !currentProcurementStep && <div className="procurement-all-done">✓ 本采购模式的配置步骤已全部完成</div>}
                        </section>
                      )}
                      {activeStep.status === "completed" ? (
                        <>
                          {activeStep.note && <div className="saved-note"><span>办理记录</span><p>{activeStep.note}</p></div>}
                          <div className="completed-meta">完成时间 {formatTime(activeStep.completedAt)} · 办理人 {activeStep.completedBy}</div>
                          <button className="text-button reopen-button" disabled={busy || !online} onClick={() => void reopenStep(activeStep)}>重新打开此步骤及后续步骤</button>
                        </>
                      ) : (
                        <>
                          <label className="field-label" htmlFor="step-note">办理记录 <span>必填后方可完成此步</span></label>
                          <textarea id="step-note" rows={5} value={noteDraft} maxLength={10000} disabled={!online} onChange={(event) => setNoteDraft(event.target.value)} placeholder="记录实际办理情况、依据及需要跟进的问题…" />
                          <div className="textarea-foot"><span>请准确记录事实，敏感信息按单位要求处理。</span><span>{noteDraft.length}/10000</span></div>
                          {autoSaveStatus && <p className="hint-text" role="status">{autoSaveStatus}</p>}

                          <div className="materials-head"><div><h3>办理依据材料</h3><span>支持多选并自动上传；Office、PDF、文档及压缩文件，单个文件最大 100 MB</span></div><span>{activeStep.attachments.length} 份</span></div>
                          <div className="upload-row">
                            <input name="file" type="file" accept={SUPPORTED_ATTACHMENT_EXTENSIONS.join(",")} multiple disabled={busy || !online} onChange={(event) => void uploadFiles(event)} />
                          </div>
                          {uploadStatus?.targetId === `${selectedCase.id}:step:${activeStep.id}` && uploadStatus.message && <p className="hint-text upload-status" role="status">{uploadStatus.message}</p>}
                          {!online && <p className="hint-text">离线时不支持上传或编辑；恢复网络后请重新操作。</p>}
                          {renderAttachmentList(activeStep.attachments)}
                          {activeStep.requiresReview && (
                            <div className="review-box">
                              <div><strong>最终人工确认</strong><p>AI 不会自动确认闭环。请由工作人员核对过程记录与材料。</p></div>
                              {activeStep.humanReview && <span className={`review-status ${activeStep.humanReview.decision}`}>{activeStep.humanReview.decision === "approved" ? "已确认" : "已退回"} · {activeStep.humanReview.reviewer}</span>}
                              <div className="review-actions">
                                <button className="secondary" disabled={busy || !online} onClick={() => void reviewStep("returned")}>退回补充</button>
                                <button className="secondary" disabled={busy || !online} onClick={() => void reviewStep("approved")}>人工确认通过</button>
                              </div>
                              {activeStep.humanReview?.comment && <small className="review-comment">确认意见：{activeStep.humanReview.comment}</small>}
                            </div>
                          )}
                          <div className="step-actions">
                            <button className="primary" disabled={busy || !online || !noteDraft.trim() || (activeStep.id === "process-assign" && !pathDraft) || (activeStep.id === "process-handle" && selectedHandlingPath?.procurement && Boolean(activeStep.procurementSteps?.some((step) => step.status !== "completed"))) || (activeStep.requiresReview && activeStep.humanReview?.decision !== "approved")} onClick={() => void completeStep()}>
                              {busy ? "处理中…" : "完成此步并继续"} <span>→</span>
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="all-done"><span>✓</span><h2>事项已完成闭环</h2><p>所有步骤均已完成。请按单位要求归档和保存原始材料。</p></div>
                  )}
                  <div className="ai-notice"><span>AI 辅助说明</span>{config?.aiEnabled ? "AI 结果仅供参考，工作人员必须核验原始材料和事实；解读会将附件文本发送至已选服务商。" : "请在“AI 设置”中选择阿里云或腾讯混元并配置 API Key 后解读附件。"}</div>
                </section>
              </div>
              <div className="storage-note"><strong>数据与存储</strong><span>事项数据和附件直接读写 OSS；每次打开时从 OSS 加载最新事项。此静态页面不提供账号认证及多人并发写入保障。</span></div>
            </div>
          )}
        </section>
      </main>

      {createOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}>
        <form className="modal-card" onSubmit={(event) => void createCase(event)}>
          <button type="button" className="modal-close" aria-label="关闭" onClick={() => setCreateOpen(false)}>×</button>
          <p className="eyebrow">新建台账</p><h2>登记办事事项</h2><p className="muted">建档后将按固定顺序生成事项来源、办理流程和最终闭环步骤。</p>
          <label>事项名称 <span className="required">*</span><input name="title" required maxLength={160} placeholder="例如：某项业务办理事项" /></label>
          <label>事项来源 <span className="required">*</span><textarea name="source" required maxLength={2000} rows={3} placeholder="记录来文、交办、申请或其他来源；避免填写不必要的敏感信息。" /></label>
          <label>事项说明<input name="description" maxLength={5000} placeholder="可选" /></label>
          {error && <p className="error-text">{error}</p>}
          <div className="modal-actions"><button type="button" className="secondary" onClick={() => setCreateOpen(false)}>取消</button><button className="primary" disabled={busy || !online}>{busy ? "正在创建…" : "创建事项"}</button></div>
        </form>
      </div>}

      {renameOpen && selectedCase && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRenameOpen(false); }}>
        <form className="modal-card" onSubmit={(event) => void renameCase(event)}>
          <button type="button" className="modal-close" aria-label="关闭" onClick={() => setRenameOpen(false)}>×</button>
          <p className="eyebrow">事项管理</p><h2>修改事项名称</h2>
          <label>事项名称 <span className="required">*</span><input name="title" required maxLength={160} defaultValue={selectedCase.title} /></label>
          {error && <p className="error-text">{error}</p>}
          <div className="modal-actions"><button type="button" className="secondary" onClick={() => setRenameOpen(false)}>取消</button><button className="primary" disabled={busy || !online}>{busy ? "正在保存…" : "保存名称"}</button></div>
        </form>
      </div>}

      {audit.length > 0 && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAudit([]); }}>
        <section className="modal-card audit-modal"><button className="modal-close" aria-label="关闭" onClick={() => setAudit([])}>×</button><p className="eyebrow">追踪与留痕</p><h2>最近操作记录</h2>
          <div className="audit-list">{audit.map((entry) => <article key={entry.id}><span className="audit-dot" /><div><strong>{entry.action.replaceAll("_", " ")}</strong><small>{entry.actor} · {formatTime(entry.at)}</small></div></article>)}</div>
          <p className="privacy-note">审计记录保存在 OSS 业务 JSON 中；此 MVP 不提供独立防篡改审计存储。</p>
        </section>
      </div>}
      {todoOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setTodoOpen(false); }}>
        <section className="modal-card todo-modal">
          <button type="button" className="modal-close" aria-label="关闭" onClick={() => setTodoOpen(false)}>×</button>
          <p className="eyebrow">临时待办</p><h2>待办提醒</h2>
          <form className="todo-form" onSubmit={(event) => void saveTodo(event)}>
            <label>事件名称 <span className="required">*</span><input name="title" required maxLength={160} defaultValue={todoEditing?.title ?? ""} /></label>
            <div className="todo-form-row">
              <label>截止日期 <span className="required">*</span><input name="dueDate" type="date" required defaultValue={todoEditing?.dueDate ?? ""} /></label>
              <label>经办人 <span className="required">*</span><input name="assignee" required maxLength={80} defaultValue={todoEditing?.assignee ?? ""} /></label>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => { setTodoEditing(null); }}>清空</button>
              <button className="primary" disabled={busy}>{busy ? "正在保存…" : todoEditing ? "保存修改" : "新增待办"}</button>
            </div>
          </form>
          <div className="todo-filter-tabs" aria-label="临时待办状态分类">
            <button type="button" className={todoFilter === "pending" ? "active" : ""} onClick={() => setTodoFilter("pending")}>
              未完成 <span>{todos.filter((todo) => !todo.isCompleted).length}</span>
            </button>
            <button type="button" className={todoFilter === "completed" ? "active" : ""} onClick={() => setTodoFilter("completed")}>
              已完成 <span>{todos.filter((todo) => todo.isCompleted).length}</span>
            </button>
          </div>
          <div className="todo-list">
            {[...todos]
              .filter((todo) => todoFilter === "completed" ? todo.isCompleted : !todo.isCompleted)
              .sort((a, b) => a.dueDate.localeCompare(b.dueDate) ||
                b.updatedAt.localeCompare(a.updatedAt))
              .map((todo) => (
              <article key={todo.id} className={todo.isCompleted ? "completed" : ""}>
                <div><strong>{todo.title}</strong><span>截止 {todo.dueDate} · 经办人 {todo.assignee}</span></div>
                <div>
                  <button className="text-button" onClick={() => setTodoEditing(todo)}>修改</button>
                  <button className="text-button" onClick={() => void toggleTodoCompleted(todo)}>{todo.isCompleted ? "恢复未完成" : "标记完成"}</button>
                  <button className="text-button danger-text" onClick={() => void deleteTodo(todo)}>删除</button>
                </div>
              </article>
            ))}
            {todos.filter((todo) => todoFilter === "completed" ? todo.isCompleted : !todo.isCompleted).length === 0 &&
              <p className="todo-empty">{todoFilter === "completed" ? "暂无已完成待办" : "暂无未完成待办"}</p>}
          </div>
        </section>
      </div>}
      {todoReminderOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setTodoReminderOpen(false); }}>
        <section className="modal-card todo-reminder">
          <button type="button" className="modal-close" aria-label="关闭" onClick={() => setTodoReminderOpen(false)}>×</button>
          <p className="eyebrow">临时待办提醒</p><h2>以下事项即将到期</h2>
          <div className="todo-reminder-list">
            {todos.filter((todo) => {
              if (todo.isCompleted) return false;
              const remaining = Math.ceil((new Date(`${todo.dueDate}T23:59:59`).getTime() - Date.now()) / 86400000);
              return remaining >= 0 && remaining <= 3;
            }).map((todo) => <article key={todo.id}><strong>{todo.title}</strong><span>截止日期：{todo.dueDate}</span><span>经办人：{todo.assignee}</span></article>)}
          </div>
          <div className="modal-actions"><button className="primary" onClick={() => setTodoReminderOpen(false)}>知道了</button></div>
        </section>
      </div>}
      {selectionMenu && (
        <button
          type="button"
          className="selection-todo-button"
          style={{ left: selectionMenu.x, top: selectionMenu.y }}
          disabled={busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void addSelectedTextTodo(selectionMenu.text)}
        >
          ＋ 加为临时待办
        </button>
      )}
      {auditChecklistOpen && selectedCase && (
        <AuditChecklist
          record={selectedCase}
          handlingPathTitle={config?.handlingPaths.find((path) => path.id === selectedCase.handlingPath)?.title ?? "未选择"}
          onClose={() => setAuditChecklistOpen(false)}
        />
      )}
    </div>
  );
}

function AnalysisCard({
  analysis,
  visible,
  onToggle,
}: {
  analysis: NonNullable<Step["attachments"][number]["analysis"]>;
  visible: boolean;
  onToggle: () => void;
}) {
  const groups = [
    ["材料关键信息", analysis.keyFacts],
    ["待核对点", analysis.checks],
    ["下一步建议", analysis.nextSteps],
    ["注意事项", analysis.cautions],
    ["需人工核实", analysis.humanVerification],
  ] as const;
  return (
    <div className="analysis-card">
      <div className="analysis-title">
        <span>AI 材料整理</span>
        <div><small>{formatTime(analysis.generatedAt)}</small><button type="button" className="text-button" onClick={onToggle}>{visible ? "隐藏" : "显示"}</button></div>
      </div>
      {visible && <>
        <p className="analysis-summary">{analysis.summary}</p>
        {groups.filter(([, items]) => items.length > 0).map(([title, items]) => <div className="analysis-group" key={title}><strong>{title}</strong><ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul></div>)}
        <p className="analysis-disclaimer">{analysis.disclaimer}</p>
      </>}
    </div>
  );
}

function AuditChecklist({
  record,
  handlingPathTitle,
  onClose,
}: {
  record: CaseRecord;
  handlingPathTitle: string;
  onClose: () => void;
}) {
  const [generatedAt] = useState(() => new Date().toISOString());
  const reportRef = useRef<HTMLElement>(null);
  const currentStep = record.steps.find((step) => step.status !== "completed");
  const procurementSteps = record.steps.find((step) => step.id === "process-handle")?.procurementSteps ?? [];
  const completedCount = record.steps.filter((step) => step.status === "completed").length +
    procurementSteps.filter((step) => step.status === "completed").length;
  const totalCount = record.steps.length + procurementSteps.length;
  const attachments = record.steps.flatMap((step) => [
    ...step.attachments,
    ...(step.procurementSteps ?? []).flatMap((procurementStep) => procurementStep.attachments ?? []),
  ]);
  const downloadPackage = async () => {
    const zip = new JSZip();
    if (reportRef.current) {
      const canvas = await html2canvas(reportRef.current, {
        scale: 1.5,
        useCORS: true,
        backgroundColor: "#ffffff",
        logging: false,
        windowWidth: reportRef.current.scrollWidth,
        windowHeight: reportRef.current.scrollHeight,
      });
      const pdf = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
      const pageWidth = 595;
      const pageHeight = 842;
      const margin = 20;
      const contentWidth = pageWidth - margin * 2;
      const sliceHeight = Math.floor((pageHeight - margin * 2) * canvas.width / contentWidth);
      let offset = 0;
      let firstPage = true;
      while (offset < canvas.height) {
        if (!firstPage) pdf.addPage();
        const height = Math.min(sliceHeight, canvas.height - offset);
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = height;
        slice.getContext("2d")?.drawImage(canvas, 0, offset, canvas.width, height, 0, 0, canvas.width, height);
        const imageHeight = height * contentWidth / canvas.width;
        pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, contentWidth, imageHeight);
        offset += height;
        firstPage = false;
      }
      zip.file("事项办理报告.pdf", pdf.output("arraybuffer"));
    }

    const seen = new Set<string>();
    for (const attachment of attachments) {
      const key = `${attachment.filename}\u0000${attachment.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const downloadUrl = await getAttachmentUrl(attachment.objectKey);
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error("附件下载失败");
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength === 0) throw new Error("附件为空");
        zip.file(attachment.filename, bytes);
      } catch (reason) {
        zip.file(`下载失败/${attachment.filename}.txt`, `附件下载失败：${attachment.filename}\n${reason instanceof Error ? reason.message : "未知错误"}`);
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${record.title.replace(/[\\/:*?"<>|]/g, "_")}-送审材料.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  const statusText = (completed: boolean, current: boolean) => completed ? "已完成" : current ? "办理中" : "待办理";
  const renderAttachments = (items: Attachment[]) => items.length === 0 ? (
    <p className="audit-empty">无附件</p>
  ) : (
    <ul className="audit-attachment-list">
      {items.map((attachment) => (
        <li key={attachment.id}>
          <span className="audit-checkbox">□</span>
          <div><strong>{attachment.filename}</strong><small>{attachment.size >= 1024 * 1024 ? `${(attachment.size / (1024 * 1024)).toFixed(1)} MB` : attachment.size >= 1024 ? `${(attachment.size / 1024).toFixed(1)} KB` : `${attachment.size} B`} · 上传人 {attachment.uploadedBy} · {formatTime(attachment.uploadedAt)}</small></div>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="audit-checklist-overlay" role="dialog" aria-modal="true" aria-label="事项办理送审清单">
      <div className="audit-checklist-toolbar">
        <strong>送审清单预览</strong>
        <div>
          <button className="secondary" onClick={onClose}>返回</button>
          <button className="secondary" onClick={() => void downloadPackage()}>打包报告及附件</button>
          <button className="primary" onClick={() => window.print()}>打印 / 保存为 PDF</button>
        </div>
      </div>
      <article ref={reportRef} className="audit-checklist-document">
        <header className="audit-document-header">
          <p>事项办理材料</p>
          <h1>事项办理送审清单</h1>
          <span>生成时间：{formatTime(generatedAt)}</span>
        </header>

        <section className="audit-document-section">
          <h2>一、事项基本信息</h2>
          <table className="audit-info-table"><tbody>
            <tr><th>事项名称</th><td>{record.title}</td><th>办理路径</th><td>{handlingPathTitle}</td></tr>
            <tr><th>事项编号</th><td colSpan={3}>{record.id}</td></tr>
            <tr><th>事项来源</th><td colSpan={3}>{record.source}</td></tr>
            <tr><th>事项说明</th><td colSpan={3}>{record.description || "未填写"}</td></tr>
            <tr><th>建档时间</th><td>{formatTime(record.createdAt)}</td><th>最近更新</th><td>{formatTime(record.updatedAt)}</td></tr>
            <tr><th>流程进度</th><td>{completedCount} / {totalCount} 步已完成</td><th>附件数量</th><td>{attachments.length} 份</td></tr>
          </tbody></table>
        </section>

        <section className="audit-document-section">
          <h2>二、办理流程与材料清单</h2>
          {record.steps.map((step, index) => {
            const isCurrent = currentStep?.id === step.id;
            return (
              <section className="audit-process-step" key={step.id}>
                <header className="audit-process-heading">
                  <h3>{index + 1}. {step.stageTitle} · {step.title}</h3>
                  <strong>{statusText(step.status === "completed", isCurrent)}</strong>
                </header>
                <p className="audit-guidance"><b>办理提示：</b>{step.guidance}</p>
                <p className="audit-record"><b>办理记录：</b>{step.note || "未填写"}</p>
                {step.status === "completed" && <p className="audit-meta">完成时间：{formatTime(step.completedAt)}　办理人：{step.completedBy || "未记录"}</p>}
                {step.humanReview && <p className="audit-meta">人工确认：{step.humanReview.decision === "approved" ? "确认通过" : "退回补充"}　确认人：{step.humanReview.reviewer}　时间：{formatTime(step.humanReview.reviewedAt)}{step.humanReview.comment ? `　意见：${step.humanReview.comment}` : ""}</p>}
                <div className="audit-step-attachments"><b>办理依据材料（{step.attachments.length} 份）</b>{renderAttachments(step.attachments)}</div>
                {step.procurementSteps?.map((procurementStep, procurementIndex) => {
                  const isCurrentProcurement = isCurrent && procurementSteps.find((item) => item.status !== "completed")?.id === procurementStep.id;
                  return (
                    <section className="audit-procurement-step" key={procurementStep.id}>
                      <header className="audit-process-heading">
                        <h4>{index + 1}.{procurementIndex + 1} {procurementStep.title}</h4>
                        <strong>{statusText(procurementStep.status === "completed", isCurrentProcurement)}</strong>
                      </header>
                      <p className="audit-guidance"><b>办理提示：</b>{procurementStep.guidance}</p>
                      <p className="audit-record"><b>办理记录：</b>{procurementStep.note || "未填写"}</p>
                      {procurementStep.status === "completed" && <p className="audit-meta">完成时间：{formatTime(procurementStep.completedAt)}　办理人：{procurementStep.completedBy || "未记录"}</p>}
                      <div className="audit-step-attachments"><b>本步骤附件（{procurementStep.attachments?.length ?? 0} 份）</b>{renderAttachments(procurementStep.attachments ?? [])}</div>
                    </section>
                  );
                })}
              </section>
            );
          })}
        </section>

        <section className="audit-document-section">
          <h2>三、送审核对</h2>
          <ul className="audit-review-checklist">
            <li><span>□</span>事项来源、办理记录及流程状态与实际情况一致</li>
            <li><span>□</span>纸质材料或电子附件齐全，且与本清单逐项核对</li>
            <li><span>□</span>需人工确认的事项已由工作人员核验并签署意见</li>
          </ul>
          <table className="audit-signature-table"><tbody>
            <tr><th>送审单位（盖章）</th><th>经办人</th><th>送审日期</th></tr>
            <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
            <tr><th colSpan={3}>审核意见</th></tr>
            <tr><td colSpan={3}>&nbsp;</td></tr>
          </tbody></table>
        </section>
        <p className="audit-document-note">本清单根据系统当前记录整理生成，仅供送审整理和打印核对；请与原始凭证、附件原件及单位档案要求核验。附件目录不包含附件文件本身，原件请另行提供或按单位要求归档。</p>
      </article>
    </div>
  );
}

function ProcurementSettings({
  modes,
  busy,
  online,
  onSave,
  onCancel,
}: {
  modes: ProcurementMode[];
  busy: boolean;
  online: boolean;
  onSave: (modes: ProcurementMode[]) => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState(modes);

  useEffect(() => setDrafts(modes), [modes]);

  function updateStep(modeId: string, stepId: string, patch: Partial<ProcurementMode["steps"][number]>) {
    setDrafts((current) => current.map((mode) => mode.id === modeId
      ? { ...mode, steps: mode.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step) }
      : mode));
  }

  function moveStep(modeId: string, index: number, direction: -1 | 1) {
    setDrafts((current) => current.map((mode) => {
      if (mode.id !== modeId) return mode;
      const target = index + direction;
      if (target < 0 || target >= mode.steps.length) return mode;
      const steps = [...mode.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...mode, steps };
    }));
  }

  function removeStep(modeId: string, stepId: string) {
    setDrafts((current) => current.map((mode) => mode.id === modeId && mode.steps.length > 1
      ? { ...mode, steps: mode.steps.filter((step) => step.id !== stepId) }
      : mode));
  }

  function addStep(modeId: string) {
    setDrafts((current) => current.map((mode) => mode.id === modeId && mode.steps.length < 50
      ? { ...mode, steps: [...mode.steps, { id: crypto.randomUUID(), title: "", guidance: "" }] }
      : mode));
  }

  return (
    <main className="settings-page">
      <div className="settings-heading">
        <div><p className="eyebrow">办理流程设置</p><h1>采购模式步骤</h1><p>分别设置四种采购模式的步骤、提示和先后顺序。保存后新选该模式的事项使用新配置；已开始办理的事项保留原步骤快照。</p></div>
        <button className="secondary" onClick={onCancel}>返回事项台账</button>
      </div>
      <div className="settings-caution"><strong>请先核对单位制度</strong><span>以下为可编辑的示例流程，不代表法定、统一或本单位正式要求。请由负责人员按现行制度配置并审核后再用于实际事项。</span></div>
      <form onSubmit={(event) => { event.preventDefault(); onSave(drafts); }}>
        <div className="settings-mode-grid">
          {drafts.map((mode) => (
            <section className="settings-mode-card" key={mode.id}>
              <div className="settings-mode-title"><div><p className="eyebrow">采购模式</p><h2>{mode.title}</h2></div><span>{mode.steps.length} 步</span></div>
              <ol className="settings-step-list">
                {mode.steps.map((step, index) => (
                  <li key={step.id} className="settings-step">
                    <span className="settings-step-number">{index + 1}</span>
                    <div className="settings-step-fields">
                      <label>步骤名称<input value={step.title} required maxLength={120} onChange={(event) => updateStep(mode.id, step.id, { title: event.target.value })} placeholder="填写办理步骤名称" /></label>
                      <label>办理提示<textarea value={step.guidance} maxLength={2000} rows={2} onChange={(event) => updateStep(mode.id, step.id, { guidance: event.target.value })} placeholder="填写记录要求或注意事项（可选）" /></label>
                    </div>
                    <div className="settings-step-controls">
                      <button type="button" className="icon-button" aria-label="上移步骤" disabled={index === 0 || busy} onClick={() => moveStep(mode.id, index, -1)}>↑</button>
                      <button type="button" className="icon-button" aria-label="下移步骤" disabled={index === mode.steps.length - 1 || busy} onClick={() => moveStep(mode.id, index, 1)}>↓</button>
                      <button type="button" className="icon-button danger-icon" aria-label="删除步骤" disabled={mode.steps.length <= 1 || busy} onClick={() => removeStep(mode.id, step.id)}>×</button>
                    </div>
                  </li>
                ))}
              </ol>
              <button type="button" className="add-procurement-step" disabled={mode.steps.length >= 50 || busy} onClick={() => addStep(mode.id)}>＋ 添加办理步骤</button>
            </section>
          ))}
        </div>
        <div className="settings-footer"><p>每种采购模式至少保留 1 步，每种最多 50 步。只有当前步骤填写记录并标记完成后，系统才会开放下一步。</p><div><button type="button" className="secondary" onClick={onCancel}>取消</button><button className="primary" disabled={busy || !online}>{busy ? "正在保存…" : "保存四种模式设置"}</button></div></div>
      </form>
    </main>
  );
}

function AiSettings({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: AiPreferences;
  busy: boolean;
  onSave: (preferences: AiPreferences) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [preferences, setPreferences] = useState(initial);

  function changeProvider(provider: AiPreferences["provider"]) {
    setPreferences({ ...getDefaultAiPreferences(provider), apiKey: preferences.apiKey });
  }

  return (
    <main className="settings-page">
      <div className="settings-heading">
        <div><p className="eyebrow">AI 辅助整理</p><h1>AI 服务设置</h1><p>选择阿里云百炼或腾讯混元，配置 API Key 和模型后，可解读 PDF/TXT 附件并生成核对建议。</p></div>
        <button className="secondary" onClick={onCancel}>返回事项台账</button>
      </div>
      <div className="settings-caution ai-settings-caution">
        <strong>材料发送说明</strong>
        <span>AI 服务商、模型和 API Key 会保存到 OSS 事项数据，其他设备打开应用后会自动读取。解读时会从 OSS 读取附件，在本机提取文本并直接发送给所选 AI 服务商；请确认材料符合单位的数据处理要求。</span>
      </div>
      <form className="ai-settings-form" onSubmit={(event) => { event.preventDefault(); onSave(preferences); }}>
        <label>AI 服务商
          <select value={preferences.provider} onChange={(event) => changeProvider(event.target.value as AiPreferences["provider"])}>
            <option value="aliyun">阿里云百炼</option>
            <option value="tencent">腾讯混元</option>
          </select>
        </label>
        <label>API Key
          <input type="password" autoComplete="new-password" value={preferences.apiKey} onChange={(event) => setPreferences((current) => ({ ...current, apiKey: event.target.value }))} placeholder="粘贴服务商控制台创建的 API Key" />
        </label>
        <label>模型名称
          <input required value={preferences.model} onChange={(event) => setPreferences((current) => ({ ...current, model: event.target.value }))} />
        </label>
        <p className="muted">当前接口：{aiProviders[preferences.provider].endpoint}</p>
        <div className="ai-provider-links">
          {preferences.provider === "aliyun"
            ? <a href="https://bailian.console.aliyun.com/" target="_blank" rel="noreferrer">打开阿里云百炼控制台</a>
            : <a href="https://console.cloud.tencent.com/hunyuan/start" target="_blank" rel="noreferrer">打开腾讯混元控制台</a>}
        </div>
        <div className="settings-footer"><p>默认模型：{aiProviders[preferences.provider].model}。可按账号开通情况修改。</p><div><button type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button><button className="primary" disabled={busy}>{busy ? "正在保存到 OSS…" : "保存 AI 设置"}</button></div></div>
      </form>
    </main>
  );
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

export default App;
