import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import {
  type SkillDefinition,
  type SkillImportDraftRequest,
  type SkillImportRequest
} from "@xiaoshuo/shared";

const AGENT_DIR = "00_设定集/.agent";
const MAX_SKILL_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_TEXT_CHARS = 120000;
const MAX_SKILL_ZIP_FILES = 40;
const STORY_DESLOP_SOURCE = "builtin:story-deslop";
const HUMANIZER_ZH_SOURCE = "builtin:humanizer-zh";
const DISABLED_BUILTINS_FILE = "disabled-builtins.json";

const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: "outline_generate",
    name: "灵感转大纲",
    description: "把灵感或要求扩展成完整小说大纲。",
    input_mode: "text",
    context_requirements: ["project_state", "style", "genre"],
    handler_type: "prompt",
    linked_targets: ["01_大纲/大纲.txt"],
    prompt: "你是资深网文主编。请把用户灵感扩展成完整、可执行的小说大纲，保留核心卖点、主线冲突、人物关系和阶段推进。",
    imported_from: "",
    writable: true
  },
  {
    id: "detail_outline_generate",
    name: "大纲转细纲",
    description: "把大纲扩展为更细的剧情细纲。",
    input_mode: "text",
    context_requirements: ["project_state", "outline"],
    handler_type: "prompt",
    linked_targets: ["01_大纲/细纲.txt"],
    prompt: "请把已有大纲扩展为更细的剧情细纲，强调因果、冲突和承接，不要写成正文。",
    imported_from: "",
    writable: true
  },
  {
    id: "chapter_outline_generate",
    name: "细纲转章纲",
    description: "把细纲拆成可直接执行的章节章纲。",
    input_mode: "text",
    context_requirements: ["project_state", "detailed_outline"],
    handler_type: "prompt",
    linked_targets: ["01_大纲/章纲.txt"],
    prompt: "请把细纲继续拆成章节章纲。每章写清目标、冲突、关键场景、人物变化和结尾钩子。",
    imported_from: "",
    writable: true
  },
  {
    id: "body_generate",
    name: "章纲转正文",
    description: "依据章纲与项目上下文生成正文。",
    input_mode: "text",
    context_requirements: ["project_state", "chapter_outline", "style", "genre"],
    handler_type: "job",
    linked_targets: ["02_正文"],
    prompt: "",
    imported_from: "",
    writable: true
  },
  {
    id: "polish_text",
    name: "正文润色",
    description: "在不改剧情事实的前提下优化正文表达。",
    input_mode: "text",
    context_requirements: ["project_state", "style"],
    handler_type: "prompt",
    linked_targets: ["02_正文/润色结果.txt"],
    prompt: "你是严格的小说编辑。不要改剧情事实，只优化句子流畅度、动作承接、画面感和对白自然度，直接输出润色后的正文。",
    imported_from: "",
    writable: true
  },
  {
    id: "story_deslop",
    name: "去AI味",
    description: "story-deslop：检测并清除 AI 写作痕迹，让细纲、章纲和正文更自然。",
    input_mode: "text",
    context_requirements: ["project_state", "style", "genre"],
    handler_type: "prompt",
    linked_targets: ["02_正文/去AI味结果.txt"],
    prompt: "你是小说文字编辑。请去除模板感、重复表达和生硬总结，让文本保留剧情事实但更自然顺滑。",
    imported_from: STORY_DESLOP_SOURCE,
    writable: true
  },
  {
    id: "humanizer_zh",
    name: "去AI味",
    description: "Humanizer-zh：去除 AI 写作痕迹，让生成文本更自然、更像人类书写。",
    input_mode: "text",
    context_requirements: ["project_state", "style", "genre"],
    handler_type: "prompt",
    linked_targets: ["02_正文/去AI味结果.txt"],
    prompt: [
      "你是 Humanizer-zh 中文文本编辑。请识别并去除 AI 生成痕迹，让文本更自然、更有人味。",
      "保留核心含义、剧情事实、人设、世界观、章节目标、伏笔和格式层级。",
      "重点清理：空泛升华、宣传腔、三段式排比、模糊归因、过度书面化、AI 高频词、公式化结尾、机械连接词。",
      "输出时只给处理后的文本本体，不要报告、解释、标题、免责声明或修改说明。"
    ].join("\n"),
    imported_from: HUMANIZER_ZH_SOURCE,
    writable: true
  },
  {
    id: "reverse_outline_extract",
    name: "反向细纲提取",
    description: "从正文中提取真实发生的剧情推进。",
    input_mode: "text",
    context_requirements: ["project_state"],
    handler_type: "prompt",
    linked_targets: ["01_大纲/反向细纲.txt"],
    prompt: "请从正文中提取真实发生的剧情推进，整理成反向细纲，按章节或段落归纳。",
    imported_from: "",
    writable: true
  },
  {
    id: "lore_extract",
    name: "设定提取",
    description: "从正文或资料中提取人物、地名、组织、能力和世界规则。",
    input_mode: "text",
    context_requirements: ["project_state", "lore"],
    handler_type: "prompt",
    linked_targets: [
      "00_设定集/设定集/人物设定.txt",
      "00_设定集/设定集/体系设定.txt",
      "00_设定集/设定集/地图设定.txt",
      "00_设定集/设定集/道具设定.txt"
    ],
    prompt: "请从文本中提取新出现的设定，并严格按人物设定、体系设定、地图设定、道具设定四段输出。",
    imported_from: "",
    writable: true
  },
  {
    id: "style_extract",
    name: "风格提取",
    description: "从样文中提取可复用的写作风格规则、风格示例特征和参考素材摘要。",
    input_mode: "text",
    context_requirements: ["style"],
    handler_type: "prompt",
    linked_targets: [
      "00_设定集/风格库/写作风格.txt",
      "00_设定集/风格库/风格示例.txt",
      "00_设定集/风格库/参考素材.txt"
    ],
    prompt: [
      "你是写作风格分析师。请从输入样文里提炼可复用的写作风格资产，不要复述剧情。",
      "必须按以下标题输出：",
      "【写作风格】句长偏好、人称/视角、对白密度、叙事节奏、情绪浓度、常用转场、禁用表达和执行规则。",
      "【风格示例】抽象出可模仿的段落特征、镜头推进方式、感官描写样式和对白样式；不得照抄原文句子。",
      "【参考素材】可复用的意象、语感、场景组织方式、资料摘要和素材边界；不得保留可识别剧情桥段。"
    ].join("\n"),
    imported_from: "",
    writable: true
  },
  {
    id: "genre_generate",
    name: "题材生成",
    description: "生成题材规则、题材素材、战斗或冲突模板和违禁词。",
    input_mode: "text",
    context_requirements: ["project_state", "genre"],
    handler_type: "prompt",
    linked_targets: [
      "00_设定集/题材库/题材规则.txt",
      "00_设定集/题材库/题材素材.txt",
      "00_设定集/题材库/战斗模板.txt",
      "00_设定集/题材库/违禁词.txt"
    ],
    prompt: [
      "你是小说题材设定编辑。请根据用户输入生成可约束后续写作的题材库。",
      "必须按以下标题输出：",
      "【题材规则】世界规则、术语体系、爽点边界、能力/科技/制度限制，以及后续生成必须遵守的硬约束。",
      "【题材素材】可复用桥段、场景、关键词、道具、势力、冲突素材和题材氛围素材。",
      "【战斗模板】战斗或冲突场景的推进模板、压迫-反转-收束节奏、场面调度和翻盘点；如果题材不以战斗为主，改写为冲突场景模板。",
      "【违禁词】禁止出现或需要替换的术语、错题材表达、现代违和词、过度血腥/敏感表达，以及替代表达建议。",
      "题材库中的 XX 是占位符，除非用户明确提供，不要自行猜测具体题材设定。"
    ].join("\n"),
    imported_from: "",
    writable: true
  },
  {
    id: "batch_generate",
    name: "批量续写",
    description: "按章节范围连续生成正文。",
    input_mode: "text",
    context_requirements: ["project_state", "chapter_outline", "style", "genre"],
    handler_type: "job",
    linked_targets: ["02_正文"],
    prompt: "",
    imported_from: "",
    writable: true
  },
  {
    id: "disassemble_book",
    name: "一键拆书",
    description: "从上传文本里提取设定和反向细纲。",
    input_mode: "text",
    context_requirements: ["attachments", "project_state"],
    handler_type: "job",
    linked_targets: ["01_大纲/反向细纲.txt", "00_设定集/设定集/拆书设定提取.txt"],
    prompt: "",
    imported_from: "",
    writable: true
  },
  {
    id: "continue_disassemble",
    name: "继续拆细纲",
    description: "把反向细纲进一步扩展成拆书细纲。",
    input_mode: "text",
    context_requirements: ["project_state", "attachments"],
    handler_type: "job",
    linked_targets: ["01_大纲/拆书细纲.txt"],
    prompt: "",
    imported_from: "",
    writable: true
  },
  {
    id: "nuwa_style_distill",
    name: "蒸馏",
    description: "Nuwa：从拆书原文或拆书产物中蒸馏可复用的小说文风档案。",
    input_mode: "text",
    context_requirements: ["attachments", "project_state", "style"],
    handler_type: "workflow",
    linked_targets: ["00_设定集/.agent/style_distillation/current.json"],
    prompt: "",
    imported_from: "builtin:nuwa-skill",
    writable: true
  },
  {
    id: "book_fusion",
    name: "融梗",
    description: "从三本以上已拆书籍中抽象融合核心设定和剧情骨架，生成原创候选方案。",
    input_mode: "text",
    context_requirements: ["project_state", "genre", "disassemble_library"],
    handler_type: "workflow",
    linked_targets: ["00_设定集/融梗方案"],
    prompt: "",
    imported_from: "builtin:book-fusion",
    writable: true
  },
  {
    id: "scan_pits",
    name: "扫描伏笔",
    description: "从正文中提取需要跟踪的伏笔并写入账本。",
    input_mode: "text",
    context_requirements: ["project_state", "ledger"],
    handler_type: "job",
    linked_targets: [],
    prompt: "",
    imported_from: "",
    writable: true
  },
  {
    id: "consistency_check",
    name: "一致性检查",
    description: "检查正文是否违背设定、章纲、风格和题材约束。",
    input_mode: "text",
    context_requirements: ["project_state", "style", "genre"],
    handler_type: "workflow",
    linked_targets: [],
    prompt: "",
    imported_from: "",
    writable: false
  },
  {
    id: "continue_text",
    name: "正文续写",
    description: "基于当前段落、章纲和项目上下文，在光标位置自然续写。",
    input_mode: "text",
    context_requirements: ["project_state", "chapter_outline", "style", "genre"],
    handler_type: "prompt",
    linked_targets: ["02_正文/续写结果.txt"],
    prompt: "你是长篇网文续写助手。请严格沿着当前剧情、章纲和人物状态继续往下写，约 500 字，不要总结，不要跳出当前场景。",
    imported_from: "",
    writable: true
  }
];

