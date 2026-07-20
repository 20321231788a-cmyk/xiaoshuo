import { Check, CircleAlert, Info, Plus, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";

// 1. 空状态 (EmptyState)
export function EmptyState({
  title,
  description,
  icon: Icon = Info,
  primaryAction,
  secondaryAction
}: {
  title: string;
  description: string;
  icon?: any;
  primaryAction?: { label: string; onClick: () => void; icon?: any };
  secondaryAction?: { label: string; onClick: () => void; icon?: any };
}) {
  return (
    <div className="empty-state">
      <span><Icon size={22} /></span>
      <h3>{title}</h3>
      <p>{description}</p>
      <div style={{ display: "flex", gap: "10px", marginTop: "12px", justifyContent: "center" }}>
        {secondaryAction && (
          <button className="button secondary" type="button" onClick={secondaryAction.onClick}>
            {secondaryAction.icon && <secondaryAction.icon size={14} />}
            {secondaryAction.label}
          </button>
        )}
        {primaryAction && (
          <button className="button primary" type="button" onClick={primaryAction.onClick}>
            {primaryAction.icon && <primaryAction.icon size={14} />}
            {primaryAction.label}
          </button>
        )}
      </div>
    </div>
  );
}

// 2. 保存冲突状态 (SaveConflictState)
export function SaveConflictState({
  title = "正文在另一处被修改",
  description = "你的版本与磁盘上的最新版本不同。请选择保留方式，当前内容不会丢失。",
  mySizeLabel,
  myTimeLabel,
  diskSizeLabel,
  diskTimeLabel,
  onSaveCopy,
  onViewDiff,
  onOverwrite
}: {
  title?: string;
  description?: string;
  mySizeLabel: string;
  myTimeLabel: string;
  diskSizeLabel: string;
  diskTimeLabel: string;
  onSaveCopy: () => void;
  onViewDiff: () => void;
  onOverwrite: () => void;
}) {
  return (
    <div className="conflict-state">
      <CircleAlert size={22} />
      <h3>{title}</h3>
      <p>{description}</p>
      <div className="version-compare">
        <div>
          <span>我的版本</span>
          <strong>{mySizeLabel}</strong>
          <small>{myTimeLabel}</small>
        </div>
        <div>
          <span>磁盘版本</span>
          <strong>{diskSizeLabel}</strong>
          <small>{diskTimeLabel}</small>
        </div>
      </div>
      <div style={{ display: "flex", gap: "10px", marginTop: "16px", justifyContent: "center" }}>
        <button className="button secondary" type="button" onClick={onSaveCopy}>另存为副本</button>
        <button className="button secondary" type="button" onClick={onViewDiff}>查看差异</button>
        <button className="button primary" type="button" onClick={onOverwrite}>保留我的版本</button>
      </div>
    </div>
  );
}

// 3. AI 写入确认 (AiWriteConfirmState)
export function AiWriteConfirmState({
  title = "准备修改当前章节",
  description = "将替换部分段落。提交后可从章节历史中撤销。",
  targetChapter,
  impactScope = "仅当前章节",
  onCancel,
  onViewDiff,
  onConfirm
}: {
  title?: string;
  description?: string;
  targetChapter: string;
  impactScope?: string;
  onCancel: () => void;
  onViewDiff: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="write-confirm">
      <ShieldCheck size={22} />
      <h3>{title}</h3>
      <p>{description}</p>
      <div className="change-line">
        <span>写入位置</span>
        <strong>{targetChapter}</strong>
      </div>
      <div className="change-line">
        <span>影响范围</span>
        <strong>{impactScope}</strong>
      </div>
      <div style={{ display: "flex", gap: "10px", marginTop: "16px", justifyContent: "center" }}>
        <button className="button secondary" type="button" onClick={onCancel}>取消</button>
        <button className="button secondary" type="button" onClick={onViewDiff}>查看差异</button>
        <button className="button primary" type="button" onClick={onConfirm}><Check size={14} />确认写入</button>
      </div>
    </div>
  );
}

// 4. 网络恢复状态 (NetworkRecoveryState)
export function NetworkRecoveryState({
  title = "网络中断，生成已暂停",
  description = "已完成的内容已保存为草稿，不会重复扣除已完成步骤的额度。",
  draftLabel = "已保存草稿",
  onCancel,
  onReconnect
}: {
  title?: string;
  description?: string;
  draftLabel?: string;
  onCancel: () => void;
  onReconnect: () => void;
}) {
  return (
    <div className="error-state">
      <RefreshCw size={22} />
      <h3>{title}</h3>
      <p>{description}</p>
      <div className="recovery-note">
        <Check size={14} />
        <span>{draftLabel}</span>
      </div>
      <div style={{ display: "flex", gap: "10px", marginTop: "16px", justifyContent: "center" }}>
        <button className="button secondary" type="button" onClick={onCancel}>稍后处理</button>
        <button className="button primary" type="button" onClick={onReconnect}><RefreshCw size={14} />重新连接</button>
      </div>
    </div>
  );
}
