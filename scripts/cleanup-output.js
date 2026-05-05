#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRAMES_DIR = path.join(ROOT, 'output', 'frames');
const OUTPUT_DIR = path.join(ROOT, 'output');

async function cleanup() {
  try {
    // 删除 frames 下的历史 job/test 目录
    const items = await fs.readdir(FRAMES_DIR).catch(() => []);
    for (const name of items) {
      if (/^(job-|test-|x$)/.test(name)) {
        const p = path.join(FRAMES_DIR, name);
        console.log('Removing', p);
        await fs.rm(p, { recursive: true, force: true });
      }
    }

    // 删除 output 根目录下的 test_clip.ts（如果存在）
    const testClipPath = path.join(OUTPUT_DIR, 'test_clip.ts');
    await fs.rm(testClipPath, { force: true }).catch(() => {});

    console.log('Cleanup complete');
  } catch (err) {
    console.error('Cleanup failed:', err.message);
    process.exit(1);
  }
}

cleanup();
