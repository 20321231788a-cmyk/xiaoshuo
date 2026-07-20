import { Command, Save, Search, User } from "lucide-react";
import type { TreeNode } from "@xiaoshuo/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DisassemblyBookSummary } from "./hooks/useWorkbenchController.js";
import { useWorkbenchController } from "./hooks/useWorkbenchController.js";
import { ProductWorkspace, type DisassemblyUiState } from "./features/product/ProductWorkspace.js";
import { CommandPalette, type SearchableDocument } from "./features/product/shared/CommandPalette.js";
import { AppShell } from "./layout/AppShell.js";
import { WorkbenchNavigation } from "./layout/WorkbenchNavigation.js";
import {
  defaultProductRoute,
  navigationLabel,
  parseProductRoute,
  productCommands,
  productRoutePath,
  type ProductRoute,
  type UserFeature
} from "./navigation.js";
import { readWorkbenchRuntime } from "./lib/runtime.js";

const runtime = readWorkbenchRuntime();
const APP_WINDOW_TITLE = "ArcWriter";

function currentProductRoute(): ProductRoute | null {
  const hashPath = window.location.hash.startsWith("#/") ? window.location.hash.slice(1) : "";
  return parseProductRoute(hashPath) || parseProductRoute(window.location.pathname);
}

function hasExplicitRouteLocation(): boolean {
  if (window.location.hash.startsWith("#/")) return true;
  return window.location.pathname !== "/" && !window.location.pathname.endsWith("/index.html");
}

function productLocation(route: ProductRoute): string {
  const basePath = window.location.protocol === "file:" ? window.location.pathname : "/";
  return `${basePath}${window.location.search}#${productRoutePath(route)}`;
}

function isReadyForFusion(book: DisassemblyBookSummary | null): boolean {
  return Boolean(book && !book.legacy && (book.paths.lore || book.paths.reverse_outline || book.paths.detail_outline));
}

function collectSearchableDocuments(nodes: TreeNode[], result: SearchableDocument[] = []): SearchableDocument[] {
  for (const node of nodes) {
    if (node.kind === "file") result.push({ path: node.path, title: node.name.replace(/\.(txt|md)$/i, "") });
    if (node.children?.length) collectSearchableDocuments(node.children, result);
  }
  return result;
}

