export function createAiService(env, fetchImpl = fetch) {
  const enabled = env.AI_ENABLED === "true" && Boolean(env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL);
  return {
    enabled,
    async analyze(text, step) {
      if (!enabled) {
        const error = new Error("AI 未启用或配置不完整");
        error.code = "AI_NOT_CONFIGURED";
        throw error;
      }
      if (!text.trim()) {
        const error = new Error("该文件没有可供分析的文本内容；请人工核对材料");
        error.code = "MATERIAL_NOT_PARSEABLE";
        throw error;
      }
      const response = await fetchImpl(`${env.AI_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.AI_API_KEY}`,
        },
        body: JSON.stringify({
          model: env.AI_MODEL,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: "你是材料整理辅助工具，不是审批者、律师或权威合规机构。只依据用户提供的材料，不得编造事实或法规。无法确认的内容写入待人工核实。仅返回 JSON 对象，字段为 summary、keyFacts、checks、nextSteps、cautions、humanVerification；keyFacts、checks、nextSteps、cautions、humanVerification 均为字符串数组。明确区分材料记载与建议。",
            },
            {
              role: "user",
              content: `当前步骤：${step.title}\n材料文本：\n${text.slice(0, 24000)}`,
            },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (!response.ok) throw new Error(`AI 服务返回 HTTP ${response.status}`);
      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("AI 服务未返回可用内容");
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error("AI 返回内容不是有效 JSON");
      }
      const arrayFields = ["keyFacts", "checks", "nextSteps", "cautions", "humanVerification"];
      if (typeof parsed.summary !== "string" || arrayFields.some((key) => !Array.isArray(parsed[key]))) {
        throw new Error("AI 返回内容格式不符合要求");
      }
      return {
        summary: parsed.summary,
        keyFacts: parsed.keyFacts,
        checks: parsed.checks,
        nextSteps: parsed.nextSteps,
        cautions: parsed.cautions,
        humanVerification: parsed.humanVerification,
        disclaimer: "AI 辅助整理，内容可能不准确；不得作为正式审批或权威结论，请工作人员核实。",
        generatedAt: new Date().toISOString(),
      };
    },
  };
}

