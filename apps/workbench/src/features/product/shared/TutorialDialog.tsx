import {
  BookCheck,
  Boxes,
  FilePenLine,
  Library,
  Network,
  Rocket,
  Settings,
  X,
  type LucideIcon
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProductRoute } from "../../../navigation.js";

type TutorialPage = {
  title: string;
  summary: string;
  workflow: string[];
  tips?: string[];
  route?: ProductRoute;
  action?: string;
};

type TutorialSection = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  pages: TutorialPage[];
};

const tutorialSections: TutorialSection[] = [
  {
    id: "start",
    label: "快速开始",
    description: "先理解项目、导航、保存和 AI 写入规则，再进入具体创作页面。",
    icon: Rocket,
    pages: [
      {
        title: "项目与主导航",
        summary: "ArcWriter 以当前项目为工作边界，所有大纲、正文、资料和任务都归属于当前小说。",
        workflow: [
          "左上项目区显示当前项目名称和位置，可从项目首页新建、打开或继续最近项目。",
          "左侧主导航按写作、规划、资料、审阅、工具分组；后台任务和设置固定在底部。",
          "切换页面不会丢失已打开文档；存在未保存正文时，关闭窗口会先提醒。"
        ],
        route: { feature: "home" },
        action: "打开项目首页"
      },
      {
        title: "搜索、命令与保存",
        summary: "顶栏集中处理跨页面操作，不必返回首页寻找入口。",
        workflow: [
          "点击“搜索项目”或按 Ctrl+K，搜索功能入口和项目文档。",
          "点击“保存全部”或按 Ctrl+S，保存当前所有已修改文档。",
          "后台任务入口显示生成、审阅、拆书和索引任务；绿色圆点表示任务系统可用。",
          "按 F1 或点击桌面顶部“教程”，可随时重新打开本手册。"
        ]
      },
      {
        title: "安全写入与错误恢复",
        summary: "AI 生成内容不会绕过作者直接覆盖正文。",
        workflow: [
          "所有 AI 正文写入都经过：生成结果、差异预览、用户确认、创建版本、正式写入。",
          "保存冲突会保留本地内容和磁盘内容，由用户决定重新载入或覆盖。",
          "生成失败、网络中断或能力不可用时保留输入，可重试，不展示日志、Trace 或内部请求信息。",
          "高风险操作会说明目标文件、覆盖范围和可撤销方式。"
        ]
      }
    ]
  },
  {
    id: "writing",
    label: "写作",
    description: "覆盖项目首页、正文编辑和 AI 助手的完整写作流程。",
    icon: FilePenLine,
    pages: [
      {
        title: "项目首页",
        summary: "管理项目入口、最近写作和三本小说的云端同步名额。",
        workflow: [
          "新建小说、打开已有项目，或从最近项目继续写作。",
          "继续写作会恢复最近章节；没有有效章节时留在项目首页。",
          "最近项目列表显示本地状态、最近打开时间、自动同步开关和“立即同步”。",
          "每个账号最多同步三本小说，单本核心数据不超过 30 MB；第四本需明确选择替换的云端作品。",
          "云同步只处理大纲、细纲、正文、风格、题材等核心资料，不上传密钥、会话、日志和内部记录。"
        ],
        tips: [
          "自动同步仅在核心文件保存并稳定后执行；手动同步仍受每日和每月流量额度保护。",
          "从云端恢复前会预览变化并创建本地备份，不会删除未列入同步范围的本地文件。"
        ],
        route: { feature: "home" },
        action: "打开项目首页"
      },
      {
        title: "正文编辑",
        summary: "章节树、长文编辑、中文标点、查找替换和 AI 辅助集中在同一工作区。",
        workflow: [
          "从章节栏打开正文或大纲文档；切换文档前会保留当前编辑状态。",
          "在正文上方使用中文标点栏；成对标点可包裹选中文字，并将光标放回正确位置。",
          "章节栏底部显示当前章节字数、最近 60 秒实时速度和本次编辑平均速度。",
          "使用查找替换、标点工具和保存守卫处理长文；TXT 不显示无意义的富文本按钮，Markdown 才显示格式操作。",
          "展开 AI 侧栏后选择上下文范围，生成修改并预览差异，再决定覆盖、追加或另存草稿。"
        ],
        tips: [
          "粘贴、AI 写入、撤销和程序化替换不计入打字速度。",
          "正文修改会标记为未保存，保存后创建可回退的版本记录。"
        ],
        route: { feature: "editor" },
        action: "进入正文编辑"
      },
      {
        title: "AI 助手",
        summary: "管理对话、资料上下文、当前会话模型、思考等级、普通生成和抽卡。",
        workflow: [
          "新建或切换会话；用户消息显示在右侧，AI 回复显示在左侧。",
          "点击“上下文 N 项”固定当前文档、添加附件或移除资料，右侧栏同步显示 AI 本次可读取的内容。",
          "模型入口可选择“跟随默认”或覆盖当前会话模型，并按模型能力选择低、中、高思考等级。",
          "普通对话适合单一结果；抽卡会生成 2 至 4 个候选，可并排比较、采用一版并保留其他草稿。",
          "AI 回复后的覆盖、追加、另存草稿、复制和丢弃操作只作用于当前结果。"
        ],
        tips: [
          "Enter 发送，Shift+Enter 换行；中文输入法组合输入期间不会误发送。",
          "会话模型覆盖不影响批量生成、审阅、技能和其他会话。"
        ],
        route: { feature: "conversations" },
        action: "打开 AI 助手"
      }
    ]
  },
  {
    id: "planning",
    label: "规划",
    description: "管理故事结构、章节节拍、伏笔和故事时间线。",
    icon: Network,
    pages: [
      {
        title: "故事大纲",
        summary: "用结构化视图管理主线、人物线、分卷、章节和情节点。",
        workflow: [
          "在主线、人物线、分卷和章节视图间切换，选择条目查看详情。",
          "新增、编辑、删除和排序情节点，并把情节点关联到具体章节。",
          "调整条目顺序后保存修订，冲突时选择保留当前修改或重新载入。",
          "文本投影用于兼容旧 TXT 和 Markdown；结构化大纲数据仍是权威来源。"
        ],
        route: { feature: "outline" },
        action: "打开故事大纲"
      },
      {
        title: "伏笔与时间线",
        summary: "伏笔台账与故事时间线是两个视图，不与项目文件历史混用。",
        workflow: [
          "伏笔按计划、已埋下、到期、已回收四个阶段管理。",
          "新增或编辑伏笔，关联章节、人物和预期回收位置；使用筛选查看待处理项。",
          "运行全文扫描，从正文中寻找可能遗漏的埋设或回收线索。",
          "时间线事件记录故事时间、排序、摘要、人物、伏笔和关联章节，可按故事顺序重排。"
        ],
        route: { feature: "clues" },
        action: "打开伏笔与时间线"
      }
    ]
  },
  {
    id: "libraries",
    label: "资料",
    description: "维护设定事实、风格规则和题材约束，作为 AI 的项目上下文。",
    icon: Library,
    pages: [
      {
        title: "设定资料",
        summary: "集中管理人物、地点、势力、物品和世界规则。",
        workflow: [
          "选择资料类型后查看列表，打开条目编辑名称、说明、标签和结构化字段。",
          "建立人物、地点、势力和物品之间的关系，并关联相关章节。",
          "自动提取的设定先进入待确认区，不会直接成为确定事实。",
          "发生修订冲突时比较当前版本和磁盘版本；历史状态可用于回退或恢复。"
        ],
        route: { feature: "sources" },
        action: "打开设定资料"
      },
      {
        title: "风格与题材",
        summary: "保存叙事风格、题材规则、范文和禁用表达，并控制哪些规则参与生成。",
        workflow: [
          "在风格库和题材库间切换，新建、编辑、排序或停用档案。",
          "风格档案可包含叙事视角、句式、节奏、对白和描写规则。",
          "题材档案可包含题材约束、核心卖点、读者预期、范文和禁用表达。",
          "应用前查看预览，确认规则如何影响生成；封面生成会默认读取首个启用的题材档案。"
        ],
        route: { feature: "style" },
        action: "打开风格与题材"
      }
    ]
  },
  {
    id: "review",
    label: "审阅",
    description: "通过多角色编辑、全文报告和项目记忆治理提高长篇一致性。",
    icon: BookCheck,
    pages: [
      {
        title: "小说编辑室",
        summary: "选择最多三个审阅角色，从不同专业角度检查当前内容。",
        workflow: [
          "选择编辑、读者、节奏、设定等审阅角色，并确定审阅范围。",
          "运行审阅后查看合并建议及每条建议的角色来源。",
          "不同角色意见冲突时保留并列结论，由作者决定采用哪一条。",
          "生成修改后先定位原文和比较差异，再确认是否写入。"
        ],
        route: { feature: "studio" },
        action: "打开小说编辑室"
      },
      {
        title: "全文审阅",
        summary: "按一致性、人物、情节、节奏、语言等维度生成版本化审阅报告。",
        workflow: [
          "选择审阅范围和维度，运行真实一致性检查或小说审阅。",
          "查看分维度得分和问题列表，筛选严重程度与处理状态。",
          "从问题直接定位原文，生成修改建议；可采纳、忽略或保留待处理。",
          "历史报告保存用户可见的问题、建议和处理状态，不保存提示词、Trace 或内部步骤。"
        ],
        route: { feature: "review" },
        action: "打开全文审阅"
      },
      {
        title: "项目记忆",
        summary: "决定哪些内容可以作为后续写作的既定事实。",
        workflow: [
          "查看待确认记忆，批量确认明确事实，或逐条确认、纠正和遗忘。",
          "主观推测、未发生事件和未来剧情不能批量确认为事实。",
          "遇到互相矛盾的记忆时查看冲突来源，选择保留、修正或删除。",
          "已确认记忆会进入后续 AI 上下文；纠正和遗忘会同步更新使用状态。"
        ],
        route: { feature: "memory" },
        action: "打开项目记忆"
      }
    ]
  },
  {
    id: "tools",
    label: "工具",
    description: "拆解参考作品、批量生成章节、迁移资料、制作封面和管理技能。",
    icon: Boxes,
    pages: [
      {
        title: "拆书工作台",
        summary: "导入参考作品，生成拆解资料，再选择蒸馏、融梗或方法迁移。",
        workflow: [
          "导入本地文本，或在可用来源中联网获取作品；书籍进入左侧参考书库。",
          "运行一键拆解，生成原始文本、章节细纲、逆向大纲和设定提取等资料。",
          "打开报告查看产物，选择拆解资料提取写作方法或生成当前项目的迁移预览。",
          "蒸馏：选中一本书，提取叙事节奏、对白、描写和反模式；每个项目保留一个可启停档案。",
          "融梗：勾选至少三本已完成拆解的作品，生成去同质化的原创候选方案。"
        ],
        tips: [
          "融梗只使用拆解后的抽象设定和结构，不应复写原文句式、专有名词或可识别桥段。"
        ],
        route: { feature: "crawl" },
        action: "打开拆书工作台"
      },
      {
        title: "批量章节生成",
        summary: "检查章节与章纲后，按顺序或独立生成多章草稿。",
        workflow: [
          "选择要生成的章节，先检查章节文件和对应章纲是否齐全。",
          "选择顺序生成或独立生成；顺序模式会使用前文结果保持连续性。",
          "选择普通或抽卡模式，设置目标字数、尝试次数、预算上限和一致性复查。",
          "启动后在后台任务查看进度；结果默认写入批次草稿，不直接覆盖正式正文。",
          "检查批次结果后逐章预览、采用或丢弃。"
        ],
        route: { feature: "batch" },
        action: "打开批量章节生成"
      },
      {
        title: "素材迁移",
        summary: "在项目之间迁移选定资料，并在写入前处理同名冲突。",
        workflow: [
          "选择来源项目和目标项目，再勾选要迁移的大纲、设定、风格或题材资料。",
          "生成差异预览，查看新增、更新、跳过和同名冲突。",
          "为每项冲突选择保留目标、使用来源或另存新名称。",
          "经过两次确认后执行迁移；迁移记录支持撤销。",
          "密钥、模型配置、会话和内部历史不会参与迁移。"
        ],
        route: { feature: "transfer" },
        action: "打开素材迁移"
      },
      {
        title: "封面生成",
        summary: "使用网站配置的生图模型生成精确 600×800 PNG 小说封面。",
        workflow: [
          "填写书名、作者名、字体风格和题材风格；题材默认读取当前项目题材库。",
          "文生图直接生成；图生图可上传一张 PNG、JPG 或 WebP 参考图。",
          "生成期间可取消；成功后检查书名与署名，文字有误可重新生成。",
          "每次生成都会保存原图和 600×800 成品，不覆盖历史版本。",
          "历史区可再次生成、打开封面文件夹或确认删除版本。"
        ],
        tips: [
          "封面始终调用网站配置的生图模型，即使文本 AI 当前使用手动 API。",
          "模型可能产生错字，成品仍需由作者在预览中确认。"
        ],
        route: { feature: "cover" },
        action: "打开封面生成"
      },
      {
        title: "创作工具与技能",
        summary: "按类别查找作者可使用的工具，并管理自动写作能力和技能版本。",
        workflow: [
          "使用全部工具、写作与审阅、导入与导出、本地处理筛选工具。",
          "在“写作与审阅”开启自动提取明确设定、降低模板化表达、生成后一致性复查。",
          "立即检查类工具只在主动点击时运行，自动开关只控制生成后的联动。",
          "进入技能三级页面查看说明、文件访问范围和版本；支持编辑、导入预览及历史回退。",
          "启用工具前会说明文件访问范围，不提供终端或内部执行入口。"
        ],
        route: { feature: "skills" },
        action: "打开创作工具"
      }
    ]
  },
  {
    id: "system",
    label: "任务与设置",
    description: "管理长任务、模型、写作体验、备份、隐私、快捷键和版本信息。",
    icon: Settings,
    pages: [
      {
        title: "后台任务",
        summary: "统一查看生成、审阅、拆书和索引任务。",
        workflow: [
          "按状态查看等待中、运行中、已暂停、已完成和失败任务。",
          "任务行显示用户可理解的进度、预算和结果入口。",
          "可暂停、恢复或停止支持控制的任务；失败任务保留可重试原因。",
          "后台任务不展示运行日志、终端输出、Trace、哈希或 IPC 信息。"
        ],
        route: { feature: "tasks" },
        action: "打开后台任务"
      },
      {
        title: "AI 配置",
        summary: "配置全局默认文本模型、本地检索、网站服务和联网搜索。",
        workflow: [
          "手动 API：填写兼容接口、密钥和默认文本模型；刷新模型会读取接口提供的全部文本模型。",
          "网站服务：登录网站账号，选择网站文本模型和默认生图模型。",
          "本地检索控制项目资料召回；联网搜索控制是否允许 AI 使用网站资料。",
          "设置页保存全局默认模型；AI 助手的会话覆盖只作用于当前会话。",
          "密钥始终遮蔽显示，不进入会话、教程、日志或封面历史。"
        ],
        route: { feature: "settings", section: "ai" },
        action: "打开 AI 配置"
      },
      {
        title: "写作体验",
        summary: "调整编辑器、自动功能和生成后的写作行为。",
        workflow: [
          "设置编辑体验、保存反馈和与写作相关的默认行为。",
          "自动提取设定、降低模板化表达和生成后一致性复查与创作工具共用同一配置。",
          "在任一页面修改开关后，另一页面立即同步；保存失败会回滚并说明原因。"
        ],
        route: { feature: "settings", section: "writing" },
        action: "打开写作体验"
      },
      {
        title: "项目与备份",
        summary: "管理本地备份、恢复和项目级保存策略。",
        workflow: [
          "查看备份位置和最近备份状态，按需创建项目备份。",
          "高风险迁移、云端恢复和数据升级前会先创建备份。",
          "恢复前确认目标项目和影响范围，避免覆盖其他小说。"
        ],
        route: { feature: "settings", section: "backup" },
        action: "打开项目与备份"
      },
      {
        title: "隐私与数据",
        summary: "查看本地数据、云同步和外部能力的边界。",
        workflow: [
          "确认哪些资料仅保存在本地，哪些核心文件允许上传网站同步。",
          "网站令牌、API 密钥、会话、日志和内部历史不进入项目同步包。",
          "联网工具启用前会说明访问范围；关闭后不应继续发起对应外部请求。"
        ],
        route: { feature: "settings", section: "privacy" },
        action: "打开隐私与数据"
      },
      {
        title: "快捷键",
        summary: "查看并使用常用键盘操作，减少在长时间写作中的鼠标移动。",
        workflow: [
          "Ctrl+S 保存全部，Ctrl+K 搜索功能和文档，F1 打开教程。",
          "AI 输入栏中 Enter 发送，Shift+Enter 换行。",
          "编辑器保留查找、替换和撤销等标准文本操作，并显示可见键盘焦点。"
        ],
        route: { feature: "settings", section: "shortcuts" },
        action: "打开快捷键"
      },
      {
        title: "关于",
        summary: "查看 ArcWriter 版本和产品信息。",
        workflow: [
          "确认当前桌面端版本和构建信息。",
          "遇到问题时记录当前页面、可见错误提示和操作步骤即可，不需要寻找内部日志。",
          "版本更新后可重新打开本教程，检查新增页面和工作流。"
        ],
        route: { feature: "settings", section: "about" },
        action: "打开关于"
      }
    ]
  }
];

