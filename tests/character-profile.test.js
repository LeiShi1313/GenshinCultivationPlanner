import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildAutomaticProfileTargets,
  buildTargetSummary,
  normalizeCharacterProfile,
  prepareAutomaticProfileRequest,
  readCharacterProfile,
} from '../core/character-profile.js';
import { expandTargets } from '../core/requirements.js';
import { normalizeScriptSettings } from '../core/settings.js';
import { buildRunSummary } from '../core/report.js';
import { buildRunRecord } from '../core/history.js';

const rulebook = {
  characters: {
    申鹤: {
      ascensionCosts: {
        ascend6: [{ id: 1, count: 6 }],
      },
      talentCosts: {
        lvl7: [{ id: 2, count: 4 }],
        lvl8: [{ id: 2, count: 6 }],
        lvl9: [{ id: 2, count: 12 }],
        lvl10: [{ id: 2, count: 16 }],
      },
    },
  },
  weapons: {
    和璞鸢: {
      rarity: 5,
      ascensionCosts: { ascend6: [{ id: 3, count: 6 }] },
    },
    新手长枪: {
      rarity: 1,
      ascensionCosts: {},
    },
  },
};

const baseSettings = {
  targetInputMode: '自动档案识别后执行',
  selectedCharacter: '申鹤',
  autoCharacterTargetLevel: '90级',
  autoNormalAttackTargetLevel: '9',
  autoElementalSkillTargetLevel: '10',
  autoElementalBurstTargetLevel: '不培养',
  autoWeaponMode: '培养角色和当前佩戴武器',
  autoWeaponTargetLevel: '90级',
};

function rawProfile(overrides = {}) {
  return {
    CharacterName: '申鹤',
    ElementType: 'Cryo',
    Level: 80,
    LevelLimit: 90,
    WeaponName: '和璞鸢',
    WeaponLevel: 80,
    WeaponLevelLimit: 90,
    AttackLevel: 6,
    AttackHasBonus: false,
    SkillLevel: 11,
    SkillHasBonus: true,
    BurstLevel: 8,
    BurstHasBonus: false,
    ...overrides,
  };
}

test('自动档案请求按武器模式选择读取分类并区分预览', () => {
  const full = prepareAutomaticProfileRequest(baseSettings, rulebook);
  assert.deepEqual(full, {
    characterName: '申鹤',
    categories: '属性;武器;天赋',
    requiresProfile: true,
    previewOnly: false,
    cultivationMode: '培养角色和当前佩戴武器',
  });
  const preview = prepareAutomaticProfileRequest({
    ...baseSettings,
    targetInputMode: '自动档案仅预览',
    autoWeaponMode: '仅培养角色',
  }, rulebook);
  assert.equal(preview.categories, '属性;天赋');
  assert.equal(preview.previewOnly, true);

  const weaponOnly = prepareAutomaticProfileRequest({
    ...baseSettings,
    selectedCharacter: '不选择角色',
    autoWeaponMode: '仅培养指定武器',
    selectedWeapon: '和璞鸢',
    weaponLevelRange: '70>90',
  }, rulebook);
  assert.equal(weaponOnly.requiresProfile, false);
  assert.equal(weaponOnly.characterName, null);
  assert.equal(weaponOnly.categories, null);

  const legacy = prepareAutomaticProfileRequest({
    ...baseSettings, autoWeaponMode: '手动指定武器', selectedWeapon: '和璞鸢', weaponLevelRange: '70>90',
  }, rulebook);
  assert.equal(legacy.cultivationMode, '培养角色和指定武器');
});

test('档案读取调用 BetterGI 接口并规范化返回字段', async () => {
  const calls = [];
  const service = {
    async GetCharacter(...args) {
      calls.push(args);
      return rawProfile();
    },
  };
  const request = prepareAutomaticProfileRequest(baseSettings, rulebook);
  const profile = await readCharacterProfile(service, request, new Date('2026-08-20T00:00:00Z'));
  assert.deepEqual(calls, [['申鹤', '属性;武器;天赋']]);
  assert.deepEqual(profile.character, { level: 80, levelLimit: 90 });
  assert.deepEqual(profile.weapon, { name: '和璞鸢', level: 80, levelLimit: 90 });
  assert.deepEqual(profile.talents.skill, { displayLevel: 11, hasBonus: true });
  assert.equal(profile.scannedAt, '2026-08-20T00:00:00.000Z');
});

