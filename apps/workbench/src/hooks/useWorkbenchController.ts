import type { WorkbenchRuntime } from "../lib/runtime.js";
import { useCloudProjectController } from "./controllers/useCloudProjectController.js";
import { useConfigController } from "./controllers/useConfigController.js";
import { useConversationController } from "./controllers/useConversationController.js";
import { useDocumentController } from "./controllers/useDocumentController.js";
import { useOperationsController } from "./controllers/useOperationsController.js";
import { useProjectController } from "./controllers/useProjectController.js";
import { useWorkbenchController as useWorkbenchCoreController } from "./controllers/useWorkbenchCoreController.js";

export type {
  DisassemblyBookSummary,
  OpenDocumentTab,
  PendingCloseRequest,
  PendingProjectSwitchRequest,
  PendingReloadRequest,
  PendingSaveConflictRequest,
  WorkbenchTab
} from "./controllers/useWorkbenchCoreController.js";

export function useWorkbenchController(runtime: WorkbenchRuntime) {
  const core = useWorkbenchCoreController(runtime);
  const project = useProjectController(core);
  const documents = useDocumentController(core);
  const conversations = useConversationController(core);
  const operations = useOperationsController(core);
  const config = useConfigController(core);
  const cloud = useCloudProjectController(core);

  return {
    ...project,
    ...documents,
    ...conversations,
    ...operations,
    ...config,
    ...cloud
  };
}

export type WorkbenchController = ReturnType<typeof useWorkbenchController>;
