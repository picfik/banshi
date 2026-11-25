import type { Analysis, Attachment, CaseRecord, Step } from "./types";
import { getOssClient } from "./oss";

export type AiProvider = "aliyun" | "tencent";
export type AiPreferences = {
  provider: AiProvider;
  apiKey: string;
  model: string;
};

const MAX_SOURCE_CHARS = 24000;
const PROVIDERS: Record<AiProvider, { label: string; model: string; endpoint: string }> = {
  aliyun: {
    label: "阿里云百炼",
    model: "qwen-plus",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  },
  tencent: {
    label: "腾讯混元",
    model: "hunyuan-turbos-latest",
    endpoint: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
  },
};

export function getDefaultAiPreferences(provider: AiProvider = "aliyun"): AiPreferences {
  return { provider, apiKey: "", model: PROVIDERS[provider].model };
}

function asArrayBuffer(content: unknown): Promise<ArrayBuffer> {
  if (content instanceof Blob) return content.arrayBuffer();
  if (content instanceof ArrayBuffer) return Promise.resolve(content);
  if (ArrayBuffer.isView(content)) {
    return Promise.resolve(new Uint8Array(content.buffer, content.byteOffset, content.byteLength).slice().buffer);
  }
  if (typeof content === "string") return Promise.resolve(new TextEncoder().encode(content).buffer);
  throw new Error("OSS 附件内容无法读取");
}

async function extractPdfText(bytes: ArrayBuffer): Promise<string> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  const { getDocument, GlobalWorkerOptions } = pdfjs;
  GlobalWorkerOptions.workerSrc = worker.default;
  const document = await getDocument({ data: bytes }).promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 100); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" "));
      if (pages.join("\n").length >= MAX_SOURCE_CHARS) break;
    }

    return pages.join("\n").slice(0, MAX_SOURCE_CHARS).trim();
  } finally {
    await document.destroy();
  }
}

function officeExtension(filename: string): string {
  return filename.slice(filename.lastIndexOf(".")).toLowerCase();
}

async function extractOfficeText(bytes: ArrayBuffer, filename: string): Promise<string> {
  const extension = officeExtension(filename);
  const legacyFormat = new Map<string, string>([
    [".doc", "doc"], [".dot", "doc"],
    [".xls", "xls"], [".xlt", "xls"], [".xla", "xls"],
    [".ppt", "ppt"], [".pot", "ppt"], [".pps", "ppt"], [".ppa", "ppt"],
  ]).get(extension);
  if (legacyFormat) {
    const office = await import("office-oxide-wasm/web");
    await office.default();
    const document = new office.WasmDocument(new Uint8Array(bytes), legacyFormat);
    try {
      return document.plainText().slice(0, MAX_SOURCE_CHARS).trim();
    } finally {
      document.free();
    }
  }
  if ([".docx", ".docm", ".dotx", ".dotm", ".docb"].includes(extension)) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: bytes });
    return result.value.slice(0, MAX_SOURCE_CHARS).trim();
  }
  if ([".xlsx", ".xlsm", ".xlsb", ".xltx", ".xltm", ".xlam", ".xls", ".xlt", ".xla", ".csv", ".tsv"].includes(extension)) {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
    const sheets = workbook.SheetNames.slice(0, 20).map((name) => {
      const sheet = workbook.Sheets[name];
      return `【工作表：${name}】\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`;
    });
    return sheets.join("\n\n").slice(0, MAX_SOURCE_CHARS).trim();
  }
  if (extension === ".rtf") {
    const text = new TextDecoder().decode(bytes)
      .replace(/\\'[0-9a-f]{2}/gi, " ")
      .replace(/\\[a-z]+-?\d* ?/gi, " ")
      .replace(/[{}]/g, " ")
      .replace(/\s+/g, " ");
    return text.slice(0, MAX_SOURCE_CHARS).trim();
  }
  if ([".html", ".htm", ".xml"].includes(extension)) {
    const text = new TextDecoder().decode(bytes)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#([0-9]+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, MAX_SOURCE_CHARS);
  }
  if ([".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppam", ".odp", ".odt", ".ods"].includes(extension)) {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.keys(zip.files).filter((name) =>
      /(?:ppt\/slides\/slide\d+\.xml|word\/document\.xml|content\.xml|.*slides?.*\.xml)$/i.test(name),
    );
    const texts: string[] = [];
    for (const entry of entries) {
      const xml = await zip.file(entry)?.async("text");
      if (!xml) continue;
      const text = xml
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#([0-9]+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/\s+/g, " ")
        .trim();
      if (text) texts.push(text);
    }
    return texts.join("\n").slice(0, MAX_SOURCE_CHARS).trim();
  }
  return "";
}