export type SkillServiceOptions = {
  projectRoot: string;
  now?: () => string;
};

export class SkillService {
  private readonly projectRoot: string;
  private readonly now: () => string;
  private readonly builtins = new Map(BUILTIN_SKILLS.map((skill) => [skill.id, { ...skill }]));

  constructor(options: SkillServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.now = options.now ?? (() => formatNow(new Date()));
  }

  async listSkills(): Promise<SkillDefinition[]> {
    const imported = await this.loadImportedSkills();
    const disabledBuiltins = await this.loadDisabledBuiltins();
    const merged = new Map<string, SkillDefinition>(
      [...this.builtins.entries()].map(([id, skill]) => [
        id,
        {
          ...skill,
          builtin: true,
          disabled: disabledBuiltins.has(id)
        }
      ])
    );
    for (const skill of imported) {
      merged.set(skill.id, { ...skill, builtin: false, disabled: false });
    }
    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async getSkill(skillId: string): Promise<SkillDefinition | null> {
    if (!skillId.trim()) {
      return null;
    }
    const skills = await this.listSkills();
    return skills.find((skill) => skill.id === skillId) ?? null;
  }

  async importSkill(payload: SkillImportRequest): Promise<SkillDefinition> {
    const source = path.resolve(payload.path);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(source);
    } catch {
      throw new Error(`skill 路径不存在: ${source}`);
    }
    const skillFile = stat.isDirectory()
      ? path.join(source, "SKILL.md")
      : (path.basename(source).toLowerCase() === "skill.md" ? source : path.join(source, "SKILL.md"));
    try {
      await fs.access(skillFile);
    } catch {
      throw new Error("未找到 SKILL.md");
    }
    const raw = await fs.readFile(skillFile, "utf8");
    const skill = this.parseExternalSkill(source, raw);
    return this.saveImportedSkill(skill, {
      sourceName: source,
      sourceText: raw
    });
  }

