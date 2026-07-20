import { ArrowUp, FileText, Paperclip, Plus, ShieldCheck, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { AssistantModelControls } from "./AssistantModelControls.js";
import { formatAssistantAttachmentSize, shouldSubmitAssistantMessage } from "./assistantComposerUtils.js";

const MIN_TEXTAREA_HEIGHT = 52;
const MAX_TEXTAREA_HEIGHT = 160;

export function AssistantComposer({ controller }: { controller: WorkbenchController }) {
  const [contextOpen, setContextOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const contextRootRef = useRef<HTMLDivElement | null>(null);
  const contextTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detail = controller.conversationDetail;
  const pinnedContext = detail?.pinned_context || [];
  const attachments = detail?.attachments || [];
  const contextCount = pinnedContext.length + attachments.length;
  const activeDocument = controller.openDocuments.find((item) => item.path === controller.activeDocumentPath) || null;
  const actionBusy = controller.conversationBusy || controller.conversationModelPreferenceBusy;
  const sendLocked = actionBusy || controller.uploadingAttachment;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const height = Math.min(MAX_TEXTAREA_HEIGHT, Math.max(MIN_TEXTAREA_HEIGHT, textarea.scrollHeight));
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [controller.messageInput]);

  useEffect(() => {
    if (!contextOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!contextRootRef.current?.contains(event.target as Node)) setContextOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextOpen(false);
      window.requestAnimationFrame(() => contextTriggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextOpen]);

  function send() {
    if (!controller.messageInput.trim() || controller.sendingMessage || sendLocked) return;
    void controller.sendMessage();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitAssistantMessage({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
      value: controller.messageInput,
      locked: controller.sendingMessage || sendLocked
    })) return;
    event.preventDefault();
    send();
  }

  return (
    <div className="assistant-composer-wrap">
      <div className="assistant-composer">
        <textarea
          ref={textareaRef}
          aria-label="消息内容"
          value={controller.messageInput}
          onChange={(event) => controller.setMessageInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="继续提问，或描述你想要的修改……"
        />

        {controller.conversationMessage && (
          <p className="assistant-composer-status" role="status" title={controller.conversationMessage}>
            {controller.conversationMessage}
          </p>
        )}

        <div className="assistant-composer-toolbar">
          <div className="assistant-composer-tools">
            <button
              className="assistant-composer-icon"
              type="button"
              title="添加资料"
              aria-label="添加资料"
              disabled={controller.uploadingAttachment || controller.sendingMessage}
              onClick={() => attachmentInputRef.current?.click()}
            >
              <Plus size={17} />
            </button>
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void controller.uploadConversationAttachment(event.target.files);
                event.currentTarget.value = "";
              }}
            />

            <div className="assistant-context-control" ref={contextRootRef}>
              <button
                ref={contextTriggerRef}
                className="assistant-context-trigger"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={contextOpen}
                onClick={() => setContextOpen((value) => !value)}
              >
                <ShieldCheck size={15} />
                <span>上下文 {contextCount} 项</span>
              </button>

              {contextOpen && (
                <div className="assistant-context-popover" role="dialog" aria-label="本次上下文">
                  <div className="assistant-context-popover-head">
                    <div>
                      <strong>本次上下文</strong>
                      <span>AI 只读取这里列出的资料</span>
                    </div>
                    <button
                      type="button"
                      disabled={!activeDocument || actionBusy}
                      onClick={() => void controller.pinCurrentDocumentToConversation()}
                    >
                      <Plus size={14} />固定当前文档
                    </button>
                  </div>

                  <div className="assistant-context-list">
                    {pinnedContext.map((item) => (
                      <div className="assistant-context-row" key={item.id}>
                        <FileText size={15} />
                        <div><strong>{item.label}</strong><small>{item.path || item.content_excerpt || "固定文本"}</small></div>
                        <button type="button" aria-label={`移除${item.label}`} disabled={actionBusy} onClick={() => void controller.removePinnedConversationContext(item.id)}><X size={14} /></button>
                      </div>
                    ))}
                    {attachments.map((item) => (
                      <div className="assistant-context-row" key={item.id}>
                        <Paperclip size={15} />
                        <div><strong>{item.name}</strong><small>{formatAssistantAttachmentSize(item.size)}</small></div>
                        <button type="button" aria-label={`删除附件${item.name}`} disabled={actionBusy} onClick={() => void controller.deleteConversationAttachment(item.id)}><X size={14} /></button>
                      </div>
                    ))}
                    {!contextCount && <p className="assistant-context-empty">尚未添加资料</p>}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="assistant-composer-actions">
            <AssistantModelControls controller={controller} />
            {controller.sendingMessage ? (
              <button className="assistant-send-button stop" type="button" title="停止生成" aria-label="停止生成" onClick={() => controller.stopMessage()}>
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button className="assistant-send-button" type="button" title="发送" aria-label="发送" onClick={send} disabled={!controller.messageInput.trim() || sendLocked}>
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
