目的

把当前项目按常见的 GitHub 工程布局整理，并说明每个功能在代码中的实现位置与实现方法，便于团队阅读与后续重构。

建议的仓库顶层结构（示例）

- README.md            # 已存在，项目总览与运行说明
- LICENSE              # （可选）添加许可证
- .github/workflows/   # CI 配置（可选）
- package.json         # 项目依赖与脚本
- tsconfig*.json       # TypeScript 配置
- vite.config.ts       # 构建配置
- src/                 # 前端源码（React + TSX）
- server/              # 后端/本地 API
- scripts/             # 辅助脚本（清理、打包等）
- output/              # 生成的 frames/videos（应加入 .gitignore）
- docs/                # 项目设计文档（可选）

当前文件映射与说明

- 前端入口与主应用
  - 文件: src/main.tsx, src/App.tsx
  - 说明: 使用 Vite + React + TypeScript，`main.tsx` 挂载应用，`App.tsx` 是顶层路由/界面容器。

- UI 组件
  - 位置: src/components/
  - 说明: 业务组件在 `src/components/`（如 `PromptForm.tsx`, `GenerationProgress.tsx`, `HistoryPanel.tsx`, `SettingsPanel.tsx`, `ShotCard.tsx`），可按域进一步拆分到 `components/ui/`（已有一组可复用 UI 原件）。

- Hooks 与工具库
  - 位置: src/hooks/use-mobile.ts
  - 工具库: src/lib/openai.ts  / src/lib/utils.ts
  - 说明: `openai.ts` 实现与 OpenAI 的封装交互（请求、返回处理、错误处理）；`utils.ts` 放置通用方法（时间格式化、文件路径处理等）。

- 类型定义
  - 位置: src/types/
  - 说明: 放置项目共享类型（如 storyboard 等）。

- 后端 / 本地服务
  - 位置: server/index.js
  - 说明: 提供本地 API 路由（例如代理调用 OpenAI、管理生成任务、提供静态文件），运行方式见 README 中的 scripts。

- 构建与配置
  - package.json: 依赖、npm 脚本（启动、构建、预览）
  - vite.config.ts: Vite 构建配置
  - tsconfig*.json: TypeScript 配置
  - tailwind.config.js / postcss.config.js / eslint.config.js: 样式与代码规范配置

- 脚本与 windows 启动
  - 位置: scripts/, scripts/windows/
  - 说明: 包含 `cleanup-output.js`、Windows 的批处理脚本（build.bat, preview.bat, start-server.bat, start.bat）用于本地运行与产出管理。

- 运行产物
  - 位置: output/frames/, output/videos/
  - 说明: 运行或生成后产出放在这里，应在 `.gitignore` 中忽略。

- 根页面
  - 文件: index.html
  - 说明: Vite 构建的 HTML 模板入口，静态元信息放在此。

- 项目配置文件
  - components.json: （项目特定配置，约束或预设）
  - README.md: 项目说明（已存在）

建议的具体重构与命令（示例，不会自动执行）

1) 在 Git 下移动文件（示例）：

```bash
# 在仓库根目录执行
git mv src/components src/components
mkdir -p docs
# 添加 LICENSE, .github/workflows 等
```

2) 更新 `.gitignore`：添加 `output/`、`node_modules/` 等。

3) 增加文档：在 `docs/` 中写入设计说明、API 文档与开发指南。

下一步（可选）

- 我可以根据上面的映射实际执行文件重构（git mv / 创建 .github / LICENSE / docs），或者仅生成 PR 提示。请告诉我你想要我立刻执行哪些操作。