  async importUploadedSkill(filename: string, content: Buffer, mediaType = ""): Promise<SkillDefinition> {
    if (!content.length) {
      throw new Error("上传文件为空");
    }
    if (content.length > MAX_SKILL_UPLOAD_BYTES) {
      throw new Error("上传文件过大，单个 skill 文件或 zip 不能超过 5MB");
    }
    const safeName = this.safeSourceName(filename || "uploaded-skill.md");
    const suffix = path.extname(safeName).toLowerCase();
    let raw = "";
    let sourceName = safeName;
    if (suffix === ".zip" || mediaType.toLowerCase().includes("zip")) {
      ({ raw, sourceName } = this.readSkillFromZip(content));
    } else if (suffix === ".md" || suffix === ".markdown" || suffix === ".txt" || safeName.toLowerCase() === "skill.md") {
      raw = this.decodeText(content);
    } else {
      throw new Error("只支持上传 SKILL.md、Markdown、txt 或 zip");
    }
    const skill = this.parseExternalSkillSource(sourceName, raw, `upload:${safeName}`);
    return this.saveImportedSkill(skill, {
      sourceName,
      sourceText: raw
    });
  }

  async importSkillDraft(payload: SkillImportDraftRequest): Promise<SkillDefinition> {
    const normalized = this.normalizeSkill(payload.skill, payload.source_url || payload.source_name || "draft");
    return this.saveImportedSkill(normalized, {
      sourceName: payload.source_name || payload.source_url || normalized.name,
      sourceText: payload.source_text || normalized.prompt
    });
  }

