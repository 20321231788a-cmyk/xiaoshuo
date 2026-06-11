import { Save, ShieldCheck } from "lucide-react";
import type { AppConfig, LicenseStatus } from "@xiaoshuo/shared";
import { Panel } from "../components/Panel.js";
import { describeConfigReadiness } from "../lib/config.js";

export function ConfigView({
  config,
  license,
  busy,
  message,
  onPatch,
  onSave,
  onRefreshLicense
}: {
  config: AppConfig;
  license: LicenseStatus;
  busy: boolean;
  message: string;
  onPatch: (patch: Partial<AppConfig>) => void;
  onSave: () => void;
  onRefreshLicense: () => void;
}) {
  const readiness = describeConfigReadiness(config);

  return (
    <div className="content-stack">
      <div className="double-grid">
        <Panel eyebrow="Model" title="模型与接口" aside={<ShieldCheck size={17} />}>
          <div className="form-grid">
            <Field label="主线路 API Key" value={config.api_key} onChange={(value) => onPatch({ api_key: value })} secret />
            <Field label="授权账号 Key" value={config.license_account_key} onChange={(value) => onPatch({ license_account_key: value })} secret />
            <Field label="主线路 Base URL" value={config.base_url} onChange={(value) => onPatch({ base_url: value })} />
            <Field label="主线路模型" value={config.model} onChange={(value) => onPatch({ model: value })} />
            <Field label="副线路 API Key" value={config.secondary_api_key} onChange={(value) => onPatch({ secondary_api_key: value })} secret />
            <Field label="副线路 Base URL" value={config.secondary_base_url} onChange={(value) => onPatch({ secondary_base_url: value })} />
            <Field label="副线路模型" value={config.secondary_model} onChange={(value) => onPatch({ secondary_model: value })} />
          </div>
          <div className="toggle-grid">
            <ToggleCard
              title="联网素材搜索"
              description={config.web_search_enabled ? "当前开启，聊天可按需搜索小说素材。" : "当前关闭，AI 不会主动访问网络。"}
              active={Boolean(config.web_search_enabled)}
              onToggle={() => onPatch({ web_search_enabled: !config.web_search_enabled })}
            />
            <ToggleCard
              title="向量召回"
              description={config.embedding_enabled ? "当前开启，生成和对话会尝试召回长期记忆。" : "当前关闭，仍保留 Embedding 配置。"}
              active={Boolean(config.embedding_enabled)}
              onToggle={() => onPatch({ embedding_enabled: !config.embedding_enabled })}
            />
          </div>
        </Panel>

        <Panel eyebrow="Embedding" title="向量配置">
          <div className="form-grid">
            <Field label="Embedding API Key" value={config.embedding_api_key} onChange={(value) => onPatch({ embedding_api_key: value })} secret />
            <Field label="Embedding Base URL" value={config.embedding_base_url} onChange={(value) => onPatch({ embedding_base_url: value })} />
            <Field label="Embedding 模型" value={config.embedding_model} onChange={(value) => onPatch({ embedding_model: value })} />
            <NumberField label="Embedding 超时" value={config.embedding_timeout ?? 60} min={5} max={300} onChange={(value) => onPatch({ embedding_timeout: value })} />
            <NumberField label="批量大小" value={config.embedding_batch_size ?? 16} min={1} max={128} onChange={(value) => onPatch({ embedding_batch_size: value })} />
            <NumberField label="召回片段数" value={config.vector_top_k ?? 10} min={1} max={40} onChange={(value) => onPatch({ vector_top_k: value })} />
            <NumberField label="召回上下文字数" value={config.vector_context_chars ?? 9000} min={1000} max={80000} step={500} onChange={(value) => onPatch({ vector_context_chars: value })} />
            <NumberField label="一致性阈值" value={config.consistency_revision_score ?? 80} min={1} max={100} onChange={(value) => onPatch({ consistency_revision_score: value })} />
          </div>
        </Panel>
      </div>

      <Panel eyebrow="Research" title="联网素材搜索">
        <div className="form-grid">
          <SelectField
            label="搜索来源"
            value={config.web_search_provider === "custom" ? "custom" : "bing"}
            options={[
              { value: "bing", label: "Bing" },
              { value: "custom", label: "自定义 API" }
            ]}
            onChange={(value) => onPatch({ web_search_provider: value as AppConfig["web_search_provider"] })}
          />
          <Field label="Bing / 自定义 API Key" value={config.web_search_api_key ?? ""} onChange={(value) => onPatch({ web_search_api_key: value })} secret />
          <Field label="自定义 Base URL" value={config.web_search_base_url ?? ""} onChange={(value) => onPatch({ web_search_base_url: value })} />
          <NumberField label="最大结果数" value={config.web_search_max_results ?? 3} min={1} max={5} onChange={(value) => onPatch({ web_search_max_results: value })} />
          <NumberField label="搜索超时秒数" value={config.web_search_timeout ?? 10} min={3} max={60} onChange={(value) => onPatch({ web_search_timeout: value })} />
          <NumberField
            label="素材上下文字数"
            value={config.web_search_context_chars ?? 3000}
            min={800}
            max={8000}
            step={200}
            onChange={(value) => onPatch({ web_search_context_chars: value })}
          />
        </div>
      </Panel>

      <Panel eyebrow="Readiness" title="配置检查">
        <div className="readiness-grid">
          {readiness.map((item) => (
            <article key={item.title} className={`readiness-card ${item.status}`}>
              <span>{item.status === "ready" ? "已就绪" : item.status === "warn" ? "需处理" : "可选"}</span>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
      </Panel>

      <Panel eyebrow="License" title="授权状态与保存">
        <div className="status-banner">
          <strong>{license.licensed ? "授权正常" : license.status || "未授权"}</strong>
          <p>{license.message || "这里会显示最近一次授权检测结果。"}</p>
        </div>
        <div className="action-row">
          <button className="refresh-button" onClick={onSave} disabled={busy}>
            <Save size={15} />
            <span>{busy ? "处理中" : "保存配置"}</span>
          </button>
          <button className="ghost-button" onClick={onRefreshLicense} disabled={busy}>
            <ShieldCheck size={15} />
            <span>刷新授权</span>
          </button>
          <span className="inline-message">{message || "保存或刷新授权后，结果会显示在这里。"}</span>
        </div>
      </Panel>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  secret = false
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={secret ? "password" : "text"} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function ToggleCard({
  title,
  description,
  active,
  onToggle
}: {
  title: string;
  description: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={`toggle-card ${active ? "active" : ""}`} onClick={onToggle}>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <span className={`toggle-switch ${active ? "active" : ""}`}>
        <span />
      </span>
    </button>
  );
}
