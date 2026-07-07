import { lazy, Suspense, type ReactNode } from "react";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";
import { ConversationsView } from "../../views/ConversationsView.js";
import { EditorView } from "../../views/EditorView.js";
import { ProjectView } from "../../views/ProjectView.js";

const TerminalView = lazy(() => import("../../views/TerminalView.js").then((module) => ({ default: module.TerminalView })));

export type LegacyWorkbenchTab = "project" | "editor" | "conversations" | "terminal";

const legacyTabs: Array<{ key: LegacyWorkbenchTab; label: string }> = [
  { key: "project", label: "项目" },
  { key: "editor", label: "编辑" },
  { key: "conversations", label: "会话" },
  { key: "terminal", label: "终端" }
];

export function LegacyWorkbenchView({
  controller,
  activeTab,
  onActiveTabChange,
  children
}: {
  controller: WorkbenchController;
  activeTab: LegacyWorkbenchTab | null;
  onActiveTabChange: (tab: LegacyWorkbenchTab) => void;
  children: ReactNode;
}) {
  return (
    <div className="xw-embedded-view">
      <nav className="xw-page-tabs xw-legacy-nav" aria-label="Workbench sections">
        <span>工作区</span>
        {legacyTabs.map((tab) => (
          <button
            key={tab.key}
            className={activeTab === tab.key ? "active" : ""}
            type="button"
            onClick={() => onActiveTabChange(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {activeTab ? renderLegacyTab(controller, activeTab, onActiveTabChange) : children}
    </div>
  );
}

function renderLegacyTab(
  controller: WorkbenchController,
  tab: LegacyWorkbenchTab,
  onActiveTabChange: (tab: LegacyWorkbenchTab) => void
) {
  if (!controller.snapshot || !controller.configDraft) {
    return <LegacyLoadingState />;
  }

  const activeDocument = controller.openDocuments.find((item) => item.path === controller.activeDocumentPath) || null;
  const hasUnsavedSwitchState = () =>
    controller.openDocuments.some((item) => item.dirty) ||
    controller.messageInput.trim().length > 0 ||
    Boolean(controller.pendingGeneratedSave);
  const openDocumentInEditor = (path: string) => {
    void controller.openDocument(path).then((opened) => {
      if (opened) {
        onActiveTabChange("editor");
      }
    });
  };

  if (tab === "project") {
    return (
      <ProjectView
        snapshot={controller.snapshot}
        busy={controller.projectBusy}
        message={controller.projectMessage}
        vectorSearchBusy={controller.vectorSearchBusy}
        vectorSearchMessage={controller.vectorSearchMessage}
        vectorSearchResults={controller.vectorSearchResults}
        pendingProjectSwitchRequest={controller.pendingProjectSwitchRequest}
        projectPathInput={controller.projectPathInput}
        projectNameInput={controller.projectNameInput}
        onProjectPathChange={controller.setProjectPathInput}
        onProjectNameChange={controller.setProjectNameInput}
        onOpenProject={() => {
          const shouldOpenEditor = !hasUnsavedSwitchState();
          if (shouldOpenEditor) {
            onActiveTabChange("editor");
          }
          void controller.openProjectFromInput();
        }}
        onCreateProject={() => {
          const shouldOpenEditor = !hasUnsavedSwitchState();
          if (shouldOpenEditor) {
            onActiveTabChange("editor");
          }
          void controller.createProjectFromInput();
        }}
        onPickOpenProject={() => void controller.pickAndOpenProject("open")}
        onPickCreateProject={() => void controller.pickAndOpenProject("create")}
        onOpenProjectPath={(path) => void controller.openProjectFromInput(path)}
        onRenameProject={() => void controller.renameCurrentProject()}
        onRefreshProject={() => void controller.refreshProjectWorkspace()}
        onCancelProjectSwitch={controller.cancelProjectSwitch}
        onConfirmProjectSwitch={() => void controller.confirmProjectSwitch()}
        onRebuildVectorIndex={() => void controller.rebuildVectorIndex()}
        onProcessPendingVectorFiles={() => void controller.processPendingVectorFiles()}
        onSearchVectorIndex={(query) => void controller.searchVectorIndex(query)}
        onOpenDocument={openDocumentInEditor}
      />
    );
  }

  if (tab === "editor") {
    return (
      <EditorView
        snapshot={controller.snapshot}
        openDocuments={controller.openDocuments}
        activeDocumentPath={controller.activeDocumentPath}
        busy={controller.documentBusy}
        message={controller.documentMessage}
        pendingCloseRequest={controller.pendingCloseRequest}
        pendingReloadRequest={controller.pendingReloadRequest}
        pendingSaveConflictRequest={controller.pendingSaveConflictRequest}
        onOpenDocument={openDocumentInEditor}
        onReloadDocument={() => void controller.reopenDocumentFromDisk()}
        onActivateDocument={controller.activateDocument}
        onCloseDocument={controller.closeDocument}
        onCancelCloseDocument={controller.cancelCloseDocument}
        onConfirmCloseDocument={controller.confirmCloseDocument}
        onCancelReloadDocument={controller.cancelReloadDocument}
        onConfirmReloadDocument={() => void controller.confirmReloadDocument()}
        onCancelSaveConflict={controller.cancelSaveConflict}
        onConfirmSaveOverwrite={() => void controller.confirmSaveOverwrite()}
        onRollbackTimelineEntry={(entryId, confirmDelete) => void controller.rollbackTimelineEntry(entryId, confirmDelete)}
        onChangeDocument={controller.updateActiveDocument}
        onSaveDocument={() => void controller.saveActiveDocument()}
      />
    );
  }

  if (tab === "conversations") {
    return (
      <ConversationsView
        conversations={controller.snapshot.conversations}
        activeConversationId={controller.conversationDetail?.id || controller.activeConversationSummary?.id || ""}
        conversationDetail={controller.conversationDetail}
        busy={controller.conversationBusy}
        message={controller.conversationMessage}
        messageInput={controller.messageInput}
        sendingMessage={controller.sendingMessage}
        uploadingAttachment={controller.uploadingAttachment}
        activeDocumentPath={controller.activeDocumentPath}
        activeDocument={activeDocument}
        pendingGeneratedSave={controller.pendingGeneratedSave}
        pendingReferenceResolution={controller.pendingReferenceResolution}
        onRefresh={() => void controller.refreshAll()}
        onCreate={() => void controller.createConversation()}
        onSelect={(conversationId) => void controller.loadConversation(conversationId)}
        onUpdateTitle={(title) => void controller.updateConversationTitle(title)}
        onSummarizeConversation={(useModel) => void controller.summarizeConversation(useModel)}
        onPinCurrentDocument={() => void controller.pinCurrentDocumentToConversation()}
        onPinText={(content) => void controller.pinTextToConversation(content)}
        onRemovePinnedContext={(itemId) => void controller.removePinnedConversationContext(itemId)}
        onMessageInputChange={controller.setMessageInput}
        onUploadAttachment={controller.uploadConversationAttachment}
        onDeleteAttachment={(attachmentId) => void controller.deleteConversationAttachment(attachmentId)}
        onSendMessage={() => void controller.sendMessage()}
        onToggleReferenceCandidate={controller.togglePendingReferenceCandidate}
        onConfirmReferenceResolution={() => void controller.confirmPendingReferenceResolution()}
        onSendWithoutReferenceCandidates={() => void controller.sendPendingReferenceResolutionWithoutCandidates()}
        onDiscardReferenceResolution={controller.discardPendingReferenceResolution}
        onStopMessage={controller.stopMessage}
        onSavePendingGenerated={(mode) => void controller.savePendingGenerated(mode)}
        onSavePendingGeneratedAsDraft={() => void controller.savePendingGeneratedAsDraft()}
        onCopyPendingGeneratedContent={() => void controller.copyPendingGeneratedContent()}
        onDiscardPendingGenerated={controller.discardPendingGenerated}
      />
    );
  }

  return (
    <Suspense fallback={<LegacyLoadingState />}>
      <TerminalView runtime={controller.runtime} snapshot={controller.snapshot} />
    </Suspense>
  );
}

function LegacyLoadingState() {
  return (
    <section className="state-panel">
      <div className="loading-line" />
      <div className="loading-line short" />
      <div className="loading-grid">
        <div className="loading-card" />
        <div className="loading-card" />
      </div>
    </section>
  );
}
