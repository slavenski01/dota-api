import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import sharp from 'sharp';

const catalogPath = 'apps/web/lib/hero-catalog.json';
const assetDir = 'apps/web/public/heroes';
const source = 'https://www.dota2.com/datafeed/herolist?language=english';
const cdn = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/icons/';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const json = data => JSON.stringify(data, null, 2) + '\n';
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2_000_000) throw new Error(`Oversized source: ${url}`);
  return bytes;
}
async function inspect(bytes) {
  const meta = await sharp(bytes, { failOn: 'warning', limitInputPixels: 512 * 512 }).metadata();
  if (meta.format !== 'png' || meta.width < 24 || meta.height < 24 || meta.width > 256 || meta.height > 256) throw new Error(`Invalid hero PNG: ${meta.format} ${meta.width}×${meta.height}`);
  // Decode every pixel, not just the PNG header; truncated files must fail.
  await sharp(bytes, { failOn: 'warning', limitInputPixels: 512 * 512 }).raw().toBuffer();
  return { width: meta.width, height: meta.height, bytes: bytes.length, sha256: sha256(bytes) };
}
function validateRecords(records) {
  if (!records.length) throw new Error('Empty hero catalog');
  const ids = new Set(), names = new Set(), hashes = new Set();
  for (const hero of records) {
    if (!Number.isSafeInteger(hero.id) || hero.id <= 0 || !hero.name?.trim() || !/^npc_dota_hero_[a-z0-9_]+$/.test(hero.internalName)) throw new Error('Invalid hero identity');
    if (ids.has(hero.id) || names.has(hero.internalName) || (hero.sha256 && hashes.has(hero.sha256))) throw new Error(`Duplicate hero/icon: ${hero.id}`);
    ids.add(hero.id); names.add(hero.internalName); hashes.add(hero.sha256);
  }
}

if (process.argv.includes('--check')) {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const records = Object.values(catalog.heroes);
  validateRecords(records);
  if (records.length !== catalog.count || catalog.source !== source) throw new Error('Catalog metadata mismatch');
  const names = JSON.parse(await readFile('apps/web/lib/heroes.json', 'utf8'));
  if (JSON.stringify(names) !== JSON.stringify(Object.fromEntries(records.map(h => [h.id, h.name])))) throw new Error('Hero names out of sync');
  for (const hero of records) {
    if (catalog.heroes[hero.id] !== hero || hero.icon !== `/heroes/${hero.id}.${hero.sha256.slice(0, 16)}.png`) throw new Error('Invalid icon mapping');
    const actual = await inspect(await readFile(`apps/web/public${hero.icon}`));
    for (const key of Object.keys(actual)) if (actual[key] !== hero[key]) throw new Error(`Icon mismatch: ${hero.id}/${key}`);
  }
  const files = (await readdir(assetDir)).filter(f => f.endsWith('.png')).sort();
  if (JSON.stringify(files) !== JSON.stringify(records.map(h => h.icon.split('/').at(-1)).sort())) throw new Error('Unreferenced or missing icon');
  console.log(`Verified ${records.length} unique hero PNGs, decoded pixels, dimensions, hashes and names (${records.reduce((sum, h) => sum + h.bytes, 0)} bytes).`);
} else if (process.argv.includes('--update')) {
  const date = process.argv.find(a => a.startsWith('--date='))?.slice(7);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Pass --update --date=YYYY-MM-DD (verification date)');
  const raw = await download(source);
  const records = JSON.parse(raw).result.data.heroes.map(h => ({ id: h.id, name: h.name_english_loc, internalName: h.name })).sort((a, b) => a.id - b.id);
  validateRecords(records);
  const downloaded = [];
  // Bounded concurrency; finish verification of the complete catalog before writing it.
  for (let start = 0; start < records.length; start += 6) {
    downloaded.push(...await Promise.all(records.slice(start, start + 6).map(async hero => {
      const imageSource = `${cdn}${hero.internalName.replace('npc_dota_hero_', '')}.png`;
      const bytes = await download(imageSource);
      const metadata = await inspect(bytes).catch(error => { throw new Error(`Invalid icon for ${hero.name}: ${error.message}`); });
      return { hero: { ...hero, icon: `/heroes/${hero.id}.${metadata.sha256.slice(0, 16)}.png`, imageSource, ...metadata }, bytes };
    })));
  }
  validateRecords(downloaded.map(h => h.hero));
  const catalog = { verifiedAt: date, source, sourceSha256: sha256(raw), count: records.length, copyright: 'Dota 2 hero artwork © Valve Corporation. All rights reserved.', heroes: Object.fromEntries(downloaded.map(({ hero }) => [hero.id, hero])) };
  await mkdir(assetDir, { recursive: true });
  for (const { hero, bytes } of downloaded) await writeFile(`apps/web/public${hero.icon}`, bytes);
  await writeFile('apps/web/lib/heroes.json', json(Object.fromEntries(records.map(h => [h.id, h.name]))));
  await writeFile(`${catalogPath}.tmp`, json(catalog));
  await rename(`${catalogPath}.tmp`, catalogPath);
  const keep = new Set(downloaded.map(h => h.hero.icon.split('/').at(-1)));
  for (const file of await readdir(assetDir)) if (/^\d+\.[a-f0-9]{16}\.png$/.test(file) && !keep.has(file)) await unlink(`${assetDir}/${file}`);
  console.log(`Saved ${catalog.count} verified hero icons from Valve. Run with --check for offline validation.`);
} else {
  throw new Error('Use --check or --update --date=YYYY-MM-DD');
}
