import { loadModelConfig, loadPublicConfig, type ConfigServiceOptions, type ModelConfig } from "@xiaoshuo/config-service";
import type { OpenAICompatibleClient, ChatCompletionMessage } from "@xiaoshuo/model-client";
import { isCancellationError, throwIfAborted } from "./cancellation.js";

export const HUMANIZER_SYSTEM_PROMPT = `
你是 Humanizer-zh 中文文本编辑，专门去除 AI 生成痕迹，让文本更自然、更像人类写作。

核心要求：
1. 保留核心含义、剧情事实、人设、世界观、设定、伏笔、章节目标和格式层级。
2. 只输出处理后的文本本体，不输出检测报告、解释、标题、免责声明或修改说明。
3. 删除填充短语，打破公式结构，变化句子节奏，信任读者，删掉像金句或总结升华的句子。
4. 清理空泛拔高、宣传腔、三段式排比、否定式排比、模糊归因、过度书面化、AI 高频词和模板化结尾。
5. 对小说内容，允许口语、停顿、留白和轻微毛边；不要新增剧情冲突，不改结尾走向。
`.trim();

export type HumanizerResult = {
  text: string;
  applied: boolean;
  error?: string;
};

export async function applyHumanizerIfEnabled({
  text,
  config,
  modelClient,
  mode = "写作内容",
  skip = false,
  signal
}: {
  text: string;
  config: ConfigServiceOptions;
  modelClient: Pick<OpenAICompatibleClient, "requestCompletion">;
  mode?: string;
  skip?: boolean;
  signal?: AbortSignal;
}): Promise<HumanizerResult> {
  const original = String(text || "").trim();
  if (skip || !original) {
    return { text: original, applied: false };
  }
  throwIfAborted(signal);

  const publicConfig = await loadPublicConfig(config);
  if (!publicConfig.humanizer_enabled) {
    return { text: original, applied: false };
  }
  throwIfAborted(signal);

  try {
    const modelConfig = await loadModelConfig(config, "primary");
    if (!modelConfig.configured) {
      return { text: original, applied: false, error: "未配置主线路模型" };
    }
    const prompt = [
      `【处理模式】${mode}`,
      "请对下面文本执行 Humanizer-zh 去AI味。只输出处理后的文本本体。",
      "",
      `【待处理文本】\n${original.slice(0, 30000)}`
    ].join("\n");
    const raw = String(
      await modelClient.requestCompletion(
        modelConfig,
        [
          { role: "system", content: HUMANIZER_SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ] satisfies ChatCompletionMessage[],
        resolveHumanizerTemperature(modelConfig),
        { signal }
      )
    ).trim();
    throwIfAborted(signal);
    const cleaned = guardAgainstOverdelete(original, cleanHumanizerOutput(raw));
    return { text: cleaned, applied: cleaned.trim() !== original.trim() };
  } catch (error) {
    if (isCancellationError(error, signal)) {
      throw error;
    }
    return { text: original, applied: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveHumanizerTemperature(config: ModelConfig): number {
  return Math.max(0.2, Math.min(0.7, config.temperature));
}

function cleanHumanizerOutput(result: string): string {
  let text = String(result || "").trim();
  text = text.replace(/^```(?:text|markdown|md)?\s*/i, "");
  text = text.replace(/\s*```$/, "");
  for (const marker of ["【处理后文本】", "【去AI味后文本】", "【Humanizer后文本】", "【正文】", "【结果】"]) {
    if (text.includes(marker)) {
      text = text.split(marker)[1]?.trim() || text;
    }
  }
  for (const marker of ["## AI味检测报告", "## 去AI味润色报告", "【修改说明】", "修改说明：", "检测报告："]) {
    if (text.includes(marker)) {
      text = text.split(marker)[0]?.trim() || text;
    }
  }
  return text.trim();
}

function guardAgainstOverdelete(original: string, cleaned: string): string {
  if (!cleaned) {
    return original;
  }
  if (original.length < 80) {
    return cleaned.length >= Math.max(8, original.length * 0.35) ? cleaned : original;
  }
  return cleaned.length >= original.length * 0.35 ? cleaned : original;
}
