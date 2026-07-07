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
    sendLedgerRecoveryPrompt: core.sendLedgerRecoveryPrompt,
    stopMessage: core.stopMessage
  };
}
