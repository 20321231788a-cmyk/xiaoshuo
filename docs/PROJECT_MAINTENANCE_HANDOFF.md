# ArcWriter 项目维护与发布交接

## 仓库与分支

- GitHub 仓库：`https://github.com/20321231788a-cmyk/xiaoshuo`
- 主分支：`main`
- 桌面应用包：`apps/desktop-shell`
- 前端工作台：`apps/workbench`
- 运行时与业务包：`packages/*`

## 本地开发

```powershell
npm install
npm run dev:desktop
```

常用验证：

```powershell
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
```

本地打包：

```powershell
npm run dist -w @xiaoshuo/desktop-shell
```

安装包输出目录：

```text
apps/desktop-shell/release/
```

## 发布到 GitHub Releases

1. 修改 `apps/desktop-shell/package.json` 的 `version`。
2. 同步锁文件：

```powershell
npm install --package-lock-only -w @xiaoshuo/desktop-shell
```

3. 提交并推送：

```powershell
git add .
git commit -m "Release ArcWriter x.y.z"
git push origin main
```

4. 创建并推送标签：

```powershell
git tag -a vx.y.z -m "ArcWriter x.y.z"
git push origin vx.y.z
```

5. GitHub Actions 会自动构建 Windows 安装包并上传到 Release，产物应包含：

- `ArcWriter-Setup-x.y.z.exe`
- `latest.yml`

## 软件更新链路

- 客户端使用公开 GitHub Releases 检查更新。
- 更新源在 `apps/desktop-shell/package.json` 的 `build.publish` 中配置。
- 主进程更新服务在 `apps/desktop-shell/src/main/update-service.ts`。
- 设置页“软件更新”面板在 `apps/workbench/src/App.tsx`。
- 不要在客户端写入 GitHub token；CI 使用仓库自带 `GITHUB_TOKEN` 发布。

## 网站配置入口

- 网站首页：`https://matian.online/`
- 注册入口：`https://matian.online/?page=api-relay&auth=register`
- 软件在未配置 AI 线路且没有项目使用历史时，默认打开“设置 - 网站配置”。
- 网站配置界面不显示 URL、API Key、token 或 Base URL。

## 常见注意事项

- `studio_config.json` 是本地配置，可能包含敏感信息，不要提交。
- `dist/`、`release/`、`output/`、`test-results/`、截图和日志都是产物，不要提交。
- Electron 主进程是 ESM；`electron-updater` 需要通过 `createRequire` 加载，避免打包后 named export 崩溃。
- 当前本地 `dist`/`release` 脚本使用 `-c.npmRebuild=false`，避免没有 Visual Studio Build Tools 的机器重建原生依赖失败。
- 发布后建议下载 GitHub Release 的安装包手动安装一次，验证启动、图标、菜单、教程、网站配置和更新检查。