test('接口不存在、空结果和角色不一致时拒绝生成目标', async () => {
  const request = prepareAutomaticProfileRequest(baseSettings, rulebook);
  await assert.rejects(readCharacterProfile(null, request), /未提供 characterDevelopmentTask\.GetCharacter/);
  await assert.rejects(readCharacterProfile({ GetCharacter: async () => null }, request), /未返回角色/);
  await assert.rejects(readCharacterProfile({
    GetCharacter: async () => { throw new Error('无法读取角色等级'); },
  }, request), /OCR V6/);
  assert.throws(() => normalizeCharacterProfile(rawProfile({ CharacterName: '莫娜' }), '申鹤'), /不一致/);
});

test('自动档案还原命座加成并生成统一角色与武器目标', () => {
  const profile = normalizeCharacterProfile(rawProfile(), '申鹤');
  const generated = buildAutomaticProfileTargets(profile, baseSettings, rulebook);
  assert.deepEqual(generated.targets, [
    {
      kind: 'character',
      name: '申鹤',
      level: { current: 80, currentLimit: 90, target: 90, targetLimit: 90 },
      talents: {
        normal: { current: 6, target: 9 },
        skill: { current: 8, target: 10 },
      },
    },
    {
      kind: 'weapon',
      name: '和璞鸢',
      level: { current: 80, currentLimit: 90, target: 90, targetLimit: 90 },
    },
  ]);
  assert.deepEqual(generated.summary, [
    '角色 申鹤：80/90 → 90/90',
    '天赋：普攻6→9，战技8→10，爆发8（不培养）',
    '武器 和璞鸢：80/90 → 90/90',
  ]);
});

test('突破状态可区分 80/80、80/90 及目标 80/90', () => {
  const target80 = { ...baseSettings, autoCharacterTargetLevel: '80级（已突破，等级上限90）', autoWeaponMode: '仅培养角色' };
  const before = buildAutomaticProfileTargets(
    normalizeCharacterProfile(rawProfile({ LevelLimit: 80 }), '申鹤'),
    target80,
    rulebook,
  );
  const after = buildAutomaticProfileTargets(
    normalizeCharacterProfile(rawProfile({ LevelLimit: 90 }), '申鹤'),
    target80,
    rulebook,
  );
  assert.equal(expandTargets(before.targets, rulebook)[0].requirements.find((item) => item.materialId === '1').count, 6);
  assert.equal(expandTargets(after.targets, rulebook)[0].requirements.find((item) => item.materialId === '1'), undefined);
});

test('旧手动目标在突破边界仍保持默认尚未突破的兼容行为', () => {
  const expanded = expandTargets([{
    kind: 'character', name: '申鹤', level: { current: 80, target: 90 }, talents: {},
  }], rulebook);
  assert.equal(expanded[0].requirements.find((item) => item.materialId === '1').count, 6);
});

test('一星初始武器自动忽略且不要求武器等级字段', () => {
  const profile = normalizeCharacterProfile(rawProfile({
    WeaponName: '新手长枪', WeaponLevel: null, WeaponLevelLimit: null,
  }), '申鹤');
  const generated = buildAutomaticProfileTargets(profile, baseSettings, rulebook);
  assert.equal(generated.targets.length, 1);
  assert.match(generated.ignoredWeaponReason, /一星初始武器“新手长枪”/);
});

test('仅培养角色和指定武器均不依赖档案中的武器字段', () => {
  const profile = normalizeCharacterProfile(rawProfile({
    WeaponName: null, WeaponLevel: null, WeaponLevelLimit: null,
  }), '申鹤');
  const disabled = buildAutomaticProfileTargets(profile, {
    ...baseSettings, autoWeaponMode: '仅培养角色',
  }, rulebook);
  assert.equal(disabled.targets.length, 1);
  const manual = buildAutomaticProfileTargets(profile, {
    ...baseSettings,
    autoWeaponMode: '培养角色和指定武器',
    selectedWeapon: '和璞鸢',
    weaponLevelRange: '70>90',
  }, rulebook);
  assert.deepEqual(manual.targets[1], {
    kind: 'weapon', name: '和璞鸢',
    level: { current: 70, target: 90, currentAscended: false, targetAscended: false },
  });
});

