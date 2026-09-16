import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import genshinDbModule from 'genshin-db';

const require = createRequire(import.meta.url);
const packageMetadata = require('genshin-db/package.json');
const db = genshinDbModule.default ?? genshinDbModule;
db.setOptions({
  queryLanguages: ['ChineseSimplified', 'English'],
  resultLanguage: 'ChineseSimplified',
});

const gameDataVersion = packageMetadata.description?.match(/Genshin Impact v([\d.]+)/)?.[1];
if (!gameDataVersion) throw new Error('无法从 genshin-db 包信息读取游戏数据版本');

const identities = {
  schemaVersion: 1,
  source: {
    repository: String(packageMetadata.repository?.url ?? '')
      .replace(/^git\+/, '')
      .replace(/\.git$/, ''),
    packageVersion: packageMetadata.version,
    gameDataVersion,
    locale: 'ChineseSimplified',
    license: packageMetadata.license,
    licenseFile: 'THIRD_PARTY_NOTICES.md',
  },
  characters: buildCharacters(),
  weapons: buildWeapons(),
};

const root = path.resolve(import.meta.dirname, '..');
const outputDirectory = path.join(root, 'guide-reader', 'data');
const outputPath = path.join(outputDirectory, 'guide-identities.json');
const temporaryPath = `${outputPath}.${process.pid}.tmp`;
await fs.mkdir(outputDirectory, { recursive: true });
try {
  await fs.writeFile(temporaryPath, `${JSON.stringify(identities, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, outputPath);
} finally {
  await fs.rm(temporaryPath, { force: true });
}

const weaponCount = Object.values(identities.weapons)
  .reduce((count, candidates) => count + candidates.length, 0);
console.log(`已生成指南身份表：${Object.keys(identities.characters).length} 名角色，` +
  `${Object.keys(identities.weapons).length} 个武器名（${weaponCount} 条武器记录）`);

function buildCharacters() {
  const result = {};
  const characters = db.characters('names', {
    matchCategories: true,
    verboseCategories: true,
  });
  if (!Array.isArray(characters) || characters.length === 0) {
    throw new Error('genshin-db 角色列表为空');
  }
  characters.sort(byNameThenId);
  for (const character of characters) {
    if (!character?.name || result[character.name]) {
      throw new Error(`genshin-db 角色名称缺失或重复：${character?.name ?? '<unknown>'}`);
    }
    if (character.name === '空' || character.name === '荧') {
      result[character.name] = { talentIdentity: 'ambiguous-traveler-element' };
      continue;
    }
    const talents = db.talents(character.name);
    if (!talents) {
      result[character.name] = { talentIdentity: 'unavailable' };
      continue;
    }
    if (talents.name !== character.name) {
      throw new Error(`genshin-db 角色技能名称不匹配：${character.name} → ${talents.name}`);
    }
    const combatSkills = ['combat1', 'combat2', 'combat3'].map((slot) => ({
      slot,
      canonicalName: talents[slot]?.name,
    }));
    if (combatSkills.some((skill) => typeof skill.canonicalName !== 'string' || !skill.canonicalName)) {
      throw new Error(`genshin-db 角色技能数据不完整：${character.name}`);
    }
    if (new Set(combatSkills.map((skill) => skill.canonicalName)).size !== combatSkills.length) {
      throw new Error(`genshin-db 角色技能名称重复：${character.name}`);
    }
    result[character.name] = { talentIdentity: 'exact', combatSkills };
  }
  return result;
}

function buildWeapons() {
  const result = {};
  const weapons = db.weapons('names', {
    matchCategories: true,
    verboseCategories: true,
  });
  if (!Array.isArray(weapons) || weapons.length === 0) {
    throw new Error('genshin-db 武器列表为空');
  }
  weapons.sort(byNameThenId);
  for (const weapon of weapons) {
    if (!weapon?.name || !Number.isSafeInteger(weapon.id)) {
      throw new Error(`genshin-db 武器身份无效：${weapon?.name ?? '<unknown>'}`);
    }
    const candidates = result[weapon.name] ??= [];
    if (candidates.some((candidate) => candidate.id === weapon.id)) {
      throw new Error(`genshin-db 武器身份重复：${weapon.name} (${weapon.id})`);
    }
    candidates.push({ id: weapon.id });
  }
  return result;
}

function byNameThenId(left, right) {
  return (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
    Number(left.id) - Number(right.id);
}