export function TutorialDialog({
  open,
  onClose,
  onNavigate
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (route: ProductRoute) => void;
}) {
  const [activeSectionId, setActiveSectionId] = useState(tutorialSections[0]!.id);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const activeSection = useMemo(
    () => tutorialSections.find((section) => section.id === activeSectionId) || tutorialSections[0]!,
    [activeSectionId]
  );
  const pageCount = tutorialSections.reduce((total, section) => total + section.pages.length, 0);

  useEffect(() => {
    if (!open) return;
    setActiveSectionId(tutorialSections[0]!.id);
    contentRef.current?.scrollTo({ top: 0 });
    window.requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [activeSectionId]);

  if (!open) return null;

  return (
    <div className="tutorial-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="tutorial-dialog" role="dialog" aria-modal="true" aria-labelledby="arcwriter-tutorial-title">
        <header className="tutorial-header">
          <div>
            <span>ArcWriter 完整功能教程</span>
            <h2 id="arcwriter-tutorial-title">从项目建立到成稿交付</h2>
            <p>按页面说明入口、操作顺序、结果去向和安全边界。</p>
          </div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="关闭教程" title="关闭教程" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="tutorial-layout">
          <nav className="tutorial-navigation" aria-label="教程分类">
            {tutorialSections.map((section) => {
              const Icon = section.icon;
              const active = section.id === activeSection.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={active ? "active" : ""}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setActiveSectionId(section.id)}
                >
                  <Icon size={15} />
                  <span>{section.label}</span>
                  <small>{section.pages.length}</small>
                </button>
              );
            })}
          </nav>

          <main className="tutorial-content" ref={contentRef}>
            <div className="tutorial-section-intro">
              <span>{activeSection.label}</span>
              <h3>{activeSection.description}</h3>
            </div>

            {activeSection.pages.map((page, index) => (
              <article className="tutorial-topic" key={page.title}>
                <div className="tutorial-topic-index" aria-hidden="true">{index + 1}</div>
                <div className="tutorial-topic-body">
                  <strong className="tutorial-topic-heading">{page.title}</strong>
                  <p>{page.summary}</p>

                  <div className="tutorial-workflow">
                    <span>怎么使用</span>
                    <ol>
                      {page.workflow.map((step) => <li key={step}>{step}</li>)}
                    </ol>
                  </div>

                  {!!page.tips?.length && (
                    <div className="tutorial-tips">
                      <span>注意</span>
                      <ul>
                        {page.tips.map((tip) => <li key={tip}>{tip}</li>)}
                      </ul>
                    </div>
                  )}

                  {page.route && page.action && (
                    <button className="button secondary compact" type="button" onClick={() => {
                      onNavigate(page.route!);
                      onClose();
                    }}>
                      {page.action}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </main>
        </div>

        <footer className="tutorial-footer">
          <span>{tutorialSections.length} 个分类，{pageCount} 项功能说明</span>
          <span>F1 随时打开</span>
          <button className="button primary compact" type="button" onClick={onClose}>开始使用</button>
        </footer>
      </section>
    </div>
  );
}