test('单项目字段异常和已超过目标不会阻断其他有效目标', () => {
  const missingLevel = buildAutomaticProfileTargets(
    normalizeCharacterProfile(rawProfile({ LevelLimit: null }), '申鹤'), baseSettings, rulebook,
  );
  assert.equal(missingLevel.targetOutcomes.find((item) => item.component === 'level' && item.kind === 'character').status, 'failed');
  assert.ok(missingLevel.targets.some((item) => item.kind === 'weapon'));

  const invalidTalent = buildAutomaticProfileTargets(
    normalizeCharacterProfile(rawProfile({ SkillLevel: 2, SkillHasBonus: true }), '申鹤'), baseSettings, rulebook,
  );
  assert.equal(invalidTalent.targetOutcomes.find((item) => item.component === 'skill').status, 'failed');
  assert.ok(invalidTalent.targets.some((item) => item.kind === 'weapon'));

  const unknownWeapon = buildAutomaticProfileTargets(
    normalizeCharacterProfile(rawProfile({ WeaponName: '未知长枪' }), '申鹤'), baseSettings, rulebook,
  );
  assert.equal(unknownWeapon.targetOutcomes.find((item) => item.kind === 'weapon').status, 'failed');
  assert.ok(unknownWeapon.targets.some((item) => item.kind === 'character'));

  const exceeded = buildAutomaticProfileTargets(
    normalizeCharacterProfile(rawProfile({ Level: 90, LevelLimit: 90 }), '申鹤'),
    { ...baseSettings, autoCharacterTargetLevel: '80级（已突破，等级上限90）' }, rulebook,
  );
  assert.equal(exceeded.targetOutcomes.find((item) => item.kind === 'character' && item.component === 'level').status, 'completed');
  assert.match(exceeded.summary[0], /已达到，跳过等级/);
});

test('角色已超过目标时继续培养手动指定武器', () => {
  const profile = normalizeCharacterProfile(rawProfile({ Level: 80, LevelLimit: 80 }), '申鹤');
  const generated = buildAutomaticProfileTargets(profile, {
    ...baseSettings,
    autoCharacterTargetLevel: '70级（已突破，等级上限80）',
    autoNormalAttackTargetLevel: '不培养',
    autoElementalSkillTargetLevel: '不培养',
    autoElementalBurstTargetLevel: '不培养',
    autoWeaponMode: '培养角色和指定武器',
    selectedWeapon: '和璞鸢',
    weaponLevelRange: '70>90',
  }, rulebook);
  assert.deepEqual(generated.targets, [{
    kind: 'weapon', name: '和璞鸢',
    level: { current: 70, target: 90, currentAscended: false, targetAscended: false },
  }]);
  assert.equal(generated.targetOutcomes.find((item) => item.kind === 'character' && item.component === 'level').status, 'completed');
  assert.equal(generated.targetOutcomes.find((item) => item.kind === 'weapon').status, 'pending');
});

test('仅培养指定武器不需要角色档案', () => {
  const settings = {
    ...baseSettings,
    selectedCharacter: '不选择角色',
    autoWeaponMode: '仅培养指定武器',
    selectedWeapon: '和璞鸢',
    weaponLevelRange: '70>90',
  };
  const request = prepareAutomaticProfileRequest(settings, rulebook);
  const generated = buildAutomaticProfileTargets(null, settings, rulebook, request);
  assert.equal(request.requiresProfile, false);
  assert.deepEqual(generated.targets.map((item) => item.kind), ['weapon']);
  assert.doesNotMatch(generated.summary.join('\n'), /角色/);
});

test('角色档案读取失败时手动指定武器仍可继续', () => {
  const settings = {
    ...baseSettings,
    autoWeaponMode: '培养角色和指定武器',
    selectedWeapon: '和璞鸢',
    weaponLevelRange: '70>90',
  };
  const request = prepareAutomaticProfileRequest(settings, rulebook);
  const generated = buildAutomaticProfileTargets(null, settings, rulebook, request, new Error('角色 OCR 失败'));
  assert.deepEqual(generated.targets.map((item) => item.kind), ['weapon']);
  assert.equal(generated.targetOutcomes.find((item) => item.kind === 'character').status, 'failed');
  assert.equal(generated.targetOutcomes.find((item) => item.kind === 'weapon').status, 'pending');
});

