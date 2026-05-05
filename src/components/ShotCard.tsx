import { useState, useRef, useEffect } from 'react';
import {
  Clock,
  Heart,
  Move,
  Image,
  Loader2,
  AlertCircle,
  Copy,
  Check,
  RefreshCw,
  X,
  Wand2,
  User,
  Upload,
} from 'lucide-react';
import type { Shot } from '../types/storyboard';

interface ShotCardProps {
  shot: Shot;
  onGenerateImage: (
    shotId: string,
    editedPrompt?: string,
    modificationPrompt?: string,
    referenceImageUrl?: string
  ) => void;
  isGeneratingAll: boolean;
}

export function ShotCard({ shot, onGenerateImage, isGeneratingAll }: ShotCardProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showRegenModal, setShowRegenModal] = useState(false);
  const [modificationInput, setModificationInput] = useState('');
  const [editedPromptInput, setEditedPromptInput] = useState('');
  const [referenceImagePreview, setReferenceImagePreview] = useState<string | null>(null);
  const [isUploadingRef, setIsUploadingRef] = useState(false);
  const [imageLoadError, setImageLoadError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 当 shot.imageUrl 改变时重置 imageLoadError
  useEffect(() => {
    setImageLoadError(false);
  }, [shot.imageUrl]);

  async function copyText(text: string, field: string) {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  function openRegenModal() {
    setModificationInput('');
    setEditedPromptInput(shot.baseImagePrompt || shot.imagePrompt);
    setReferenceImagePreview(null);
    setShowRegenModal(true);
  }

  function handleRegenerate() {
    // 判断用户是否修改了任何内容
    const originalPrompt = shot.baseImagePrompt || shot.imagePrompt;
    const hasEdited = editedPromptInput.trim().length > 0 && editedPromptInput.trim() !== originalPrompt;
    const hasMod = modificationInput.trim().length > 0;
    const hasRef = referenceImagePreview !== null;

    console.log('[ShotCard] handleRegenerate:', {
      hasEdited,
      hasMod,
      hasRef,
      editedPromptPreview: editedPromptInput.slice(0, 60),
      modificationPreview: modificationInput.slice(0, 60),
    });

    if (!hasEdited && !hasMod && !hasRef) {
      // 无任何修改，纯重新生成
      console.log('[ShotCard] Pure regenerate (no changes)');
      onGenerateImage(shot.id);
    } else {
      // 有修改，传递对应的参数
      console.log('[ShotCard] Regenerate with changes:', {
        edited: hasEdited,
        mod: hasMod,
        ref: hasRef,
      });
      onGenerateImage(
        shot.id,
        hasEdited ? editedPromptInput.trim() : undefined,
        hasMod ? modificationInput.trim() : undefined,
        hasRef ? referenceImagePreview : undefined
      );
    }

    setShowRegenModal(false);
    setModificationInput('');
    setEditedPromptInput('');
    setReferenceImagePreview(null);
  }

  function handleReferenceUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingRef(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result as string;
      setReferenceImagePreview(result);
      setIsUploadingRef(false);
    };
    reader.onerror = () => setIsUploadingRef(false);
    reader.readAsDataURL(file);

    // 清空 input，允许重复选择同一文件
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function clearReferenceImage() {
    setReferenceImagePreview(null);
  }

  const CopyBtn = ({ text, field }: { text: string; field: string }) => (
    <button
      onClick={() => copyText(text, field)}
      className="p-1 rounded hover:bg-white/10 transition-colors text-white/30 hover:text-white/70"
      title="复制"
    >
      {copiedField === field ? (
        <Check size={12} className="text-green-400" />
      ) : (
        <Copy size={12} />
      )}
    </button>
  );

  return (
    <>
      <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden hover:border-violet-500/30 transition-colors group">
        {/* 镜头头部 */}
        <div className="px-4 py-3 bg-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-full bg-violet-600/40 flex items-center justify-center text-xs font-bold text-violet-300">
              {shot.index}
            </span>
            <span className="text-sm font-medium text-white/80">{shot.shotType}</span>
            {shot.segmentDescription && (
              <span className="hidden sm:inline text-[10px] text-white/25 bg-white/5 px-1.5 py-0.5 rounded">
                段{shot.segmentIndex + 1}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-white/40">
            <span className="flex items-center gap-1">
              <Clock size={11} />
              {shot.duration}
            </span>
            <span className="flex items-center gap-1">
              <Move size={11} />
              {shot.cameraMovement}
            </span>
          </div>
        </div>

        {/* 图像区域 - 保持 1:1 正方形（与生成尺寸 1024x1024 一致，不裁切变形） */}
        <div className="relative aspect-square bg-black/30 overflow-hidden">
          {shot.imageStatus === 'done' && shot.imageUrl && !imageLoadError ? (
            <img
              src={shot.imageUrl}
              alt={`Shot ${shot.index}`}
              className="w-full h-full object-contain"
              onError={() => setImageLoadError(true)}
              onLoad={() => setImageLoadError(false)}
            />
          ) : imageLoadError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-amber-400/70 px-4 text-center">
              <AlertCircle size={24} />
              <span className="text-xs">图片加载失败（可能 URL 已过期）</span>
              <button
                onClick={() => { setImageLoadError(false); onGenerateImage(shot.id); }}
                className="text-xs px-3 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 transition-colors flex items-center gap-1"
              >
                <RefreshCw size={11} /> 重新生成
              </button>
            </div>
          ) : shot.imageStatus === 'loading' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/40">
              <Loader2 size={28} className="animate-spin text-violet-400" />
              <span className="text-xs">生成图像中...</span>
            </div>
          ) : shot.imageStatus === 'error' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-red-400/70 px-4 text-center">
              <AlertCircle size={24} />
              <span className="text-xs">{shot.imageError || '生成失败'}</span>
              <button
                onClick={() => onGenerateImage(shot.id)}
                className="text-xs px-3 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 transition-colors flex items-center gap-1"
              >
                <RefreshCw size={11} /> 重试
              </button>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center">
                <Image size={24} className="text-white/20" />
              </div>
              <button
                onClick={() => onGenerateImage(shot.id)}
                disabled={isGeneratingAll}
                className="text-xs px-4 py-2 rounded-lg bg-violet-600/60 hover:bg-violet-600/80 text-white/80 hover:text-white transition-colors disabled:opacity-40 flex items-center gap-1.5"
              >
                <Image size={12} />
                生成图像
              </button>
            </div>
          )}

          {/* 情绪标签 */}
          <div className="absolute top-2 left-2">
            <span className="px-2 py-0.5 rounded-full bg-black/50 backdrop-blur-sm text-xs text-white/60 flex items-center gap-1">
              <Heart size={10} className="text-rose-400" />
              {shot.mood}
            </span>
          </div>
        </div>

        {/* 人物描述（如果存在） */}
        {shot.characterDescription && (
          <div className="px-4 pt-2">
            <div className="flex items-center gap-1.5 mb-1">
              <User size={11} className="text-amber-400" />
              <span className="text-xs text-amber-400/70 font-medium">人物外观</span>
            </div>
            <p className="text-xs text-amber-200/50 leading-relaxed bg-amber-500/5 rounded-lg px-3 py-1.5 border border-amber-500/10 line-clamp-2">
              {shot.characterDescription}
            </p>
          </div>
        )}

        {/* 场景描述 */}
        <div className="px-4 pt-3 pb-2">
          <p className="text-sm text-white/70 leading-relaxed">{shot.sceneDescription}</p>
        </div>

        {/* 图像提示词 */}
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-violet-400 flex items-center gap-1">
              <Image size={11} />
              图像提示词
            </span>
            <CopyBtn text={shot.imagePrompt} field={`img-${shot.id}`} />
          </div>
          <p className="text-xs text-white/40 leading-relaxed bg-white/3 rounded-lg px-3 py-2 border border-white/5 line-clamp-3">
            {shot.imagePrompt}
          </p>
        </div>

        {/* 底部：重新生成图像按钮（done 状态时显示） */}
        {shot.imageStatus === 'done' && (
          <div className="px-4 pb-4 flex justify-end gap-2">
            <button
              onClick={openRegenModal}
              disabled={isGeneratingAll}
              className="text-xs px-3 py-1.5 rounded-lg border border-violet-500/30 text-violet-300/70 hover:text-violet-300 hover:border-violet-500/50 transition-colors flex items-center gap-1 disabled:opacity-30"
            >
              <Wand2 size={11} />
              重新生成（修改）
            </button>
          </div>
        )}
      </div>

      {/* 重新生成弹窗 */}
      {showRegenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-gray-900 border border-white/15 rounded-2xl w-full max-w-lg p-5 shadow-2xl max-h-[90vh] overflow-y-auto">
            {/* 头部 */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-violet-600/30 flex items-center justify-center">
                  <Wand2 size={15} className="text-violet-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white/90">重新生成图像</h3>
                  <p className="text-xs text-white/30">第 {shot.index} 个分镜 · {shot.shotType}</p>
                </div>
              </div>
              <button
                onClick={() => setShowRegenModal(false)}
                className="p-1.5 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* 参考图区域（当前生成的图 + 上传的新参考图） */}
            <div className="mb-4">
              <p className="text-xs text-white/30 mb-2 font-medium flex items-center gap-1">
                <Image size={11} className="text-violet-400" />
                参考图（可选）
              </p>
              <div className="grid grid-cols-2 gap-2">
                {/* 当前生成的图 */}
                {shot.imageUrl && !referenceImagePreview && (
                  <div className="relative rounded-xl overflow-hidden border border-white/10 bg-black/40">
                    <img src={shot.imageUrl} alt="Current" className="w-full aspect-square object-cover opacity-50" />
                    <span className="absolute bottom-1 left-1 right-1 text-center text-[10px] text-white/40 bg-black/60 rounded px-1 py-0.5">
                      当前图像
                    </span>
                  </div>
                )}
                {/* 上传的参考图 */}
                {referenceImagePreview ? (
                  <div className="relative rounded-xl overflow-hidden border border-violet-500/40 bg-black/40">
                    <img src={referenceImagePreview} alt="Reference" className="w-full aspect-square object-cover" />
                    <button
                      onClick={clearReferenceImage}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center hover:bg-red-500/60 transition-colors"
                    >
                      <X size={10} className="text-white" />
                    </button>
                    <span className="absolute bottom-1 left-1 right-1 text-center text-[10px] text-violet-300 bg-black/60 rounded px-1 py-0.5">
                      参考图
                    </span>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploadingRef}
                    className="aspect-square rounded-xl border border-dashed border-white/15 bg-white/3 hover:border-violet-500/40 hover:bg-white/5 transition-colors flex flex-col items-center justify-center gap-1.5"
                  >
                    {isUploadingRef ? (
                      <Loader2 size={18} className="text-white/40 animate-spin" />
                    ) : (
                      <>
                        <Upload size={18} className="text-white/30" />
                        <span className="text-[10px] text-white/30">上传参考图</span>
                      </>
                    )}
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleReferenceUpload}
                className="hidden"
              />
              {referenceImagePreview && (
                <p className="text-[10px] text-amber-400/50 mt-1.5 flex items-center gap-1">
                  <span className="w-1 h-1 rounded-full bg-amber-400/50 inline-block" />
                  参考图将作为图生图的基础，可结合下方提示词一起使用
                </p>
              )}
            </div>

            {/* 直接编辑提示词 */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs text-white/30 font-medium flex items-center gap-1">
                  <Wand2 size={11} className="text-violet-400" />
                  图像提示词（可直接编辑）
                </p>
                <button
                  onClick={() => setEditedPromptInput(shot.baseImagePrompt || shot.imagePrompt)}
                  className="text-[10px] text-violet-400/60 hover:text-violet-400 transition-colors"
                >
                  重置
                </button>
              </div>
              <textarea
                value={editedPromptInput}
                onChange={(e) => setEditedPromptInput(e.target.value)}
                rows={4}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white/80 leading-relaxed resize-none focus:outline-none focus:border-violet-500/50 transition-colors placeholder:text-white/15"
                placeholder="在此直接编辑图像提示词（英文）……"
              />
            </div>

            {/* 修改描述（追加方式） */}
            <div className="mb-4">
              <p className="text-xs text-white/30 mb-1.5 font-medium flex items-center gap-1">
                <RefreshCw size={11} className="text-cyan-400" />
                修改描述（可选，与上方提示词叠加）
              </p>
              <textarea
                value={modificationInput}
                onChange={(e) => setModificationInput(e.target.value)}
                placeholder="例如：将背景改为夜景、人物服装换成红色、添加下雨效果……"
                rows={2}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white/70 leading-relaxed resize-none focus:outline-none focus:border-cyan-500/50 transition-colors placeholder:text-white/15"
              />
              {modificationInput.trim() && (
                <p className="text-[10px] text-cyan-400/50 mt-1">
                  将追加到提示词后：<span className="text-cyan-300/60">{modificationInput.trim().slice(0, 40)}{modificationInput.trim().length > 40 ? '…' : ''}</span>
                </p>
              )}
            </div>

            {/* 底部操作 */}
            <div className="flex gap-2">
              <button
                onClick={() => setShowRegenModal(false)}
                className="flex-1 text-xs py-2.5 rounded-xl border border-white/10 text-white/50 hover:text-white/70 hover:border-white/20 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleRegenerate}
                className="flex-1 text-xs py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors flex items-center justify-center gap-1.5"
              >
                <RefreshCw size={12} />
                {referenceImagePreview
                  ? '以参考图生成'
                  : modificationInput.trim()
                  ? '按描述修改'
                  : editedPromptInput !== (shot.baseImagePrompt || shot.imagePrompt)
                  ? '按提示词生成'
                  : '重新生成'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