  async importedSkillDirectory(): Promise<string> {
    const dir = path.dirname(await this.importedSkillsPath());
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async deleteSkill(skillId: string): Promise<{ ok: boolean; deleted: boolean; disabled: boolean; skill_id: string }> {
    const id = normalizeSkillId(skillId);
    if (!id) {
      throw new Error("skill id 不能为空");
    }
    const imported = await this.loadImportedSkills();
    if (imported.some((skill) => skill.id === id)) {
      await this.saveImportedSkills(imported.filter((skill) => skill.id !== id));
      await fs.rm(path.join(await this.importedSkillDirectory(), "sources", id), { recursive: true, force: true }).catch(() => {});
      return { ok: true, deleted: true, disabled: false, skill_id: id };
    }
    if (this.builtins.has(id)) {
      const disabled = await this.setBuiltinDisabled(id, true);
      return { ok: true, deleted: false, disabled, skill_id: id };
    }
    throw new Error("skill 不存在");
  }

  async toggleBuiltinSkill(skillId: string, disabled?: boolean): Promise<SkillDefinition> {
    const id = normalizeSkillId(skillId);
    if (!this.builtins.has(id)) {
      throw new Error("只能禁用或恢复默认技能");
    }
    const nextDisabled = await this.setBuiltinDisabled(id, disabled);
    const skill = await this.getSkill(id);
    if (!skill) {
      throw new Error("skill 不存在");
    }
    return { ...skill, builtin: true, disabled: nextDisabled };
  }

  async updateSkillDescription(skillId: string, description: string): Promise<SkillDefinition> {
    const id = normalizeSkillId(skillId);
    if (!id) {
      throw new Error("skill id 不能为空");
    }
    if (this.builtins.has(id)) {
      throw new Error("默认技能简介不能直接修改");
    }
    const imported = await this.loadImportedSkills();
    const index = imported.findIndex((skill) => skill.id === id);
    if (index < 0) {
      throw new Error("导入技能不存在");
    }
    const currentSkill = imported[index];
    if (!currentSkill) {
      throw new Error("导入技能不存在");
    }
    const nextDescription = normalizeSkillDescription(description);
    const nextSkill: SkillDefinition = {
      ...currentSkill,
      description: nextDescription || "导入的外部 skill"
    };
    imported[index] = nextSkill;
    await this.saveImportedSkills(imported);
    return { ...nextSkill, builtin: false, disabled: false };
  }

  private async importedSkillsPath(): Promise<string> {
    const filePath = path.join(this.projectRoot, AGENT_DIR, "skills", "imported.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return filePath;
  }

  private async loadImportedSkills(): Promise<SkillDefinition[]> {
    const filePath = await this.importedSkillsPath();
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    const skills: SkillDefinition[] = [];
    for (const item of parsed) {
      try {
        skills.push(this.normalizeSkill(item as SkillDefinition, (item as SkillDefinition).imported_from || ""));
      } catch {
        continue;
      }
    }
    return skills;
  }

  private async saveImportedSkills(skills: SkillDefinition[]): Promise<void> {
    const filePath = await this.importedSkillsPath();
    await fs.writeFile(filePath, `${JSON.stringify(skills, null, 2)}\n`, "utf8");
  }

  private async disabledBuiltinsPath(): Promise<string> {
    const filePath = path.join(this.projectRoot, AGENT_DIR, "skills", DISABLED_BUILTINS_FILE);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return filePath;
  }

  private async loadDisabledBuiltins(): Promise<Set<string>> {
    const filePath = await this.disabledBuiltinsPath();
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      return new Set();
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return new Set();
      }
      return new Set(parsed.map((item) => normalizeSkillId(String(item || ""))).filter((id) => this.builtins.has(id)));
    } catch {
      return new Set();
    }
  }

