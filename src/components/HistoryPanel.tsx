import { Clock, Trash2, FolderOpen } from 'lucide-react';
import type { StoryboardProject } from '../types/storyboard';
import { deleteProject } from '../lib/openai';

interface HistoryPanelProps {
  projects: StoryboardProject[];
  onLoad: (project: StoryboardProject) => void;
  onDelete: (id: string) => void;
}

export function HistoryPanel({ projects, onLoad, onDelete }: HistoryPanelProps) {
  if (projects.length === 0) return null;

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-4">
        <Clock size={15} className="text-white/40" />
        <span className="text-sm text-white/40 font-medium">历史项目</span>
        <span className="text-xs bg-white/10 px-2 py-0.5 rounded-full text-white/30">
          {projects.length}
        </span>
      </div>
      <div className="space-y-2">
        {projects.map((p) => (
          <div
            key={p.id}
            className="group flex items-center gap-3 p-3 rounded-xl border border-white/8 bg-white/3 hover:bg-white/5 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white/70 truncate">{p.title || p.userPrompt}</p>
              <p className="text-xs text-white/30 mt-0.5">
                {p.shots.length} 个分镜 · {new Date(p.createdAt).toLocaleDateString('zh-CN')}
              </p>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => onLoad(p)}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-violet-500/20 text-white/40 hover:text-violet-400 transition-colors"
                title="加载项目"
              >
                <FolderOpen size={13} />
              </button>
              <button
                onClick={() => {
                  deleteProject(p.id);
                  onDelete(p.id);
                }}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-red-500/20 text-white/40 hover:text-red-400 transition-colors"
                title="删除项目"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
