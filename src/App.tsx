import { useState, useEffect, useCallback, useRef } from 'react';
import { Film, Sparkles, ImageIcon, Play, Download, Layers, AlertCircle, XCircle } from 'lucide-react';
import './App.css';

import type { Shot, StoryboardProject, GenerationStep, AppSettings } from './types/storyboard';
import {
  generateFullStory,
  generateStoryboardScript,
  generateCharacterTurnaround,
  generateShotImage,
  saveProject,
  loadProjects,
  deleteProject,
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
  const [characterTurnaroundUrl, setCharacterTurnaroundUrl] = useState<string | undefined>();
  const [characterTurnaroundPrompt, setCharacterTurnaroundPrompt] = useState<string | undefined>();

  // 用 ref 跟踪最新的 shots，避免 generateSingleImage 闭包过期
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;
  const backgroundImageRef = useRef<string | undefined>(undefined);
  backgroundImageRef.current = backgroundImageUrl;
  const characterTurnaroundRef = useRef<string | undefined>(undefined);
  characterTurnaroundRef.current = characterTurnaroundUrl;

  // 取消生成
  const abortControllerRef = useRef<AbortController | null>(null);
  function handleCancel() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setError('用户已取消生成');
    setStep('error');
  }

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
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setStep('expanding-story');
      setError(undefined);
      setShots([]);
      setCompletedImageCount(0);
      setFullStory('');
      setBackgroundImageUrl(undefined);
      setCharacterTurnaroundUrl(undefined);
      setCharacterTurnaroundPrompt(undefined);
      setCurrentFps(fps);

      // 检查是否已取消
      function checkAborted() {
        if (controller.signal.aborted) throw new Error('用户已取消生成');
      }

      try {
        // ── Step 1: 展开故事 + 按秒拆分段落 ──
        const { fullStory: story, segments } = await generateFullStory(prompt, durationSeconds);
        checkAborted();
        setFullStory(story);
        setStep('generating-script');

        // ── Step 2: 为每个段落的每帧生成分镜提示词（同时生成固定背景图）──
        const { shots: newShots, backgroundImageUrl: bgUrl, backgroundPrompt: bgPrompt } =
          await generateStoryboardScript(segments, style, fps, settings.frameVariation, settings.imageSize);
        checkAborted();

        if (!bgUrl) {
          throw new Error('统一背景图生成失败。请检查图像接口，或重新生成分镜。');
        }
        if (!newShots.some((shot) => !!shot.maskImageUrl)) {
          throw new Error('人物蒙版生成失败，无法在统一背景上添加人物。请重新生成分镜。');
        }

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
        shotsRef.current = newShots;
        setStep('background-ready');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[handleGenerate] error:', msg);
        setError(msg);
        setStep('error');
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }
    },
    [settings]
  );

  async function handleGenerateCharacterTurnaround() {
    if (!shotsRef.current.length || !currentProject) return;

    const characterDescription = shotsRef.current
      .map((shot) => shot.characterDescription)
      .find((desc) => !!desc?.trim()) || '';

    if (!characterDescription.trim()) {
      setError('缺少人物描述，无法生成人物三视图。请重新生成分镜。');
      setStep('error');
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setError(undefined);
    setStep('generating-character');

    try {
      const result = await generateCharacterTurnaround(characterDescription, currentProject.style, settings.imageSize);
      if (controller.signal.aborted) throw new Error('用户已取消生成');
      setCharacterTurnaroundUrl(result.imageUrl);
      setCharacterTurnaroundPrompt(result.prompt);
      setCurrentProject((prev) => prev ? {
        ...prev,
        characterTurnaroundUrl: result.imageUrl,
        characterTurnaroundPrompt: result.prompt,
      } : prev);
      setStep('character-ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStep('error');
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }

  async function handleGenerateCharacters() {
    if (!shotsRef.current.length) return;
    if (!backgroundImageRef.current) {
      setError('统一背景图尚未生成，不能进入人物生成。请重新生成分镜。');
      setStep('error');
      return;
    }

    const hasMask = shotsRef.current.some((shot) => !!shot.maskImageUrl);
    if (!hasMask) {
      setError('人物蒙版尚未生成，不能在统一背景上添加人物。请重新生成分镜。');
      setStep('error');
      return;
    }
    if (!characterTurnaroundRef.current) {
      setError('人物三视图尚未确认，不能进入逐帧人物生成。');
      setStep('error');
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setError(undefined);
    setCompletedImageCount(shotsRef.current.filter(s => s.imageStatus === 'done' && s.imageUrl).length);
    setStep('generating-images');

    try {
      await generateImagesInBatches(shotsRef.current, 1, settings.imageSize, controller.signal);
      if (controller.signal.aborted) throw new Error('用户已取消生成');
      setStep('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStep('error');
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }

  // ─── 批量生成图像：首帧统一背景 inpaint，后续用上一帧做图生图参考 ────────
  // 首帧负责把角色稳定放进统一背景；后续帧只做小幅动作增量，提升逐帧连续感。
  async function generateImagesInBatches(shotList: Shot[], _concurrency: number, imageSize: string = '1024x1024', signal?: AbortSignal) {
    let failCount = 0;
    let consecutiveFails = 0;
    const MAX_CONSECUTIVE_FAILS = 3;
    const bgUrl = backgroundImageRef.current;
    let lastReferenceImageUrl: string | undefined;

    if (!bgUrl) {
      throw new Error('缺少统一背景图，已停止生成，避免背景不一致。');
    }

    const orderedShots = [...shotList].sort((a, b) => (a.index || 0) - (b.index || 0));

    for (let i = 0; i < orderedShots.length; i++) {
      if (signal?.aborted) throw new Error('用户已取消生成');
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        console.error(`[generateImagesInBatches] 连续 ${MAX_CONSECUTIVE_FAILS} 帧失败，中止生成`);
        throw new Error(`连续 ${MAX_CONSECUTIVE_FAILS} 帧人物生成失败，可能 inpaint 接口不可用或被限流。`);
      }

      const shot = orderedShots[i];
      if (!shot.maskImageUrl) {
        throw new Error(`第 ${shot.index} 帧缺少人物蒙版，已停止生成。`);
      }

      const before = shotsRef.current.find(s => s.id === shot.id);
      if (before?.imageStatus === 'done' && before.imageUrl) {
        lastReferenceImageUrl = before.imageUrl;
        consecutiveFails = 0;
        continue;
      }

      try {
        if (!lastReferenceImageUrl) {
          console.log(`[generateImagesInBatches] Frame ${shot.index}: master frame via inpaint on unified background`);
          lastReferenceImageUrl = await generateSingleImage(shot.id, undefined, undefined, undefined, bgUrl, shot.maskImageUrl, imageSize);
        } else {
          console.log(`[generateImagesInBatches] Frame ${shot.index}: image-to-image from previous frame`);
          lastReferenceImageUrl = await generateSingleImage(shot.id, undefined, undefined, lastReferenceImageUrl, undefined, undefined, imageSize);
        }

        if (!lastReferenceImageUrl) {
          throw new Error(`第 ${shot.index} 帧生成后缺少图片结果，无法作为下一帧参考。`);
        }
        consecutiveFails = 0;
      } catch (err) {
        console.error(`[generateImagesInBatches] frame ${shot.index} failed:`, err);
        failCount++;
        consecutiveFails++;
      }

      if (i < orderedShots.length - 1) {
        await new Promise(r => setTimeout(r, 3000));
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
    ): Promise<string | undefined> => {
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
          !!(bgImageUrl && maskUrl && !referenceImageUrl && !editedPrompt?.trim() && !modificationPrompt?.trim()),
          bgImageUrl && maskUrl ? characterTurnaroundRef.current : undefined,
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
        return imageUrl;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setShots((prev) =>
          prev.map((s) =>
            s.id === shotId
              ? { ...s, imageStatus: 'error', imageError: msg }
              : s
          )
        );
        throw err;
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
    setBackgroundImageUrl(project.backgroundImageUrl);
    setCharacterTurnaroundUrl(project.characterTurnaroundUrl);
    setCharacterTurnaroundPrompt(project.characterTurnaroundPrompt);
    setCurrentFps(project.fps || 8);
    setError(undefined);
    setCompletedImageCount(project.shots.filter(s => s.imageStatus === 'done').length);
    setStep('done');
  }

  // ─── 下载图像（ZIP 打包，避免浏览器拦截多文件下载） ──────────────────────────
  async function downloadImages() {
    const doneShots = shots.filter((s) => s.imageStatus === 'done' && s.imageUrl);
    if (doneShots.length === 0) return;

    try {
      // 构建 ZIP 文件（仅使用 Stored 模式，无需压缩库）
      const files: { name: string; data: Uint8Array }[] = [];

      for (const shot of doneShots) {
        const resp = await fetch(shot.imageUrl!);
        const blob = await resp.blob();
        const buf = new Uint8Array(await blob.arrayBuffer());
        const name = `shot_${String(shot.index).padStart(3, '0')}_seg${shot.segmentIndex}_${shot.shotType.replace(/\s+/g, '_')}.png`;
        files.push({ name, data: buf });
      }

      const zip = buildZip(files);
      const blob = new Blob([new Uint8Array(zip)], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `storyboard_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[downloadImages] ZIP failed, falling back to individual:', err);
      // 降级：逐个下载（间隔 500ms 避免拦截）
      for (const shot of doneShots) {
        if (shot.imageUrl) {
          const a = document.createElement('a');
          a.href = shot.imageUrl;
          a.download = `shot_${String(shot.index).padStart(3, '0')}_seg${shot.segmentIndex}.png`;
          a.click();
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
  }

  /** 构建最小 ZIP 文件（Stored 模式，无压缩） */
  function buildZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
    const encoder = new TextEncoder();
    const entries: { header: Uint8Array; data: Uint8Array; offset: number }[] = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      // Local file header (30 + name + data)
      const header = new Uint8Array(30 + nameBytes.length);
      const hv = new DataView(header.buffer);
      hv.setUint32(0, 0x04034b50, true);  // signature
      hv.setUint16(4, 20, true);           // version needed
      hv.setUint16(6, 0, true);            // flags
      hv.setUint16(8, 0, true);            // compression: stored
      hv.setUint16(10, 0, true);           // mod time
      hv.setUint16(12, 0, true);           // mod date
      hv.setUint32(14, crc32(file.data), true);
      hv.setUint32(18, file.data.length, true);
      hv.setUint32(22, file.data.length, true);
      hv.setUint16(26, nameBytes.length, true);
      hv.setUint16(28, 0, true);           // extra length
      header.set(nameBytes, 30);
      entries.push({ header, data: file.data, offset });
      offset += header.length + file.data.length;
    }

    // Central directory
    const centralParts: Uint8Array[] = [];
    let centralSize = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const entry = entries[i];
      const nameBytes = encoder.encode(file.name);
      const cd = new Uint8Array(46 + nameBytes.length);
      const dv = new DataView(cd.buffer);
      dv.setUint32(0, 0x02014b50, true);   // central directory signature
      dv.setUint16(4, 20, true);            // version made by
      dv.setUint16(6, 20, true);            // version needed
      dv.setUint16(8, 0, true);             // flags
      dv.setUint16(10, 0, true);            // compression
      dv.setUint16(12, 0, true);            // mod time
      dv.setUint16(14, 0, true);            // mod date
      dv.setUint32(16, crc32(file.data), true);
      dv.setUint32(20, file.data.length, true);
      dv.setUint32(24, file.data.length, true);
      dv.setUint16(28, nameBytes.length, true);
      dv.setUint16(30, 0, true);            // extra length
      dv.setUint16(32, 0, true);            // comment length
      dv.setUint16(34, 0, true);            // disk number
      dv.setUint16(36, 0, true);            // internal attrs
      dv.setUint32(38, 0, true);            // external attrs
      dv.setUint32(42, entry.offset, true); // relative offset
      cd.set(nameBytes, 46);
      centralParts.push(cd);
      centralSize += cd.length;
    }

    // End of central directory
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    // Concatenate all parts
    const totalSize = offset + centralSize + 22;
    const result = new Uint8Array(totalSize);
    let pos = 0;
    for (const entry of entries) {
      result.set(entry.header, pos); pos += entry.header.length;
      result.set(entry.data, pos); pos += entry.data.length;
    }
    for (const cd of centralParts) {
      result.set(cd, pos); pos += cd.length;
    }
    result.set(eocd, pos);
    return result;
  }

  /** CRC-32 校验 */
  function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const isGenerating = step === 'expanding-story' || step === 'generating-script' || step === 'generating-images';
  const doneImageCount = shots.filter((s) => s.imageStatus === 'done' && s.imageUrl).length;
  const isStepError = step === 'error';
  const isBackgroundReady = step === 'background-ready';
  const isCharacterReady = step === 'character-ready';

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
                    <p className="text-[10px] text-white/30">ChatGPT 5.5 根据梗概展开</p>
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
                  <li>4. 先生成并确认统一背景图</li>
                  <li>5. 在同一背景上逐帧添加人物</li>
                </ol>
              </div>
            )}

            {/* 历史记录 */}
            <HistoryPanel
              projects={projects}
              onLoad={handleLoadProject}
              onDelete={(id) => {
                deleteProject(id);
                setProjects(loadProjects());
              }}
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
                        {doneImageCount < shots.length && step === 'done' && (
                          <span className="ml-2 text-amber-400/70">
                            · {shots.length - doneImageCount} 帧待生成
                          </span>
                        )}
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
                          生成分镜与统一背景中...
                        </span>
                      )}
                      {step === 'background-ready' && (
                        <span className="text-xs text-blue-400">
                          统一背景已生成，等待确认
                        </span>
                      )}
                      {step === 'generating-character' && (
                        <span className="text-xs text-fuchsia-400 animate-pulse">
                          生成人物三视图中...
                        </span>
                      )}
                      {step === 'character-ready' && (
                        <span className="text-xs text-fuchsia-300">
                          人物三视图已生成，等待确认
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
                      {isGenerating && (
                        <button
                          onClick={handleCancel}
                          className="text-xs px-2.5 py-1 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-1"
                        >
                          <XCircle size={12} />
                          取消
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {isBackgroundReady && currentProject && (
                  <div className="mb-5 rounded-2xl border border-blue-500/25 bg-blue-500/8 overflow-hidden">
                    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-0">
                      <div className="bg-black/30">
                        {backgroundImageUrl ? (
                          <img
                            src={backgroundImageUrl}
                            alt="统一背景"
                            className="w-full h-full min-h-[180px] object-cover"
                          />
                        ) : (
                          <div className="min-h-[180px] flex items-center justify-center text-xs text-white/35">
                            背景图未生成
                          </div>
                        )}
                      </div>
                      <div className="p-5">
                        <div className="flex items-center gap-2 mb-2">
                          <ImageIcon size={16} className="text-blue-300" />
                          <h3 className="text-sm font-semibold text-blue-200">统一背景确认</h3>
                        </div>
                        <p className="text-xs text-white/55 leading-relaxed mb-3">
                          分镜脚本已经生成。接下来所有帧会基于左侧这张同一背景图添加人物，不再重新生成整张画面，以减少背景漂移。
                        </p>
                        {currentProject.backgroundPrompt && (
                          <div className="mb-4 rounded-xl border border-white/8 bg-white/5 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-white/25 mb-1">Background Prompt</p>
                            <p className="text-xs text-white/45 line-clamp-3">{currentProject.backgroundPrompt}</p>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={handleGenerateCharacterTurnaround}
                            disabled={!backgroundImageUrl || isGenerating}
                            className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors flex items-center gap-2"
                          >
                            <Play size={14} />
                            下一步：生成人物三视图
                          </button>
                          <button
                            onClick={() => { setError(undefined); setStep('idle'); }}
                            className="px-4 py-2.5 rounded-xl border border-white/10 text-white/55 hover:bg-white/5 text-sm transition-colors"
                          >
                            重新生成分镜
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {isCharacterReady && currentProject && (
                  <div className="mb-5 rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/8 overflow-hidden">
                    <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-0">
                      <div className="bg-black/30">
                        {characterTurnaroundUrl ? (
                          <img
                            src={characterTurnaroundUrl}
                            alt="人物三视图"
                            className="w-full h-full min-h-[220px] object-contain"
                          />
                        ) : (
                          <div className="min-h-[220px] flex items-center justify-center text-xs text-white/35">
                            人物三视图未生成
                          </div>
                        )}
                      </div>
                      <div className="p-5">
                        <div className="flex items-center gap-2 mb-2">
                          <Sparkles size={16} className="text-fuchsia-300" />
                          <h3 className="text-sm font-semibold text-fuchsia-200">人物三视图确认</h3>
                        </div>
                        <p className="text-xs text-white/55 leading-relaxed mb-3">
                          后续每一帧都会以这张三视图作为人物身份参考，并把人物添加到统一背景的蒙版区域内，减少脸、服装和体型跑偏。
                        </p>
                        {characterTurnaroundPrompt && (
                          <div className="mb-4 rounded-xl border border-white/8 bg-white/5 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wide text-white/25 mb-1">Character Reference Prompt</p>
                            <p className="text-xs text-white/45 line-clamp-4">{characterTurnaroundPrompt}</p>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={handleGenerateCharacters}
                            disabled={!characterTurnaroundUrl || isGenerating}
                            className="px-4 py-2.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors flex items-center gap-2"
                          >
                            <Play size={14} />
                            确认人物，生成所有帧
                          </button>
                          <button
                            onClick={handleGenerateCharacterTurnaround}
                            disabled={isGenerating}
                            className="px-4 py-2.5 rounded-xl border border-fuchsia-500/25 text-fuchsia-200 hover:bg-fuchsia-500/10 disabled:opacity-40 text-sm transition-colors"
                          >
                            重新生成三视图
                          </button>
                        </div>
                      </div>
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
                            isGeneratingAll={isGenerating || isBackgroundReady || isCharacterReady}
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