export function App() {
  const controller = useWorkbenchController(runtime);
  const [route, setRoute] = useState<ProductRoute>(() => currentProductRoute() || { feature: "home" });
  const [commandOpen, setCommandOpen] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => window.localStorage.getItem("arcwriter.navigation.collapsed") === "1");
  const [selectedDisassemblyBookId, setSelectedDisassemblyBookId] = useState("");
  const [fusionBookIds, setFusionBookIds] = useState<string[]>([]);
  const initialRouteResolved = useRef(false);
  const feature = route.feature;

  const searchableDocuments = useMemo(
    () => collectSearchableDocuments(controller.snapshot?.projectChrome.tree || []),
    [controller.snapshot?.projectChrome.tree]
  );

  useEffect(() => {
    document.title = APP_WINDOW_TITLE;
  }, []);

  useEffect(() => {
    window.localStorage.setItem("arcwriter.navigation.collapsed", navigationCollapsed ? "1" : "0");
  }, [navigationCollapsed]);

  useEffect(() => {
    function protectUnsavedDocuments(event: BeforeUnloadEvent) {
      if (!controller.openDocuments.some((document) => document.dirty)) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectUnsavedDocuments);
    return () => window.removeEventListener("beforeunload", protectUnsavedDocuments);
  }, [controller.openDocuments]);

  useEffect(() => {
    const unsubscribeRefresh = window.xiaoshuoDesktop?.onRequestRefresh?.(() => {
      void controller.refreshProjectWorkspace();
    });
    const unsubscribeSave = window.xiaoshuoDesktop?.onRequestSave?.(() => void controller.saveAllDocuments());
    const unsubscribeFind = window.xiaoshuoDesktop?.onRequestFind?.(() => navigate(defaultProductRoute("editor")));
    const unsubscribeReplace = window.xiaoshuoDesktop?.onRequestReplace?.(() => navigate(defaultProductRoute("editor")));
    return () => {
      unsubscribeRefresh?.();
      unsubscribeSave?.();
      unsubscribeFind?.();
      unsubscribeReplace?.();
    };
  }, [controller]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void controller.saveAllDocuments();
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [controller]);

  useEffect(() => {
    function handlePopState() {
      const next = currentProductRoute() || { feature: "home" };
      setRoute(next);
      syncControllerTab(next.feature);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  });

  useEffect(() => {
    if (controller.snapshot?.currentProject.path) void controller.refreshDisassemblyLibrary();
  }, [controller.snapshot?.currentProject.path]);

  useEffect(() => {
    if (initialRouteResolved.current || controller.status !== "ready") return;
    initialRouteResolved.current = true;
    const explicitRoute = currentProductRoute();
    if (hasExplicitRouteLocation()) {
      const nextRoute = explicitRoute || { feature: "home" } as const;
      setRoute(nextRoute);
      syncControllerTab(nextRoute.feature);
      if (!explicitRoute) navigate(nextRoute, true);
      return;
    }
    navigate(defaultProductRoute(controller.activeDocumentPath ? "editor" : "home"), true);
  }, [controller.activeDocumentPath, controller.status]);

  useEffect(() => {
    const books = controller.disassemblyBooks.filter((book) => !book.legacy);
    const ids = new Set(books.map((book) => book.id));
    const fusionIds = new Set(books.filter(isReadyForFusion).map((book) => book.id));
    setSelectedDisassemblyBookId((current) => current && ids.has(current) ? current : books[0]?.id || "");
    setFusionBookIds((current) => current.filter((id) => fusionIds.has(id)));
  }, [controller.disassemblyBooks]);

  function syncControllerTab(next: UserFeature) {
    if (next === "home") controller.setActiveTab("project");
    else if (next === "editor") controller.setActiveTab("editor");
    else if (next === "conversations") controller.setActiveTab("conversations");
    else if (next === "settings") controller.setActiveTab("config");
    else if (next === "crawl" || next === "batch" || next === "transfer" || next === "skills") controller.setActiveTab("operations");
    else controller.setActiveTab("overview");
  }

  function navigate(next: ProductRoute, replace = false) {
    const location = productLocation(next);
    const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (currentLocation !== location) window.history[replace ? "replaceState" : "pushState"]({}, "", location);
    setRoute(next);
    syncControllerTab(next.feature);
  }

  function selectFeature(next: UserFeature) {
    navigate(defaultProductRoute(next));
  }

  const disassemblyUi: DisassemblyUiState = {
    selectedBookId: selectedDisassemblyBookId,
    fusionBookIds,
    onSelectBook: setSelectedDisassemblyBookId,
    onToggleFusionBook: (bookId) => setFusionBookIds((current) => current.includes(bookId) ? current.filter((id) => id !== bookId) : [...current, bookId])
  };

  return (
    <AppShell
      navigationCollapsed={navigationCollapsed}
      navigation={<WorkbenchNavigation feature={feature} collapsed={navigationCollapsed} projectName={controller.snapshot?.currentProject.name || ""} projectPath={controller.snapshot?.currentProject.path || ""} onToggleCollapsed={() => setNavigationCollapsed((value) => !value)} onSelect={selectFeature} onOpenProject={() => controller.pickAndOpenProject("open")} />}
      topbar={<WorkbenchTopbar feature={feature} projectName={controller.snapshot?.currentProject.name || ""} onSelectFeature={selectFeature} onOpenCommand={() => setCommandOpen(true)} onSave={() => void controller.saveAllDocuments()} saving={controller.documentBusy} />}
      center={<>{controller.status === "loading" && <LoadingState />}{controller.status === "error" && <ErrorState message={controller.error} />}{controller.status === "ready" && controller.snapshot && controller.configDraft && <ProductWorkspace controller={controller} route={route} disassemblyUi={disassemblyUi} onNavigate={navigate} onSelectFeature={selectFeature} />}</>}
      dialog={<CommandPalette open={commandOpen} commands={productCommands} documents={searchableDocuments} onClose={() => setCommandOpen(false)} onNavigate={navigate} onOpenDocument={(path) => { navigate({ feature: "editor" }); void controller.openDocument(path); }} />}
    />
  );
}

function WorkbenchTopbar({ feature, projectName, onSelectFeature, onOpenCommand, onSave, saving }: { feature: UserFeature; projectName: string; onSelectFeature: (feature: UserFeature) => void; onOpenCommand: () => void; onSave: () => void; saving: boolean }) {
  return (
    <header className="topbar">
      <div className="title-stack">
        <span>{projectName || "本地小说项目"}</span>
        <strong>{navigationLabel(feature)}</strong>
      </div>
      <div className="top-actions">
        <button className="search-trigger" type="button" onClick={onOpenCommand}><Search size={15} /><span>搜索项目</span><kbd>Ctrl K</kbd></button>
        <button className="icon-button" type="button" title="命令面板" aria-label="命令面板" onClick={onOpenCommand}><Command size={16} /></button>
        <button className="task-trigger" type="button" onClick={() => onSelectFeature("tasks")}><span className="pulse-dot" />后台任务</button>
        <button className="avatar-button" type="button" aria-label="打开设置" onClick={() => onSelectFeature("settings")}><User size={16} /></button>
        <button className="button primary top-save-button" type="button" onClick={onSave} disabled={saving}><Save size={15} />{saving ? "保存中" : "保存全部"}</button>
      </div>
    </header>
  );
}

function LoadingState() {
  return <section className="aw-runtime-state" aria-live="polite"><div /><div /><div /></section>;
}

function ErrorState({ message }: { message: string }) {
  return <section className="aw-runtime-error" role="alert"><h1>暂时无法打开工作台</h1><p>{message || "本地服务还没有准备好。"}</p><button type="button" className="aw-primary-button" onClick={() => window.location.reload()}>重新连接</button></section>;
}
