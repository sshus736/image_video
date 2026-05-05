import { useState } from 'react';
import { Settings, Cpu, Film, Clock, Palette, Move, Maximize2 } from 'lucide-react';
import type { AppSettings } from '../types/storyboard';
import { STYLES, FPS_OPTIONS, DURATION_OPTIONS, VARIATION_OPTIONS, IMAGE_SIZE_OPTIONS } from '../types/storyboard';
import { saveSettings } from '../lib/openai';

interface SettingsPanelProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
}

export function SettingsPanel({ settings, onUpdate }: SettingsPanelProps) {
  const [open, setOpen] = useState(false);

  function handleChange(field: keyof AppSettings, value: string | number) {
    const updated = { ...settings, [field]: value };
    onUpdate(updated);
    saveSettings(updated);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-white/80 hover:text-white text-sm"
      >
        <Settings size={16} />
        <span>设置</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <div className="flex items-center gap-2 mb-6">
              <Settings size={20} className="text-violet-400" />
              <h2 className="text-lg font-semibold text-white">生成设置</h2>
            </div>

            {/* Image Model */}
            <div className="mb-5">
              <label className="block text-sm text-white/60 mb-2 flex items-center gap-1">
                <Cpu size={14} /> 图像生成模型
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(['gpt-image-2', 'dall-e-3'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => handleChange('imageModel', m)}
                    className={`px-3 py-2.5 rounded-lg text-sm border transition-colors ${
                      settings.imageModel === m
                        ? 'border-violet-500 bg-violet-500/20 text-violet-300'
                        : 'border-white/10 bg-white/5 text-white/60 hover:border-white/30'
                    }`}
                  >
                    {m === 'gpt-image-2' ? 'GPT Image 2' : 'DALL·E 3'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-white/30 mt-1.5">
                {settings.imageModel === 'gpt-image-2'
                  ? 'GPT Image 2：最新高质量模型，支持图生图，需要 API 访问权限'
                  : 'DALL·E 3：稳定快速，适合大多数场景'}
              </p>
            </div>

            {/* 默认帧率 */}
            <div className="mb-5">
              <label className="block text-sm text-white/60 mb-2 flex items-center gap-1">
                <Film size={14} /> 默认帧率
              </label>
              <div className="flex gap-2">
                {FPS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleChange('fps', opt.value)}
                    className={`flex-1 py-2.5 rounded-lg text-xs border transition-colors ${
                      settings.fps === opt.value
                        ? 'border-cyan-500 bg-cyan-500/20 text-cyan-300'
                        : 'border-white/10 bg-white/5 text-white/60 hover:border-white/30'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 默认视频时长 */}
            <div className="mb-5">
              <label className="block text-sm text-white/60 mb-2 flex items-center gap-1">
                <Clock size={14} /> 默认视频时长
              </label>
              <div className="flex gap-2 flex-wrap">
                {DURATION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleChange('durationSeconds', opt.value)}
                    className={`flex-1 min-w-[48px] py-2.5 rounded-lg text-xs border transition-colors ${
                      settings.durationSeconds === opt.value
                        ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                        : 'border-white/10 bg-white/5 text-white/60 hover:border-white/30'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Style */}
            <div className="mb-5">
              <label className="block text-sm text-white/60 mb-2 flex items-center gap-1">
                <Palette size={14} /> 默认风格
              </label>
              <select
                value={settings.style}
                onChange={(e) => handleChange('style', e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
              >
                {STYLES.map((s) => (
                  <option key={s.value} value={s.value} className="bg-gray-900">
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 帧间变化幅度 */}
            <div className="mb-6">
              <label className="block text-sm text-white/60 mb-2 flex items-center gap-1">
                <Move size={14} /> 帧间变化幅度
              </label>
              <div className="flex gap-2 flex-wrap">
                {VARIATION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleChange('frameVariation', opt.value)}
                    className={`flex-1 min-w-[56px] py-2 rounded-lg text-xs border transition-colors ${
                      settings.frameVariation === opt.value
                        ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                        : 'border-white/10 bg-white/5 text-white/60 hover:border-white/30'
                    }`}
                    title={opt.desc}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-white/30 mt-1.5">
                {VARIATION_OPTIONS.find(o => o.value === settings.frameVariation)?.desc || '控制相邻帧画面差异大小'}
              </p>
            </div>

            {/* 图片尺寸 */}
            <div className="mb-6">
              <label className="block text-sm text-white/60 mb-2 flex items-center gap-1">
                <Maximize2 size={14} /> 图片尺寸
              </label>
              <div className="grid grid-cols-2 gap-2">
                {IMAGE_SIZE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleChange('imageSize', opt.value)}
                    className={`px-3 py-2 rounded-lg text-xs border transition-colors ${
                      settings.imageSize === opt.value
                        ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                        : 'border-white/10 bg-white/5 text-white/60 hover:border-white/30'
                    }`}
                    title={opt.desc}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-white/30 mt-1.5">
                {IMAGE_SIZE_OPTIONS.find(o => o.value === settings.imageSize)?.desc || '生成图片的分辨率'}
              </p>
            </div>

            <button
              onClick={() => setOpen(false)}
              className="w-full px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm transition-colors"
            >
              完成
            </button>
          </div>
        </div>
      )}
    </>
  );
}
