import type { WorkbenchController as CoreWorkbenchController } from "./useWorkbenchCoreController.js";

export function useConversationController(core: CoreWorkbenchController) {
  return {
    conversationDetail: core.conversationDetail,
    conversationBusy: core.conversationBusy,
    conversationMessage: core.conversationMessage,
    uploadingAttachment: core.uploadingAttachment,
    messageInput: core.messageInput,
    setMessageInput: core.setMessageInput,
    sendingMessage: core.sendingMessage,
    getConversationPlanRun: core.getConversationPlanRun,
    subscribeConversationPlanRun: core.subscribeConversationPlanRun,
    controlConversationPlanRun: core.controlConversationPlanRun,
    pendingReferenceResolution: core.pendingReferenceResolution,
    loadConversation: core.loadConversation,
    createConversation: core.createConversation,
    updateConversationTitle: core.updateConversationTitle,
    summarizeConversation: core.summarizeConversation,
    pinCurrentDocumentToConversation: core.pinCurrentDocumentToConversation,
    pinTextToConversation: core.pinTextToConversation,
    removePinnedConversationContext: core.removePinnedConversationContext,
    uploadConversationAttachment: core.uploadConversationAttachment,
    uploadWorkflowAttachment: core.uploadWorkflowAttachment,
    deleteConversationAttachment: core.deleteConversationAttachment,
    sendMessage: core.sendMessage,
    togglePendingReferenceCandidate: core.togglePendingReferenceCandidate,
    confirmPendingReferenceResolution: core.confirmPendingReferenceResolution,
    sendPendingReferenceResolutionWithoutCandidates: core.sendPendingReferenceResolutionWithoutCandidates,
    discardPendingReferenceResolution: core.discardPendingReferenceResolution,
    sendLedgerRecoveryPrompt: core.sendLedgerRecoveryPrompt,
    stopMessage: core.stopMessage
  };
}
