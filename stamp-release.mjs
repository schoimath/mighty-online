import {readFile, writeFile} from 'node:fs/promises';
import {VERSION} from './release.js';

// The site is served directly from main. Stamp the static assets before publishing.
const koreanTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
}).formatToParts(new Date());
const {year, month, day, hour, minute, second} = Object.fromEntries(koreanTime.map(part => [part.type, part.value]));
const version = [...VERSION.split('.').slice(0, 2), year + month + day + hour + minute + second].join('.');
const updatedAt = `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
const stamp = `export const VERSION = '${version}';
export const UPDATED_AT = '${updatedAt}';
export const UPDATED_ON = UPDATED_AT.slice(0, 10);
export const UPDATED_LABEL = UPDATED_AT.slice(0, 19).replace('T', ' ');
`;
for (const asset of ['index.html', 'boards.html', 'bot-worker.js', 'lab/table-agents.js', 'lab/contract-search.js', 'lab/table-strategy.js',
  'agent-kit/registry.js', 'agent-kit/cooperative.js', 'claim-worker.js']) {
  const file = new URL(asset, import.meta.url);
  const source = await readFile(file, 'utf8');
  const updated = source.replace(/\?v=\d+\.\d+(?:\.\d{12}(?:\d{2})?)?(?=["'])/g, '?v=' + version);
  if (updated !== source) await writeFile(file, updated);
}
await writeFile(new URL('release.js', import.meta.url), stamp);
console.log(`v${version} · ${updatedAt}`);