test('全部目标已达到时不再生成刷取目标', () => {
  const profile = normalizeCharacterProfile(rawProfile({
    Level: 90, LevelLimit: 90, WeaponLevel: 90, WeaponLevelLimit: 90,
  }), '申鹤');
  const generated = buildAutomaticProfileTargets(profile, {
    ...baseSettings,
    autoNormalAttackTargetLevel: '不培养',
    autoElementalSkillTargetLevel: '不培养',
    autoElementalBurstTargetLevel: '不培养',
  }, rulebook);
  assert.deepEqual(generated.targets, []);
  assert.equal(generated.targetOutcomes.some((item) => item.status === 'failed'), false);
  assert.match(generated.summary.join('\n'), /已达到/);
});

test('公开设置只使用自动档案并忽略已移除的旧手动字段', () => {
  const normalized = normalizeScriptSettings({
    ...baseSettings,
    characterLevelRange: '1>90',
    selectedWeapon: '和璞鸢',
    weaponLevelRange: '1>90',
  });
  assert.equal(normalized.targetsText, '');
  assert.equal(normalizeScriptSettings({
    ...baseSettings,
    customTargetsEnabled: true,
    targetsText: '申鹤:1>90',
  }).targetsText, '');
});

test('手动目标摘要与自动档案共用同一格式', () => {
  assert.deepEqual(buildTargetSummary([{
    kind: 'character', name: '申鹤', level: { current: 70, target: 90 },
    talents: { skill: { current: 6, target: 9 } },
  }]), ['角色 申鹤：70 → 90', '天赋：战技6→9']);
});

test('等价自动目标与手动目标展开后的材料需求一致', () => {
  const auto = buildAutomaticProfileTargets(
    normalizeCharacterProfile(rawProfile({ LevelLimit: 80, WeaponLevelLimit: 80 }), '申鹤'),
    baseSettings,
    rulebook,
  );
  const manual = [
    {
      kind: 'character', name: '申鹤', level: { current: 80, target: 90 },
      talents: { normal: { current: 6, target: 9 }, skill: { current: 8, target: 10 } },
    },
    { kind: 'weapon', name: '和璞鸢', level: { current: 80, target: 90 } },
  ];
  assert.deepEqual(expandTargets(auto.targets, rulebook), expandTargets(manual, rulebook));
});

test('培养档案摘要进入邮件和历史记录', () => {
  const plan = {
    todayQueue: [], displayShortages: [], weeklyStrategy: [], manualItems: [],
    targetSummary: ['角色 申鹤：80/90 → 90/90', '天赋：战技8→10'],
    targetOutcomes: [{ kind: 'character', component: 'level', status: 'pending', name: '申鹤' }],
    profile: { mode: '自动档案识别后执行', profile: { characterName: '申鹤' } },
  };
  const summary = buildRunSummary(plan, {}, {
    executionEnabled: true,
    execution: { status: 'skipped', code: 'no_candidate', reason: '没有缺口' },
    estimateReason: '暂无可估算任务',
  });
  assert.match(summary, /\n\n培养档案\n/);
  assert.match(summary, /角色 申鹤：80\/90 → 90\/90/);
  const record = buildRunRecord({
    executionEnabled: true, plan, inventoryBefore: {}, inventoryAfter: {},
    execution: { status: 'skipped', code: 'no_candidate', message: '没有缺口' },
  });
  assert.deepEqual(record.profile, plan.profile);
  assert.deepEqual(record.targetSummary, plan.targetSummary);
  assert.deepEqual(record.targetOutcomes, plan.targetOutcomes);
});

test('自动档案仅预览在背包扫描和任务调度前直接结束', () => {
  const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const previewBranch = source.indexOf('if (request.previewOnly)');
  const previewReturn = source.indexOf('return;', previewBranch);
  const firstInventoryScan = source.indexOf('await scanInventoryMaterials(');
  const queueCompile = source.indexOf('compileResinExecutionQueue({');
  assert.ok(previewBranch > 0 && previewReturn > previewBranch);
  assert.ok(previewReturn < firstInventoryScan);
  assert.ok(previewReturn < queueCompile);
  assert.match(source.slice(previewBranch, previewReturn), /未读取背包、未执行刷取任务、未发送通知/);
  assert.match(source, /if \(!suppressExecution && scriptSettings\.scanInventory !== false\)/);
  assert.match(source, /if \(!suppressExecution\) appendArtifactFallbackTask/);
  assert.match(source, /if \(request\.requiresProfile\)/);
});
