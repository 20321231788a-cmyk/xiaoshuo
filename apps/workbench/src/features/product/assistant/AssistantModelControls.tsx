import { Brain, Check, ChevronUp, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeAiModelOption,
  type AiModelOption,
  type ReasoningEffort
} from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";

const effortLabels: Record<ReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高"
};

export function AssistantModelControls({ controller }: { controller: WorkbenchController }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const config = controller.configDraft;
  const mode = config?.ai_config_mode === "website" ? "website" : "manual";
  const activeProfile = mode === "website" ? config?.website_profile : config?.manual_profile;
  const defaultModel = String(activeProfile?.model || config?.model || "").trim();
  const preferences = controller.conversationModelPreferences;
  const selectedModelId = preferences.model_override || defaultModel;
  const locked = controller.sendingMessage || controller.conversationBusy || controller.conversationModelPreferenceBusy;

  const models = useMemo(() => {
    const source = mode === "website"
      ? controller.websiteAiDashboard?.models || []
      : controller.manualModelCatalog;
    const unique = new Map<string, AiModelOption>();
    for (const option of source) {
      if (option.selectable && option.capabilities.text_generation) {
        unique.set(option.id, option);
      }
    }
    if (defaultModel && !unique.has(defaultModel)) {
      unique.set(defaultModel, normalizeAiModelOption({ id: defaultModel, name: defaultModel }));
    }
    if (preferences.model_override && !unique.has(preferences.model_override)) {
      unique.set(preferences.model_override, normalizeAiModelOption({
        id: preferences.model_override,
        name: preferences.model_override
      }));
    }
    return [...unique.values()];
  }, [controller.manualModelCatalog, controller.websiteAiDashboard?.models, defaultModel, mode, preferences.model_override]);

  const selectedModel = models.find((item) => item.id === selectedModelId)
    || (selectedModelId ? normalizeAiModelOption({ id: selectedModelId }) : null);
  const supportedEfforts = selectedModel?.reasoning_efforts || [];
  const filteredModels = models.filter((item) => {
    const haystack = `${item.name} ${item.id} ${item.provider}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const discoveryBusy = mode === "website" ? controller.websiteAiBusy : controller.manualModelDiscoveryBusy;
  const discoveryMessage = mode === "website" ? controller.websiteAiMessage : controller.manualModelDiscoveryMessage;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function selectModel(modelOverride: string) {
    const nextId = modelOverride || defaultModel;
    const option = models.find((item) => item.id === nextId)
      || (nextId ? normalizeAiModelOption({ id: nextId }) : null);
    const efforts = option?.reasoning_efforts || [];
    const nextEffort = efforts.includes(preferences.reasoning_effort)
      ? preferences.reasoning_effort
      : efforts.length === 1
        ? efforts[0]!
        : efforts.includes("medium")
          ? "medium"
          : preferences.reasoning_effort;
    const nextPreferences = {
      model_override: modelOverride,
      reasoning_enabled: Boolean(preferences.reasoning_enabled && efforts.length),
      reasoning_effort: nextEffort
    };
    const saved = modelOverride
      ? await controller.updateConversationModelAndDefault(modelOverride, nextPreferences)
      : await controller.updateConversationModelPreferences(nextPreferences);
    if (saved) {
      setQuery("");
    }
  }

  async function selectEffort(effort: ReasoningEffort) {
    if (!preferences.reasoning_enabled || !supportedEfforts.includes(effort) || locked) return;
    await controller.updateConversationModelPreferences({ ...preferences, reasoning_effort: effort });
  }

  async function toggleReasoning() {
    if (!supportedEfforts.length || locked) return;
    const nextEnabled = !preferences.reasoning_enabled;
    const nextEffort = supportedEfforts.includes(preferences.reasoning_effort)
      ? preferences.reasoning_effort
      : supportedEfforts.includes("medium")
        ? "medium"
        : supportedEfforts[0]!;
    await controller.updateConversationModelPreferences({
      ...preferences,
      reasoning_enabled: nextEnabled,
      reasoning_effort: nextEffort
    });
  }

  async function refreshModels() {
    if (mode === "website") {
      await controller.refreshWebsiteAiDashboard();
    } else {
      await controller.refreshManualModelCatalog(undefined, { force: true });
    }
  }

  const reasoningTitle = !selectedModel
    ? "请先选择模型"
    : !supportedEfforts.length
      ? "该模型不支持思考模式"
      : supportedEfforts.length === 1
        ? "该模型当前只支持高思考等级"
        : preferences.reasoning_enabled
          ? "已开启，可设置当前会话的思考等级"
          : "开启后可选择思考等级";
  const effectiveEffort = preferences.reasoning_enabled && supportedEfforts.includes(preferences.reasoning_effort)
    ? preferences.reasoning_effort
    : supportedEfforts.length === 1
      ? supportedEfforts[0]
      : null;
  const modelLabel = selectedModel?.name || selectedModelId || "选择模型";
  const triggerLabel = effectiveEffort ? `${modelLabel} · ${effortLabels[effectiveEffort]}` : modelLabel;
  const triggerTitle = preferences.model_override
    ? `当前会话模型：${selectedModelId}${effectiveEffort ? `，思考等级：${effortLabels[effectiveEffort]}` : ""}`
    : defaultModel
      ? `跟随默认模型：${defaultModel}${effectiveEffort ? `，思考等级：${effortLabels[effectiveEffort]}` : ""}`
      : "选择当前会话模型";

  return (
    <div className="assistant-model-controls" ref={rootRef}>
      <button
        ref={triggerRef}
        className="assistant-model-trigger"
        type="button"
        title={triggerTitle}
        aria-label={`选择模型与思考等级，当前${triggerLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={locked}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{triggerLabel}</span>
        <ChevronUp size={13} className={open ? "open" : ""} />
      </button>

      {open && (
        <div className="assistant-model-popover" role="dialog" aria-label="选择模型与思考等级">
          <div className="assistant-model-popover-head">
            <label>
              <Search size={14} />
              <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" />
            </label>
            <button type="button" title="刷新模型" aria-label="刷新模型" disabled={discoveryBusy} onClick={() => void refreshModels()}>
              <RefreshCw size={14} className={discoveryBusy ? "spin" : ""} />
            </button>
          </div>

          <div className="assistant-model-list" role="listbox">
            <button
              type="button"
              className={!preferences.model_override ? "selected" : ""}
              role="option"
              aria-selected={!preferences.model_override}
              disabled={!defaultModel || locked}
              onClick={() => void selectModel("")}
            >
              <span><strong>跟随默认</strong><small>{defaultModel || "请先在设置中配置默认模型"}</small></span>
              {!preferences.model_override && <Check size={14} />}
            </button>
            {discoveryBusy && !models.length && [0, 1, 2].map((item) => <i className="assistant-model-skeleton" key={item} />)}
            {!discoveryBusy && filteredModels.map((model) => (
              <button
                type="button"
                key={model.id}
                className={preferences.model_override === model.id ? "selected" : ""}
                role="option"
                aria-selected={preferences.model_override === model.id}
                title={model.id}
                disabled={locked}
                onClick={() => void selectModel(model.id)}
              >
                <span><strong>{model.name}</strong><small>{model.provider || "OpenAI 兼容"} · {describeReasoning(model)}{model.id === defaultModel ? " · 全局默认" : ""}</small></span>
                {preferences.model_override === model.id && <Check size={14} />}
              </button>
            ))}
            {!discoveryBusy && !filteredModels.length && <p>没有找到匹配的文本模型。</p>}
          </div>

          <div className="assistant-reasoning-panel" title={reasoningTitle}>
            <div>
              <Brain size={14} />
              <span><strong>思考模式</strong><small>{reasoningTitle}</small></span>
              <button
                className={`toggle${preferences.reasoning_enabled ? " on" : ""}`}
                type="button"
                role="switch"
                aria-checked={preferences.reasoning_enabled}
                aria-label={`${preferences.reasoning_enabled ? "关闭" : "开启"}思考模式`}
                disabled={locked || !supportedEfforts.length}
                onClick={() => void toggleReasoning()}
              />
            </div>
            <ReasoningSegments value={preferences.reasoning_effort} supported={supportedEfforts} locked={locked || !preferences.reasoning_enabled} onSelect={selectEffort} />
          </div>
          {discoveryMessage && <p className="assistant-model-message" title={discoveryMessage}>{discoveryMessage}</p>}
        </div>
      )}
    </div>
  );
}

function ReasoningSegments({
  value,
  supported,
  locked,
  onSelect
}: {
  value: ReasoningEffort;
  supported: ReasoningEffort[];
  locked: boolean;
  onSelect: (effort: ReasoningEffort) => Promise<void>;
}) {
  return (
    <div className="assistant-reasoning-segments">
      {(Object.keys(effortLabels) as ReasoningEffort[]).map((effort) => (
        <button
          type="button"
          key={effort}
          className={value === effort && supported.includes(effort) ? "active" : ""}
          aria-pressed={value === effort}
          disabled={locked || !supported.includes(effort)}
          onClick={() => void onSelect(effort)}
        >
          {effortLabels[effort]}
        </button>
      ))}
    </div>
  );
}

function describeReasoning(model: AiModelOption): string {
  if (!model.reasoning_efforts.length) return "不支持思考等级";
  if (model.reasoning_efforts.length === 1 && model.reasoning_efforts[0] === "high") return "仅高思考";
  return "支持低 / 中 / 高思考";
}
