import type { Shot, StorySegment, StoryboardProject } from '../types/storyboard';

// ─────────────────────────────────────────────────────────────────────────────
// 后端代理地址（开发模式走 Vite proxy → 3001，生产模式同域）
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = '/api';

function normalizeImageSize(imageSize?: string): string {
  return imageSize || '1024x1024';
}

/** 用文本代理展开故事并按秒拆分段落 */
export async function generateFullStory(
  synopsis: string,
  durationSeconds: number = 6
): Promise<{ fullStory: string; segments: StorySegment[] }> {
  const res = await fetch(`${API_BASE}/story-expansion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ synopsis, durationSeconds }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      (err as { error?: string })?.error || `故事展开失败 (${res.status})`
    );
  }

  const data = await res.json();
  const fullStory = (data as { fullStory?: string })?.fullStory;
  if (!fullStory) throw new Error('Story expansion returned empty result');

  const rawSegments = (data as { segments?: Array<{ index?: number; timeRange?: string; description?: string }> })?.segments || [];

  const segments: StorySegment[] = rawSegments.map((s, i) => ({
    index: s.index ?? i,
    timeRange: s.timeRange || `${i}s-${i + 1}s`,
    description: s.description || '',
    shots: [],
  }));

  return { fullStory, segments };
}

// 视频合成接口已移除：前端请直接下载帧图片或使用外部工具合成视频。

// ═══════════════════════════════════════════════════════════════════════════════
// 场景模板类型 —— 逐帧动画的核心数据结构
// ═══════════════════════════════════════════════════════════════════════════════

/** 场景模板：整段视频的固定视觉要素，保证每帧画面一致 */
interface SceneTemplate {
  /** 固定的画面描述（背景、环境、构图、光照等），50-80词 */
  fixedScene: string;
  /** 人物列表，每个人的固定外貌描述 */
  characters: Array<{
    name: string;
    appearance: string;  // 30-50词，每次逐字复用
    position: string;    // 在画面中的位置（如 "center-left"）
  }>;
  /** 画面构图（如 "medium shot, eye-level"） */
  composition: string;
  /** 光照（如 "soft warm daylight from window"） */
  lighting: string;
  /** 色调（如 "warm golden tones"） */
  colorPalette: string;
  /** 图片尺寸 */
  imageSize: string;
  /** 整体风格 */
  style: string;
  /** 背景图专用 prompt（纯背景，无人物） */
  backgroundPrompt?: string;
  /** 角色在画面中的区域描述（用于生成蒙版） */
  characterRegion?: string;
  /** 角色尺寸锚点约束（附加到每帧 prompt 防止缩放抖动） */
  sizeConstraint?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 0: 生成场景模板 —— 所有帧共享的视觉常量
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSceneTemplate(
  segments: StorySegment[],
  style: string,
  imageSize: string = '1024x1024',
): Promise<SceneTemplate> {
  const fixedImageSize = normalizeImageSize(imageSize);
  const segmentsDesc = segments.map((s) =>
    `[${s.timeRange}]: ${s.description}`
  ).join('\n');

  const prompt = `You are a film director preparing a frame image sequence.
Given this story, create a SCENE TEMPLATE that defines EVERY visual constant.
These values will be COPIED VERBATIM into every single frame's prompt.

STORY:
${segmentsDesc}

VISUAL STYLE: ${style}

Return JSON:
{
  "fixedScene": "A detailed 50-80 word English description of the environment/background that remains IDENTICAL in every frame. Include: setting, weather, time of day, key objects, spatial arrangement.",
  "characters": [
    { "name": "Character name", "appearance": "30-50 word detailed English appearance (face, hair, body, clothing, accessories, skin tone)", "position": "screen position like center-left, right, center" }
  ],
  "composition": "camera shot type and angle, e.g. medium shot, eye-level, rule of thirds",
  "lighting": "lighting description, e.g. soft warm daylight from left window",
  "colorPalette": "color mood, e.g. warm golden tones with deep shadows",
  "imageSize": "${fixedImageSize}",
  "style": "${style}",
  "backgroundPrompt": "50-70 word English prompt for the BACKGROUND ONLY — NO people, NO characters, just the pure environment/scene. This will be used to generate a fixed background image that stays identical across all frames.",
  "characterRegion": "Describe where the character(s) occupy in the frame (e.g. 'lower-center 30% of frame, standing figure from knees up', 'full left half of image', 'center of image, head-to-waist'). This defines the white mask area for inpainting.",
  "sizeConstraint": "A short English phrase for character size anchoring, e.g. 'occupy about 70% of the frame height, standing full body in frame, no zoom, consistent scale across all frames'"
}

IMPORTANT:
- Identify ALL characters that appear across ALL segments
- Every detail must be specific enough to reproduce identically
- backgroundPrompt must describe ONLY the environment — absolutely no human figures
- characterRegion must be a clear spatial description so a mask can be generated
- sizeConstraint is CRITICAL: it will be appended to EVERY frame's prompt to prevent character scaling jitter across frames
- Think of sizeConstraint as an anchor: the same character must appear at the SAME scale and position in every single frame
- Keep the camera locked, keep the background identical, and allow only tiny subject pose or expression changes between frames`;

    const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'You are a meticulous film director. Respond with valid JSON only. Be extremely detailed and specific.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.5,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    // 降级返回默认模板
    console.warn('[generateSceneTemplate] failed, using default template');
    return {
      fixedScene: 'A cinematic scene with consistent environment and lighting',
      characters: [],
      composition: 'medium shot, eye-level',
      lighting: 'natural soft lighting',
      colorPalette: 'cinematic color grading',
      imageSize: fixedImageSize,
      style,
      backgroundPrompt: 'A cinematic scene, empty environment, consistent lighting, no people, no characters',
      characterRegion: 'center of image',
      sizeConstraint: 'occupy about 70% of the frame height, consistent scale, no zoom',
    };
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(content);
    return {
      fixedScene: String(parsed.fixedScene || ''),
      characters: Array.isArray(parsed.characters) ? parsed.characters.map((c: Record<string, unknown>) => ({
        name: String(c.name || 'Character'),
        appearance: String(c.appearance || ''),
        position: String(c.position || 'center'),
      })) : [],
      composition: String(parsed.composition || 'medium shot'),
      lighting: String(parsed.lighting || 'natural lighting'),
      colorPalette: String(parsed.colorPalette || ''),
      imageSize: fixedImageSize,
      style: String(parsed.style || style),
      backgroundPrompt: String(parsed.backgroundPrompt || ''),
      characterRegion: String(parsed.characterRegion || 'center of image'),
      sizeConstraint: String(parsed.sizeConstraint || 'occupy about 70% of the frame height, consistent scale, no zoom'),
    };
  } catch {
    console.warn('[generateSceneTemplate] JSON parse failed, using default');
    return {
      fixedScene: '', characters: [], composition: '', lighting: '', colorPalette: '',
      imageSize: fixedImageSize, style,
      backgroundPrompt: 'A cinematic empty scene, no people',
      characterRegion: 'center of image',
      sizeConstraint: 'occupy about 70% of the frame height, consistent scale, no zoom',
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1: 逐段生成分镜 —— 每段独立请求，输出量小不会截断
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 为单个段落生成 N 帧的分镜提示词
 * 核心思想：每帧的提示词 = 固定场景模板 + 微小动作变化
 * 同段内只有动作在变，其他一切（背景、人物外观、构图、光照）完全一样
 */
async function generateSegmentFrames(
  segment: StorySegment,
  frameCount: number,
  template: SceneTemplate,
  prevFrameAction?: string,   // 上一段最后一帧的动作（跨段连续性）
  isFirstSegment: boolean = false,
  variation: number = 0.10,   // 帧间变化幅度（0.01-0.30）
): Promise<Shot[]> {
  const lockedVariation = Math.min(Math.max(variation, 0.03), 0.30);
  // 构建场景模板文本（每帧复制的部分）
  const charBlock = template.characters.length > 0
    ? template.characters.map(c => `${c.name}: ${c.appearance} (position: ${c.position})`).join('. ')
    : '';

  const sceneBlock = [
    template.fixedScene,
    charBlock,
    template.composition,
    template.lighting,
    template.colorPalette,
    template.style,
    // 角色尺寸锚点约束 —— 防止缩放抖动
    template.sizeConstraint ? `SIZE ANCHOR: ${template.sizeConstraint}` : '',
  ].filter(Boolean).join('. ');

  // 根据变化幅度计算允许的词语变化数
  const maxChangedWords = Math.max(1, Math.round(lockedVariation * 15));
  const variationDesc = lockedVariation <= 0.05
    ? 'EXTREMELY SUBTLE: change ONLY 1 word between frames. The images should look nearly identical — like a still photograph with barely perceptible micro-movement.'
    : lockedVariation <= 0.12
      ? `SUBTLE: change ${maxChangedWords} words between frames. Think stop-motion animation with tiny incremental movements.`
      : lockedVariation <= 0.20
        ? `MODERATE: change ${maxChangedWords} words between frames. Think smooth character animation.`
        : `EXPRESSIVE: change ${maxChangedWords} words between frames. Think dynamic character animation.`;

  const prompt = `You are creating a sequence of frame images for a unified-background inpainting animation pipeline.

## HOW THE PIPELINE WORKS:
- Frame 1 is generated on a fixed unified background and becomes the master frame.
- Frames 2+ are image-to-image from the immediately previous frame, so each prompt must describe only the next tiny motion step.
- A separate character turnaround sheet is used ONLY to lock identity, outfit, body proportions, and colors for the master frame.
- The camera, lens, crop, background objects, lighting, color palette, and character scale must stay locked across all frames.
- Every frame prompt MUST explicitly describe where the character stands/sits in the frame, body orientation, gaze direction, pose, and the tiny change from the previous frame.
- Never let the character turnaround sheet force a front-facing neutral pose.

## SCENE TEMPLATE:
${sceneBlock}

## SEGMENT STORY: ${segment.description}

## FRAME IMAGE RULES:
1. Generate EXACTLY ${frameCount} frames (numbered 1 to ${frameCount})
2. Every imagePrompt must be a complete frame instruction, 55-95 English words, including locked scene/camera plus the current pose.
3. Every actionDescription must be a frame-to-frame motion delta, not a new scene. Include screen position, body orientation, gaze direction, pose/action, expression, and exactly what changed since the previous frame. 30-55 English words.
4. If the story implies side/back/profile/looking-away, state it explicitly. Avoid defaulting to "front-facing".
5. ${variationDesc}
6. The action change must be GRADUAL and CONTINUOUS across frames, suitable for animation onion-skinning.
7. DO NOT change: background, camera angle, crop, lens, lighting, color palette, clothing, character identity, character scale, or prop positions.
8. DO NOT add/remove characters or objects between frames
9. The first frame${isFirstSegment ? '' : ' must smoothly continue from the previous segment\'s last action'}: ${prevFrameAction || 'starting pose based on story'}
10. CRITICAL: The character turnaround reference is IDENTITY ONLY. Do not copy its neutral front-facing pose into story frames.
11. CRITICAL: Frame-specific placement/orientation/action has higher priority than the turnaround sheet.
12. For frames 2+, actionDescription should start with "From the previous frame," and describe a small incremental movement such as head turn, eye line shift, hand lift, weight shift, step, or expression change.
13. Keep motion physically plausible: no teleporting, no sudden scale changes, no sudden limb jumps, no new camera move.

## KEYFRAME PRINCIPLE:
- Frame 1: starting action (subtle, establishing) — this is the MASTER FRAME used as visual reference
- Frame ${Math.max(2, (frameCount * 0.25) | 0)}-${(frameCount * 0.5) | 0}: action development
- Frame ${(frameCount * 0.5) | 0}-${(frameCount * 0.75) | 0}: action peak/climax
- Frame ${(frameCount * 0.75) | 0}-${frameCount}: action resolution/preparing for next

Return JSON:
{
  "shots": [
    {
      "index": 1,
      "segmentIndex": ${segment.index},
      "shotType": "Medium Shot",
      "sceneDescription": "中文场景描述",
      "cameraMovement": "Static",
      "mood": "中文情绪",
      "duration": "${(1/frameCount).toFixed(4)}s",
      "characterDescription": "英文人物外观（从模板复制）",
      "imagePrompt": "Complete English frame instruction. Must include exact screen position, body orientation, gaze direction, pose/action, expression, and scene interaction.",
      "actionDescription": "English action instruction with screen position + body orientation + gaze direction + pose/action + expression."
    }
  ]
}

Generate exactly ${frameCount} shots. Make the character's placement and facing direction follow the story, not the neutral turnaround sheet.`;

  // ── 带重试的段落帧生成 ──
  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.5',
          messages: [
            { role: 'system', content: 'You are a frame image director for a reference-based animation pipeline. Frame 1 is the master frame (full scene prompt). Frames 2+ are reference-based (action delta only, since the reference image locks all visual elements). Respond with valid JSON only.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.6,
          max_tokens: 16384,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { error?: { message?: string } })?.error?.message ||
            `分镜生成失败 (段落 ${segment.index}, status ${res.status})`
        );
      }

      const data = await res.json();
      const finishReason = data?.choices?.[0]?.finish_reason;
      const content: string = data?.choices?.[0]?.message?.content || '{}';

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content);
      } catch {
        if (finishReason === 'length') {
          console.warn(`[generateSegmentFrames] Segment ${segment.index} truncated (attempt ${attempt}/${MAX_RETRIES}), attempting repair...`);
          const repaired = tryRepairTruncatedJSON(content);
          if (repaired) {
            try {
              parsed = JSON.parse(repaired);
              console.warn(`[generateSegmentFrames] Repair succeeded`);
            } catch {
              if (attempt < MAX_RETRIES) { lastError = new Error(`段落 ${segment.index} 截断修复失败，重试中...`); console.warn(lastError.message); continue; }
              throw new Error(`段落 ${segment.index} 响应被截断且修复失败。请降低帧率或减少秒数。`);
            }
          } else {
            if (attempt < MAX_RETRIES) { lastError = new Error(`段落 ${segment.index} 截断无法修复，重试中...`); console.warn(lastError.message); continue; }
            throw new Error(`段落 ${segment.index} 响应被截断且无法修复。请降低帧率或减少秒数。`);
          }
        } else {
          if (attempt < MAX_RETRIES) { lastError = new Error(`段落 ${segment.index} JSON 解析失败，重试中...`); console.warn(lastError.message); continue; }
          throw new Error(`段落 ${segment.index} 响应 JSON 解析失败`);
        }
      }

      const rawShots: Record<string, unknown>[] = Array.isArray(parsed)
        ? (parsed as Record<string, unknown>[])
        : ((parsed as Record<string, unknown[]>)?.shots as Record<string, unknown>[]) || [];

      if (!rawShots.length) {
        if (attempt < MAX_RETRIES) {
          lastError = new Error(`段落 ${segment.index} 未返回任何帧数据（shots 为空），重试 ${attempt}/${MAX_RETRIES}...`);
          console.warn(lastError.message);
          // 重试时调高 temperature 让模型更发散，避免输出空数组
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`段落 ${segment.index} 未返回任何帧数据（已重试 ${MAX_RETRIES} 次）`);
      }

      // 成功获取帧数据
      if (attempt > 1) {
        console.log(`[generateSegmentFrames] Segment ${segment.index}: succeeded on attempt ${attempt}/${MAX_RETRIES}`);
      }

      return rawShots.map((s, i) => ({
        id: `shot-${Date.now()}-${segment.index}-${i}`,
        index: 0, // 将在外层设置正确的全局索引
        segmentIndex: segment.index,
        segmentDescription: segment.description,
        shotType: String(s.shotType || 'Medium Shot'),
        sceneDescription: String(s.sceneDescription || ''),
        cameraMovement: String(s.cameraMovement || 'Static'),
        mood: String(s.mood || ''),
        duration: String(s.duration || `${(1/frameCount).toFixed(4)}s`),
        characterDescription: String(s.characterDescription || charBlock),
        baseImagePrompt: String(s.imagePrompt || ''),
        imagePrompt: String(s.imagePrompt || ''),
        actionDescription: String(s.actionDescription || ''),
        imageStatus: 'idle' as const,
      }));
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        console.warn(`[generateSegmentFrames] Segment ${segment.index} attempt ${attempt} failed: ${(err as Error).message}, retrying...`);
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw lastError;
    }
  }

  // 不应该到这里，但 TypeScript 需要
  throw lastError || new Error(`段落 ${segment.index} 生成失败`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 主入口：生成完整分镜脚本
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 逐帧动画式分镜生成
 * 
 * 新策略（逐帧动画思想）：
 *   Phase 0: 生成场景模板（固定背景、人物外观、构图、光照）
 *   Phase 1: 逐段请求，每段生成 fps 帧，只描述微小动作变化
 * 
 * 优势：
 *   - 场景模板只生成一次，保证全局一致
 *   - 每段独立请求，24fps×4s=96帧也不会截断（每段只输出24帧）
 *   - 帧间只有2-4个词的动作差异，保证视觉连续性
 */
export async function generateStoryboardScript(
  segments: StorySegment[],
  style: string,
  fps: number,
  variation: number = 0.10,
  imageSize: string = '1024x1024',
): Promise<{ shots: Shot[]; backgroundImageUrl?: string; backgroundPrompt?: string }> {
  const fixedImageSize = normalizeImageSize(imageSize);
  const totalExpected = segments.length * fps;
  console.log(`[generateStoryboardScript] Starting: ${segments.length} segments × ${fps} fps = ${totalExpected} frames`);

  // ── Phase 0: 生成场景模板 ──
  const template = await generateSceneTemplate(segments, style, fixedImageSize);
  console.log(`[generateStoryboardScript] Scene template: ${template.characters.length} characters, scene="${template.fixedScene.slice(0, 60)}..."`);

  // ── Phase 0.5: 生成固定背景图 ──
  let backgroundImageUrl: string | undefined;
  let characterMaskDataUrl: string | undefined;

  if (template.backgroundPrompt) {
    try {
      console.log(`[generateStoryboardScript] Generating background image...`);
      backgroundImageUrl = await generateBackgroundImage(template.backgroundPrompt, fixedImageSize);
      console.log(`[generateStoryboardScript] Background image ready: ${backgroundImageUrl.slice(0, 60)}...`);

      // 生成蒙版（在浏览器端用 Canvas 绘制）
      if (template.characterRegion) {
        characterMaskDataUrl = generateMaskDataUrl(template.characterRegion, fixedImageSize);
        console.log(`[generateStoryboardScript] Mask generated for region: "${template.characterRegion}", size=${fixedImageSize}`);
      }
    } catch (bgErr) {
      console.warn(`[generateStoryboardScript] Background image generation failed: ${(bgErr as Error).message}, will use direct generation`);
    }
  }

  // ── Phase 1: 并行生成帧（分批并发，加速 2-3 倍） ──
  const CONCURRENCY = 3; // 段落并发数
  const allShots: Shot[] = [];
  let globalIndex = 0;

  // 先收集所有段落的结果（按批次并发）
  const segResults: { si: number; shots: Shot[] }[] = [];

  for (let batchStart = 0; batchStart < segments.length; batchStart += CONCURRENCY) {
    const batch = segments.slice(batchStart, batchStart + CONCURRENCY);
    const batchPromises = batch.map(async (seg) => {
      const si = seg.index;
      // 简化的跨段连续性：用前一段的描述作为 hint（不依赖前一段的完成）
      const prevHint = si > 0 ? segments[si - 1].description : '';

      try {
        const segShots = await generateSegmentFrames(
          seg,
          fps,
          template,
          prevHint,  // 使用段落描述作为连续性 hint（并行时无法拿到前段的实际帧）
          si === 0,
          variation, // 帧间变化幅度
        );
        return { si, shots: segShots };
      } catch (segErr) {
        // 段落生成失败 → 用默认帧填充
        console.warn(`[generateStoryboardScript] Segment ${si} failed: ${(segErr as Error).message}, generating fallback frames`);
        const charBlock = template.characters.length > 0
          ? template.characters.map(c => `${c.name}: ${c.appearance} (position: ${c.position})`).join('. ')
          : '';
        const sceneBlock = [
          template.fixedScene,
          charBlock,
          template.composition,
          template.lighting,
          template.colorPalette,
          template.style,
          template.sizeConstraint ? `SIZE ANCHOR: ${template.sizeConstraint}` : '',
        ].filter(Boolean).join('. ');

        const fallbackShots = Array.from({ length: fps }, (_, fi) => {
          // 确保 prompt 不为空——如果 sceneBlock 和描述都为空，用默认 prompt
          const fallbackPrompt = [sceneBlock, seg.description, `frame ${fi + 1} of ${fps}`]
            .filter(s => s && s.trim())
            .join('. ') || 'cinematic scene, medium shot, consistent lighting';
          // 帧 0 用完整 prompt，后续帧用简短动作描述
          const isFirstFrame = fi === 0;
          const fallbackAction = isFirstFrame ? '' : `${seg.description}, frame ${fi + 1} of ${fps}, slight action progression`;
          return {
            id: `shot-${Date.now()}-${seg.index}-${fi}`,
            index: 0,
            segmentIndex: seg.index,
            segmentDescription: seg.description,
            shotType: 'Medium Shot' as const,
            sceneDescription: seg.description,
            cameraMovement: 'Static' as const,
            mood: '',
            duration: `${(1/fps).toFixed(4)}s`,
            characterDescription: charBlock || 'A character',
            baseImagePrompt: fallbackPrompt,
            imagePrompt: fallbackPrompt,
            actionDescription: fallbackAction,
            imageStatus: 'idle' as const,
          };
        });
        return { si, shots: fallbackShots };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    segResults.push(...batchResults);

    // 每批日志
    for (const r of batchResults) {
      console.log(`[generateStoryboardScript] Segment ${r.si}: ${r.shots.length} frames`);
    }
  }

  // 按原始段落顺序排列，分配全局索引
  segResults.sort((a, b) => a.si - b.si);
  for (const { shots: segShots } of segResults) {
    if (segShots.length !== fps) {
      console.warn(`[generateStoryboardScript] expected ${fps} frames, got ${segShots.length}`);
    }

    for (const shot of segShots) {
      shot.index = globalIndex + 1;
      if (characterMaskDataUrl) {
        shot.maskImageUrl = characterMaskDataUrl;
      }
      globalIndex++;
    }

    allShots.push(...segShots);
  }

  console.log(`[generateStoryboardScript] All segments complete: ${allShots.length} frames`);

  if (allShots.length < totalExpected) {
    console.warn(`[generateStoryboardScript] WARNING: Generated ${allShots.length}/${totalExpected} frames`);
  } else {
    console.log(`[generateStoryboardScript] Complete: ${allShots.length} frames generated`);
  }

  for (const seg of segments) {
    seg.shots = allShots.filter((s) => s.segmentIndex === seg.index);
  }

  return { shots: allShots, backgroundImageUrl, backgroundPrompt: template.backgroundPrompt };
}

/** 尝试修复被截断的 JSON（补全未闭合的字符串、数组和对象） */
function tryRepairTruncatedJSON(content: string): string | null {
  let repaired = content.trimEnd();

  // 移除最后一个不完整的 shot 对象（可能包含未闭合的字符串）
  const lastCompleteShot = repaired.lastIndexOf('},');
  const lastShotInArray = repaired.lastIndexOf('}');

  if (lastCompleteShot >= 0) {
    repaired = repaired.substring(0, lastCompleteShot + 1);
  } else if (lastShotInArray >= 0) {
    repaired = repaired.substring(0, lastShotInArray + 1);
  } else {
    return null;
  }

  // 补全未闭合的数组和对象
  let openBrackets = 0;
  let openBraces = 0;
  for (const ch of repaired) {
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
  }

  for (let i = 0; i < openBrackets; i++) repaired += ']';
  for (let i = 0; i < openBraces; i++) repaired += '}';

  return repaired;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 图像生成 —— 固定 1024x1024
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 背景分离方案的辅助函数 ────────────────────────────────────────────────

/**
 * 生成固定背景图（纯环境，无人物）
 * 用于背景分离+蒙版重绘方案
 */
export async function generateBackgroundImage(
  backgroundPrompt: string,
  imageSize: string = '1024x1024',
): Promise<string> {
  const fixedImageSize = normalizeImageSize(imageSize);
  const fullPrompt = `${backgroundPrompt}, no people, no characters, no human figures, empty scene, high quality, detailed background`;
  console.log(`[generateBackgroundImage] prompt="${fullPrompt.slice(0, 80)}...", size=${fixedImageSize}`);

  const res = await fetch(`${API_BASE}/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt: fullPrompt,
      n: 1,
      size: fixedImageSize,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } })?.error?.message || `背景图生成失败 (${res.status})`);
  }

  const data = await res.json();
  const item = (data.data as Array<Record<string, unknown>>)?.[0];
  if (!item) throw new Error('背景图 API 返回空数据');
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) {
    // 背景图 URL → base64（必须转为 base64，因为后续 inpaint 需要 base64）
    console.log(`[generateBackgroundImage] Got external URL, converting to base64 via proxy`);
    try {
      const proxyRes = await fetch(`${API_BASE}/fetch-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url }),
        signal: AbortSignal.timeout(30_000),
      });
      if (proxyRes.ok) {
        const proxyData = await proxyRes.json();
        const base64 = (proxyData as { base64?: string })?.base64;
        if (base64) return base64;
      }
    } catch (proxyErr) {
      console.warn(`[generateBackgroundImage] URL→base64 proxy failed: ${(proxyErr as Error).message}`);
    }
    return item.url as string;
  }
  throw new Error('背景图 API 响应缺少 url 和 b64_json');
}