export async function extractAttachmentText(attachment: Attachment): Promise<string> {
  const object = await getOssClient().get(attachment.objectKey);
  const bytes = await asArrayBuffer(object.content);
  const extension = officeExtension(attachment.filename);
  const extractedText = attachment.contentType === "text/plain"
    ? new TextDecoder().decode(bytes).slice(0, MAX_SOURCE_CHARS).trim()
    : attachment.contentType === "application/pdf"
      ? await extractPdfText(bytes)
      : await extractOfficeText(bytes, attachment.filename);
  if (!extractedText) {
    throw new Error(extension === ".doc" || extension === ".xls" || extension === ".ppt"
      ? `${attachment.filename}：无法从旧版 Office 文件中提取文本，请确认文件未加密且格式有效`
      : `${attachment.filename}：没有可提取的文本；扫描版 PDF 或图片暂不支持 OCR`);
  }
  return extractedText;
}

async function requestAnalysis(userContent: string, preferences: AiPreferences): Promise<Analysis> {
  if (!preferences.apiKey.trim()) throw new Error("请先在 AI 设置中填写 API Key");
  const provider = PROVIDERS[preferences.provider];
  let response: Response;
  try {
    response = await fetch(provider.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${preferences.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: preferences.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "你是办事材料整理助手。只根据提供的材料文本归纳，不补造事实、法律依据或审批结论。用中文输出严格 JSON，不要 Markdown，结构为：summary(string), keyFacts(string[]), checks(string[]), nextSteps(string[]), cautions(string[]), humanVerification(string[])。不确定内容放入 checks 或 humanVerification。",
          },
          { role: "user", content: userContent },
        ],
      }),
    });
  } catch (reason) {
    throw new Error(`无法连接${provider.label}。请检查浏览器网络和服务跨域设置：${reason instanceof Error ? reason.message : String(reason)}`);
  }
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`${provider.label}请求失败（${response.status}）：${responseText.slice(0, 500)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`${provider.label}返回了无法识别的响应`);
  }
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`${provider.label}未返回文本分析结果`);
  return {
    ...parseAnalysis(content),
    disclaimer: "AI 内容仅供辅助整理，需由工作人员核验原始材料、政策依据和办理事实，不构成审批或权威结论。",
    generatedAt: new Date().toISOString(),
  };
}

function parseAnalysis(content: string): Omit<Analysis, "generatedAt" | "disclaimer"> {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 返回内容不是有效 JSON，请重试");
  const parsed: unknown = JSON.parse(content.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object") throw new Error("AI 返回内容结构无效，请重试");
  const value = parsed as Record<string, unknown>;
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("AI 未返回有效摘要，请重试");
  const list = (key: string) => Array.isArray(value[key])
    ? (value[key] as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  return {
    summary: value.summary.trim(),
    keyFacts: list("keyFacts"),
    checks: list("checks"),
    nextSteps: list("nextSteps"),
    cautions: list("cautions"),
    humanVerification: list("humanVerification"),
  };
}

export async function analyzeAttachment(
  attachment: Attachment,
  step: Step,
  preferences: AiPreferences,
): Promise<{ analysis: Analysis; extractedText: string }> {
  const extractedText = await extractAttachmentText(attachment);
  const analysis = await requestAnalysis(
    `办理步骤：${step.title}\n步骤提示：${step.guidance}\n\n附件名称：${attachment.filename}\n附件文本：\n${extractedText}`,
    preferences,
  );
  return {
    analysis,
    extractedText,
  };
}

export async function analyzeCaseAttachments(
  record: CaseRecord,
  preferences: AiPreferences,
): Promise<Analysis> {
  if (!preferences.apiKey.trim()) throw new Error("请先在 AI 设置中填写 API Key");
  const sources = record.steps.flatMap((step) => [
    ...step.attachments.map((attachment) => ({ attachment, stepTitle: step.title, note: step.note })),
    ...(step.procurementSteps ?? []).flatMap((procurementStep) =>
      (procurementStep.attachments ?? []).map((attachment) => ({
        attachment,
        stepTitle: `${step.title} · ${procurementStep.title}`,
        note: procurementStep.note,
      })),
    ),
  ]);
  if (sources.length === 0) throw new Error("该事项还没有附件，暂不能生成综合解读");
  const maxCombinedChars = 48000;
  const perAttachmentLimit = Math.max(256, Math.floor(maxCombinedChars / sources.length));
  const seen = new Set<string>();
  const sourceTexts: string[] = [];
  for (const source of sources) {
    const identity = `${source.attachment.objectKey}\u0000${source.attachment.filename}\u0000${source.attachment.size}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const text = await extractAttachmentText(source.attachment);
    sourceTexts.push([
      `附件：${source.attachment.filename}`,
      `所在步骤：${source.stepTitle}`,
      source.note ? `办理记录：${source.note}` : "",
      `附件内容：\n${text.slice(0, perAttachmentLimit)}`,
    ].filter(Boolean).join("\n"));
  }
  const userContent = [
    `事项名称：${record.title}`,
    `事项来源：${record.source}`,
    record.description ? `事项说明：${record.description}` : "",
    "请综合比对以下全部附件及办理记录，提出有依据的归纳意见、待核对问题和建议；区分材料事实与推断，不得补造事实或法律依据。",
    sourceTexts.join("\n\n---\n\n"),
  ].filter(Boolean).join("\n\n").slice(0, maxCombinedChars);
  return requestAnalysis(userContent, preferences);
}

export const aiProviders = PROVIDERS;
