import type { AiModelOption, ReasoningEffort } from "./schemas/config.js";

export type ModelRequestCapability = {
  provider: string;
  reasoningEfforts: ReasoningEffort[];
  supportsReasoning: boolean;
  omitSamplingParameters: boolean;
  enableDeepSeekThinking: boolean;
};

const NON_TEXT_MODEL_PATTERN = /(?:^|[-_.:/])(embed(?:ding)?|rerank|image|audio|speech|tts|whisper|moderation)(?:[-_.:/]|$)/i;
const OPENAI_REASONING_PATTERN = /^(?:o[134](?:[-_.]|$)|gpt-5(?:[-_.]|$))|reasoning/i;
const DEEPSEEK_PATTERN = /deepseek/i;

export function isTextGenerationModel(modelId: string, category = ""): boolean {
  const normalizedCategory = category.trim().toLowerCase();
  if (["embedding", "vector", "rerank", "image", "audio", "speech", "moderation"].includes(normalizedCategory)) {
    return false;
  }
  return !NON_TEXT_MODEL_PATTERN.test(modelId.trim());
}

export function resolveModelRequestCapability(modelId: string, providerHint = ""): ModelRequestCapability {
  const model = modelId.trim().toLowerCase();
  const provider = normalizeProvider(providerHint, model);
  const isDeepSeek = provider === "deepseek" || DEEPSEEK_PATTERN.test(model);
  const isOpenAiReasoning = provider === "openai" && OPENAI_REASONING_PATTERN.test(model);

  if (isDeepSeek) {
    return {
      provider: "deepseek",
      reasoningEfforts: ["high"],
      supportsReasoning: true,
      omitSamplingParameters: true,
      enableDeepSeekThinking: true
    };
  }
  if (isOpenAiReasoning) {
    return {
      provider: "openai",
      reasoningEfforts: ["low", "medium", "high"],
      supportsReasoning: true,
      omitSamplingParameters: true,
      enableDeepSeekThinking: false
    };
  }
  return {
    provider,
    reasoningEfforts: [],
    supportsReasoning: false,
    omitSamplingParameters: false,
    enableDeepSeekThinking: false
  };
}

export function normalizeAiModelOption(input: {
  id: string;
  name?: string;
  provider?: string;
  category?: string;
  selectable?: boolean;
  reasoningEfforts?: ReasoningEffort[];
  supportsReasoning?: boolean;
}): AiModelOption {
  const id = input.id.trim();
  const category = (input.category || "text").trim() || "text";
  const textGeneration = isTextGenerationModel(id, category);
  const inferred = resolveModelRequestCapability(id, input.provider || "");
  const explicitEfforts = uniqueReasoningEfforts(input.reasoningEfforts || []);
  const reasoningEfforts = explicitEfforts.length ? explicitEfforts : inferred.reasoningEfforts;
  const reasoning = input.supportsReasoning === true || reasoningEfforts.length > 0;
  return {
    id,
    name: (input.name || id).trim() || id,
    provider: inferred.provider || (input.provider || "").trim(),
    category,
    selectable: input.selectable !== false && textGeneration,
    capabilities: {
      text_generation: textGeneration,
      streaming: true,
      reasoning,
      image_generation: false,
      image_edit: false
    },
    reasoning_efforts: reasoningEfforts,
    supported_sizes: []
  };
}

function normalizeProvider(providerHint: string, model: string): string {
  const provider = providerHint.trim().toLowerCase();
  if (provider.includes("deepseek") || DEEPSEEK_PATTERN.test(model)) return "deepseek";
  if (provider.includes("openai") || /^(?:gpt-|o[134](?:[-_.]|$))/.test(model)) return "openai";
  if (provider.includes("anthropic") || model.includes("claude")) return "anthropic";
  if (provider.includes("google") || model.includes("gemini")) return "google";
  if (provider.includes("qwen") || model.includes("qwen")) return "qwen";
  return provider;
}

function uniqueReasoningEfforts(values: ReasoningEffort[]): ReasoningEffort[] {
  const allowed: ReasoningEffort[] = ["low", "medium", "high"];
  return allowed.filter((effort) => values.includes(effort));
}