  private async saveDisabledBuiltins(ids: Set<string>): Promise<void> {
    const filePath = await this.disabledBuiltinsPath();
    const values = [...ids].filter((id) => this.builtins.has(id)).sort();
    await fs.writeFile(filePath, `${JSON.stringify(values, null, 2)}\n`, "utf8");
  }

  private async setBuiltinDisabled(skillId: string, disabled?: boolean): Promise<boolean> {
    const id = normalizeSkillId(skillId);
    if (!this.builtins.has(id)) {
      throw new Error("只能禁用或恢复默认技能");
    }
    const disabledBuiltins = await this.loadDisabledBuiltins();
    const nextDisabled = disabled === undefined ? !disabledBuiltins.has(id) : Boolean(disabled);
    if (nextDisabled) {
      disabledBuiltins.add(id);
    } else {
      disabledBuiltins.delete(id);
    }
    await this.saveDisabledBuiltins(disabledBuiltins);
    return nextDisabled;
  }

  private async saveImportedSkill(
    skill: SkillDefinition,
    options: {
      sourceName: string;
      sourceText: string;
    }
  ): Promise<SkillDefinition> {
    const current = new Map((await this.loadImportedSkills()).map((item) => [item.id, item]));
    current.set(skill.id, skill);
    await this.saveImportedSkills([...current.values()]);
    if (options.sourceText.trim()) {
      await this.saveSkillSourceSnapshot(skill, options.sourceName, options.sourceText);
    }
    return skill;
  }

  public normalizeSkill(skill: SkillDefinition, importedFrom: string): SkillDefinition {
    const skillId = normalizeSkillId(skill.id || skill.name || "imported_skill");
    const prompt = (skill.prompt || "").trim().slice(0, 12000);
    if (!prompt) {
      throw new Error("skill prompt 不能为空");
    }
    return {
      id: skillId || "imported_skill",
      name: (skill.name || skillId || "imported_skill").trim().slice(0, 80),
      description: normalizeSkillDescription(skill.description || "导入的外部 skill"),
      input_mode: skill.input_mode || "text",
      context_requirements: normalizeStringArray(skill.context_requirements, 12, ["project_state", "conversation"]),
      handler_type: "prompt",
      linked_targets: normalizeStringArray(skill.linked_targets, 8, []),
      prompt,
      imported_from: (importedFrom || skill.imported_from || "").trim().slice(0, 500),
      writable: Boolean(skill.writable),
      builtin: false,
      disabled: false
    };
  }

