import type { WorkbenchController as CoreWorkbenchController } from "./useWorkbenchCoreController.js";

export function useCloudProjectController(core: CoreWorkbenchController) {
  return {
    cloudProjectSlots: core.cloudProjectSlots,
    cloudProjectBusy: core.cloudProjectBusy,
    cloudProjectMessage: core.cloudProjectMessage,
    refreshCloudProjects: core.refreshCloudProjects,
    uploadCurrentProjectToCloud: core.uploadCurrentProjectToCloud,
    syncCloudProjectToCurrent: core.syncCloudProjectToCurrent,
    deleteCloudProject: core.deleteCloudProject
  };
}
