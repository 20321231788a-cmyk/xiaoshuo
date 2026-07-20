import {
  resolveModelRequestCapability,
  type ReasoningEffort
} from "@xiaoshuo/shared";

export type ModelCapability = "text" | "stream" | "structured_output" | "reasoning" | "embedding";

export class ProviderCapabilities {
  static getModelCapabilities(model: string): Set<ModelCapability> {
    const caps = new Set<ModelCapability>(["text", "stream"]);
    const lower = model.toLowerCase();
    
    if (resolveModelRequestCapability(model).supportsReasoning) {
      caps.add("reasoning");
    }

    if (
      lower.includes("gpt-4o") ||
      lower.includes("gpt-4-o") ||
      lower.includes("mini") ||
      lower.includes("claude-3-5")
    ) {
      caps.add("structured_output");
    }

    if (lower.includes("embed") || lower.includes("text-embedding")) {
      caps.add("embedding");
    }

    return caps;
  }

  static supportsCapability(model: string, capability: ModelCapability): boolean {
    return this.getModelCapabilities(model).has(capability);
  }

  static getReasoningEfforts(model: string, providerHint = ""): ReasoningEffort[] {
    return resolveModelRequestCapability(model, providerHint).reasoningEfforts;
  }
}
