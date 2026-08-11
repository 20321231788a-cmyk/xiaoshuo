import type {
  AiConfigProfile,
  AppConfig,
  DesktopUpdateStatus,
  WebsiteAiRechargeOption,
  WebsiteAiRechargeOrder
} from "@xiaoshuo/shared";
import { ArchiveRestore, Cable, Download, ExternalLink, Eye, EyeOff, Gift, RefreshCw, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent as ReactFormEvent } from "react";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";

const WEBSITE_HOME_URL = "https://matian.online/";
const WEBSITE_REGISTER_URL = "https://matian.online/?page=api-relay&auth=register";

export function SettingsFeaturePage({ controller }: { controller: WorkbenchController }) {
  const config = controller.configDraft;
  const [showSecrets, setShowSecrets] = useState(false);
  const [websiteEmail, setWebsiteEmail] = useState("");
  const [websitePassword, setWebsitePassword] = useState("");
  const [websiteLoginVisible, setWebsiteLoginVisible] = useState(false);
  const [websiteDialog, setWebsiteDialog] = useState<"redeem" | "recharge" | null>(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [selectedRechargeIndex, setSelectedRechargeIndex] = useState(0);
  const websiteDashboard = controller.websiteAiDashboard;
  const rechargeOptions = websiteDashboard?.recharge_options || [];
  const rechargeOptionKey = rechargeOptions.map((item) => item.option_index).join("|");

  useEffect(() => {
    if (!rechargeOptions.length) {
      setSelectedRechargeIndex(0);
      return;
    }
    if (!rechargeOptions.some((item) => item.option_index === selectedRechargeIndex)) {
      setSelectedRechargeIndex(rechargeOptions[0]?.option_index ?? 0);
    }
  }, [rechargeOptionKey, selectedRechargeIndex]);

  if (!config) {
    return null;
  }
  const activeConfig = config;
  const mode: AppConfig["ai_config_mode"] = activeConfig.ai_config_mode === "website" ? "website" : "manual";
  const manualProfile = normalizeUiAiProfile(activeConfig.manual_profile);
  const websiteProfile = normalizeUiAiProfile(activeConfig.website_profile);
  const websiteLoggedIn = Boolean(websiteDashboard?.logged_in);
  const websiteModels = websiteDashboard?.models || [];
  const websiteEmbeddingModels = websiteDashboard?.embedding_models || [];
  const websiteModel = websiteProfile.model || websiteDashboard?.selected_model || websiteModels[0]?.id || "";
  const websiteEmbeddingModel = websiteProfile.embedding_model || websiteDashboard?.selected_embedding_model || websiteEmbeddingModels[0]?.id || "";
  const websiteTemp = websiteProfile.temp ?? websiteDashboard?.temp ?? 0.7;
  const websiteTopP = websiteProfile.top_p ?? websiteDashboard?.top_p ?? 1;
  const selectedRechargeOption = rechargeOptions.find((item) => item.option_index === selectedRechargeIndex) || rechargeOptions[0] || null;

  function switchMode(nextMode: AppConfig["ai_config_mode"]) {
    controller.patchConfig({ ai_config_mode: nextMode });
    if (nextMode === "website") {
      void controller.refreshWebsiteAiDashboard();
    }
  }

  function submitWebsiteLogin(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    void controller.loginWebsiteAi(websiteEmail, websitePassword);
  }

  function applyWebsiteConfig() {
    if (!websiteModel) {
      return;
    }
    void controller.applyWebsiteAiConfig({
      model: websiteModel,
      embedding_model: websiteEmbeddingModel,
      temp: websiteTemp,
      top_p: websiteTopP
    });
  }

  function patchManualProfile(patch: Partial<AiConfigProfile>) {
    controller.patchConfig({ manual_profile: { ...manualProfile, ...patch } });
  }

  function patchWebsiteProfile(patch: Partial<AiConfigProfile>) {
    controller.patchConfig({ website_profile: { ...websiteProfile, ...patch } });
  }

  function openWebsiteDialog(kind: "redeem" | "recharge") {
    if (!websiteLoggedIn) {
      void controller.refreshWebsiteAiDashboard();
      return;
    }
    if (kind === "recharge" && selectedRechargeOption) {
      setSelectedRechargeIndex(selectedRechargeOption.option_index);
    }
    setWebsiteDialog(kind);
  }

  async function submitRedeem(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = await controller.redeemWebsiteAiCode(redeemCode);
    if (success) {
      setRedeemCode("");
    }
  }

  function createRechargeOrder() {
    if (!selectedRechargeOption) {
      return;
    }
    void controller.createWebsiteAiRechargeOrder(selectedRechargeOption.option_index);
  }

  function refreshRechargeOrder() {
    const orderId = controller.websiteAiRechargeOrder?.order_id || "";
    if (orderId) {
      void controller.refreshWebsiteAiRechargeOrder(orderId);
    }
  }

  return (
    <section className="xw-feature-page">
      <div className="xw-settings-header">
        <div>
          <strong>AI 配置</strong>
        </div>
        <div className="xw-settings-header-actions">
          <div className="xw-segmented-control" role="tablist" aria-label="AI 配置模式">
            <button type="button" className={mode === "website" ? "active" : ""} onClick={() => switchMode("website")}>
              网站配置
            </button>
            <button type="button" className={mode === "manual" ? "active" : ""} onClick={() => switchMode("manual")}>
              手动配置
            </button>
          </div>
          {mode === "manual" ? (
            <button className="xw-secondary-button compact" type="button" onClick={() => setShowSecrets((value) => !value)}>
              {showSecrets ? <EyeOff size={15} /> : <Eye size={15} />}
              {showSecrets ? "隐藏密钥" : "显示密钥"}
            </button>
          ) : (
            <button className="xw-secondary-button compact" type="button" onClick={() => void controller.refreshWebsiteAiDashboard()} disabled={controller.websiteAiBusy}>
              <RefreshCw size={15} />
              刷新账号
            </button>
          )}
        </div>
      </div>
      {mode === "manual" ? (
        <ManualAiSettings config={activeConfig} profile={manualProfile} controller={controller} showSecrets={showSecrets} onProfileChange={patchManualProfile} />
      ) : (
        <div className="xw-settings-list ai">
          <section className="xw-settings-section">
            <div className="xw-settings-section-head">
              <strong>网站账号</strong>
              <span>{websiteLoggedIn ? "已接入网站个人页中转配置。" : "使用 QQ 邮箱登录后读取个人页模型和额度。"}</span>
            </div>
            <div className="xw-website-entry-actions">
              <a className="xw-secondary-button compact" href={WEBSITE_REGISTER_URL} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                注册
              </a>
              <a className="xw-secondary-button compact" href={WEBSITE_HOME_URL} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                前往网站
              </a>
            </div>
            {websiteLoggedIn && websiteDashboard?.account ? (
              <div className="xw-website-account">
                <div>
                  <strong>{websiteDashboard.account.email || websiteDashboard.account.name || "网站账号"}</strong>
                  <span>{websiteDashboard.account.enabled ? "账号可用" : "账号已停用"}</span>
                </div>
                <div className="xw-website-account-actions">
                  <button className="xw-secondary-button compact" type="button" onClick={() => openWebsiteDialog("redeem")} disabled={!websiteLoggedIn || controller.websiteAiRedeemBusy}>
                    <Gift size={14} />
                    兑换
                  </button>
                  <button className="xw-secondary-button compact" type="button" onClick={() => openWebsiteDialog("recharge")} disabled={!websiteLoggedIn || controller.websiteAiRechargeBusy}>
                    <WalletCards size={14} />
                    充值
                  </button>
                  <button className="xw-secondary-button compact" type="button" onClick={() => setWebsiteLoginVisible((value) => !value)}>
                    切换账号
                  </button>
                </div>
                <div className="xw-website-stat-row">
                  <span>余额 {formatCompactNumber(websiteDashboard.account.balance)}</span>
                  <span>已用 {formatCompactNumber(websiteDashboard.account.used)}</span>
                  <span>并发 {websiteDashboard.max_concurrency || "-"}</span>
                  <span>RPM {websiteDashboard.max_rpm || "-"}</span>
                  <span>TPM {websiteDashboard.max_tpm || "-"}</span>
                </div>
              </div>
            ) : (
              <p className="xw-feature-empty">尚未登录网站配置。</p>
            )}
            {(websiteLoginVisible || !websiteLoggedIn) && (
              <form className="xw-website-login-form" onSubmit={submitWebsiteLogin}>
                <TextSettingRow label="QQ 邮箱" value={websiteEmail} placeholder="123456@qq.com" onChange={setWebsiteEmail} />
                <label className="xw-setting-field">
                  <span>密码</span>
                  <input type="password" value={websitePassword} autoComplete="current-password" onChange={(event) => setWebsitePassword(event.target.value)} />
                </label>
                <button className="xw-primary-button compact" type="submit" disabled={controller.websiteAiBusy || !websiteEmail.trim() || !websitePassword}>
                  登录网站
                </button>
              </form>
            )}
          </section>

          <section className="xw-settings-section">
            <div className="xw-settings-section-head">
              <strong>网站模型</strong>
              <span>软件会在本地隐藏写入中转连接信息，界面只保留可选模型。</span>
            </div>
            <div className="xw-settings-grid">
              <SelectSettingRow
                label="语言模型"
                value={websiteModel}
                placeholder="登录后读取模型"
                options={websiteModels.map((item) => ({ value: item.id, label: item.provider ? `${item.name} · ${item.provider}` : item.name }))}
                onChange={(value) => patchWebsiteProfile({ model: value })}
              />
              {websiteEmbeddingModels.length > 0 && (
                <SelectSettingRow
                  label="向量模型"
                  value={websiteEmbeddingModel}
                  placeholder="可选"
                  options={websiteEmbeddingModels.map((item) => ({ value: item.id, label: item.provider ? `${item.name} · ${item.provider}` : item.name }))}
                  onChange={(value) => patchWebsiteProfile({ embedding_model: value, embedding_enabled: true })}
                />
              )}
              <SliderSettingRow label="temperature" value={websiteTemp} min={0} max={2} step={0.01} onChange={(value) => patchWebsiteProfile({ temp: value })} />
              <SliderSettingRow label="top_p" value={websiteTopP} min={0} max={1} step={0.01} onChange={(value) => patchWebsiteProfile({ top_p: value })} />
            </div>
          </section>

          <WebsiteWebSearchSettings config={activeConfig} controller={controller} />
        </div>
      )}
      <SoftwareUpdateSettings />
      <div className="xw-feature-actions">
        {mode === "manual" ? (
          <>
            <button className="xw-primary-button compact" onClick={controller.saveConfig} disabled={controller.configBusy}>保存设置</button>
            <button className="xw-secondary-button compact" onClick={controller.refreshLicense} disabled={controller.configBusy}>刷新授权</button>
            <span>{controller.configMessage || "设置会应用到后续生成和会话。"}</span>
          </>
        ) : (
          <>
            <button className="xw-primary-button compact" onClick={applyWebsiteConfig} disabled={controller.websiteAiBusy || !websiteModel}>应用网站配置</button>
            <button className="xw-secondary-button compact" onClick={() => void controller.refreshWebsiteAiDashboard()} disabled={controller.websiteAiBusy}>刷新网站状态</button>
            <span>{controller.websiteAiMessage || websiteDashboard?.message || "网站配置会应用到后续聊天、生成和技能调用。"}</span>
          </>
        )}
      </div>
      {websiteDialog === "redeem" && (
        <WebsiteRedeemDialog
          code={redeemCode}
          busy={controller.websiteAiRedeemBusy}
          message={controller.websiteAiRedeemMessage}
          purchaseUrl={websiteDashboard?.redeem_purchase_url || ""}
          onChange={setRedeemCode}
          onSubmit={submitRedeem}
          onClose={() => setWebsiteDialog(null)}
        />
      )}
      {websiteDialog === "recharge" && (
        <WebsiteRechargeDialog
          options={rechargeOptions}
          selectedIndex={selectedRechargeIndex}
          order={controller.websiteAiRechargeOrder}
          busy={controller.websiteAiRechargeBusy}
          message={controller.websiteAiRechargeMessage}
          fallbackQr={websiteDashboard?.recharge_qr || ""}
          onSelect={setSelectedRechargeIndex}
          onCreate={createRechargeOrder}
          onRefresh={refreshRechargeOrder}
          onClose={() => setWebsiteDialog(null)}
        />
      )}
    </section>
  );
}

function SoftwareUpdateSettings() {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [busyAction, setBusyAction] = useState<"check" | "download" | "install" | "">("");
  const updatesApi = typeof window !== "undefined" ? window.xiaoshuoDesktop?.updates : undefined;
  const desktopAvailable = Boolean(updatesApi);
  const busy = busyAction !== "" || status?.state === "checking" || status?.state === "downloading";
  const canCheck = Boolean(updatesApi && status?.canCheck) && status?.state !== "checking" && status?.state !== "downloading";
  const canDownload = Boolean(updatesApi && status?.state === "available") && !busyAction;
  const canInstall = Boolean(updatesApi && status?.state === "downloaded") && !busyAction;

  useEffect(() => {
    if (!updatesApi) {
      return;
    }
    let mounted = true;
    void updatesApi.getStatus().then((nextStatus) => {
      if (mounted) {
        setStatus(nextStatus);
      }
    });
    const unsubscribe = updatesApi.onStatus((nextStatus) => {
      if (mounted) {
        setStatus(nextStatus);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [updatesApi]);

  async function runUpdateAction(action: "check" | "download" | "install") {
    if (!updatesApi) {
      return;
    }
    setBusyAction(action);
    try {
      if (action === "check") {
        setStatus(await updatesApi.check());
      } else if (action === "download") {
        setStatus(await updatesApi.download());
      } else {
        await updatesApi.installAndRestart();
      }
    } finally {
      setBusyAction("");
    }
  }

  return (
    <section className="xw-settings-section xw-update-section">
      <div className="xw-settings-section-head">
        <strong>软件更新</strong>
        <span>优先通过国内镜像检查完整桌面软件更新，失败后回退 GitHub，不使用网站授权或客户端 GitHub token。</span>
      </div>
      <div className="xw-update-panel">
        <div className="xw-update-status-grid">
          <StatusRow label="当前版本" value={status?.currentVersion || "开发预览"} />
          <StatusRow label="最新版本" value={status?.latestVersion || "-"} />
          <StatusRow label="状态" value={describeUpdateStatus(status, desktopAvailable)} />
          <StatusRow label="更新源" value={describeUpdateSource(status?.updateSource)} />
          <StatusRow label="检查时间" value={status?.checkedAt ? formatDateTime(status.checkedAt) : "-"} />
        </div>
        {status?.state === "downloading" && (
          <div className="xw-update-progress">
            <div>
              <span>下载进度</span>
              <strong>{Math.round(status.percent || 0)}%</strong>
            </div>
            <div className="xw-update-progress-track">
              <span style={{ width: `${Math.max(0, Math.min(100, status.percent || 0))}%` }} />
            </div>
            <small>
              {formatUpdateBytes(status.transferred || 0)} / {formatUpdateBytes(status.total || 0)}
              {status.bytesPerSecond ? ` · ${formatUpdateBytes(status.bytesPerSecond)}/s` : ""}
            </small>
          </div>
        )}
        {status?.releaseNotes && <pre className="xw-update-notes">{trimUpdateNotes(status.releaseNotes)}</pre>}
        {status?.error && <p className="xw-update-error">{status.error}</p>}
        {!desktopAvailable && <p className="xw-feature-empty">仅桌面安装版可用。当前浏览器预览不能执行自动更新。</p>}
        <div className="xw-update-actions">
          <button className="xw-secondary-button compact" type="button" onClick={() => void runUpdateAction("check")} disabled={!canCheck}>
            <RefreshCw size={14} />
            {busyAction === "check" || status?.state === "checking" ? "检查中" : "检查更新"}
          </button>
          <button className="xw-secondary-button compact" type="button" onClick={() => void runUpdateAction("download")} disabled={!canDownload}>
            <Download size={14} />
            {busyAction === "download" || status?.state === "downloading" ? "下载中" : "下载更新"}
          </button>
          <button className="xw-primary-button compact" type="button" onClick={() => void runUpdateAction("install")} disabled={!canInstall}>
            <ArchiveRestore size={14} />
            重启安装
          </button>
        </div>
      </div>
    </section>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="xw-status-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function describeUpdateStatus(status: DesktopUpdateStatus | null, desktopAvailable: boolean): string {
  if (!desktopAvailable) {
    return "非桌面环境";
  }
  if (!status) {
    return "读取中";
  }
  if (!status.canCheck) {
    return "开发模式不可用";
  }
  if (status.state === "checking") {
    return "正在检查";
  }
  if (status.state === "available") {
    return "发现新版本";
  }
  if (status.state === "not_available") {
    return "已是最新";
  }
  if (status.state === "downloading") {
    return "正在下载";
  }
  if (status.state === "downloaded") {
    return "已下载，等待安装";
  }
  if (status.state === "error") {
    return "检查失败";
  }
  return "待检查";
}

function describeUpdateSource(source: DesktopUpdateStatus["updateSource"]): string {
  if (source === "mirror") {
    return "国内镜像";
  }
  if (source === "github") {
    return "GitHub";
  }
  return "-";
}

function formatUpdateBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(value)} B`;
}

function formatBytes(value: number): string {
  return formatUpdateBytes(value);
}

function formatDateShort(value: string): string {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  });
}

function trimUpdateNotes(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 900) {
    return normalized;
  }
  return `${normalized.slice(0, 900)}...`;
}

function normalizeUiAiProfile(profile: Partial<AiConfigProfile> | null | undefined): AiConfigProfile {
  return {
    api_key: profile?.api_key || "",
    base_url: profile?.base_url || "",
    model: profile?.model || "",
    temp: profile?.temp ?? 0.7,
    top_p: profile?.top_p ?? 1,
    secondary_api_key: profile?.secondary_api_key || "",
    secondary_base_url: profile?.secondary_base_url || "",
    secondary_model: profile?.secondary_model || "",
    secondary_temp: profile?.secondary_temp ?? 0.5,
    secondary_top_p: profile?.secondary_top_p ?? 1,
    embedding_enabled: Boolean(profile?.embedding_enabled),
    embedding_api_key: profile?.embedding_api_key || "",
    embedding_base_url: profile?.embedding_base_url || "",
    embedding_model: profile?.embedding_model || "",
    license_account_key: profile?.license_account_key || ""
  };
}

function webSearchTogglePatch(config: AppConfig, enabled: boolean): Partial<AppConfig> {
  return {
    web_search_enabled: enabled,
    ...(enabled && config.web_search_provider === "custom" && !config.web_search_base_url?.trim() ? { web_search_provider: "bing" as const } : {})
  };
}

function WebsiteWebSearchSettings({ config, controller }: { config: AppConfig; controller: WorkbenchController }) {
  function savePatch(patch: Partial<AppConfig>) {
    void controller.patchAndSaveConfig(patch, "联网素材搜索设置已保存。");
  }

  return (
    <section className="xw-settings-section">
      <div className="xw-settings-section-head">
        <strong>联网素材搜索</strong>
        <span>网站配置也会使用这组搜索设置；Bing 无需额外密钥，自定义搜索密钥仍在手动配置页维护。</span>
      </div>
      <div className="xw-settings-grid">
        <ToggleSettingRow
          label="联网素材搜索"
          checked={Boolean(config.web_search_enabled)}
          onChange={() => savePatch(webSearchTogglePatch(config, !config.web_search_enabled))}
        />
        <label className="xw-setting-field">
          <span>搜索来源</span>
          <select
            value={config.web_search_provider === "custom" ? "custom" : "bing"}
            onChange={(event) => savePatch({ web_search_provider: event.target.value === "custom" ? "custom" : "bing" })}
          >
            <option value="bing">Bing</option>
            <option value="custom">自定义 API</option>
          </select>
        </label>
        <NumberSettingRow label="结果数量" value={config.web_search_max_results || 3} min={1} max={5} onChange={(value) => savePatch({ web_search_max_results: value })} />
        <NumberSettingRow label="搜索超时秒数" value={config.web_search_timeout || 10} min={3} max={60} onChange={(value) => savePatch({ web_search_timeout: value })} />
        <NumberSettingRow label="素材上下文字符" value={config.web_search_context_chars || 3000} min={800} max={8000} onChange={(value) => savePatch({ web_search_context_chars: value })} />
      </div>
    </section>
  );
}

function WebsiteRedeemDialog({
  code,
  busy,
  message,
  purchaseUrl,
  onChange,
  onSubmit,
  onClose
}: {
  code: string;
  busy: boolean;
  message: string;
  purchaseUrl: string;
  onChange: (value: string) => void;
  onSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  return (
    <div className="xw-website-modal-backdrop" onClick={onClose}>
      <form className="xw-website-modal" onSubmit={onSubmit} onClick={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <div className="xw-website-modal-head">
          <div>
            <strong>兑换码</strong>
            <span>额度码和工具授权码都可以在这里兑换。</span>
          </div>
          <button className="xw-secondary-button compact" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        {purchaseUrl && (
          <a className="xw-website-link-button" href={purchaseUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            购买兑换码
          </a>
        )}
        <label className="xw-setting-field">
          <span>输入兑换码</span>
          <input value={code} autoFocus placeholder="XXXX-XXXX-XXXX" onChange={(event) => onChange(event.target.value)} />
        </label>
        <button className="xw-primary-button compact" type="submit" disabled={busy || !code.trim()}>
          {busy ? "兑换中..." : "立即兑换"}
        </button>
        {message && <p className="xw-website-modal-message">{message}</p>}
      </form>
    </div>
  );
}

function WebsiteRechargeDialog({
  options,
  selectedIndex,
  order,
  busy,
  message,
  fallbackQr,
  onSelect,
  onCreate,
  onRefresh,
  onClose
}: {
  options: WebsiteAiRechargeOption[];
  selectedIndex: number;
  order: WebsiteAiRechargeOrder | null;
  busy: boolean;
  message: string;
  fallbackQr: string;
  onSelect: (value: number) => void;
  onCreate: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const selected = options.find((item) => item.option_index === selectedIndex) || options[0] || null;
  const paymentQr = order?.payment_qr || (!options.length ? fallbackQr : "");
  const paymentLink = order?.payment_url || order?.payment_code || "";
  const canCreate = Boolean(selected) && !busy && order?.status !== "pending" && order?.status !== "paid";

  return (
    <div className="xw-website-modal-backdrop" onClick={onClose}>
      <section className="xw-website-modal recharge" onClick={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <div className="xw-website-modal-head">
          <div>
            <strong>充值中心</strong>
            <span>选择档位后创建订单，支付成功会自动刷新余额。</span>
          </div>
          <button className="xw-secondary-button compact" type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        {options.length > 0 ? (
          <>
            <div className="xw-recharge-option-grid">
              {options.map((option) => (
                <button
                  key={option.option_index}
                  type="button"
                  className={`xw-recharge-option ${option.option_index === selectedIndex ? "selected" : ""}`}
                  onClick={() => onSelect(option.option_index)}
                  disabled={busy || order?.status === "pending"}
                >
                  <strong>到账 {formatMoney(option.amount)}</strong>
                  <span>实付 {formatMoney(option.real_price)}</span>
                  {option.real_price < option.amount && <small>节省 {formatMoney(option.amount - option.real_price)}</small>}
                </button>
              ))}
            </div>
            {selected && (
              <div className="xw-recharge-summary">
                <span>本次实付</span>
                <strong>{formatMoney(selected.real_price || selected.amount)}</strong>
              </div>
            )}
            <button className="xw-primary-button compact" type="button" onClick={onCreate} disabled={!canCreate}>
              {describeRechargeActionLabel(order, busy)}
            </button>
          </>
        ) : (
          <div className="xw-recharge-empty">
            {fallbackQr ? (
              <>
                <span>管理员暂未配置充值档位，请扫码联系充值。</span>
                <img src={fallbackQr} alt="充值二维码" />
              </>
            ) : (
              <span>管理员暂未配置充值方式</span>
            )}
          </div>
        )}

        {order && (
          <div className="xw-recharge-order">
            <div>
              <span>订单号</span>
              <strong>{order.order_id}</strong>
            </div>
            <div>
              <span>当前状态</span>
              <strong>{describeRechargeStatus(order.status)}{order.status === "pending" ? "（自动同步中）" : ""}</strong>
            </div>
            {order.expire_at && (
              <div>
                <span>过期时间</span>
                <strong>{formatDateTime(order.expire_at)}</strong>
              </div>
            )}
            {order.payment_error && <p>{order.payment_error}</p>}
            <button className="xw-secondary-button compact" type="button" onClick={onRefresh} disabled={busy || !order.order_id}>
              <RefreshCw size={14} />
              手动刷新
            </button>
          </div>
        )}

        {paymentQr && (
          <div className="xw-recharge-qr">
            <img src={paymentQr} alt="充值二维码" />
          </div>
        )}
        {paymentLink && (
          <a className="xw-website-link-button" href={paymentLink} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            打开支付链接
          </a>
        )}
        {message && <p className="xw-website-modal-message">{message}</p>}
      </section>
    </div>
  );
}

function ManualAiSettings({
  config,
  profile,
  controller,
  showSecrets,
  onProfileChange
}: {
  config: AppConfig;
  profile: Partial<AiConfigProfile>;
  controller: WorkbenchController;
  showSecrets: boolean;
  onProfileChange: (patch: Partial<AiConfigProfile>) => void;
}) {
  return (
    <div className="xw-settings-list ai">
      <section className="xw-settings-section">
        <div className="xw-settings-section-head">
          <strong>主模型</strong>
          <span>聊天、写作和技能执行的默认线路</span>
        </div>
        <div className="xw-settings-grid">
          <SecretSettingRow label="API Key" value={profile.api_key || ""} visible={showSecrets} onChange={(value) => onProfileChange({ api_key: value })} />
          <TextSettingRow label="Base URL" value={profile.base_url || ""} placeholder="https://api.openai.com/v1" onChange={(value) => onProfileChange({ base_url: value })} />
          <TextSettingRow label="模型" value={profile.model || ""} placeholder="gpt-4.1-mini" onChange={(value) => onProfileChange({ model: value })} />
          <SliderSettingRow label="temperature" value={profile.temp ?? 0.7} min={0} max={2} step={0.01} onChange={(value) => onProfileChange({ temp: value })} />
          <SliderSettingRow label="top_p" value={profile.top_p ?? 1} min={0} max={1} step={0.01} onChange={(value) => onProfileChange({ top_p: value })} />
        </div>
      </section>

      <section className="xw-settings-section">
        <div className="xw-settings-section-head">
          <strong>副模型</strong>
          <span>可用于备用线路或轻量任务，未填写时继续使用主模型</span>
        </div>
        <div className="xw-settings-grid">
          <SecretSettingRow label="副 API Key" value={profile.secondary_api_key || ""} visible={showSecrets} onChange={(value) => onProfileChange({ secondary_api_key: value })} />
          <TextSettingRow label="副 Base URL" value={profile.secondary_base_url || ""} placeholder="留空沿用主 Base URL" onChange={(value) => onProfileChange({ secondary_base_url: value })} />
          <TextSettingRow label="副模型" value={profile.secondary_model || ""} placeholder="可选" onChange={(value) => onProfileChange({ secondary_model: value })} />
          <SliderSettingRow label="temperature" value={profile.secondary_temp ?? 0.5} min={0} max={2} step={0.01} onChange={(value) => onProfileChange({ secondary_temp: value })} />
          <SliderSettingRow label="top_p" value={profile.secondary_top_p ?? 1} min={0} max={1} step={0.01} onChange={(value) => onProfileChange({ secondary_top_p: value })} />
        </div>
      </section>

      <section className="xw-settings-section">
        <div className="xw-settings-section-head with-action">
          <div>
            <strong>Embedding 与向量召回</strong>
            <span>用于项目索引、长期记忆和素材召回</span>
          </div>
          <button
            className="xw-secondary-button compact"
            type="button"
            onClick={() =>
              void controller.testEmbeddingConnection({
                embedding_enabled: Boolean(profile.embedding_enabled),
                embedding_api_key: profile.embedding_api_key || "",
                embedding_base_url: profile.embedding_base_url || "",
                embedding_model: profile.embedding_model || "",
                embedding_timeout: config.embedding_timeout || 60,
                embedding_batch_size: config.embedding_batch_size || 16
              })
            }
            disabled={controller.embeddingTestBusy || controller.configBusy}
          >
            <Cable size={14} />
            {controller.embeddingTestBusy ? "检测中" : "检测链接"}
          </button>
        </div>
        <div className="xw-settings-grid">
          <ToggleSettingRow label="启用向量召回" checked={Boolean(profile.embedding_enabled)} onChange={() => onProfileChange({ embedding_enabled: !profile.embedding_enabled })} />
          <SecretSettingRow label="Embedding API Key" value={profile.embedding_api_key || ""} visible={showSecrets} onChange={(value) => onProfileChange({ embedding_api_key: value })} />
          <TextSettingRow label="Embedding Base URL" value={profile.embedding_base_url || ""} onChange={(value) => onProfileChange({ embedding_base_url: value })} />
          <TextSettingRow label="Embedding 模型" value={profile.embedding_model || ""} onChange={(value) => onProfileChange({ embedding_model: value })} />
          <NumberSettingRow label="超时秒数" value={config.embedding_timeout || 60} min={5} max={300} onChange={(value) => controller.patchConfig({ embedding_timeout: value })} />
          <NumberSettingRow label="批大小" value={config.embedding_batch_size || 16} min={1} max={128} onChange={(value) => controller.patchConfig({ embedding_batch_size: value })} />
          <NumberSettingRow label="召回条数" value={config.vector_top_k || 10} min={1} max={40} onChange={(value) => controller.patchConfig({ vector_top_k: value })} />
          <NumberSettingRow label="召回上下文字符" value={config.vector_context_chars || 9000} min={1000} max={80000} onChange={(value) => controller.patchConfig({ vector_context_chars: value })} />
        </div>
        {controller.embeddingTestMessage && <p className="xw-setting-inline-message">{controller.embeddingTestMessage}</p>}
      </section>

      <section className="xw-settings-section">
        <div className="xw-settings-section-head">
          <strong>联网素材搜索</strong>
          <span>优先使用 Bing，为会话和生成任务补充外部素材来源</span>
        </div>
        <div className="xw-settings-grid">
          <ToggleSettingRow label="联网素材搜索" checked={Boolean(config.web_search_enabled)} onChange={() => controller.patchConfig({ web_search_enabled: !config.web_search_enabled })} />
          <label className="xw-setting-field">
            <span>搜索来源</span>
            <select value={config.web_search_provider === "custom" ? "custom" : "bing"} onChange={(event) => controller.patchConfig({ web_search_provider: event.target.value === "custom" ? "custom" : "bing" })}>
              <option value="bing">Bing</option>
              <option value="custom">自定义 API</option>
            </select>
          </label>
          <SecretSettingRow label="Bing / 自定义 API Key" value={config.web_search_api_key || ""} visible={showSecrets} onChange={(value) => controller.patchConfig({ web_search_api_key: value })} />
          <TextSettingRow label="自定义 Base URL" value={config.web_search_base_url || ""} placeholder="自定义搜索时填写，Bing 可留空" onChange={(value) => controller.patchConfig({ web_search_base_url: value })} />
          <NumberSettingRow label="结果数量" value={config.web_search_max_results || 3} min={1} max={5} onChange={(value) => controller.patchConfig({ web_search_max_results: value })} />
          <NumberSettingRow label="搜索超时秒数" value={config.web_search_timeout || 10} min={3} max={60} onChange={(value) => controller.patchConfig({ web_search_timeout: value })} />
          <NumberSettingRow label="素材上下文字符" value={config.web_search_context_chars || 3000} min={800} max={8000} onChange={(value) => controller.patchConfig({ web_search_context_chars: value })} />
        </div>
      </section>

      <section className="xw-settings-section">
        <div className="xw-settings-section-head">
          <strong>授权</strong>
          <span>保存后可刷新当前设备授权状态</span>
        </div>
        <div className="xw-settings-grid">
          <SecretSettingRow label="授权账号 Key" value={profile.license_account_key || ""} visible={showSecrets} onChange={(value) => onProfileChange({ license_account_key: value })} />
        </div>
      </section>
    </div>
  );
}

function SelectSettingRow({
  label,
  value,
  placeholder,
  options,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="xw-setting-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={!options.length}>
        {!options.length && <option value="">{placeholder || "暂无可选项"}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toFixed(1)}万`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatMoney(value: number): string {
  const amount = Number.isFinite(value) ? value : 0;
  return `¥${amount.toFixed(2)}`;
}

function describeRechargeStatus(status: string): string {
  if (status === "paid") {
    return "已支付";
  }
  if (status === "expired") {
    return "已过期";
  }
  if (status === "pending") {
    return "待支付";
  }
  return status || "未创建";
}

function describeRechargeActionLabel(order: WebsiteAiRechargeOrder | null, busy: boolean): string {
  if (busy) {
    return "创建订单中...";
  }
  if (order?.status === "paid") {
    return "余额已到账";
  }
  if (order?.status === "pending") {
    return "等待支付完成";
  }
  return "发起充值并自动到账";
}

function formatDateTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function TextSettingRow({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="xw-setting-field">
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SecretSettingRow({
  label,
  value,
  visible,
  onChange
}: {
  label: string;
  value: string;
  visible: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="xw-setting-field">
      <span>{label}</span>
      <input type={visible ? "text" : "password"} value={value} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberSettingRow({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Number.isFinite(value) ? value : min));

  useEffect(() => {
    setDraft(String(Number.isFinite(value) ? value : min));
  }, [value, min]);

  function commitDraft() {
    const parsed = Number(draft);
    const fallback = Number.isFinite(value) ? value : min;
    const next = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
    setDraft(String(next));
    if (next !== value) {
      onChange(next);
    }
  }

  return (
    <label className="xw-setting-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitDraft();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function ToggleSettingRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="xw-setting-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={onChange} />
    </label>
  );
}

function SliderSettingRow({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const displayValue = Number.isFinite(value) ? value : min;
  return (
    <label className="xw-setting-field slider">
      <span>{label}</span>
      <div className="xw-slider-control">
        <input type="range" min={min} max={max} step={step} value={displayValue} onChange={(event) => onChange(Number(event.target.value))} />
        <output>{displayValue.toFixed(2)}</output>
      </div>
    </label>
  );
}
