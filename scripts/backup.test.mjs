import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyBackup } from './local.mjs';

test('backup checks every component, rejects partial publication and corrupted bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dota-backup-test-'));
  try {
    const manifest = { format: 1, project: 'dota-test', image: `sha256:${'a'.repeat(64)}`, files: {} };
    for (const name of ['database.dump', 'storage.tar', 'image.tar']) {
      const bytes = Buffer.from(name);
      await writeFile(join(directory, name), bytes);
      manifest.files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    }
    await assert.rejects(verifyBackup(directory), { code: 'ENOENT' });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    assert.deepEqual(await verifyBackup(directory), manifest);
    for (const name of Object.keys(manifest.files)) {
      await writeFile(join(directory, name), 'corrupt');
      await assert.rejects(verifyBackup(directory), /integrity_mismatch/);
      await writeFile(join(directory, name), name);
    }
    delete manifest.files['image.tar'];
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyBackup(directory), /integrity_mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
