import { createApiClient } from "@xiaoshuo/api-client";
import {
  projectLibraryBundleSchema,
  type CoverGenerationMode,
  type CoverRecord,
  type ProjectLibraryBundle,
  type ProjectLibraryRecord
} from "@xiaoshuo/shared";
import { FolderOpen, ImagePlus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import type { UserFeature } from "../../../navigation.js";

const FONT_STYLES = ["行草", "行楷", "隶书", "宋体", "黑体", "篆书", "手写体"];
const MAX_REFERENCE_SIZE = 10 * 1024 * 1024;
const REFERENCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function CoverProductPage({
  controller,
  onSelectFeature
}: {
  controller: WorkbenchController;
  onSelectFeature: (feature: UserFeature) => void;
}) {
  const api = useMemo(() => createApiClient({ baseUrl: controller.runtime.apiBase, fetchFn: controller.runtime.fetchFn }), [controller.runtime.apiBase, controller.runtime.fetchFn]);
  const projectName = controller.snapshot?.currentProject.name || "";
  const projectPath = controller.snapshot?.currentProject.path || "";
  const [bookTitle, setBookTitle] = useState(projectName);
  const [authorName, setAuthorName] = useState("");
  const [fontStyle, setFontStyle] = useState("行草");
  const [genreStyle, setGenreStyle] = useState("");
  const [genreLibrary, setGenreLibrary] = useState<ProjectLibraryBundle | null>(null);
  const [mode, setMode] = useState<CoverGenerationMode>("text_to_image");
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState("");
  const [records, setRecords] = useState<CoverRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const genreTouched = useRef(false);
  const referenceInput = useRef<HTMLInputElement | null>(null);
  const generationController = useRef<AbortController | null>(null);

  const selectedRecord = records.find((record) => record.id === selectedId) || records[0] || null;
  const savedWebsiteProfile = controller.snapshot?.config.website_profile;
  const selectedImageModelId = controller.websiteAiDashboard?.selected_image_model || savedWebsiteProfile?.image_model || "";
  const selectedImageModel = controller.websiteAiDashboard?.image_models.find((model) => model.id === selectedImageModelId) || null;
  const websiteLoggedIn = controller.websiteAiDashboard?.logged_in ?? Boolean(savedWebsiteProfile?.license_account_key || savedWebsiteProfile?.api_key);
  const imageEditUnavailable = mode === "image_to_image" && selectedImageModel?.capabilities.image_edit === false;
  const canGenerate = Boolean(projectPath && bookTitle.trim() && authorName.trim() && fontStyle.trim() && genreStyle.trim() && websiteLoggedIn && selectedImageModelId && !imageEditUnavailable && !generating && (mode !== "image_to_image" || referenceFile));

  const loadWorkspace = useCallback(async () => {
    if (!projectPath) {
      setRecords([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const [historyResult, genreResult] = await Promise.allSettled([
      api.getCovers(),
      requestGenreLibrary(controller)
    ]);
    if (historyResult.status === "fulfilled") {
      setRecords(historyResult.value.records);
      setSelectedId((current) => historyResult.value.records.some((record) => record.id === current) ? current : historyResult.value.records[0]?.id || "");
    } else {
      setError(describeError(historyResult.reason, "封面历史读取失败。"));
    }
    if (genreResult.status === "fulfilled") {
      setGenreLibrary(genreResult.value);
      const defaultProfile = activeGenreProfiles(genreResult.value)[0];
      if (!genreTouched.current) setGenreStyle(defaultProfile?.name || "");
    } else {
      setGenreLibrary(null);
      if (!genreTouched.current) setGenreStyle("");
    }
    setLoading(false);
  }, [api, controller, projectPath]);

  useEffect(() => {
    genreTouched.current = false;
    setBookTitle(projectName);
    setAuthorName("");
    setFontStyle("行草");
    setGenreStyle("");
    setMode("text_to_image");
    clearReference();
    void loadWorkspace();
    void controller.refreshWebsiteAiDashboard({ silent: true });
    return () => generationController.current?.abort();
  }, [projectPath]);

  useEffect(() => {
    if (!referenceFile) {
      setReferencePreview("");
      return;
    }
    const url = URL.createObjectURL(referenceFile);
    setReferencePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [referenceFile]);

  async function generateCover() {
    if (!canGenerate) return;
    setGenerating(true);
    setError("");
    setMessage("正在生成封面，完成后会自动保存到当前项目。");
    const abort = new AbortController();
    generationController.current = abort;
    try {
      const profile = activeGenreProfiles(genreLibrary).find((item) => item.name === genreStyle.trim()) || null;
      const result = await api.generateCover({
        mode,
        book_title: bookTitle,
        author_name: authorName,
        font_style: fontStyle,
        genre_style: genreStyle,
        genre_description: profile?.kind === "genre_profile" ? profile.description || profile.summary : "",
        genre_rules: genreRules(genreLibrary),
        reference_image: mode === "image_to_image" && referenceFile ? {
          filename: referenceFile.name,
          media_type: referenceFile.type as "image/png" | "image/jpeg" | "image/webp",
          data_base64: arrayBufferToBase64(await referenceFile.arrayBuffer())
        } : undefined
      }, abort.signal);
      setRecords((current) => [result, ...current.filter((record) => record.id !== result.id)]);
      setSelectedId(result.id);
      setMessage("封面已保存，请核对书名和作者署名。");
    } catch (nextError) {
      if (abort.signal.aborted) setMessage("封面生成已取消。");
      else setError(describeError(nextError, "封面生成失败，请重试。"));
    } finally {
      generationController.current = null;
      setGenerating(false);
    }
  }

  function selectReference(file: File | undefined) {
    if (!file) return;
    if (!REFERENCE_TYPES.has(file.type)) {
      setError("参考图仅支持 PNG、JPG 和 WebP。");
      return;
    }
    if (file.size > MAX_REFERENCE_SIZE) {
      setError("参考图不能超过 10 MB。");
      return;
    }
    setError("");
    setReferenceFile(file);
  }

  function clearReference() {
    setReferenceFile(null);
    if (referenceInput.current) referenceInput.current.value = "";
  }

  async function removeCover(record: CoverRecord) {
    if (!window.confirm(`确定删除《${record.book_title}》的这个封面版本吗？文件会移入项目回收站。`)) return;
    try {
      await api.deleteCover(record.id);
      const next = records.filter((item) => item.id !== record.id);
      setRecords(next);
      setSelectedId(next[0]?.id || "");
      setMessage("封面版本已移入项目回收站。");
    } catch (nextError) {
      setError(describeError(nextError, "封面删除失败。"));
    }
  }

  async function openCoverFolder() {
    setError("");
    try {
      await api.openCoverFolder();
    } catch (nextError) {
      setError(describeError(nextError, "无法打开封面文件夹。"));
    }
  }

  return (
    <section className="xw-feature-page cover-page">
      <header className="cover-page-header">
        <div>
          <h1>封面生成</h1>
          <span>{selectedImageModelId ? `网站模型：${selectedImageModel?.name || selectedImageModelId}` : "尚未配置网站生图模型"}</span>
        </div>
        <button type="button" className="xw-secondary-button compact" onClick={() => void openCoverFolder()} disabled={!projectPath}>
          <FolderOpen size={15} />打开封面文件夹
        </button>
      </header>

      <div className="cover-workspace">
        <aside className="cover-controls" aria-label="封面参数">
          <div className="cover-mode-control xw-segmented-control" role="tablist" aria-label="生图模式">
            <button type="button" role="tab" aria-selected={mode === "text_to_image"} className={mode === "text_to_image" ? "active" : ""} disabled={generating} onClick={() => setMode("text_to_image")}>文生图</button>
            <button type="button" role="tab" aria-selected={mode === "image_to_image"} className={mode === "image_to_image" ? "active" : ""} disabled={generating} onClick={() => setMode("image_to_image")}>图生图</button>
          </div>

          <label><span>书名</span><input maxLength={80} value={bookTitle} disabled={generating} onChange={(event) => setBookTitle(event.target.value)} /></label>
          <label><span>作者名</span><input maxLength={40} value={authorName} disabled={generating} placeholder="笔名" onChange={(event) => setAuthorName(event.target.value)} /></label>
          <label><span>字体风格</span><input maxLength={80} list="cover-font-styles" value={fontStyle} disabled={generating} onChange={(event) => setFontStyle(event.target.value)} /></label>
          <datalist id="cover-font-styles">{FONT_STYLES.map((font) => <option key={font} value={font} />)}</datalist>
          <label>
            <span>题材风格</span>
            <input maxLength={80} list="cover-genre-styles" value={genreStyle} disabled={generating} placeholder="从题材库同步或手动填写" onChange={(event) => { genreTouched.current = true; setGenreStyle(event.target.value); }} />
          </label>
          <datalist id="cover-genre-styles">{activeGenreProfiles(genreLibrary).map((profile) => <option key={profile.id} value={profile.name} />)}</datalist>
          {!activeGenreProfiles(genreLibrary).length && <button type="button" className="cover-inline-link" onClick={() => onSelectFeature("style")}>前往风格与题材</button>}

          {mode === "image_to_image" && (
            <div className="cover-reference">
              <input ref={referenceInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => selectReference(event.target.files?.[0])} />
              {referencePreview ? (
                <div className="cover-reference-preview">
                  <img src={referencePreview} alt="参考图预览" />
                  <span>
                    <button type="button" className="icon-button" title="更换参考图" aria-label="更换参考图" disabled={generating} onClick={() => referenceInput.current?.click()}><Upload size={15} /></button>
                    <button type="button" className="icon-button" title="移除参考图" aria-label="移除参考图" disabled={generating} onClick={clearReference}><X size={15} /></button>
                  </span>
                </div>
              ) : (
                <button type="button" className="cover-reference-picker" disabled={generating} onClick={() => referenceInput.current?.click()}><Upload size={17} />选择参考图</button>
              )}
            </div>
          )}

          {!websiteLoggedIn || !selectedImageModelId ? (
            <div className="cover-capability-state" role="status">
              <span>封面生成需要网站账号和默认生图模型。</span>
              <button type="button" onClick={() => onSelectFeature("settings")}>前往 AI 配置</button>
            </div>
          ) : imageEditUnavailable ? (
            <div className="cover-capability-state" role="status"><span>当前模型不支持图生图。</span><button type="button" onClick={() => onSelectFeature("settings")}>更换模型</button></div>
          ) : null}

          <div className="cover-generate-actions">
            <button type="button" className="xw-primary-button" disabled={!canGenerate} onClick={() => void generateCover()}>
              {generating ? <RefreshCw size={16} className="spin" /> : <ImagePlus size={16} />}{generating ? "生成中" : records.length ? "再生成一张" : "生成封面"}
            </button>
            {generating && <button type="button" className="xw-secondary-button" onClick={() => generationController.current?.abort()}>取消</button>}
          </div>
          {(message || error) && <p className={error ? "cover-message error" : "cover-message"} role={error ? "alert" : "status"}>{error || message}</p>}
        </aside>

        <main className="cover-preview-pane">
          {loading ? <div className="cover-preview-skeleton" aria-label="正在读取封面" /> : selectedRecord ? (
            <>
              <CoverImage api={api} record={selectedRecord} className="cover-main-image" />
              <div className="cover-preview-actions">
                <button type="button" className="xw-secondary-button compact" onClick={() => void generateCover()} disabled={!canGenerate}>文字有误，重新生成</button>
                <button type="button" className="icon-button" title="删除当前版本" aria-label="删除当前封面版本" disabled={generating} onClick={() => void removeCover(selectedRecord)}><Trash2 size={16} /></button>
              </div>
            </>
          ) : (
            <div className="cover-empty-preview"><ImagePlus size={28} /><strong>还没有封面</strong><span>填写左侧信息后生成第一张封面。</span></div>
          )}
        </main>

        <aside className="cover-history" aria-label="封面历史">
          <div className="cover-history-head"><strong>历史版本</strong><span>{records.length}</span></div>
          <div className="cover-history-list">
            {records.map((record) => (
              <button type="button" key={record.id} className={record.id === selectedRecord?.id ? "active" : ""} onClick={() => setSelectedId(record.id)}>
                <CoverImage api={api} record={record} className="cover-history-image" />
                <span><strong>{record.book_title}</strong><small>{record.mode === "image_to_image" ? "图生图" : "文生图"} · {formatTime(record.created_at)}</small></span>
              </button>
            ))}
            {!loading && !records.length && <p>生成后的封面版本会保留在这里。</p>}
          </div>
        </aside>
      </div>
    </section>
  );
}

type CoverApi = ReturnType<typeof createApiClient>;

function CoverImage({ api, record, className }: { api: CoverApi; record: CoverRecord; className: string }) {
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setFailed(false);
    void api.getCoverImage(record.id).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch(() => active && setFailed(true));
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, record.id]);
  if (failed) return <span className={`${className} cover-image-failed`}>无法读取</span>;
  if (!source) return <span className={`${className} cover-image-loading`} />;
  return <img className={className} src={source} alt={`《${record.book_title}》封面`} />;
}

async function requestGenreLibrary(controller: WorkbenchController): Promise<ProjectLibraryBundle> {
  const fetchFn = controller.runtime.fetchFn || fetch;
  const response = await fetchFn(new URL("/api/project-libraries/genre", controller.runtime.apiBase));
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(String(payload.detail || "题材库读取失败"));
  return projectLibraryBundleSchema.parse(payload);
}

function activeGenreProfiles(bundle: ProjectLibraryBundle | null) {
  return (bundle?.records || [])
    .filter((record): record is Extract<ProjectLibraryRecord, { kind: "genre_profile" }> => record.kind === "genre_profile" && record.status === "active" && record.active)
    .sort((left, right) => left.order - right.order);
}

function genreRules(bundle: ProjectLibraryBundle | null): string[] {
  return (bundle?.records || [])
    .filter((record): record is Extract<ProjectLibraryRecord, { kind: "genre_rule" }> => record.kind === "genre_rule" && record.status === "active" && record.enabled)
    .sort((left, right) => left.order - right.order)
    .slice(0, 12)
    .map((record) => record.instruction)
    .filter(Boolean);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
