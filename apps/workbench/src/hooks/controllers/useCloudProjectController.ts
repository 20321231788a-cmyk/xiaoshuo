import type { CloudProjectInspectResponse, CurrentProject } from "@xiaoshuo/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nextAutoSyncDelay } from "./cloudSyncPolicy.js";
import type { WorkbenchController as CoreWorkbenchController } from "./useWorkbenchCoreController.js";

const STORAGE_KEY = "arcwriter.cloud-sync.preferences.v1";

export type CloudSyncPreference = {
  auto: boolean;
  slot_id: 1 | 2 | 3;
  remote_id: string;
  project_name: string;
  last_auto_sync_at: string;
  auto_sync_day: string;
  auto_sync_count: number;
};

type CloudSyncPreferences = Record<string, CloudSyncPreference>;

export function useCloudProjectController(core: CoreWorkbenchController) {
  const [preferences, setPreferences] = useState<CloudSyncPreferences>(() => loadPreferences());
  const [coreStats, setCoreStats] = useState<Record<string, CloudProjectInspectResponse>>({});
  const [inspectingPaths, setInspectingPaths] = useState<string[]>([]);
  const [pendingAutoSyncPaths, setPendingAutoSyncPaths] = useState<string[]>([]);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coreRef = useRef(core);
  const lastDocumentSignatureRef = useRef<Record<string, string>>({});
  coreRef.current = core;

  const savePreferences = useCallback((updater: (current: CloudSyncPreferences) => CloudSyncPreferences) => {
    setPreferences((current) => {
      const next = updater(current);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 同步偏好写入失败不影响本地写作，当前会话继续保留状态。
      }
      return next;
    });
  }, []);

  const setProjectAutoSync = useCallback((projectPath: string, enabled: boolean, slotId: number) => {
    const normalizedSlot = normalizeSlot(slotId);
    if (!enabled) setPendingAutoSyncPaths((current) => current.filter((item) => item !== projectPath));
    savePreferences((current) => ({
      ...current,
      [projectPath]: {
        auto: enabled,
        slot_id: normalizedSlot,
        remote_id: current[projectPath]?.remote_id || "",
        project_name: current[projectPath]?.project_name || "",
        last_auto_sync_at: current[projectPath]?.last_auto_sync_at || "",
        auto_sync_day: current[projectPath]?.auto_sync_day || "",
        auto_sync_count: current[projectPath]?.auto_sync_count || 0
      }
    }));
  }, [savePreferences]);

  const inspectCloudProject = useCallback(async (projectPath: string) => {
    if (!projectPath || !window.xiaoshuoDesktop?.cloudProjects?.inspect) return null;
    setInspectingPaths((current) => current.includes(projectPath) ? current : [...current, projectPath]);
    try {
      const result = await window.xiaoshuoDesktop.cloudProjects.inspect({ project_path: projectPath });
      setCoreStats((current) => ({ ...current, [projectPath]: result }));
      return result;
    } catch {
      return null;
    } finally {
      setInspectingPaths((current) => current.filter((item) => item !== projectPath));
    }
  }, []);

  const syncProjectToCloud = useCallback(async (project: CurrentProject, slotId: number, mode: "manual" | "auto" = "manual") => {
    const result = await coreRef.current.uploadProjectToCloud(project, slotId, mode);
    if (!result) return null;
    const now = new Date();
    const today = localDay(now);
    savePreferences((current) => {
      const previous = current[project.path];
      const sameDay = previous?.auto_sync_day === today;
      const next = { ...current };
      for (const [otherPath, preference] of Object.entries(next)) {
        if (otherPath !== project.path && (preference.remote_id === result.slot.id || preference.slot_id === result.slot.slot_id)) delete next[otherPath];
      }
      return {
        ...next,
        [project.path]: {
          auto: previous?.auto || false,
          slot_id: normalizeSlot(result.slot.slot_id || slotId),
          remote_id: result.slot.id,
          project_name: result.slot.project_name || project.name,
          last_auto_sync_at: mode === "auto" ? now.toISOString() : previous?.last_auto_sync_at || "",
          auto_sync_day: mode === "auto" ? today : previous?.auto_sync_day || "",
          auto_sync_count: mode === "auto" && !result.unchanged ? (sameDay ? previous?.auto_sync_count || 0 : 0) + 1 : previous?.auto_sync_count || 0
        }
      };
    });
    void inspectCloudProject(project.path);
    return result;
  }, [inspectCloudProject, savePreferences]);

  const documentSignature = useMemo(() => core.openDocuments
    .map((document) => `${document.path}:${document.updatedAt}:${document.chars}:${document.dirty ? 1 : 0}`)
    .sort()
    .join("|"), [core.openDocuments]);

  useEffect(() => {
    const project = core.snapshot?.currentProject;
    if (!project?.path) return;
    const previousSignature = lastDocumentSignatureRef.current[project.path];
    if (previousSignature === undefined) {
      lastDocumentSignatureRef.current[project.path] = documentSignature;
      return;
    }
    if (previousSignature === documentSignature) return;
    const preference = preferences[project.path];
    if (!preference?.auto) {
      lastDocumentSignatureRef.current[project.path] = documentSignature;
      return;
    }
    if (core.cloudProjectBusy || core.sendingMessage || core.operationsBusy || core.openDocuments.some((document) => document.dirty)) return;
    lastDocumentSignatureRef.current[project.path] = documentSignature;
    const today = localDay(new Date());
    const autoCount = preference.auto_sync_day === today ? preference.auto_sync_count : 0;
    const delay = nextAutoSyncDelay({
      lastSyncAt: preference.last_auto_sync_at,
      autoSyncCount: autoCount,
      todayUploadRemaining: core.cloudProjectSummary?.today_upload_remaining ?? null,
      dailyBytesRemaining: core.cloudProjectSummary?.daily_upload_bytes_remaining,
      expectedBytes: coreStats[project.path]?.core_bytes
    });
    if (delay === null) return;
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    setPendingAutoSyncPaths((current) => current.includes(project.path) ? current : [...current, project.path]);
    autoTimerRef.current = setTimeout(() => {
      setPendingAutoSyncPaths((current) => current.filter((item) => item !== project.path));
      void syncProjectToCloud(project, preference.slot_id, "auto");
    }, delay);
  }, [core.cloudProjectBusy, core.cloudProjectSummary, core.openDocuments, core.operationsBusy, core.sendingMessage, core.snapshot?.currentProject, coreStats, documentSignature, preferences, syncProjectToCloud]);

  useEffect(() => () => {
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
  }, []);

  return {
    cloudProjectSlots: core.cloudProjectSlots,
    cloudProjectSummary: core.cloudProjectSummary,
    cloudProjectBusy: core.cloudProjectBusy,
    cloudProjectActivePath: core.cloudProjectActivePath,
    cloudProjectMessage: core.cloudProjectMessage,
    cloudSyncPreferences: preferences,
    cloudCoreStats: coreStats,
    cloudInspectingPaths: inspectingPaths,
    cloudPendingAutoSyncPaths: pendingAutoSyncPaths,
    refreshCloudProjects: core.refreshCloudProjects,
    inspectCloudProject,
    setProjectAutoSync,
    syncProjectToCloud,
    uploadCurrentProjectToCloud: core.uploadCurrentProjectToCloud,
    restoreCloudProject: core.restoreCloudProject,
    syncCloudProjectToCurrent: core.syncCloudProjectToCurrent,
    deleteCloudProject: core.deleteCloudProject
  };
}

function loadPreferences(): CloudSyncPreferences {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Partial<CloudSyncPreference>>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([projectPath, value]) => {
      if (!projectPath || !value || typeof value !== "object") return [];
      return [[projectPath, {
        auto: Boolean(value.auto),
        slot_id: normalizeSlot(value.slot_id || 1),
        remote_id: String(value.remote_id || ""),
        project_name: String(value.project_name || ""),
        last_auto_sync_at: String(value.last_auto_sync_at || ""),
        auto_sync_day: String(value.auto_sync_day || ""),
        auto_sync_count: Math.max(0, Number(value.auto_sync_count || 0))
      }]];
    }));
  } catch {
    return {};
  }
}

function normalizeSlot(value: number): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
