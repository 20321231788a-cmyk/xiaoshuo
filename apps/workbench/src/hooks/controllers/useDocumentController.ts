import type { WorkbenchController as CoreWorkbenchController } from "./useWorkbenchCoreController.js";

export function useDocumentController(core: CoreWorkbenchController) {
  return {
    openDocuments: core.openDocuments,
    activeDocumentPath: core.activeDocumentPath,
    documentBusy: core.documentBusy,
    documentMessage: core.documentMessage,
    pendingCloseRequest: core.pendingCloseRequest,
    pendingReloadRequest: core.pendingReloadRequest,
    pendingSaveConflictRequest: core.pendingSaveConflictRequest,
    pendingProjectSwitchRequest: core.pendingProjectSwitchRequest,
    openDocument: core.openDocument,
    reopenDocumentFromDisk: core.reopenDocumentFromDisk,
    activateDocument: core.activateDocument,
    closeDocument: core.closeDocument,
    cancelCloseDocument: core.cancelCloseDocument,
    confirmCloseDocument: core.confirmCloseDocument,
    cancelReloadDocument: core.cancelReloadDocument,
    confirmReloadDocument: core.confirmReloadDocument,
    cancelSaveConflict: core.cancelSaveConflict,
    confirmSaveOverwrite: core.confirmSaveOverwrite,
    rollbackTimelineEntry: core.rollbackTimelineEntry,
    clearRevisionLog: core.clearRevisionLog,
    addLedgerItem: core.addLedgerItem,
    toggleLedgerItem: core.toggleLedgerItem,
    updateActiveDocument: core.updateActiveDocument,
    saveActiveDocument: core.saveActiveDocument,
    createProjectTreeFile: core.createProjectTreeFile,
    deleteProjectTreeFile: core.deleteProjectTreeFile
  };
}
