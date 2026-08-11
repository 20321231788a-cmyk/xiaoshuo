import { lazy, Suspense, type ReactNode } from "react";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";
import type { ProductRoute, UserFeature } from "../../navigation.js";

import { HomeProductPage } from "./home/HomeProductPage.js";
import { EditorProductPage } from "./editor/EditorProductPage.js";

const AssistantProductPage = lazy(() => import("./assistant/AssistantProductPage.js").then((module) => ({ default: module.AssistantProductPage })));
const OutlineProductPage = lazy(() => import("./outline/OutlineProductPage.js").then((module) => ({ default: module.OutlineProductPage })));
const CluesProductPage = lazy(() => import("./clues/CluesProductPage.js").then((module) => ({ default: module.CluesProductPage })));
const SourcesProductPage = lazy(() => import("./sources/SourcesProductPage.js").then((module) => ({ default: module.SourcesProductPage })));
const StyleProductPage = lazy(() => import("./style/StyleProductPage.js").then((module) => ({ default: module.StyleProductPage })));
const StudioProductPage = lazy(() => import("./studio/StudioProductPage.js").then((module) => ({ default: module.StudioProductPage })));
const ReviewProductPage = lazy(() => import("./review/ReviewProductPage.js").then((module) => ({ default: module.ReviewProductPage })));
const MemoryProductPage = lazy(() => import("./memory/MemoryProductPage.js").then((module) => ({ default: module.MemoryProductPage })));
const DisassemblyProductPage = lazy(() => import("./disassembly/DisassemblyProductPage.js").then((module) => ({ default: module.DisassemblyProductPage })));
const BatchProductPage = lazy(() => import("./batch/BatchProductPage.js").then((module) => ({ default: module.BatchProductPage })));
const TransferProductPage = lazy(() => import("./transfer/TransferProductPage.js").then((module) => ({ default: module.TransferProductPage })));
const CoverProductPage = lazy(() => import("./cover/CoverProductPage.js").then((module) => ({ default: module.CoverProductPage })));
const SkillsProductPage = lazy(() => import("./tools/SkillsProductPage.js").then((module) => ({ default: module.SkillsProductPage })));
const TasksProductPage = lazy(() => import("./tasks/TasksProductPage.js").then((module) => ({ default: module.TasksProductPage })));
const SettingsFeaturePage = lazy(() => import("../settings/SettingsFeaturePage.js").then((module) => ({ default: module.SettingsFeaturePage })));

function deferredPage(page: ReactNode) {
  return <Suspense fallback={<div className="aw-feature-loading">正在加载页面...</div>}>{page}</Suspense>;
}

export type DisassemblyUiState = {
  selectedBookId: string;
  fusionBookIds: string[];
  onSelectBook: (bookId: string) => void;
  onToggleFusionBook: (bookId: string) => void;
};

export function ProductWorkspace({
  controller,
  route,
  disassemblyUi,
  onNavigate,
  onSelectFeature
}: {
  controller: WorkbenchController;
  route: ProductRoute;
  disassemblyUi: DisassemblyUiState;
  onNavigate: (route: ProductRoute) => void;
  onSelectFeature: (feature: UserFeature) => void;
}) {
  if (!controller.snapshot || !controller.configDraft) {
    return null;
  }

  switch (route.feature) {
    case "home":
      return <HomeProductPage controller={controller} onSelectFeature={onSelectFeature} />;
    case "editor":
      return <EditorProductPage controller={controller} onSelectFeature={onSelectFeature} />;
    case "conversations":
      return deferredPage(<AssistantProductPage controller={controller} onSelectFeature={onSelectFeature} />);
    case "outline":
      return deferredPage(<OutlineProductPage controller={controller} />);
    case "clues":
      return deferredPage(<CluesProductPage controller={controller} onSelectFeature={onSelectFeature} />);
    case "sources":
      return deferredPage(<SourcesProductPage controller={controller} />);
    case "style":
      return deferredPage(<StyleProductPage controller={controller} />);
    case "studio":
      return deferredPage(<StudioProductPage controller={controller} onSelectFeature={onSelectFeature} />);
    case "review":
      return deferredPage(<ReviewProductPage controller={controller} onSelectFeature={onSelectFeature} />);
    case "memory":
      return deferredPage(<MemoryProductPage controller={controller} onSelectFeature={onSelectFeature} />);
    case "crawl":
      return deferredPage(<DisassemblyProductPage controller={controller} disassemblyUi={disassemblyUi} />);
    case "batch":
      return deferredPage(<BatchProductPage controller={controller} />);
    case "transfer":
      return deferredPage(<TransferProductPage controller={controller} onSelectFeature={onSelectFeature} />);
    case "cover":
      return deferredPage(<CoverProductPage controller={controller} onSelectFeature={onSelectFeature} />);
    case "skills":
      return deferredPage(<SkillsProductPage controller={controller} route={route} onNavigate={onNavigate} />);
    case "tasks":
      return deferredPage(<TasksProductPage controller={controller} />);
    case "settings":
      return deferredPage(<SettingsFeaturePage controller={controller} section={route.section} onNavigate={onNavigate} />);
  }
}
