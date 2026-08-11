---
name: ArcWriter
description: 本地优先的 AI 小说创作工作台，以安静纸面、清晰上下文和可追溯写入为核心。
colors:
  ink: "oklch(25% 0.018 285)"
  text: "oklch(34% 0.018 285)"
  muted: "oklch(52% 0.018 285)"
  faint: "oklch(64% 0.014 285)"
  paper: "oklch(98.4% 0.012 82)"
  paper-warm: "oklch(96.8% 0.017 82)"
  stone: "oklch(95.2% 0.009 285)"
  stone-deep: "oklch(92.5% 0.012 285)"
  line: "oklch(87.5% 0.013 285)"
  line-strong: "oklch(78% 0.018 285)"
  accent: "oklch(42% 0.075 335)"
  accent-hover: "oklch(36% 0.074 335)"
  accent-soft: "oklch(94.5% 0.025 335)"
  success: "oklch(45% 0.068 142)"
  warning: "oklch(52% 0.08 75)"
  danger: "oklch(48% 0.10 28)"
  focus: "oklch(63% 0.08 335)"
typography:
  body:
    fontFamily: "Inter, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "normal"
  control:
    fontFamily: "Inter, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: "normal"
  heading:
    fontFamily: "Inter, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 680
    lineHeight: "28px"
  page-title:
    fontFamily: "Inter, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: "28px"
  manuscript:
    fontFamily: "Source Han Serif SC, Songti SC, STSong, serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "2"
rounded:
  compact: "4px"
  control: "6px"
  panel: "8px"
spacing:
  tight: "4px"
  compact: "8px"
  control: "12px"
  section: "20px"
  page: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.paper}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  workspace-nav-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.control}"
    rounded: "{rounded.compact}"
    padding: "0 9px"
    height: "31px"
  input-default:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 9px"
    height: "34px"
---

# Design System: ArcWriter

## Overview

**Creative North Star: "The Quiet Writing Desk"**

ArcWriter is a calm, local-first writing desk rather than an AI control room. Its warm paper ground keeps the manuscript and the author in charge; cool violet-grey neutrals recede into navigation, controls and operational detail. A restrained plum accent marks the few places where a user can act, commit or understand current selection.

The system has the density of a professional desktop tool, but it earns density through hierarchy. The workspace is a stable 210px navigation rail, a 62px context bar and one dominant working surface. AI, planning, setting libraries and background work are visible when relevant, then collapse or move to progressive disclosure. High-risk writing always names the destination, change mode and status before it can alter a project.

**Key Characteristics:**

- Warm reading surfaces, cool operational surfaces and one controlled plum accent.
- Chinese-first desktop typography, with a dedicated Songti manuscript voice.
- Fine 1px dividers and tonal changes establish structure before shadows do.
- Inline confirmation and right-side drawers preserve context instead of interrupting it.
- Compact controls, 1024px minimum desktop layout and a collapsed navigation treatment for narrow windows.

## Colors

The palette is deliberately quiet: paper carries attention, plum carries intent, and status colors only report verifiable state. The frontmatter values are canonical because the implementation is authored in OKLCH.

### Primary

- **Plum Ink:** used for primary actions, active navigation, selected writing modes and links that move the work forward. Its soft companion is reserved for active or selected backgrounds, never used as a large decorative field.

### Secondary

- **Moss Confirmation:** used for saved, healthy and completed state, always with text or an icon rather than colour alone.
- **Amber Attention:** used for pending writes, warnings and review-needed state. It must tell the user what needs attention.
- **Brick Error:** used for failed operations and destructive actions. It never substitutes for an explanation.

### Neutral

- **Warm Paper:** the main reading and working surface. It is nearly white but never clinical white.
- **Violet Stone:** the sidebar, secondary panels and segmented-control base. It separates operations from manuscript without turning the application dark.
- **Violet Ink:** the main text ramp, moving from ink to text, muted and faint for a four-level hierarchy.
- **Fine Rule:** 1px structural borders. Use the stronger rule only for an interactive boundary, a persistent drawer or a focus-adjacent separation.

### Named Rules

**The One Plum Rule.** Plum is an action and selection signal. Keep it below roughly one tenth of a normal workspace surface, so the next meaningful action remains immediately legible.

**The Status Must Speak Rule.** Success, warning and error always appear with explicit Chinese status copy and, where space permits, an icon. Colour is reinforcement, never the only carrier of meaning.

## Typography

**Display Font:** Inter, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif.
**Body Font:** Inter, Segoe UI, Microsoft YaHei UI, system-ui, sans-serif.
**Manuscript Font:** Source Han Serif SC, Songti SC, STSong, serif.

**Character:** Interface type is compact, neutral and highly legible in common Windows environments. Manuscript type changes to a Chinese serif face with a 2.0 line height, 2em first-line indent and a centred 650px reading measure, making the writing surface feel authored rather than administrative.

### Hierarchy

- **Page title** (700, 20px, 28px): one title per working surface. Pair with a short muted explanation only when it clarifies the next action.
- **Section heading** (680, 16px, 28px): panel and section anchors. It should never compete with a page title.
- **Control label** (650, 13px): buttons, navigation items, key-value labels and compact operation rows.
- **Body** (400, 14px): supporting interface copy. Keep explanatory paragraphs concise and near the control they explain.
- **Caption** (400 to 650, 12px): metadata, helper copy, dates, keyboard hints and secondary status.
- **Manuscript** (400, 15px, 2.0): the only long-form reading style. Maintain its 650px maximum measure and do not place dashboard chrome inside it.