export async function generateCharacterTurnaround(
  characterDescription: string,
  style: string,
  imageSize: string = '1024x1024',
): Promise<{ imageUrl: string; prompt: string }> {
  const fixedImageSize = normalizeImageSize(imageSize);
  const prompt = `Create a clean character turnaround reference sheet for animation consistency.
Show the SAME character in exactly three full-body views: front view, side view, and back view, aligned left to right on a plain neutral studio background.
The character must be identical across all three views: same face, hair, body proportions, clothing, colors, accessories, and silhouette.
No scene background, no action pose, no dramatic lighting, no extra props, no text labels, no watermark.
Visual style: ${style}.
Character specification: ${characterDescription}`;

  console.log(`[generateCharacterTurnaround] prompt="${prompt.slice(0, 100)}...", size=${fixedImageSize}`);

  const res = await fetch(`${API_BASE}/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt,
      n: 1,
      size: fixedImageSize,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } })?.error?.message || `人物三视图生成失败 (${res.status})`);
  }

  const data = await res.json();
  const item = (data.data as Array<Record<string, unknown>>)?.[0];
  if (!item) throw new Error('人物三视图 API 返回空数据');
  if (item.b64_json) return { imageUrl: `data:image/png;base64,${item.b64_json}`, prompt };
  if (item.url) {
    try {
      const proxyRes = await fetch(`${API_BASE}/fetch-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url }),
        signal: AbortSignal.timeout(30_000),
      });
      if (proxyRes.ok) {
        const proxyData = await proxyRes.json();
        const base64 = (proxyData as { base64?: string })?.base64;
        if (base64) return { imageUrl: base64, prompt };
      }
    } catch (proxyErr) {
      console.warn(`[generateCharacterTurnaround] URL→base64 proxy failed: ${(proxyErr as Error).message}`);
    }
    return { imageUrl: item.url as string, prompt };
  }
  throw new Error('人物三视图 API 响应缺少 url 和 b64_json');
}

