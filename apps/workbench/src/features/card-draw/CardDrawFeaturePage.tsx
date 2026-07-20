import { useState } from "react";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";
import { ProjectFileSelect } from "../workflow/WorkflowControls.js";

export function CardDrawFeaturePage({ controller }: { controller: WorkbenchController }) {
  const [mode, setMode] = useState<"outline" | "detail_outline" | "chapter_outline" | "body">("outline");
  const [candidateCount, setCandidateCount] = useState(3);
  const [chapter, setChapter] = useState(1);
  const [startChapter, setStartChapter] = useState(1);
  const [chapterCount, setChapterCount] = useState(1);
  const [sectionWords, setSectionWords] = useState(300);
  const [targetWords, setTargetWords] = useState(2500);
  const [targetPath, setTargetPath] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [instruction, setInstruction] = useState("");
  const [pendingCandidateId, setPendingCandidateId] = useState("");
  const result = controller.latestCardDrawResult;
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;
  return (
    <section className="xw-feature-page">
      <div className="xw-operation-form">
        <div className="xw-operation-grid">
          <label><span>生成类型</span><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="outline">大纲</option><option value="detail_outline">细纲</option><option value="chapter_outline">章纲</option><option value="body">正文</option></select></label>
          <label><span>抽卡数量</span><input type="number" min={2} max={4} value={candidateCount} onChange={(event) => setCandidateCount(Math.max(2, Math.min(4, Number(event.target.value) || 2)))} /></label>
          <label><span>章节</span><input type="number" min={1} value={chapter} onChange={(event) => setChapter(Number(event.target.value))} /></label>
          <label><span>目标字数</span><input type="number" min={300} max={20000} value={targetWords} onChange={(event) => setTargetWords(Number(event.target.value))} /></label>
          <label><span>章纲起始章</span><input type="number" min={1} value={startChapter} onChange={(event) => setStartChapter(Number(event.target.value))} /></label>
          <label><span>章纲数量</span><input type="number" min={1} max={300} value={chapterCount} onChange={(event) => setChapterCount(Number(event.target.value))} /></label>
          <label><span>每节字数</span><input type="number" min={100} max={2000} value={sectionWords} onChange={(event) => setSectionWords(Number(event.target.value))} /></label>
          <label><span>写入路径</span><input value={targetPath} onChange={(event) => setTargetPath(event.target.value)} placeholder="留空按类型写入默认目标" /></label>
          <ProjectFileSelect label="参考来源文件" value={sourcePath} onChange={setSourcePath} controller={controller} />
        </div>
        <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="写卡要求，例如更强爽点、更换因果、更偏情绪拉扯。当前打开文档会作为输入参考。" />
        <button
          className="xw-primary-button"
          onClick={() => {
            setPendingCandidateId("");
            void controller.generateCardDraw({ mode, candidate_count: candidateCount, chapter, start_chapter: startChapter, chapter_count: chapterCount, section_words: sectionWords, target_words: targetWords, target_path: targetPath, instruction, source_path: sourcePath || activeDocument?.path || "", text: activeDocument?.content || "" });
          }}
          disabled={controller.operationsBusy}
        >
          开始抽卡
        </button>
      </div>
      {result && (
        <div className="xw-candidate-list">
          {result.candidates.map((candidate) => {
            const awaitingConfirmation = pendingCandidateId === candidate.id;
            return (
            <article key={candidate.id} className={`xw-candidate-card ${result.selected_id === candidate.id || awaitingConfirmation ? "selected" : ""}`}>
              <div>
                <strong>{candidate.id}</strong>
                <span>{candidate.excerpt}</span>
                <small>{candidate.path} · {candidate.chars} 字</small>
              </div>
              <div className="xw-operation-actions">
                <button className="xw-secondary-button compact" onClick={() => void controller.openDocument(candidate.path)}>打开预览</button>
                {awaitingConfirmation ? (
                  <>
                    <button className="xw-secondary-button compact" onClick={() => setPendingCandidateId("")} disabled={controller.operationsBusy}>取消</button>
                    <button className="xw-primary-button compact" onClick={() => void controller.selectCardDraw(result.draw_id, { candidate_id: candidate.id, target_path: targetPath || result.target_path }).then(() => setPendingCandidateId(""))} disabled={controller.operationsBusy}>确认写入</button>
                  </>
                ) : <button className="xw-primary-button compact" onClick={() => setPendingCandidateId(candidate.id)} disabled={controller.operationsBusy}>选择此版本</button>}
              </div>
            </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
