import { ClipboardCheck, MessageSquare, X } from "lucide-react";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import type { PendingReviewItem } from "../../../lib/workflow.js";
import { PendingReviewPanel } from "./PendingReviewPanel.js";

export function PendingReviewDrawer({
  open,
  controller,
  onClose,
  onOpenOrigin,
  onOpenTarget,
  onOpenEditor,
  onOpenLibrary,
  onRequestRevision
}: {
  open: boolean;
  controller: WorkbenchController;
  onClose: () => void;
  onOpenOrigin: (review: PendingReviewItem) => void;
  onOpenTarget: (path: string) => void;
  onOpenEditor: () => void;
  onOpenLibrary: (domain: "lore" | "style" | "genre") => void;
  onRequestRevision: (review: PendingReviewItem) => void;
}) {
  if (!open) return null;
  const reviews = controller.pendingReviews;
  return <aside className="pending-review-drawer" aria-label="待确认生成内容">
    <header>
      <div><ClipboardCheck size={17} /><span><strong>待确认内容</strong><small>{reviews.length} 项尚未写入项目</small></span></div>
      <button className="icon-button subtle" type="button" aria-label="关闭待确认内容" onClick={onClose}><X size={16} /></button>
    </header>
    <div className="pending-review-drawer-body">
      {!reviews.length && <p className="pending-review-drawer-empty">当前没有待确认的生成内容。</p>}
      {reviews.map((review) => <section className="pending-review-drawer-item" key={`${review.kind}:${review.id}`}>
        {review.pending.conversationId && <button className="pending-review-origin" type="button" onClick={() => onOpenOrigin(review)}><MessageSquare size={13} />回到原对话</button>}
        <PendingReviewPanel review={review} controller={controller} compact onOpenTarget={onOpenTarget} onOpenEditor={onOpenEditor} onOpenLibrary={onOpenLibrary} onRequestRevision={onRequestRevision} />
      </section>)}
    </div>
  </aside>;
}
