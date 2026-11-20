import type { Analysis, Attachment, Step } from "./types";
import { getOssClient } from "./oss";

export type AiProvider = "aliyun" | "tencent";
export type AiPreferences = {
  provider: AiProvider;
  apiKey: string;
  model: string;
};

const MAX_SOURCE_CHARS = 24000;
const AI_REQUEST_TIMEOUT_MS = 90000;
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
  if (!preferences.apiKey.trim()) throw new Error("请先在 AI 设置中填写 API Key");
  const object = await getOssClient().get(attachment.objectKey);
  const bytes = await asArrayBuffer(object.content);
  const extractedText = attachment.contentType === "text/plain"
    ? new TextDecoder().decode(bytes).slice(0, MAX_SOURCE_CHARS).trim()
    : attachment.contentType === "application/pdf"
      ? await extractPdfText(bytes)
      : "";
  if (!extractedText) throw new Error("附件中没有可提取的文本；扫描版 PDF 暂不支持 OCR");

  const provider = PROVIDERS[preferences.provider];
  let response: Response;
  let responseText: string;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(provider.endpoint, {
      method: "POST",
      signal: controller.signal,
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
          {
            role: "user",
            content: `办理步骤：${step.title}\n步骤提示：${step.guidance}\n\n附件文本：\n${extractedText}`,
          },
        ],
      }),
    });
    responseText = await response.text();
  } catch (reason) {
    if (controller.signal.aborted) {
      throw new Error(`${provider.label}请求超过 90 秒未完成，请检查网络或服务状态后重试`);
    }
    throw new Error(`无法连接${provider.label}。请检查浏览器网络和服务跨域设置：${reason instanceof Error ? reason.message : String(reason)}`);
  } finally {
    clearTimeout(timeout);
  }
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
  const parsed = parseAnalysis(content);
  return {
    analysis: {
      ...parsed,
      disclaimer: "AI 内容仅供辅助整理，需由工作人员核验原始材料、政策依据和办理事实，不构成审批或权威结论。",
      generatedAt: new Date().toISOString(),
    },
    extractedText,
  };
}

export const aiProviders = PROVIDERS;
