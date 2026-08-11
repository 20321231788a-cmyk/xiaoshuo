export type AssistantComposerKeyState = {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
  value: string;
  locked: boolean;
};

export function shouldSubmitAssistantMessage(state: AssistantComposerKeyState): boolean {
  return state.key === "Enter"
    && !state.shiftKey
    && !state.isComposing
    && state.keyCode !== 229
    && !state.locked
    && Boolean(state.value.trim());
}

export function formatAssistantAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
