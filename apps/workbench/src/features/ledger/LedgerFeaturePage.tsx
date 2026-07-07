import { useState } from "react";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";
import { ProjectFileSelect } from "../workflow/WorkflowControls.js";

type CenterFeature =
  | "editor"
  | "conversations"
  | "timeline"
  | "settings-set"
  | "style-library"
  | "theme-library"
  | "batch"
  | "crawl"
  | "card_draw"
  | "ledger"
  | "revision"
  | "skills"
  | "consistency"
  | "settings"
  | "terminal";

export function LedgerFeaturePage({ controller, onSelectFeature }: { controller: WorkbenchController; onSelectFeature: (feature: CenterFeature) => void }) {
  const [draft, setDraft] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanText, setScanText] = useState("");
  const [scanInstruction, setScanInstruction] = useState("");
  const ledger = controller.snapshot?.ledger || [];
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;
  return (
    <section className="xw-feature-page">
      <div className="xw-feature-toolbar">
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="新增伏笔或待回收线索" />
        <button
          className="xw-primary-button compact"
          onClick={() => {
            const text = draft.trim();
            if (text) {
              void controller.addLedgerItem(text);
              setDraft("");
            }
          }}
          disabled={controller.projectBusy || !draft.trim()}
        >
          新增
        </button>
      </div>
      <div className="xw-operation-form">
        <div className="xw-operation-grid two">
          <ProjectFileSelect label="扫描来源文件" value={scanPath} onChange={setScanPath} controller={controller} />
          <label><span>当前文档</span><input value={activeDocument?.title || "未打开文档"} readOnly /></label>
        </div>
        <textarea value={scanText} onChange={(event) => setScanText(event.target.value)} placeholder="可粘贴正文片段。留空则使用当前文档或来源路径。" />
        <textarea value={scanInstruction} onChange={(event) => setScanInstruction(event.target.value)} placeholder="扫描要求，例如只提取未回收伏笔、人物承诺、物品线索。" />
        <button
          className="xw-primary-button"
          onClick={() => void controller.runWorkflowSkill("scan_pits", {
            text: scanText || activeDocument?.content || "",
            source_path: scanPath || activeDocument?.path || "",
            instruction: scanInstruction,
            write_result: true
          })}
          disabled={controller.operationsBusy}
        >
          扫描伏笔
        </button>
      </div>
      <div className="xw-feature-list">
        {ledger.map((item) => (
          <article key={item.id} className={`xw-feature-card ${item.status === "closed" ? "muted" : ""}`}>
            <div className="xw-feature-card-head">
              <strong>{item.desc}</strong>
              <small>{item.status === "closed" ? "已关闭" : "未关闭"}</small>
            </div>
            <span>{item.updated_at || item.created_at}</span>
            <div className="xw-feature-actions">
              {item.status !== "closed" && (
                <button
                  className="xw-primary-button compact"
                  onClick={() => {
                    onSelectFeature("conversations");
                    void controller.sendLedgerRecoveryPrompt(item);
                  }}
                  disabled={controller.sendingMessage || controller.conversationBusy}
                >
                  发给AI回收
                </button>
              )}
              <button className="xw-secondary-button compact" onClick={() => void controller.toggleLedgerItem(item.id)} disabled={controller.projectBusy}>
                {item.status === "closed" ? "重新打开" : "关闭"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!ledger.length && <p className="xw-feature-empty">暂无伏笔记录</p>}
    </section>
  );
}
