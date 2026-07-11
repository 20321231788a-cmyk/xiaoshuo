import { ACTION_DESCRIPTORS } from "./action-registry.js";

export class ActionExecutor {
  private runtimeContext: any;

  constructor(runtimeContext: any) {
    this.runtimeContext = runtimeContext;
  }

  async execute(action: string, args: Record<string, any>): Promise<any> {
    const descriptor = ACTION_DESCRIPTORS[action];
    if (!descriptor) {
      throw new Error(`[ActionExecutor] 阻止：未授权或不支持的 Action: ${action}`);
    }

    // Enforce permission boundary checks
    const allowedPermissions = new Set(descriptor.required_permissions);
    if (allowedPermissions.has("project.write") && args.bypassService) {
      throw new Error(`[ActionExecutor] 阻止：禁止绕过受控服务直写盘: ${action}`);
    }

    switch (action) {
      case "read_project_files":
        return await this.runtimeContext.projectManifest.getProjectId();
      case "resolve_project_references":
        return args.paths || [];
      case "run_skill":
        return await this.runtimeContext.runSkillInternal(args.skill_id, args.request);
      case "search_web_material":
        return { sources: [] };
      case "propose_save":
        if (args.bypassDocumentService) {
          throw new Error("[ActionExecutor] 阻止：禁止绕过 DocumentService 直写文件");
        }
        return { ok: true, path: args.path };
      default:
        return { ok: true, message: `Action ${action} executed.` };
    }
  }
}
