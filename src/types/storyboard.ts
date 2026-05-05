// 分镜相关类型定义

export interface Shot {
  id: string;
  index: number;
  segmentIndex: number;       // 所属故事段落索引（0-based）
  segmentDescription: string; // 所属段落的故事描述
  shotType: string;           // 镜头类型（远景/中景/特写等）
  sceneDescription: string;   // 场景描述
  cameraMovement: string;     // 镜头运动
  mood: string;               // 情绪/氛围
  duration: string;           // 时长建议（现在统一 1/fps 秒）
  imagePrompt: string;       // 当前使用的完整图像提示词（可能包含用户修改）
  baseImagePrompt: string;   // 原始 AI 生成的基础提示词（不含用户修改）
  characterDescription: string; // 人物外貌描述（所有镜头保持一致）
  imageUrl?: string;         // 生成的图像 URL（base64 或 URL）
  referenceImageUrl?: string; // 参考图 URL（用户上传的参考图，base64）
  maskImageUrl?: string;     // 蒙版图（白色不透明=角色区域要重绘，黑色不透明=背景保留，RGBA PNG）
  actionDescription?: string; // 角色动作描述（用于 inpaint prompt 的动作部分）
  imageStatus: 'idle' | 'loading' | 'done' | 'error';
  imageError?: string;
}

/** 故事段落（1 秒的故事内容） */
export interface StorySegment {
  index: number;              // 段落序号（0-based）
  timeRange: string;          // 时间范围，如 "0s-1s"
  description: string;        // 段落故事描述
  shots: Shot[];              // 该段落的帧
}

export interface StoryboardProject {
  id: string;
  title: string;
  userPrompt: string;
  style: string;
  fps: number;               // 帧率
  durationSeconds: number;    // 视频总秒数
  shots: Shot[];
  segments: StorySegment[];   // 故事段落
  createdAt: string;
  fullStory?: string;         // 文本模型展开的完整故事
  videoUrl?: string;          // 合成视频的 URL
  backgroundImageUrl?: string; // 固定背景图（背景分离方案）
  backgroundPrompt?: string;   // 背景图生成所用的 prompt
}

export type GenerationStep =
  | 'idle'
  | 'expanding-story'
  | 'generating-script'
  | 'generating-images'
  | 'composing-video'
  | 'done'
  | 'error';

export interface AppSettings {
  imageModel: 'gpt-image-2' | 'dall-e-3';
  fps: number;               // 帧率（1秒几帧）
  durationSeconds: number;    // 视频秒数
  style: string;
  /** 帧间变化幅度（0.01-0.30）：控制相邻帧之间允许的画面变化量，越小越平滑 */
  frameVariation: number;
  /** 图片尺寸（宽x高），当前固定为 1024x1024 */
  imageSize: string;
}

/** 图片尺寸选项：用户选择后，本次生成流程内固定使用该尺寸 */
export const IMAGE_SIZE_OPTIONS = [
  { value: '1024x1024', label: '1024×1024', desc: '正方形，标准' },
  { value: '1024x1536', label: '1024×1536', desc: '竖版 2:3' },
  { value: '768x1024', label: '768×1024', desc: '竖版 3:4' },
  { value: '1536x1024', label: '1536×1024', desc: '横版 3:2' },
  { value: '1024x768', label: '1024×768', desc: '横版 4:3' },
  { value: '1280x720', label: '1280×720', desc: '横版 16:9' },
  { value: '1920x1080', label: '1920×1080', desc: '全高清 16:9' },
];

export const STYLES = [
  { value: 'cinematic', label: '电影感' },
  { value: 'anime', label: '日系动漫' },
  { value: 'noir', label: '黑色电影' },
  { value: 'documentary', label: '纪录片' },
  { value: 'fantasy', label: '奇幻史诗' },
  { value: 'sci-fi', label: '科幻未来' },
  { value: 'horror', label: '恐怖悬疑' },
  { value: 'romance', label: '浪漫爱情' },
];

/** 帧率选项：1秒生成几帧 */
export const FPS_OPTIONS = [
  { value: 4, label: '4 fps' },
  { value: 6, label: '6 fps' },
  { value: 8, label: '8 fps' },
  { value: 12, label: '12 fps' },
  { value: 24, label: '24 fps' },
  { value: 30, label: '30 fps' },
];

/** 视频秒数选项 */
export const DURATION_OPTIONS = [
  { value: 4, label: '4 秒' },
  { value: 6, label: '6 秒' },
  { value: 8, label: '8 秒' },
  { value: 10, label: '10 秒' },
  { value: 12, label: '12 秒' },
];

/** 帧间变化幅度选项 */
export const VARIATION_OPTIONS = [
  { value: 0.03, label: '极小', desc: '几乎静止，仅微表情' },
  { value: 0.06, label: '很小', desc: '轻微动作变化' },
  { value: 0.10, label: '小', desc: '缓慢动作，推荐' },
  { value: 0.18, label: '中', desc: '明显动作' },
  { value: 0.30, label: '大', desc: '大幅动作' },
];

