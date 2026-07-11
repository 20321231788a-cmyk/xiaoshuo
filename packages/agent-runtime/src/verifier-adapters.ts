export interface AgentVerificationInput {
  action: string;
  path: string;
  text?: string;
}

export interface AgentVerificationResult {
  ok: boolean;
  message: string;
}

export interface VerifierPort {
  verify(input: AgentVerificationInput): Promise<AgentVerificationResult>;
}

export interface AgentMemoryCommitInput {
  conversationId: string;
  summary: string;
  content: string;
}

export interface AgentArtifactRef {
  refId: string;
  path: string;
}

export interface MemoryCommitPort {
  prepare(input: AgentMemoryCommitInput): Promise<AgentArtifactRef | null>;
  commit(artifact: AgentArtifactRef): Promise<void>;
}

export class BasicVerifier implements VerifierPort {
  async verify(input: AgentVerificationInput): Promise<AgentVerificationResult> {
    if (!input.path) {
      return { ok: false, message: "验证失败：写入目标路径不能为空" };
    }
    if (input.action === "propose_save" && !input.text?.trim()) {
      return { ok: false, message: "验证失败：保存计划中的写入文本不能为空" };
    }
    return { ok: true, message: "模式与路径验证通过" };
  }
}

export class NoopMemoryCommit implements MemoryCommitPort {
  async prepare(input: AgentMemoryCommitInput): Promise<AgentArtifactRef | null> {
    return {
      refId: `artifact_ref_${Math.random().toString(36).slice(2, 10)}`,
      path: `00_设定集/会话摘要_${input.conversationId}.txt`
    };
  }
  async commit(artifact: AgentArtifactRef): Promise<void> {
    // No-op for structural compat adapter
  }
}
