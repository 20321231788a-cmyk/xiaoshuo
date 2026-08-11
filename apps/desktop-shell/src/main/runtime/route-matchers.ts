export function matchDocumentRoute(pathname: string): string {
  const prefix = "/api/documents/";
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  return decodeURIComponent(pathname.slice(prefix.length));
}

export function matchTimelineRoute(pathname: string):
  | {
      id: string;
      action?: string;
    }
  | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "timeline" || segments.length < 3 || segments.length > 4) {
    return null;
  }
  return {
    id: decodeURIComponent(segments[2] || ""),
    action: segments[3]
  };
}

export function matchConversationRoute(pathname: string):
  | {
      id?: string;
      action?: string;
      itemId?: string;
    }
  | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "conversations") {
    return null;
  }
  if (segments.length === 2) {
    return {};
  }
  if (segments.length === 3) {
    return { id: decodeURIComponent(segments[2] || "") };
  }
  if (segments.length === 4) {
    return { id: decodeURIComponent(segments[2] || ""), action: segments[3] };
  }
  if (segments.length === 5) {
    return { id: decodeURIComponent(segments[2] || ""), action: segments[3], itemId: decodeURIComponent(segments[4] || "") };
  }
  return null;
}

export function matchSkillRoute(pathname: string):
  | {
      id?: string;
      action?: string;
    }
  | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "skills") {
    return null;
  }
  if (segments.length === 2) {
    return {};
  }
  if (segments.length === 3) {
    const value = decodeURIComponent(segments[2] || "");
    if (value === "import" || value === "open-folder" || value === "upload" || value === "draft" || value === "draft-from-url" || value === "import-draft") {
      return { action: value };
    }
    return { id: value };
  }
  if (segments.length === 4 && (segments[3] === "run" || segments[3] === "toggle" || segments[3] === "clone" || segments[3] === "versions" || segments[3] === "rollback")) {
    return {
      id: decodeURIComponent(segments[2] || ""),
      action: segments[3]
    };
  }
  return null;
}

export function matchCardDrawRoute(pathname: string):
  | {
      drawId?: string;
      action?: string;
    }
  | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "card-draw") {
    return null;
  }
  if (segments.length === 2) {
    return {};
  }
  if (segments.length === 4 && segments[3] === "select") {
    return {
      drawId: decodeURIComponent(segments[2] || ""),
      action: "select"
    };
  }
  return null;
}