/**
 * 生成蒙版图（Canvas 绘制）
 * 根据 characterRegion 描述，在指定尺寸画布上绘制白色角色区域、黑色背景
 * 标准 RGBA PNG：白色不透明 (255,255,255,1) = 要重绘的区域，黑色不透明 (0,0,0,1) = 保留区域
 *
 * 防抖动设计：
 *   1. 蒙版尺寸与图片尺寸严格一致
 *   2. 白色区域外围绘制固定大小的外框锚点（bounding box），锁定角色占比
 *   3. 所有帧共享相同的蒙版，角色被限制在固定区域内
 *
 * characterRegion 格式例：
 *   "lower-center 40% of frame" → 下方 40% 中心区域
 *   "center of image, head-to-waist" → 中央偏上
 *   "full left half of image" → 左半
 */
export function generateMaskDataUrl(characterRegion: string, imageSize: string = '1024x1024'): string {
  const fixedImageSize = normalizeImageSize(imageSize);
  const [targetW, targetH] = fixedImageSize.split('x').map(Number);
  const W = targetW || 1024;
  const H = targetH || 1024;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // 初始化：全黑（保留背景）
  ctx.fillStyle = 'rgba(0,0,0,255)';
  ctx.fillRect(0, 0, W, H);

  // 根据 characterRegion 描述计算蒙版区域（相对于 W×H）
  const region = characterRegion.toLowerCase();

  let x = W * 0.25;
  let y = H * 0.1;
  let w = W * 0.5;
  let h = H * 0.8;

  // 水平位置
  if (region.includes('left half') || region.includes('full left')) {
    x = 0; w = W * 0.5;
  } else if (region.includes('right half') || region.includes('full right')) {
    x = W * 0.5; w = W * 0.5;
  } else if (region.includes('center-left') || region.includes('left-center')) {
    x = 0; w = W * 0.6;
  } else if (region.includes('center-right') || region.includes('right-center')) {
    x = W * 0.4; w = W * 0.6;
  } else {
    x = W * 0.25; w = W * 0.5;
  }

  // 垂直位置
  const percentMatch = region.match(/(\d+)%/);
  const heightPercent = percentMatch ? parseInt(percentMatch[1]) / 100 : 0.7;

  if (region.includes('lower') || region.includes('bottom')) {
    h = H * heightPercent;
    y = H - h;
  } else if (region.includes('upper') || region.includes('top')) {
    h = H * heightPercent;
    y = 0;
  } else if (region.includes('full') || region.includes('entire')) {
    y = 0; h = H;
  } else if (region.includes('head-to-waist') || region.includes('upper body')) {
    y = H * 0.1; h = H * 0.5;
  } else if (region.includes('knees up') || region.includes('three-quarter')) {
    y = H * 0.1; h = H * 0.65;
  } else {
    y = H * 0.1; h = H * 0.75;
  }

  // ── 固定外框锚点（Bounding Box 锚点）──
  // 在白色角色区域外围画一个稍大的矩形框（灰色），作为 AI 重绘时的边界参考
  // 这确保 AI 在每次重绘时都把角色限制在这个固定框内，防止缩放抖动
  const ANCHOR_PADDING = Math.max(Math.round(Math.min(W, H) * 0.03), 4); // 3% 边距
  const anchorX = Math.max(0, x - ANCHOR_PADDING);
  const anchorY = Math.max(0, y - ANCHOR_PADDING);
  const anchorW = Math.min(W, w + ANCHOR_PADDING * 2);
  const anchorH = Math.min(H, h + ANCHOR_PADDING * 2);

  // 绘制锚点框（浅灰色，作为 AI 的边界参考，不会被重绘）
  ctx.strokeStyle = 'rgba(200,200,200,1)';
  ctx.lineWidth = Math.max(2, Math.round(Math.min(W, H) * 0.005));
  ctx.strokeRect(anchorX, anchorY, anchorW, anchorH);

  // 白色不透明区域 (alpha=1) = inpaint 将在此重绘角色
  // 黑色不透明区域 (alpha=1) = 保留背景不动
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(x, y, w, h);

  return canvas.toDataURL('image/png');
}

