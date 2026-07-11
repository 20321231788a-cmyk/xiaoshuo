export type ModelCapability = "text" | "stream" | "structured_output" | "reasoning" | "embedding";

export class ProviderCapabilities {
  static getModelCapabilities(model: string): Set<ModelCapability> {
    const caps = new Set<ModelCapability>(["text", "stream"]);
    const lower = model.toLowerCase();
    
    if (lower.includes("o1") || lower.includes("o3") || lower.includes("reasoning") || lower.includes("r1")) {
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
}
