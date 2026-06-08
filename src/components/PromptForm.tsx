import { useState } from 'react';
import { Wand2, Palette, Sliders, Clock, Film, Move, Maximize2 } from 'lucide-react';
import type { AppSettings } from '../types/storyboard';
import { STYLES, FPS_OPTIONS, DURATION_OPTIONS, VARIATION_OPTIONS, IMAGE_SIZE_OPTIONS } from '../types/storyboard';

interface PromptFormProps {
  settings: AppSettings;
  onGenerate: (prompt: string, style: string, fps: number, durationSeconds: number) => void;
  onUpdateSettings: (s: AppSettings) => void;
  isGenerating: boolean;
}

const EXAMPLE_PROMPTS = [
  '宇航员在火星发现神秘外星遗迹，进入后触发了远古能量装置',
  '19世纪伦敦侦探追踪连环失踪案，最终揭开惊人阴谋',
  '2090年植物学家与AI机器人在最后一片雨林中守护绿色希望',
  '深夜东京街头，两个陌生人在雨中相遇，命运从此交织',
];

export function PromptForm({ settings, onGenerate, onUpdateSettings, isGenerating }: PromptFormProps) {
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState(settings.style || 'cinematic');
  const [fps, setFps] = useState(settings.fps || 8);
  const [durationSeconds, setDurationSeconds] = useState(settings.durationSeconds || 6);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || isGenerating) return;
    const trimmed = prompt.trim();
    if (trimmed.length > 2000) {
      alert('故事梗概过长，请控制在 2000 字以内');
      return;
    }
    const totalFrames = fps * durationSeconds;
    if (totalFrames > 200) {
      alert(`总帧数 ${totalFrames} 过多（上限 200 帧），请降低帧率或缩短时长`);
      return;
    }
    onGenerate(trimmed, style, fps, durationSeconds);
  }

  const totalFrames = fps * durationSeconds;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* 提示词输入 */}
      <div>
        <label className="block text-sm font-medium text-white/70 mb-2 flex items-center gap-2">
          <Wand2 size={15} className="text-violet-400" />
          故事梗概
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="输入故事梗概，Frame Prompt 将自动拆分为逐秒画面...&#10;例如：宇航员在火星发现外星遗迹..."
          rows={4}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/25 text-sm resize-none focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/50 transition-colors"
        />
        {/* 示例提示词 */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLE_PROMPTS.map((ex, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPrompt(ex)}
              className="text-xs px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-white/40 hover:text-white/70 hover:border-violet-500/50 transition-colors truncate max-w-[200px]"
              title={ex}
            >
              示例 {i + 1}
            </button>
          ))}
        </div>
      </div>

      {/* 风格选择 */}
      <div>
        <label className="block text-sm font-medium text-white/70 mb-2 flex items-center gap-2">
          <Palette size={15} className="text-rose-400" />
          视觉风格
        </label>
        <select
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500 transition-colors"
        >
          {STYLES.map((s) => (
            <option key={s.value} value={s.value} className="bg-gray-900">
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* 帧率 + 秒数 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-white/70 mb-2 flex items-center gap-2">
            <Film size={15} className="text-cyan-400" />
            每秒帧数
          </label>
          <div className="flex gap-1.5">
            {FPS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFps(opt.value)}
                className={`flex-1 py-2.5 rounded-xl text-xs border transition-colors font-medium ${
                  fps === opt.value
                    ? 'border-cyan-500 bg-cyan-500/25 text-cyan-300'
                    : 'border-white/10 bg-white/5 text-white/50 hover:border-white/25'
                }`}
              >
                {opt.value}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-white/70 mb-2 flex items-center gap-2">
            <Clock size={15} className="text-emerald-400" />
            视频时长
          </label>
          <div className="flex gap-1.5">
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDurationSeconds(opt.value)}
                className={`flex-1 py-2.5 rounded-xl text-xs border transition-colors font-medium ${
                  durationSeconds === opt.value
                    ? 'border-emerald-500 bg-emerald-500/25 text-emerald-300'
                    : 'border-white/10 bg-white/5 text-white/50 hover:border-white/25'
                }`}
              >
                {opt.value}s
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 帧间变化幅度 */}
      <div>
        <label className="block text-sm font-medium text-white/70 mb-2 flex items-center gap-2">
          <Move size={15} className="text-amber-400" />
          帧间变化幅度
          <span className="text-xs text-white/30 font-normal">越小越平滑</span>
        </label>
        <div className="flex gap-1.5">
          {VARIATION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onUpdateSettings({ ...settings, frameVariation: opt.value });
              }}
              className={`flex-1 py-2 rounded-xl text-xs border transition-colors font-medium ${
                settings.frameVariation === opt.value
                  ? 'border-amber-500 bg-amber-500/25 text-amber-300'
                  : 'border-white/10 bg-white/5 text-white/50 hover:border-white/25'
              }`}
              title={opt.desc}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-white/25 mt-1">
          {VARIATION_OPTIONS.find(o => o.value === settings.frameVariation)?.desc}
        </p>
      </div>

      {/* 图片尺寸 */}
      <div>
        <label className="block text-sm font-medium text-white/70 mb-2 flex items-center gap-2">
          <Maximize2 size={15} className="text-blue-400" />
          图片尺寸
          <span className="text-xs text-white/30 font-normal">选定后本次生成固定使用</span>
        </label>
        <div className="grid gap-1.5 grid-cols-2 sm:grid-cols-3">
          {IMAGE_SIZE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onUpdateSettings({ ...settings, imageSize: opt.value });
              }}
              className={`py-2 px-2.5 rounded-xl text-xs border transition-colors font-medium ${
                settings.imageSize === opt.value
                  ? 'border-blue-500 bg-blue-500/25 text-blue-300'
                  : 'border-white/10 bg-white/5 text-white/50 hover:border-white/25'
              }`}
              title={opt.desc}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-white/25 mt-1">
          {IMAGE_SIZE_OPTIONS.find(o => o.value === settings.imageSize)?.desc || '生成图片的分辨率'}
        </p>
      </div>

      {/* 帧数预览 */}
      <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/5 border border-white/8">
        <span className="text-xs text-white/40">总计帧数</span>
        <span className="text-sm font-semibold text-white/80 flex items-center gap-1.5">
          <Sliders size={13} className="text-violet-400" />
          {totalFrames} 帧
          <span className="text-white/30 font-normal">({fps}fps × {durationSeconds}s)</span>
        </span>
      </div>

      {/* 提交按钮 */}
      <button
        type="submit"
        disabled={!prompt.trim() || isGenerating}
        className="w-full py-3 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-lg shadow-violet-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isGenerating ? (
          <>
            <Sliders size={16} className="animate-spin" />
            生成中...
          </>
        ) : (
          <>
            <Wand2 size={16} />
            生成分镜
          </>
        )}
      </button>
    </form>
  );
}