/**
 * 调用后端 inpaint 接口（背景+蒙版重绘）
 * @param backgroundImageUrl - 固定背景图（base64 或 URL）
 * @param maskDataUrl - 蒙版图（带 Alpha 的 PNG base64）
 * @param characterPrompt - 角色外观+动作的完整描述
 * @param model - 使用的模型（默认 gpt-image-2，降级可用 dall-e-2）
 */
async function inpaintFrame(
  backgroundImageUrl: string,
  maskDataUrl: string,
  characterPrompt: string,
  frameName?: string,
  model = 'gpt-image-2',
  imageSize: string = '1024x1024',
  characterReferenceImageUrl?: string,
): Promise<string> {
  const fixedImageSize = normalizeImageSize(imageSize);
  // 确保背景图是 base64 data URL
  let bgBase64 = backgroundImageUrl;
  if (!backgroundImageUrl.startsWith('data:')) {
    // 外部 URL → 通过后端代理下载（避免 CORS），30秒超时
    console.log(`[inpaintFrame] Fetching background via proxy: ${backgroundImageUrl.slice(0, 60)}...`);
    const proxyController = new AbortController();
    const proxyTimeout = setTimeout(() => proxyController.abort(), 30_000);
    try {
      const proxyRes = await fetch(`${API_BASE}/fetch-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: backgroundImageUrl }),
        signal: proxyController.signal,
      });
      if (!proxyRes.ok) throw new Error(`背景图下载失败 (${proxyRes.status})`);
      const proxyData = await proxyRes.json();
      bgBase64 = (proxyData as { base64: string }).base64;
    } finally {
      clearTimeout(proxyTimeout);
    }
  }

  // inpaint 请求，6分钟超时（图片生成需1-5分钟）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 360_000);

  try {
    const res = await fetch(`${API_BASE}/inpaint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backgroundImageBase64: bgBase64,
        maskBase64: maskDataUrl,
        prompt: characterPrompt,
        frameName,
        model,
        size: fixedImageSize,
        characterReferenceImageBase64: characterReferenceImageUrl,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: { message?: string } })?.error?.message || `Inpaint 失败 (${res.status})`);
    }

    const data = await res.json();
    const item = (data.data as Array<Record<string, unknown>>)?.[0];
    if (!item) throw new Error('Inpaint API 返回空数据');
    if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
    if (item.url) {
      // 外部 URL → 通过后端代理下载为 base64
      console.log(`[inpaintFrame] Got external URL, converting to base64 via proxy`);
      try {
        const proxyRes = await fetch(`${API_BASE}/fetch-image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: item.url }),
          signal: AbortSignal.timeout(30_000),
        });
        if (proxyRes.ok) {
          const proxyData = await proxyRes.json();
          const base64 = (proxyData as { base64?: string })?.base64;
          if (base64) return base64;
        }
      } catch (proxyErr) {
        console.warn(`[inpaintFrame] URL→base64 proxy failed: ${(proxyErr as Error).message}`);
      }
      return item.url as string;
    }
    throw new Error('Inpaint API 响应缺少 url 和 b64_json');
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 生成单张图（支持两种模式）
 *
 * 模式一：背景分离 + Inpaint（推荐，背景绝对一致）
 *   传入 backgroundImageUrl + maskDataUrl → 调用 /api/inpaint
 *   角色在蒙版白色区域重绘，背景保持原封不动
 *
 * 模式二：直接生图（降级/兜底）
 *   传入 prompt → 调用 /api/images
 *
 * @param shot - 分镜数据
 * @param editedPrompt - 用户直接编辑后的完整 prompt（优先级最高）
 * @param modificationPrompt - 用户描述的修改内容，通过 AI 重写为完整 prompt
 * @param referenceImageUrl - 参考图 URL（base64 data URL，用于图生图）
 * @param backgroundImageUrl - 固定背景图（背景分离方案）
 * @param maskDataUrl - 蒙版图（背景分离方案）
 */
export async function generateShotImage(
  shot: Shot,
  editedPrompt?: string,
  modificationPrompt?: string,
  referenceImageUrl?: string,
  backgroundImageUrl?: string,
  maskDataUrl?: string,
  imageSize: string = '1024x1024',
  requireBackgroundInpaint: boolean = false,
  characterTurnaroundUrl?: string,
): Promise<string> {
  const fixedImageSize = normalizeImageSize(imageSize);
  let finalPrompt: string;

  const isReferenceMode = !!(referenceImageUrl && referenceImageUrl.startsWith('data:'));

  if (editedPrompt?.trim()) {
    finalPrompt = editedPrompt.trim();
  } else if (modificationPrompt?.trim()) {
    try {
      finalPrompt = await rewritePromptWithModification(shot.baseImagePrompt || shot.imagePrompt, modificationPrompt.trim());
      console.log(`[generateShotImage] Rewrote prompt via AI: "${modificationPrompt.trim().slice(0, 40)}..." → ${finalPrompt.length} chars`);
    } catch {
      console.warn('[generateShotImage] AI prompt rewrite failed, using fallback');
      finalPrompt = `${shot.imagePrompt}. INSTRUCT: ${modificationPrompt.trim()}`;
    }
  } else if (isReferenceMode && shot.actionDescription?.trim()) {
    // 参考图模式 + 有动作描述：使用简短的动作 delta 作为 prompt
    // 参考图已锁定全部视觉要素，只需描述本帧的微小动作变化
    finalPrompt = [
      shot.actionDescription.trim(),
      shot.sceneDescription ? `Scene continuity: ${shot.sceneDescription}` : '',
      shot.cameraMovement ? `Camera must remain ${shot.cameraMovement}; do not introduce a new camera move.` : '',
    ].filter(Boolean).join(' ');
    console.log(`[generateShotImage] Reference mode with actionDescription (${finalPrompt.length} chars delta)`);
  } else if (isReferenceMode) {
    // 参考图模式但无动作描述：使用完整 prompt（带一致性前缀）
    finalPrompt = shot.imagePrompt;
    console.log(`[generateShotImage] Reference mode without actionDescription, using full prompt`);
  } else {
    finalPrompt = shot.imagePrompt;
  }

  if (!finalPrompt.trim()) {
    throw new Error('Image prompt is empty');
  }

  // 使用带序号前缀的 frameName，保证文件按帧顺序排序
  const paddedIndex = String(shot.index ?? 0).padStart(5, '0');
  const frameNameWithIndex = `${paddedIndex}-${shot.id}`;

  // ── 模式一：背景分离 + Inpaint（仅用于首帧 / 无参考图的主帧生成）──
  // 条件：有背景图 + 有蒙版，不是用户手动编辑，且不是参考图模式
  // 参考图模式下走模式二（图生图），不经过 inpaint
  if (backgroundImageUrl && maskDataUrl && !editedPrompt?.trim() && !modificationPrompt?.trim() && !isReferenceMode) {
    console.log(`[generateShotImage] Using inpaint mode (background + mask), shot=${shot.id}`);
    try {
      // inpaint prompt = 角色外观 + 动作描述（不含背景信息，因为背景已固定）
      const frameDirection = [
        shot.actionDescription,
        shot.sceneDescription,
        shot.cameraMovement ? `camera: ${shot.cameraMovement}` : '',
      ].filter(Boolean).join('. ');
      const inpaintPrompt = characterTurnaroundUrl
        ? `Frame-specific direction has highest priority: ${frameDirection}. Use the provided character turnaround image as an important visual reference for identity, face, hair, body proportions, clothing, colors, accessories, and silhouette. Do NOT copy the turnaround sheet's neutral front-facing standing pose. The turnaround is identity reference only, not a pose reference. Set the character's screen position, body orientation, gaze direction, pose, and expression exactly as required by this frame. Inpaint only inside the masked character area and preserve the existing background. Frame instruction: ${finalPrompt}`
        : finalPrompt;
      const result = await inpaintFrame(backgroundImageUrl, maskDataUrl, inpaintPrompt, frameNameWithIndex, 'gpt-image-2', fixedImageSize, characterTurnaroundUrl);
      console.log(`[generateShotImage] ✅ Inpaint succeeded, shot=${shot.id}`);
      return result;
    } catch (inpaintErr) {
      console.warn(`[generateShotImage] ⚠️ Inpaint failed (gpt-image-2): ${(inpaintErr as Error).message}, trying dall-e-2...`);
      // 降级：尝试 dall-e-2（更传统的蒙版重绘）
      try {
        const result = await inpaintFrame(backgroundImageUrl, maskDataUrl, finalPrompt, shot.id, 'dall-e-2', fixedImageSize);
        console.log(`[generateShotImage] ✅ dall-e-2 inpaint succeeded, shot=${shot.id}`);
        return result;
      } catch (de2Err) {
        console.warn(`[generateShotImage] ⚠️ dall-e-2 inpaint also failed: ${(de2Err as Error).message}, falling back to direct generation`);
        if (requireBackgroundInpaint) {
          throw new Error(`统一背景人物生成失败：${(de2Err as Error).message}`);
        }
        // 最终降级：直接生图
      }
    }
  } else if (requireBackgroundInpaint) {
    throw new Error('统一背景人物生成需要 backgroundImageUrl 和 maskDataUrl，且不能使用参考图模式或编辑模式。');
  } else {
    if (!backgroundImageUrl || !maskDataUrl) {
      console.log(`[generateShotImage] Direct generation mode (no background/mask), shot=${shot.id}`);
    } else if (editedPrompt?.trim() || modificationPrompt?.trim()) {
      console.log(`[generateShotImage] Direct generation mode (user edited), shot=${shot.id}`);
    }
  }

  // ── 模式二：直接生图（兜底 / 用户手动编辑 / 参考图模式） ──
  //
  // 参考图模式（image-to-image）是保证帧间一致性的核心机制：
  //   将本段主帧（或上一段主帧）作为视觉锚点传入，模型在保持角色外观、
  //   背景、光照、构图的条件下，仅按 prompt 描述的微小动作变化调整画面。

  // 参考图模式下，在 prompt 前添加一致性锚定指令
  const referencePrefix = isReferenceMode
    ? [
        'REFERENCE-BASED FRAME CONTINUATION:',
        'Use the provided previous frame as the visual base for the next animation frame.',
        'Preserve the same camera angle, lens, crop, perspective, background objects, object positions, lighting, shadows, color palette, image style, character identity, face, clothing, and character scale.',
        'Make only the small character motion described in the prompt.',
        'Do not repaint the scene, do not redesign the background, do not add or remove objects, do not zoom, do not pan, do not change the time of day.',
        'The result should look like the next adjacent frame in the same shot.',
      ].join(' ') + ' '
    : '';

  const body: Record<string, unknown> = {
    model: 'gpt-image-2',
    prompt: referencePrefix + finalPrompt,
    frameName: frameNameWithIndex,
    n: 1,
    size: fixedImageSize,
  };

  if (isReferenceMode) {
    body.image = referenceImageUrl;
    console.log(`[generateShotImage] Reference-based image-to-image mode (${(referenceImageUrl.length / 1024).toFixed(0)}KB ref)`);
  } else if (referenceImageUrl) {
    console.warn(`[generateShotImage] Reference image is NOT base64, skipping image-to-image mode`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 360_000); // 6分钟超时

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if ((fetchErr as Error).name === 'AbortError') {
      throw new Error('图像生成超时（6分钟），请检查网络或后端服务');
    }
    const errMsg = (fetchErr as Error).message || '';
    if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError') || errMsg.includes('net::ERR')) {
      throw new Error(`无法连接到后端服务（${errMsg}）。请确认后端已启动（端口 3001）。`);
    }
    throw new Error(`网络错误: ${errMsg}`);
  } finally {
    clearTimeout(timeoutId);
  }

  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    const text = await res.text().catch(() => '');
    throw new Error(
      res.status === 500
        ? `图像生成服务内部错误 (500)。${text ? `响应内容: ${text.slice(0, 200)}` : ''}`
        : `图像 API 返回了非 JSON 响应 (HTTP ${res.status})`
    );
  }

  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const dataArr = (data.data as Array<Record<string, unknown>> | undefined) || [];
  if (dataArr.length === 0) throw new Error('API returned empty data array');

  const item = dataArr[0];
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) {
    // 外部 URL → 通过后端代理下载为 base64（避免 CORS/过期/混合内容问题）
    console.log(`[generateShotImage] Got external URL, converting to base64 via proxy: ${String(item.url).slice(0, 60)}...`);
    try {
      const proxyRes = await fetch(`${API_BASE}/fetch-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url }),
        signal: AbortSignal.timeout(30_000),
      });
      if (proxyRes.ok) {
        const proxyData = await proxyRes.json();
        const base64 = (proxyData as { base64?: string })?.base64;
        if (base64) {
          console.log(`[generateShotImage] Successfully converted URL → base64`);
          return base64; // 已包含 data:image/xxx;base64, 前缀
        }
      }
    } catch (proxyErr) {
      console.warn(`[generateShotImage] URL→base64 proxy failed, returning raw URL: ${(proxyErr as Error).message}`);
    }
    return item.url as string; // 降级：返回原始 URL
  }

  throw new Error('API response missing url and b64_json fields');
}

