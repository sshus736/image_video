import { useState, useEffect, useCallback, useRef } from 'react';
import { Film, Sparkles, ImageIcon, Play, Download, Layers, AlertCircle } from 'lucide-react';
import './App.css';

import type { Shot, StoryboardProject, GenerationStep, AppSettings } from './types/storyboard';
import {
  generateFullStory,
  generateStoryboardScript,
  generateShotImage,
  saveProject,
  loadProjects,
  loadSettings,
  saveSettings,
} from './lib/openai';

import { SettingsPanel } from './components/SettingsPanel';
import { PromptForm } from './components/PromptForm';
import { ShotCard } from './components/ShotCard';
import { GenerationProgress } from './components/GenerationProgress';
import { HistoryPanel } from './components/HistoryPanel';

function App() {
  const loadedSettings = loadSettings();
  const [settings, setSettings] = useState<AppSettings>(() => ({
    imageModel: loadedSettings.imageModel || 'gpt-image-2',
    fps: loadedSettings.fps || 8,
    durationSeconds: loadedSettings.durationSeconds || 6,
    style: loadedSettings.style || 'cinematic',
    frameVariation: loadedSettings.frameVariation ?? 0.10,
    imageSize: loadedSettings.imageSize || '1024x1024',
  }));

  const [currentProject, setCurrentProject] = useState<StoryboardProject | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [step, setStep] = useState<GenerationStep>('idle');
  const [error, setError] = useState<string | undefined>();
  const [completedImageCount, setCompletedImageCount] = useState(0);
  const [projects, setProjects] = useState<StoryboardProject[]>(() => loadProjects());

  // 完整故事 & 视频 & 当前设置参数
  const [fullStory, setFullStory] = useState('');
  const [currentFps, setCurrentFps] = useState(8);

  // 固定背景图（背景分离方案）
  const [backgroundImageUrl, setBackgroundImageUrl] = useState<string | undefined>();

  // 用 ref 跟踪最新的 shots，避免 generateSingleImage 闭包过期
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;
  const backgroundImageRef = useRef<string | undefined>(undefined);
  backgroundImageRef.current = backgroundImageUrl;

  // 保存项目到 localStorage（不存 base64 图片数据，只存元数据）
  useEffect(() => {
    if (currentProject && shots.length > 0) {
      try {
        const updated = { ...currentProject, shots, fullStory };
        saveProject(updated);
        setProjects(loadProjects());
      } catch (err) {
        console.warn('[App] Failed to save project:', (err as Error).message);
      }
    }
  }, [shots, fullStory]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 完整流程：梗概 → 展开故事(按秒分段) → 分镜提示词 → 生图 ───────────
  const handleGenerate = useCallback(
    async (prompt: string, style: string, fps: number, durationSeconds: number) => {
      setStep('expanding-story');
      setError(undefined);
      setShots([]);
      setCompletedImageCount(0);
      setFullStory('');
      setCurrentFps(fps);

      try {
        // ── Step 1: 展开故事 + 按秒拆分段落 ──
        const { fullStory: story, segments } = await generateFullStory(prompt, durationSeconds);
        setFullStory(story);
        setStep('generating-script');

        // ── Step 2: 为每个段落的每帧生成分镜提示词（同时生成固定背景图）──
        const { shots: newShots, backgroundImageUrl: bgUrl, backgroundPrompt: bgPrompt } =
          await generateStoryboardScript(segments, style, fps, settings.frameVariation, settings.imageSize);

        // 存储背景图（供逐帧 inpaint 使用）
        setBackgroundImageUrl(bgUrl);

        const project: StoryboardProject = {
          id: `project-${Date.now()}`,
          title: prompt.slice(0, 40) + (prompt.length > 40 ? '...' : ''),
          userPrompt: prompt,
          style,
          fps,
          durationSeconds,
          shots: newShots,
          segments,
          createdAt: new Date().toISOString(),
          backgroundImageUrl: bgUrl,
          backgroundPrompt: bgPrompt,
        };

        setCurrentProject(project);
        setShots(newShots);
        shotsRef.current = newShots; // 手动同步 ref，避免 generateSingleImage 闭包读到空数组
        setStep('generating-images');

        // ── Step 3: 并发生成所有帧图像（3 并发） ──
        await generateImagesInBatches(newShots, 3, settings.imageSize);
        setStep('done');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[handleGenerate] error:', msg);
        setError(msg);
        setStep('error');
        // 不自动恢复，让用户看到错误信息
      }
    },
    [settings]
  );

  // ─── 批量生成图像（段主帧 + 参考图链 方案） ────────────────────────────────
  // 策略：
  //   Phase 1: 逐段串行生成每段的"主帧"（第1帧），段间用前一帧作参考图锚定
  //   Phase 2: 段内剩余帧并发生成，统一使用本段主帧作为参考图
  //
  // 核心理念：先产生主体图片，后续所有帧都在主体图片上微调，而非重新生成。
  //   有背景图时，主帧走 inpaint（背景+蒙版+提示词），保证背景绝对固定；
  //   无背景图时，主帧走直接生图。后续帧统一走「参考图 + 图生图」模式。
  //
  // 快速失败：连续 3 帧失败则中止，避免长时间无响应
  async function generateImagesInBatches(shotList: Shot[], concurrency: number, imageSize: string = '1024x1024') {
    let failCount = 0;
    let consecutiveFails = 0;
    const MAX_CONSECUTIVE_FAILS = 3;
    const bgUrl = backgroundImageRef.current;
    const effectiveConcurrency = 1; // 串行避免凭证池冷却

    // 按段分组（保持 segmentIndex 排序）
    const segGroups = new Map<number, Shot[]>();
    for (const shot of shotList) {
      if (!segGroups.has(shot.segmentIndex)) segGroups.set(shot.segmentIndex, []);
      segGroups.get(shot.segmentIndex)!.push(shot);
    }
    const segEntries = Array.from(segGroups.entries()).sort(([a], [b]) => a - b);

    // ═══════════════════════════════════════════════════════════════════════════
    // Phase 1: 逐段生成「主帧」（每段第 1 帧）—— 串行以保证跨段参考链
    // ═══════════════════════════════════════════════════════════════════════════
    let crossSegmentRef: string | undefined; // 上一段主帧的 imageUrl

    for (const [segIdx, segShots] of segEntries) {
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        console.error(`[generateImagesInBatches] 连续 ${MAX_CONSECUTIVE_FAILS} 帧失败，中止生成`);
        setError(`连续 ${MAX_CONSECUTIVE_FAILS} 帧图像生成失败，可能 API 不可用或被限流。请稍后重试。`);
        setStep('error');
        return;
      }

      const firstShot = segShots[0];
      if (!firstShot) continue;

      try {
        if (segIdx === 0) {
          // 第一段主帧：走 inpaint（背景分离）或直接生图
          if (bgUrl && firstShot.maskImageUrl) {
            console.log(`[generateImagesInBatches] Segment ${segIdx} master: inpaint (background + mask)`);
            await generateSingleImage(firstShot.id, undefined, undefined, undefined, bgUrl, firstShot.maskImageUrl, imageSize);
          } else {
            console.log(`[generateImagesInBatches] Segment ${segIdx} master: direct generation (no background)`);
            await generateSingleImage(firstShot.id, undefined, undefined, undefined, undefined, undefined, imageSize);
          }
        } else {
          // 后续段主帧：用上一段主帧作参考图（图生图），保持跨段角色一致性
          console.log(`[generateImagesInBatches] Segment ${segIdx} master: reference-based (cross-segment anchor)`);
          await generateSingleImage(firstShot.id, undefined, undefined, crossSegmentRef, undefined, undefined, imageSize);
        }

        // 获取刚生成的主帧 URL，作为跨段参考链
        const updated = shotsRef.current.find(s => s.id === firstShot.id);
        if (updated?.imageUrl) {
          crossSegmentRef = updated.imageUrl;
        }
        consecutiveFails = 0;
      } catch (err) {
        console.error(`[generateImagesInBatches] Segment ${segIdx} master frame failed:`, err);
        failCount++;
        consecutiveFails++;
        // 主帧失败时尝试降级：用上一段主帧作参考图重试
        if (crossSegmentRef && consecutiveFails < MAX_CONSECUTIVE_FAILS) {
          try {
            console.warn(`[generateImagesInBatches] Retrying segment ${segIdx} master with cross-segment ref fallback`);
            await generateSingleImage(firstShot.id, undefined, undefined, crossSegmentRef, undefined, undefined, imageSize);
            const retryUpdated = shotsRef.current.find(s => s.id === firstShot.id);
            if (retryUpdated?.imageUrl) crossSegmentRef = retryUpdated.imageUrl;
            consecutiveFails = 0;
          } catch (retryErr) {
            console.error(`[generateImagesInBatches] Segment ${segIdx} master retry also failed:`, retryErr);
            failCount++;
            consecutiveFails++;
          }
        }
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Phase 2: 段内剩余帧 —— 统一用本段主帧作参考图（可并发生成）
      // ═══════════════════════════════════════════════════════════════════════
      const segmentMasterUrl = shotsRef.current.find(s => s.id === firstShot.id)?.imageUrl;

      if (segShots.length <= 1 || !segmentMasterUrl) continue;

      const remainingShots = segShots.slice(1);
      const batchSize = Math.max(effectiveConcurrency, 1);

      for (let j = 0; j < remainingShots.length; j += batchSize) {
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          console.error(`[generateImagesInBatches] 连续 ${MAX_CONSECUTIVE_FAILS} 帧失败，中止生成`);
          setError(`连续 ${MAX_CONSECUTIVE_FAILS} 帧图像生成失败，可能 API 不可用或被限流。请稍后重试。`);
          setStep('error');
          return;
        }

        const batch = remainingShots.slice(j, j + batchSize);
        const results = await Promise.allSettled(batch.map(async (shot) => {
          try {
            // 所有段内剩余帧统一使用本段主帧作为参考图进行图生图微调
            await generateSingleImage(shot.id, undefined, undefined, segmentMasterUrl, undefined, undefined, imageSize);
            return true;
          } catch (err) {
            console.error(`[generateImagesInBatches] frame ${shot.index} failed:`, err);
            return false;
          }
        }));

        for (const r of results) {
          if (r.status === 'fulfilled' && r.value === false) {
            failCount++;
            consecutiveFails++;
          } else if (r.status === 'rejected') {
            failCount++;
            consecutiveFails++;
          } else {
            consecutiveFails = 0;
          }
        }

        // 每批之间等待 5 秒，避免触发代理凭证池冷却
        if (j + batchSize < remainingShots.length) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      // 段间等待 8 秒，让凭证池恢复
      if (segIdx < segEntries.length - 1) {
        await new Promise(r => setTimeout(r, 8000));
      }
    }

    if (failCount > 0) {
      console.warn(`[generateImagesInBatches] ${failCount}/${shotList.length} frames failed`);
    }
  }

  // ─── 生成单张图像 ──────────────────────────────────────────────────────────
  const generateSingleImage = useCallback(
    async (
      shotId: string,
      editedPrompt?: string,
      modificationPrompt?: string,
      referenceImageUrl?: string,
      bgImageUrl?: string,
      maskUrl?: string,
      imageSize?: string,
    ) => {
      const shot = shotsRef.current.find((s) => s.id === shotId);
      if (!shot) {
        console.warn(`[generateSingleImage] shot not found: ${shotId}, ref has ${shotsRef.current.length} shots`);
        return;
      }

      // 标记为 loading
      setShots((prev) =>
        prev.map((s) =>
          s.id === shotId ? { ...s, imageStatus: 'loading' } : s
        )
      );

      try {
        // 背景图优先从参数取，否则从 ref 取（自动重绘场景时）
        const effectiveBgUrl = bgImageUrl ?? backgroundImageRef.current;
        const effectiveMask = maskUrl ?? shot.maskImageUrl;

        const imageUrl = await generateShotImage(
          shot,
          editedPrompt,
          modificationPrompt,
          referenceImageUrl,
          effectiveBgUrl,
          effectiveMask,
          imageSize,
        );

        // 更新 imagePrompt
        let newPrompt = shot.imagePrompt;
        if (editedPrompt?.trim()) {
          // 用户直接编辑了完整 prompt
          newPrompt = editedPrompt.trim();
        } else if (modificationPrompt?.trim()) {
          // AI 已重写 prompt，但这里我们无法获取重写后的文本
          // 标记为已修改（实际生成的图片已反映修改）
          newPrompt = `${shot.imagePrompt} [已修改: ${modificationPrompt.trim()}]`;
        }

        setShots((prev) =>
          prev.map((s) =>
            s.id === shotId
              ? {
                  ...s,
                  imageStatus: 'done',
                  imageUrl,
                  imagePrompt: newPrompt,
                  referenceImageUrl: referenceImageUrl || undefined,
                }
              : s
          )
        );
        setCompletedImageCount((c) => c + 1);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setShots((prev) =>
          prev.map((s) =>
            s.id === shotId
              ? { ...s, imageStatus: 'error', imageError: msg }
              : s
          )
        );
      }
    },
    [] // 无外部依赖，通过 shotsRef 读取最新 shots
  );

  // 合成视频功能已移除（服务端/客户端均禁用）

  // ─── 加载历史项目 ──────────────────────────────────────────────────────────
  function handleLoadProject(project: StoryboardProject) {
    setCurrentProject(project);
    setShots(project.shots);
    setFullStory(project.fullStory || '');
    setCurrentFps(project.fps || 8);
    setStep('done');
  }

  // ─── 下载图像 ──────────────────────────────────────────────────────────────
  function downloadImages() {
    shots.forEach((shot) => {
      if (shot.imageStatus === 'done' && shot.imageUrl) {
        const a = document.createElement('a');
        a.href = shot.imageUrl;
        a.download = `shot_${shot.index}_seg${shot.segmentIndex}_${shot.shotType.replace(/\s+/g, '_')}.png`;
        a.click();
      }
    });
  }

  const isGenerating = step === 'expanding-story' || step === 'generating-script' || step === 'generating-images';
  const doneImageCount = shots.filter((s) => s.imageStatus === 'done' && s.imageUrl).length;
  const isStepError = step === 'error';

  // 按段落分组 shots（用于显示）
  const segmentGroups = (() => {
    if (!currentProject?.segments?.length) {
      // 兼容旧项目：没有 segments 的按 segmentIndex 分
      const map = new Map<number, Shot[]>();
      for (const shot of shots) {
        const key = shot.segmentIndex ?? 0;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(shot);
      }
      return Array.from(map.entries()).sort(([a], [b]) => a - b).map(([segIdx, segShots]) => ({
        index: segIdx,
        timeRange: `${segIdx}s-${segIdx + 1}s`,
        description: segShots[0]?.segmentDescription || '',
        shots: segShots,
      }));
    }
    return currentProject.segments.map((seg) => ({
      ...seg,
      shots: shots.filter((s) => s.segmentIndex === seg.index),
    }));
  })();

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* 背景装饰 */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-cyan-600/8 rounded-full blur-3xl" />
      </div>

      {/* 顶部导航 */}
      <header className="sticky top-0 z-30 bg-gray-950/80 backdrop-blur-xl border-b border-white/8">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg">
              <Film size={16} className="text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white leading-none">Frame Prompt</h1>
              <p className="text-xs text-white/30 mt-0.5">帧提示词工作台</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {shots.length > 0 && (
              <div className="hidden sm:flex items-center gap-1.5 text-xs text-white/40 px-3 py-1.5 rounded-lg bg-white/5">
                  <Layers size={12} />
                  <span>{segmentGroups.length} 段 · {shots.length} 帧</span>
                  <span className="mx-1 text-white/20">·</span>
                  <ImageIcon size={12} />
                  <span>{doneImageCount} 张图像</span>
                </div>
            )}
            <SettingsPanel
              settings={settings}
              onUpdate={(s) => {
                setSettings(s);
                saveSettings(s);
              }}
            />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 relative">
        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6">
          {/* 左侧：输入面板 */}
          <div className="space-y-5">
            {/* 输入卡片 */}
            <div className="bg-white/3 border border-white/10 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles size={16} className="text-violet-400" />
                <h2 className="text-sm font-semibold text-white/80">创作设置</h2>
              </div>
              <PromptForm
                settings={settings}
                onGenerate={handleGenerate}
                onUpdateSettings={(s) => { setSettings(s); saveSettings(s); }}
                isGenerating={isGenerating}
              />
            </div>

            {/* 展开的故事预览 */}
            {fullStory && (
              <div className="bg-white/3 border border-emerald-500/20 rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <Sparkles size={13} className="text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-emerald-300">完整剧情</p>
                    <p className="text-[10px] text-white/30">ChatGPT 5.4 根据梗概展开</p>
                  </div>
                </div>
                <div className="max-h-60 overflow-y-auto text-xs text-white/60 leading-relaxed whitespace-pre-wrap bg-white/3 rounded-xl px-3 py-2.5 border border-white/5">
                  {fullStory}
                </div>
              </div>
            )}

            {/* 导出面板 */}
            {shots.length > 0 && (
              <div className="border border-cyan-500/20 rounded-2xl overflow-hidden bg-cyan-500/5 p-5">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-full bg-cyan-500/20 flex items-center justify-center">
                    <Download size={16} className="text-cyan-400" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-cyan-300">导出</p>
                    <p className="text-xs text-white/40">下载图像</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <button
                    onClick={downloadImages}
                    className="w-full py-2.5 rounded-xl border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 transition-colors flex items-center justify-center gap-2 text-sm"
                  >
                    <Download size={14} />
                    下载所有图像
                  </button>
                  {/* 合成视频按钮已移除 */}
                </div>
              </div>
            )}

            {/* 快速操作提示 */}
            {shots.length === 0 && !isGenerating && (
              <div className="p-4 rounded-2xl border border-white/8 bg-white/2">
                <p className="text-xs text-white/30 font-medium mb-2 flex items-center gap-1">
                  <Play size={11} /> 使用流程
                </p>
                <ol className="space-y-1.5 text-xs text-white/25">
                  <li>1. 输入故事梗概（几句话即可）</li>
                  <li>2. 选择画面风格、帧率和视频时长</li>
                  <li>3. AI 自动将故事拆分为逐秒段落</li>
                  <li>4. 为每秒生成 N 帧图像</li>
                  <li>5. 下载生成的图像</li>
                </ol>
              </div>
            )}

            {/* 历史记录 */}
            <HistoryPanel
              projects={projects}
              onLoad={handleLoadProject}
              onDelete={(id) => setProjects(loadProjects().filter((p) => p.id !== id))}
            />
          </div>

          {/* 右侧：分镜展示 */}
          <div>

            {isStepError && error && (
              /* 错误提示 */
              <div className="mb-5 rounded-2xl border border-red-500/30 bg-red-500/10 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <AlertCircle size={18} className="text-red-400" />
                  <h3 className="text-sm font-semibold text-red-300">生成出错</h3>
                </div>
                <p className="text-xs text-red-300/70 leading-relaxed mb-3">{error}</p>
                <button
                  onClick={() => { setError(undefined); setStep('idle'); }}
                  className="text-xs px-4 py-2 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
                >
                  关闭并重试
                </button>
              </div>
            )}

            {shots.length === 0 && !isGenerating && !isStepError ? (
              /* 空状态 */
              <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
                <div className="w-20 h-20 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
                  <Film size={32} className="text-white/15" />
                </div>
                <h3 className="text-lg font-semibold text-white/20 mb-2">
                  还没有分镜
                </h3>
                <p className="text-sm text-white/15 max-w-xs">
                  在左侧输入故事梗概，Frame Prompt 将自动拆分为逐秒段落，为每秒生成多帧图像
                </p>
              </div>
            ) : (
              /* 分镜展示——按段落分组 */
              <div>
                {currentProject && (
                  <div className="mb-5 flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-semibold text-white/80 line-clamp-1">
                        {currentProject.title}
                      </h2>
                      <p className="text-xs text-white/35 mt-0.5">
                        {segmentGroups.length} 段 · {shots.length} 帧 · {currentFps}fps · {currentProject.durationSeconds}s · {currentProject.style}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {step === 'expanding-story' && (
                        <span className="text-xs text-emerald-400 animate-pulse">
                          分析故事中...
                        </span>
                      )}
                      {step === 'generating-script' && (
                        <span className="text-xs text-amber-400 animate-pulse">
                          生成分镜脚本中...
                        </span>
                      )}
                      {step === 'generating-images' && (
                        <span className="text-xs text-violet-400 animate-pulse">
                          生成图像中 {completedImageCount}/{shots.length}
                        </span>
                      )}
                      {step === 'composing-video' && (
                        <span className="text-xs text-cyan-400 animate-pulse">
                          合成视频中...
                        </span>
                      )}
                      {step === 'done' && (
                        <span className="text-xs text-green-400 flex items-center gap-1">
                          <Sparkles size={11} />
                          已完成
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* 按段落渲染 */}
                <div className="space-y-6">
                  {segmentGroups.map((seg) => (
                    <div key={seg.index}>
                      {/* 段落标题 */}
                      <div className="flex items-center gap-2 mb-3">
                        <span className="px-2.5 py-1 rounded-lg bg-violet-500/20 text-xs font-semibold text-violet-300 border border-violet-500/20">
                          {seg.timeRange}
                        </span>
                        <p className="text-sm text-white/60 line-clamp-1 flex-1">
                          {seg.description || `第 ${seg.index + 1} 段`}
                        </p>
                        <span className="text-[10px] text-white/25">
                          {seg.shots.length} 帧
                        </span>
                      </div>

                      {/* 段落内的帧 */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                        {seg.shots.map((shot) => (
                          <ShotCard
                            key={shot.id}
                            shot={shot}
                            onGenerateImage={generateSingleImage}
                            isGeneratingAll={isGenerating}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* 全局进度指示器 */}
      <GenerationProgress
        step={step}
        totalShots={shots.length}
        completedShots={completedImageCount}
        error={error}
      />
    </div>
  );
}

export default App;
