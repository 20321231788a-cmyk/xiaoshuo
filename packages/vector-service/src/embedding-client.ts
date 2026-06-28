import type { EmbeddingConfig } from "@xiaoshuo/config-service";

export type EmbeddingClientOptions = {
  fetchFn?: typeof fetch;
};

export class EmbeddingClient {
  private readonly config: EmbeddingConfig;
  private readonly fetchFn: typeof fetch;
  private readonly effectiveBaseUrl: string;
  private readonly effectiveModel: string;
  private readonly provider: string;

  constructor(config: EmbeddingConfig, options: EmbeddingClientOptions = {}) {
    this.config = config;
    this.fetchFn = options.fetchFn ?? fetch;

    const resolved = this.resolveEndpoint();
    this.effectiveBaseUrl = resolved.baseUrl;
    this.effectiveModel = resolved.model;
    this.provider = resolved.provider;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (!this.config.configured) {
      throw new Error("Embedding interface is not configured. Please fill API Key, Base URL and model.");
    }
    const cleaned = inputs.map((item) => (item.trim() ? item : " "));
    return this.embedDoubaoMultimodal(cleaned);
  }

  private async embedDoubaoMultimodal(inputs: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const input of inputs) {
      vectors.push(await this.embedDoubaoMultimodalInput(input));
    }
    return vectors;
  }

  private async embedDoubaoMultimodalInput(input: string): Promise<number[]> {
    const endpoint = this.multimodalEndpoint(this.effectiveBaseUrl);
    const payload = {
      model: this.effectiveModel,
      input: [{ type: "text", text: input }]
    };

    const controller = new AbortController();
    const timeoutMs = (this.config.timeout || 60) * 1000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.api_key}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(this.formatApiError(response.status, text));
      }

      const data = await response.json();
      const vectors = this.extractVectors(data);
      const vector = vectors[0];
      if (!vector) {
        throw new Error("Embedding response did not contain vector data.");
      }
      return vector;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("向量请求超时，请检查网络或降低批量大小。");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private extractVectors(data: unknown): number[][] {
    if (!data || typeof data !== "object") {
      throw new Error("Embedding response is not a JSON object.");
    }
    const rawItems = (data as Record<string, unknown>).data;
    if (Array.isArray(rawItems)) {
      const vectors = rawItems.map((item) => this.extractVector(item)).filter((vector): vector is number[] => Boolean(vector));
      if (vectors.length === 0) {
        throw new Error("Embedding response did not contain vector data.");
      }
      return vectors;
    }

    const directVector = this.extractVector(rawItems);
    if (directVector) {
      return [directVector];
    }

    const topLevelVector = this.extractVector(data);
    if (topLevelVector) {
      return [topLevelVector];
    }

    if (rawItems === undefined) {
      throw new Error("Embedding response missing data array.");
    }
    throw new Error("Embedding response did not contain vector data.");
  }

  private extractVector(item: unknown): number[] | null {
    if (!item || typeof item !== "object") {
      return null;
    }
    let vector = (item as Record<string, unknown>).embedding;
    if (vector && typeof vector === "object" && !Array.isArray(vector)) {
      const record = vector as Record<string, unknown>;
      vector = record.dense ?? record.float ?? record.vector;
    }
    if (!Array.isArray(vector)) {
      return null;
    }
    return vector.map((val) => Number(val));
  }

  async test(): Promise<{
    ok: boolean;
    model: string;
    configured_model: string;
    base_url: string;
    provider: string;
    dimensions: number;
  }> {
    const vectors = await this.embed(["test embedding connection"]);
    const vector = vectors[0];
    if (!vector) {
      throw new Error("Failed to get embedding vector during test");
    }
    return {
      ok: true,
      model: this.effectiveModel,
      configured_model: this.config.model,
      base_url: this.effectiveBaseUrl,
      provider: this.provider,
      dimensions: vector.length
    };
  }

  storageModel(): string {
    return `${this.provider}:${this.effectiveModel}@${this.effectiveBaseUrl}`;
  }

  private resolveEndpoint(): { baseUrl: string; model: string; provider: string } {
    const baseUrl = this.normalizeBaseUrl(this.config.base_url);
    const model = (this.config.model || "").trim();
    return { baseUrl, model, provider: "doubao_multimodal" };
  }

  private normalizeBaseUrl(baseUrl: string): string {
    let value = (baseUrl || "").trim().replace(/\/+$/, "");
    const marker = "/embeddings";
    const lower = value.toLowerCase();
    if (lower.includes(marker)) {
      value = value.substring(0, lower.lastIndexOf(marker));
    }
    return value;
  }

  private multimodalEndpoint(baseUrl: string): string {
    const value = (baseUrl || "").trim().replace(/\/+$/, "");
    const lower = value.toLowerCase();
    if (lower.endsWith("/embeddings/multimodal")) {
      return value;
    }
    if (lower.endsWith("/api/v3")) {
      return `${value}/embeddings/multimodal`;
    }
    if (lower.includes("ark.cn-beijing.volces.com")) {
      return "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal";
    }
    return `${value}/embeddings/multimodal`;
  }

  private formatApiError(status: number, text: string): string {
    const compact = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (status === 504 || compact.includes("504 Gateway Time-out") || compact.includes("Gateway Time-out")) {
      return "向量接口网关超时（504）。上游服务没有及时返回，请稍后重试。";
    }
    if (status === 502 || status === 503 || compact.includes("Bad Gateway") || compact.includes("Service Unavailable")) {
      return `向量接口暂时不可用（${status}）。请稍后重试。`;
    }
    if (status === 429 || compact.toLowerCase().includes("rate limit")) {
      return "向量接口限流，请稍后重试或降低批量大小。";
    }
    if (status > 0) {
      return `向量接口返回错误 ${status}：${compact || text}`;
    }
    return compact || text;
  }
}