  private async saveSkillSourceSnapshot(skill: SkillDefinition, sourceName: string, sourceText: string): Promise<void> {
    const base = path.join(await this.importedSkillDirectory(), "sources", skill.id);
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, "source.md"), sourceText.slice(0, MAX_SKILL_TEXT_CHARS), "utf8");
    await fs.writeFile(
      path.join(base, "metadata.json"),
      `${JSON.stringify(
        {
          skill_id: skill.id,
          skill_name: skill.name,
          source_name: sourceName,
          imported_from: skill.imported_from,
          saved_at: this.now()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  private parseExternalSkillSource(sourceName: string, raw: string, importedFrom: string): SkillDefinition {
    const source = this.safeSourceName(sourceName) || "SKILL.md";
    const parsed = this.parseExternalSkill(source, raw);
    return {
      ...parsed,
      imported_from: importedFrom || parsed.imported_from
    };
  }

  private safeSourceName(value: string): string {
    const name = path.basename((value || "skill.md").replace(/\\/g, "/"));
    return name.replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "skill.md";
  }

  private decodeText(content: Buffer): string {
    const encodings: BufferEncoding[] = ["utf8", "utf16le"];
    for (const encoding of encodings) {
      try {
        return content.toString(encoding);
      } catch {
        continue;
      }
    }
    return content.toString("utf8");
  }

  private readSkillFromZip(content: Buffer): { raw: string; sourceName: string } {
    let archive: AdmZip;
    try {
      archive = new AdmZip(content);
    } catch (error) {
      throw new Error("zip 文件无效");
    }
    const entries = archive.getEntries();
    if (entries.length > MAX_SKILL_ZIP_FILES) {
      throw new Error("zip 内文件过多");
    }
    let skillEntry: AdmZip.IZipEntry | null = null;
    let totalSize = 0;
    for (const entry of entries) {
      const normalized = entry.entryName.replace(/\\/g, "/");
      const parts = normalized.split("/").filter(Boolean);
      if (normalized.startsWith("/") || parts.includes("..")) {
        throw new Error("zip 内包含不安全路径");
      }
      totalSize += Math.max(0, entry.header.size);
      if (totalSize > MAX_SKILL_UPLOAD_BYTES) {
        throw new Error("zip 解压后内容过大");
      }
      if (parts.at(-1)?.toLowerCase() === "skill.md") {
        skillEntry = entry;
      }
    }
    if (!skillEntry) {
      throw new Error("zip 中未找到 SKILL.md");
    }
    return {
      raw: this.decodeText(skillEntry.getData()),
      sourceName: skillEntry.entryName
    };
  }

  public parseExternalSkill(source: string, raw: string): SkillDefinition {
    const metadata: Record<string, string> = {};
    let body = raw;
    const frontmatter = raw.match(/^---\s*\n(.*?)\n---\s*\n(.*)$/s);
    if (frontmatter) {
      body = frontmatter[2] || "";
      for (const line of (frontmatter[1] || "").split(/\r?\n/)) {
        const index = line.indexOf(":");
        if (index < 0) {
          continue;
        }
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^"|"$/g, "");
        metadata[key] = value;
      }
    }
    const baseName = metadata.name || path.basename(source);
    const skillId = normalizeSkillId(baseName) || `imported_${Math.abs(hashString(source))}`;
    return {
      id: skillId,
      name: metadata.name || path.basename(source),
      description: metadata.description || "导入的外部 skill",
      input_mode: "text",
      context_requirements: ["project_state", "conversation"],
      handler_type: "prompt",
      linked_targets: [],
      prompt: body.trim().slice(0, 12000),
      imported_from: source,
      writable: false
    };
  }

  public async fetchUrlText(url: string): Promise<{ text: string; sourceName: string }> {
    const headers = { "User-Agent": "XiaoShuo-Agent-Skill-Importer/1.0" };
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`抓取失败: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let text = "";
    for (const candidate of ["utf-8", "gb18030", "utf-16le"]) {
      try {
        const decoder = new TextDecoder(candidate, { fatal: true });
        text = decoder.decode(bytes);
        break;
      } catch {}
    }
    if (!text) {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    
    let sourceName = this.safeSourceName(new URL(url).pathname.split("/").pop() || "web-skill-source.md");
    if (this.looksLikeHtml(text)) {
      text = this.htmlToText(text);
      if (!sourceName || !sourceName.includes(".")) {
        sourceName = "web-skill-source.md";
      }
    }
    return { text: text.trim(), sourceName };
  }

  public looksLikeHtml(text: string): boolean {
    const sample = (text || "").slice(0, 500).toLowerCase();
    return sample.includes("<html") || sample.includes("<!doctype html") || sample.includes("<body");
  }

  public htmlToText(text: string): string {
    const $ = cheerio.load(text || "");
    $("script, style, iframe, noscript, form").remove();
    const rawText = $.text()
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\u00a0/g, " ");
    return rawText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
}

function normalizeStringArray(values: readonly string[] | undefined, limit: number, fallback: string[]): string[] {
  const list = (values || []).map((item) => String(item).trim()).filter(Boolean).slice(0, limit);
  return list.length ? list : [...fallback];
}

function normalizeSkillDescription(value: string): string {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1000);
}

function normalizeSkillId(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function formatNow(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
