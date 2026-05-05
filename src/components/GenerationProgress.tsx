import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import type { GenerationStep } from '../types/storyboard';

interface GenerationProgressProps {
  step: GenerationStep;
  totalShots: number;
  completedShots: number;
  error?: string;
}

export function GenerationProgress({
  step,
  totalShots,
  completedShots,
  error,
}: GenerationProgressProps) {
  if (step === 'idle' || step === 'done') return null;

  const steps = [
    { key: 'expanding-story', label: '展开完整剧情', icon: '📖' },
    { key: 'generating-script', label: '生成分镜脚本', icon: '📝' },
    { key: 'generating-images', label: `生成图像 (${completedShots}/${totalShots})`, icon: '🎨' },
  ];

  const stepOrder: GenerationStep[] = ['expanding-story', 'generating-script', 'generating-images'];
  const currentIdx = stepOrder.indexOf(step);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-full max-w-sm mx-4">
      <div className="bg-gray-900/95 backdrop-blur-xl border border-white/15 rounded-2xl px-5 py-4 shadow-2xl">
        {error ? (
          <div className="flex items-center gap-3 text-red-400">
            <AlertCircle size={18} />
            <div>
              <p className="text-sm font-medium">生成失败</p>
              <p className="text-xs text-red-400/70 mt-0.5 line-clamp-2">{error}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {steps.map((s, idx) => {
              const isActive = step === s.key;
              const isDone = idx < currentIdx;

              return (
                <div key={s.key} className={`flex items-center gap-3 ${!isActive && !isDone ? 'opacity-30' : ''}`}>
                  <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0">
                    {isDone ? (
                      <CheckCircle size={16} className="text-green-400" />
                    ) : isActive ? (
                      <Loader2 size={16} className="text-violet-400 animate-spin" />
                    ) : (
                      <span className="text-sm">{s.icon}</span>
                    )}
                  </div>
                  <span
                    className={`text-sm ${
                      isActive ? 'text-white' : isDone ? 'text-green-400' : 'text-white/40'
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
              );
            })}
            {/* 进度条（图像生成阶段） */}
            {step === 'generating-images' && totalShots > 0 && (
              <div className="mt-2 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-violet-500 to-cyan-500 rounded-full transition-all duration-500"
                  style={{ width: `${(completedShots / totalShots) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
