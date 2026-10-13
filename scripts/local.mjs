// Host-side operations use Docker's current context (or DOCKER_CONTEXT).
// Backups contain private match data. Credentials stay in .env, outside backups.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat, chmod } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = join(root, '.env');
const project = process.env.COMPOSE_PROJECT_NAME || 'dota-api';
const validProject = name => /^[a-z][a-z0-9-]{1,48}$/.test(name);
async function docker(args, { input, output, env = {}, quiet = false } = {}) {
  const child = spawn('docker', args, { cwd: root, env: { ...process.env, ...env }, stdio: [input ? 'pipe' : 'ignore', 'pipe', quiet ? 'pipe' : 'inherit'] });
  let text = '';
  if (!output) child.stdout.on('data', chunk => { text += chunk; });
  // Quiet diagnostics must never echo connection strings or source keys.
  if (quiet) child.stderr.resume();
  const closed = new Promise((accept, reject) => {
    child.once('error', () => reject(Error('docker_unavailable')));
    child.once('close', code => code === 0 ? accept() : reject(Error('docker_operation_failed')));
  });
  const streams = [];
  if (input) streams.push(pipeline(createReadStream(input), child.stdin));
  if (output) streams.push(pipeline(child.stdout, createWriteStream(output, { flags: 'wx', mode: 0o600 })));
  await Promise.all([closed, ...streams]);
  return text.trim();
}
function compose(name, args, options) {
  if (!validProject(name)) throw Error('invalid_project_name');
  return docker(['compose', '--project-directory', root, '--env-file', envFile, '-f', join(root, 'compose.yaml'), '-p', name, ...args], options);
}
async function checksum(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return { sha256: digest.digest('hex'), bytes: (await stat(path)).size };
}
export async function verifyBackup(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !validProject(manifest.project) || !/^sha256:[a-f0-9]{64}$/.test(manifest.image)) throw Error('invalid_backup_manifest');
  for (const name of ['database.dump', 'storage.tar', 'image.tar']) {
    const expected = manifest.files?.[name], actual = await checksum(join(directory, name));
    if (!expected || expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) throw Error('backup_integrity_mismatch');
  }
  return manifest;
}
async function init() {
  let text;
  try { text = await readFile(envFile, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; text = await readFile(join(root, '.env.example'), 'utf8'); }
  const config = parseEnv(text);
  if (config.POSTGRES_PASSWORD && !/^[a-f0-9]{48,128}$/.test(config.POSTGRES_PASSWORD)) throw Error('POSTGRES_PASSWORD_must_be_48_to_128_hex_characters');
  if (!config.POSTGRES_PASSWORD) {
    const setting = `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`;
    text = /^POSTGRES_PASSWORD=.*$/m.test(text) ? text.replace(/^POSTGRES_PASSWORD=.*$/m, setting) : `${text}\n${setting}\n`;
    await writeFile(envFile, text, { mode: 0o600 });
  } else if (!(await stat(envFile).catch(() => null))) await writeFile(envFile, text, { mode: 0o600 });
  await chmod(envFile, 0o600);
  console.log('Local settings ready; existing credentials preserved.');
}
async function backup(directory) {
  // mkdir without recursive/exist_ok intentionally refuses to overwrite a backup.
  await mkdir(directory, { mode: 0o700 });
  const services = (await compose(project, ['ps', '--status', 'running', '--services'])).split('\n').filter(s => ['web', 'worker'].includes(s));
  try {
    // Record image before shutdown; backup must describe the actual running code.
    const worker = await compose(project, ['ps', '-aq', 'worker']);
    if (!worker) throw Error('worker_container_required');
    const image = await docker(['inspect', '--format', '{{.Image}}', worker]);
    await compose(project, ['stop', '--timeout', '45', 'web', 'worker']);
    const options = { env: { DOTA_IMAGE: image } };
    await compose(project, ['run', '--rm', '--no-deps', '-T', 'worker', 'node', 'scripts/storage-audit.mjs'], options);
    await compose(project, ['exec', '-T', 'db', 'pg_dump', '-U', 'dota', '-d', 'dota', '--format=custom', '--no-owner', '--no-privileges'], { output: join(directory, 'database.dump') });
    await compose(project, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'worker', '-C', '/var/lib/dota/storage', '--exclude=./.tmp', '-cf', '-', '.'], { ...options, output: join(directory, 'storage.tar') });
    await docker(['image', 'save', image], { output: join(directory, 'image.tar') });
    const files = Object.fromEntries(await Promise.all(['database.dump', 'storage.tar', 'image.tar'].map(async name => [name, await checksum(join(directory, name))])));
    const manifest = { format: 1, createdAt: new Date().toISOString(), project, image, postgresMajor: 18, files };
    await writeFile(join(directory, 'manifest.json.part'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await rename(join(directory, 'manifest.json.part'), join(directory, 'manifest.json'));
    await verifyBackup(directory);
    console.log(`Backup verified: ${directory}`);
  } finally {
    // Preserve intentionally stopped services; never start a new worker as cleanup.
    if (services.length) await compose(project, ['start', '--wait', ...services]);
  }
}
async function restore(directory, target, port) {
  if (!validProject(target) || target === project || !/^\d{4,5}$/.test(port) || +port < 1024 || +port > 65535) throw Error('restore_requires_new_project_and_port');
  const manifest = await verifyBackup(directory);
  if (target === manifest.project || manifest.postgresMajor !== 18) throw Error('invalid_restore_target');
  // Refuse even stopped/empty existing installations. No destructive --clean.
  const label = `label=com.docker.compose.project=${target}`;
  if (await docker(['ps', '-aq', '--filter', label]) || await docker(['volume', 'ls', '-q', '--filter', label])) throw Error('restore_target_already_exists');
  const volumes = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).split('\n');
  if (volumes.includes(`${target}_postgres`) || volumes.includes(`${target}_storage`)) throw Error('restore_target_already_exists');
  await docker(['image', 'load'], { input: join(directory, 'image.tar') });
  await docker(['image', 'inspect', '--format', '{{.Id}}', manifest.image], { quiet: true });
  const listing = await docker(['run', '--rm', '-i', '--entrypoint', 'tar', manifest.image, '-tvf', '-'], { input: join(directory, 'storage.tar') });
  for (const line of listing.split('\n').filter(Boolean)) {
    const name = line.trim().split(/\s+/).at(-1);
    if (!(line.startsWith('d') && /^\.\/(?:[a-f0-9]{2}\/)?$/.test(name)) && !(line.startsWith('-') && /^\.\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(name))) throw Error('unsafe_storage_archive');
  }
  const options = { env: { DOTA_IMAGE: manifest.image, DOTA_PORT: port } };
  await compose(target, ['up', '-d', '--wait', 'db'], options);
  await compose(target, ['exec', '-T', 'db', 'pg_restore', '-U', 'dota', '-d', 'dota', '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges'], { ...options, input: join(directory, 'database.dump') });
  await compose(target, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'worker', '-C', '/var/lib/dota/storage', '--no-same-owner', '-xf', '-'], { ...options, input: join(directory, 'storage.tar') });
  await compose(target, ['run', '--rm', '--no-deps', '-T', 'worker', 'node', 'scripts/storage-audit.mjs'], options);
  await compose(target, ['up', '-d', '--no-build', '--wait'], options);
  console.log(`Restored and verified: http://127.0.0.1:${port} (project ${target}, image ${manifest.image})`);
}
async function main() {
  const [command, path, target, port, ...extra] = process.argv.slice(2);
  if (extra.length) throw Error('invalid_arguments');
  if (command === 'init' && !path) return init();
  if (command === 'verify' && path && !target) { await verifyBackup(resolve(path)); return console.log('Backup checksums verified.'); }
  if (command === 'backup' && path && !target) return backup(resolve(path));
  if (command === 'restore' && path && target && port) return restore(resolve(path), target, port);
  if (command === 'up' && !path) {
    await compose(project, ['build', 'web']);
    return console.log(await compose(project, ['up', '-d', '--no-build', '--wait']));
  }
  if (command === 'stop' && !path) return console.log(await compose(project, ['stop']));
  if (command === 'status' && !path) return console.log(await compose(project, ['ps', '-a']));
  throw Error('Usage: node scripts/local.mjs init|up|stop|status|backup <new-directory>|verify <directory>|restore <directory> <new-project> <port>');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
