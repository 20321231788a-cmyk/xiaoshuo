import type { WorkbenchController as CoreWorkbenchController } from "./useWorkbenchCoreController.js";

export function useProjectController(core: CoreWorkbenchController) {
  return {
    runtime: core.runtime,
    status: core.status,
    snapshot: core.snapshot,
    error: core.error,
    activeTab: core.activeTab,
    setActiveTab: core.setActiveTab,
    isRefreshing: core.isRefreshing,
    refreshAll: core.refreshAll,
    projectBusy: core.projectBusy,
    projectMessage: core.projectMessage,
    vectorSearchBusy: core.vectorSearchBusy,
    vectorSearchMessage: core.vectorSearchMessage,
    vectorSearchResults: core.vectorSearchResults,
    projectPathInput: core.projectPathInput,
    setProjectPathInput: core.setProjectPathInput,
    projectNameInput: core.projectNameInput,
    setProjectNameInput: core.setProjectNameInput,
    refreshProjectWorkspace: core.refreshProjectWorkspace,
    openProjectFromInput: core.openProjectFromInput,
    createProjectFromInput: core.createProjectFromInput,
    pickAndOpenProject: core.pickAndOpenProject,
    exportCurrentProject: core.exportCurrentProject,
    importProjectArchive: core.importProjectArchive,
    renameCurrentProject: core.renameCurrentProject,
    rebuildVectorIndex: core.rebuildVectorIndex,
    processPendingVectorFiles: core.processPendingVectorFiles,
    searchVectorIndex: core.searchVectorIndex,
    cancelProjectSwitch: core.cancelProjectSwitch,
    confirmProjectSwitch: core.confirmProjectSwitch,
    activeConversationSummary: core.activeConversationSummary
  };
}
