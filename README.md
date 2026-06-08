# AI分镜工作室 - 视频版

输入故事梗概 → AI 展开完整剧情 → 生成分镜脚本 → 逐帧生成图像 → 合成视频

## 🚀 快速启动

### 方法一：一键启动（推荐）
双击运行 `start.bat`

### 方法二：命令行
```bash
cd d:/Share/web/image_video
npm install   # 首次运行需要
npm run dev
```

## ✨ 新增功能（v2.0）

- **📖 故事展开**：输入简短梗概，ChatGPT 5.5 自动展开为完整剧情
- **🎬 视频合成**：所有帧图片生成后，一键合成 MP4 视频
- **🔄 三步流程**：梗概 → 展开故事 → 分镜生图 → 合成视频

## 📋 完整工作流

```
用户输入故事梗概（1-2句话）
       ↓
ChatGPT 5.5 展开为完整剧情（800-1200字）
       ↓
ChatGPT 5.5 将剧情拆分为 N 个分镜脚本（含人物一致性描述）
       ↓
GPT Image 2 并发生成每一帧图像（3并发）
       ↓
ffmpeg 将帧序列合成为 MP4 视频（8fps）
       ↓
在浏览器播放 / 下载视频
```

## ⚙️ 配置

1. 复制 `.env.example` 为 `.env`
2. 填入 API Key：

```env
# 图像生成 API（gpt-image-2 反代）
IMAGE_API_BASE=https://wzjself.org/v1
IMAGE_API_KEY=your_image_api_key_here

# 文本生成 API（OpenAI / ChatGPT 5.5）
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=your_openai_api_key_here
```

## 🔧 技术栈

- React 19 + TypeScript 5.9
- Vite 7 构建工具
- Tailwind CSS + shadcn/ui
- Express 5 后端代理
 - ChatGPT 5.5（故事展开 + 分镜脚本）
- GPT Image 2（帧图像生成）
- ffmpeg（视频合成）

## 📂 项目结构

```
image_video/
├── src/
│   ├── App.tsx                  # 主应用（三步流程 + 视频合成）
│   ├── components/
│   │   ├── PromptForm.tsx       # 梗概输入表单
│   │   ├── ShotCard.tsx         # 分镜卡片（含图生图）
│   │   ├── GenerationProgress.tsx # 三步进度指示器
│   │   └── ...
│   ├── lib/
│   │   └── openai.ts            # API 层（故事展开 + 生图 + 合成视频）
│   └── types/
│       └── storyboard.ts        # 类型定义
├── server/
│   └── index.js                 # Express 后端（含视频合成 API）
├── output/                      # 生成的帧图片和视频
├── .env                         # API 配置
└── scripts/
       └── windows/
              ├── start.bat            # 启动脚本
              ├── build.bat            # 构建脚本
              ├── preview.bat          # 预览脚本
              └── start-server.bat     # 后端启动脚本
```

## 📁 脚本说明

| 脚本 | 说明 |
|------|------|
| `scripts/windows/start.bat` | 一键启动开发服务器 |
| `scripts/windows/build.bat` | 构建生产版本 |
| `scripts/windows/preview.bat` | 预览生产版本 |
| `scripts/windows/start-server.bat` | 启动后端服务 |
