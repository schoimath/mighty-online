import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8').replaceAll('\r\n','\n');
const digest = text => createHash('sha256').update(text).digest('hex');
const {scoring, ...preset} = JSON.parse(read('../configs/rules.json'));
// An additional named export of existing helpers does not change the archived rules or bots.
export const engineRulesSource = read('../engine.js').replace(/\nexport \{[^}\n]+\};\n$/, '');
export const rulesHash = digest(JSON.stringify(preset) + engineRulesSource);
export const scoringHash = digest(JSON.stringify(scoring) + read('./scoring.js'));
export const rulesetId = preset.ruleset_id;
export const rulesVersion = preset.rules_version;
export const observationVersion = 'seat-visible-v2';
export const actionVersion = 'mighty-action-v1';
export const rngVersion = 'mulberry32-fisher-yates-v1';
