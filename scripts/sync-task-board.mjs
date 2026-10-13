import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const markdown = await readFile('tasks-plan.md', 'utf8');
const board = await readFile('tasks-board.html', 'utf8');
const payload = JSON.stringify({ sourceName: 'tasks-plan.md', sourceSha256: createHash('sha256').update(markdown).digest('hex'), markdown }).replaceAll('<', '\\u003c');
const updated = board.replace(/(<script id="plan-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, start, end) => start + payload + end);
if (updated === board && !board.includes(payload)) throw new Error('board_snapshot_missing');
if (process.argv.includes('--check')) {
  if (updated !== board) throw new Error('board_snapshot_outdated');
} else await writeFile('tasks-board.html', updated);