/**
 * 通过 AI 重写提示词 —— 提高修改敏感度
 * 不再简单拼接 "Modification: xxx"，而是让文本模型把修改融入完整的提示词
 */
async function rewritePromptWithModification(
  originalPrompt: string,
  modification: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'system',
          content: `You are an image prompt engineer. The user has an original image generation prompt and wants to modify it. Rewrite the ENTIRE prompt to incorporate the modification while keeping the overall structure and style. Output ONLY the rewritten prompt in English, no explanation, no quotes, 60-100 words. The rewritten prompt must be a complete, standalone image generation prompt.`,
        },
        {
          role: 'user',
          content: `Original prompt:\n${originalPrompt}\n\nRequired modification:\n${modification}\n\nRewrite the entire prompt with this modification applied:`,
        },
      ],
      temperature: 0.5,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    throw new Error('AI prompt rewrite failed');
  }

  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content || originalPrompt).trim();
}


// ─────────────────────────────────────────────────────────────────────────────
// 本地存储
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'storyboard_projects';
const SETTINGS_KEY = 'storyboard_settings';

export function saveProject(project: StoryboardProject): void {
  try {
    const existing = loadProjects();
    const idx = existing.findIndex((p) => p.id === project.id);

    // 保存时剥离大体积 base64 数据，避免 localStorage quota 溢出
    // 背景图和每帧的 imageUrl 可能是几 MB 的 base64 data URL
    const lightweight = {
      ...project,
      shots: project.shots.map((s) => ({
        ...s,
        // 清除 imageUrl（base64 图片数据），只保留元数据
        imageUrl: undefined,
        // 清除 maskImageUrl（蒙版 base64 数据）
        maskImageUrl: undefined,
        // 清除 referenceImageUrl
        referenceImageUrl: undefined,
      })),
      // 清除背景图 base64
      backgroundImageUrl: undefined,
      characterTurnaroundUrl: undefined,
    };

    if (idx >= 0) existing[idx] = lightweight;
    else existing.unshift(lightweight);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing.slice(0, 20)));
  } catch (err) {
    console.warn('[saveProject] Failed to save:', (err as Error).message);
    // quota 溢出时尝试清理旧项目
    try {
      const existing = loadProjects();
      if (existing.length > 5) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(existing.slice(0, 5)));
        console.warn('[saveProject] Trimmed projects to 5 to free space');
      }
    } catch {
      // 最终降级：清空所有项目
      console.warn('[saveProject] Clearing all projects due to quota');
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  }
}

export function loadProjects(): StoryboardProject[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

export function deleteProject(id: string): void {
  const existing = loadProjects().filter((p) => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
}

export function saveSettings(settings: Partial<import('../types/storyboard').AppSettings>): void {
  const existing = loadSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...existing, ...settings }));
}

export function loadSettings(): import('../types/storyboard').AppSettings {
  try {
    return JSON.parse(
      localStorage.getItem(SETTINGS_KEY) || '{}'
    ) as import('../types/storyboard').AppSettings;
  } catch {
    return { imageModel: 'gpt-image-2', fps: 8, durationSeconds: 6, style: 'cinematic', frameVariation: 0.10, imageSize: '1024x1024' };
  }
}
