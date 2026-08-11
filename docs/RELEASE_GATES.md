# ArcWriter 发布流程

## 默认：小范围正式发布

所有与桌面包版本一致的带注释 `vX.Y.Z` 标签都会触发
`.github/workflows/release-small-scale.yml`。工作流会从标签源码执行完整
`npm run acceptance:preview`，构建 Windows 安装包，并创建非预发布 GitHub
Release。

每次发布仅上传：

- `ArcWriter-Setup-<version>.exe`
- `ArcWriter-Setup-<version>.exe.blockmap`
- `latest.yml`

发布前要求：

1. `main` 已推送且工作区干净；
2. `apps/desktop-shell/package.json`、锁文件与标签版本完全一致；
3. 标签必须为带注释的标签；
4. 本地已完成 `npm run acceptance:preview`；
5. Release 说明明确“仅供小规模使用、可能未签名、非商业稳定版”。

工作流会再次校验标签类型与目标、版本一致性、完整验收和全部发布附件。
发布后必须核对分支、标签目标、Release 状态、附件大小和 SHA-256。

## 可选的严格发布准备

`desktop-rc.yml` 仍可用于额外的夜间、安装态和 RC 质量验证。签名、受保护
环境、密封评估、长时间 soak 与商业级证据属于扩大发布范围前的附加要求，
不阻塞默认的小范围正式发布。

## 禁止事项

- 不得将未通过验收的安装包上传到 Release；
- 不得覆盖或永久删除用户项目文件；
- 不得声称小范围发布已经满足商业稳定版、签名或严格 RC 门槛；
- 不得发布标签与应用版本不一致的构建。
