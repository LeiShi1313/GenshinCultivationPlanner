import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileResinPolicyV2, formatResinPolicyPreview } from '../core/resin-policy-v2.js';
import { normalizeScriptSettings } from '../core/settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : null;
const rawSettings = inputPath
  ? JSON.parse(await fs.readFile(inputPath, 'utf8'))
  : await readSchemaDefaults(path.join(root, 'settings.json'));

const normalized = normalizeScriptSettings(rawSettings);
const policy = compileResinPolicyV2(normalized);
const preview = formatResinPolicyPreview(policy);

console.log('树脂规则校验通过');
console.log(`模式：${preview.mode}`);
console.log(`任务顺序：${preview.order}`);
console.log(`秘境允许树脂：${preview.resinTypes}`);
console.log(`路线执行时机：${preview.routeTiming}`);
console.log(JSON.stringify(policy, null, 2));

async function readSchemaDefaults(settingsPath) {
  const schema = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  return Object.fromEntries(schema
    .filter((item) => item.name && item.default !== undefined)
    .map((item) => [item.name, item.default]));
}