### Named Rules

**The Manuscript Has the Last Word Rule.** In an active editor, manuscript text is visually larger, more spacious and more central than every navigation or AI control around it.

## Elevation

ArcWriter is flat by default. Depth comes from warm-versus-stone tonal layering, 1px rules and persistent spatial zones. The only shared shadow is a diffused, low-contrast two-layer shadow for an elevated command surface, a home continuation surface or a persistent review drawer. It must never be used to decorate every panel.

### Shadow Vocabulary

- **Quiet lift** (`0 1px 2px oklch(25% 0.015 285 / 0.08), 0 4px 8px oklch(25% 0.015 285 / 0.05)`): a low ambient lift for a surface temporarily raised above the writing plane.
- **Drawer lift** (`-14px 0 32px rgba(53, 39, 29, .16)`): reserved for the right-side pending-review drawer. It explains a changed plane without simulating glass.

### Named Rules

**The Paper Stack Rule.** If a surface can be separated by paper, stone or a fine rule, do that. Add a shadow only when the surface physically overlays another working plane.

## Components

### Buttons

- **Shape:** compactly rounded controls (6px), usually 32px tall with a 6px icon-to-label gap.
- **Primary:** Plum Ink fill, Warm Paper text, 12px horizontal padding. Reserve it for commit, create, save and advance actions. A page normally has one primary action cluster.
- **Hover / Focus:** primary hover darkens to the existing plum hover token. Keyboard focus is a 2px Focus Plum outline offset by 2px. Disabled controls stay visible at 48% opacity and cannot imply availability.
- **Secondary:** Warm Paper fill, Fine Rule border and Violet Ink text. Hover changes to Violet Stone and strengthens the border.
- **Tertiary:** text and icon only, normally Plum Ink. Use it for navigation to details, not for a destructive or irreversible commitment.

### Cards / Containers

- **Corner Style:** quiet 8px panels, 6px controls and 4px compact chips or row selections.
- **Background:** Warm Paper for the active plane; Violet Stone for a supporting plane; Warm Paper Soft for a welcoming or manuscript-adjacent surface.
- **Border:** one Fine Rule. Do not use coloured side stripes.
- **Internal Padding:** 8px for dense rows, 12px for control groups, 20px to 24px for page sections.

### Inputs / Fields

- **Style:** Warm Paper background, Fine Rule border, compact 13px interface type and at least 34px height.
- **Focus:** 2px Focus Plum outline with a 2px offset. Focus must remain obvious against both paper and stone.
- **Error / Disabled:** errors use Brick Error plus cause and recovery copy; disabled fields use opacity, not faded text alone.

### Navigation

- **Structure:** a persistent 210px Violet Stone rail grouped by writing, planning, materials, review and tools. The top context bar stays 62px tall and names the active project or surface.
- **States:** default items are quiet Violet Ink; hover uses Violet Stone Deep; active uses Plum Ink on Plum Soft with stronger weight. Keep the active treatment to the actual current route.
- **Narrow desktop:** at 1120px, collapse the rail to 58px and keep icons available. The product remains a desktop workspace with a 1024px minimum width, not a squeezed mobile layout.

### Pending Review

- **Purpose:** generated work remains read-only until confirmation. The message-level panel names the target, write mode, character change, preview and failure reason; the global drawer gathers every outstanding item across pages.
- **Risk treatment:** replacement writes show an amber warning in the same panel. The primary button says the exact action, such as confirming an outline overwrite or appending a chapter.
- **Interaction:** use inline expansion and the non-blocking right drawer before considering a modal. Preserve the source conversation, destination and retry path.

## Do's and Don'ts

### Do:

- **Do** keep the main workspace on Warm Paper and support rails or secondary panels on Violet Stone.
- **Do** use the 12px, 13px, 14px, 16px and 20px type ladder. Give manuscript copy its dedicated 15px Songti treatment rather than treating it as generic body text.
- **Do** use 1px Fine Rule borders, 6px controls and 8px panels to make dense desktop information easy to scan.
- **Do** show AI context, destination, overwrite scope, failure reason and recovery action near the operation that needs them.
- **Do** respect `prefers-reduced-motion` and retain the visible 2px keyboard focus outline.
- **Do** use progressive disclosure: message preview first, right-side review drawer second, a modal only when the work genuinely cannot remain in context.

### Don't:

- **Don't** turn ArcWriter into a generic SaaS dashboard, with hero metrics, equal-weight card grids or a control-room visual hierarchy.
- **Don't** use decorative glassmorphism, large high-saturation blue fields or purple gradients. The product is a quiet writing desk, not a generic AI tool.
- **Don't** make the interface resemble a code IDE. Files and advanced controls are supporting structure, never the visual protagonist over the manuscript.
- **Don't** let three columns compete at equal visual weight. The active writing or planning surface must own the centre of the screen.
- **Don't** use a coloured left or right card stripe, gradient text, decorative blur or shadow stacks to manufacture hierarchy.
- **Don't** use status colour without clear Chinese copy, an icon where appropriate and an actionable next step for errors.
- **Don't** hide what AI read, where a result will write or what an overwrite replaces. High-risk actions must state target, scope and recovery path before commitment.
