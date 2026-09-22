import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  appendGuideTargetData,
  buildGuideTargetData,
  classifyResolvedTargetState,
  resolveGuideDomainOpenings,
} from '../core/guide-targets.js';

const rulebook = JSON.parse(readFileSync(new URL('../data/rulebook.json', import.meta.url)));
const identities = JSON.parse(readFileSync(new URL('../guide-reader/data/guide-identities.json', import.meta.url)));
const startedAt = '2026-09-22T00:00:00.000Z';
const completedAt = '2026-09-22T00:01:00.000Z';
const nowMs = Date.parse('2026-09-22T00:02:00.000Z');

function guideCharacter(name = '申鹤') {
  return {
    name,
    homeLevel: 80,
    level: { current: 80, target: 90, noUpgradeNeeded: false, incomplete: false },
    weapon: { name: '和璞鸢', current: 80, target: 90, incomplete: false },
    talents: {
      incomplete: false,
      talents: [
        { name: '踏辰摄斗', displayedCurrent: 6, target: 9 },
        { name: '仰灵威召将役咒', displayedCurrent: 11, target: 12 },
        { name: '神女遣灵真诀', displayedCurrent: 8, target: 9 },
      ],
    },
  };
}

function snapshot(characters) {
  return {
    collection: {
      ok: true,
      incomplete: false,
      run_id: 'guide-test',
      started_at: startedAt,
      completed_at: completedAt,
      home: { characters: characters.map((item) => ({ name: item.name, level: item.homeLevel })) },
      characters: [],
    },
    preview: {
      run_id: 'guide-test',
      evidence_started_at: startedAt,
      captured_at: completedAt,
      characterProgress: characters,
    },
  };
}

function rawProfile() {
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
  };
}

test('提升指南会跳过不支持角色并保留其他有效角色', async () => {
  const invalid = { ...guideCharacter('未收录角色'), weapon: { ...guideCharacter().weapon } };
  const service = { GetCharacter: async (name) => name === '申鹤' ? rawProfile() : null };
  const result = await buildGuideTargetData({
    snapshot: snapshot([invalid, guideCharacter()]), identities, rulebook, service, nowMs,
  });

  assert.deepEqual(result.guide.characters, ['申鹤']);
  assert.equal(result.targets.some((target) => target.kind === 'character' && target.name === '申鹤'), true);
  assert.equal(result.targets.some((target) => target.kind === 'weapon' && target.name === '和璞鸢'), true);
  assert.match(result.targetOutcomes.find((outcome) => outcome.component === 'guide').message, /未收录角色/);
});

test('纯指南全部角色不可用时返回可诊断结果', async () => {
  const invalid = guideCharacter('未收录角色');
  const result = await buildGuideTargetData({
    snapshot: snapshot([invalid]), identities, rulebook, service: {}, nowMs,
  });
  assert.deepEqual(result.targets, []);
  assert.deepEqual(result.guide.targetRequests, []);
  assert.equal(result.targetOutcomes[0].status, 'failed');
});

test('角色档案接口异常不会被伪装成可跳过的数据问题', async () => {
  const service = { GetCharacter: async () => { throw new Error('档案接口异常'); } };
  await assert.rejects(buildGuideTargetData({
    snapshot: snapshot([guideCharacter()]), identities, rulebook, service, nowMs,
  }), (error) => error.code === 'profile_invalid' && /档案接口异常/.test(error.message));
});

test('原目标优先时仍保留指南失败警告和非重复目标', () => {
  const result = appendGuideTargetData({
    originalTargetData: { targets: [{ kind: 'character', name: '申鹤' }], inventory: {} },
    originalTargetSummary: ['原角色目标'],
    originalTargetOutcomes: [{ kind: 'character', component: 'level', status: 'pending', name: '申鹤' }],
    guideTargetData: {
      targets: [{ kind: 'character', name: '申鹤' }, { kind: 'weapon', name: '和璞鸢' }],
      targetOutcomes: [
        { kind: 'character', component: 'level', status: 'pending', name: '申鹤' },
        { kind: 'weapon', component: 'level', status: 'pending', name: '和璞鸢' },
        { kind: 'character', component: 'guide', status: 'failed', name: '未收录角色' },
      ],
      guide: { runId: 'guide-test' },
    },
  });
  assert.deepEqual(result.targetData.targets.map((target) => `${target.kind}:${target.name}`), [
    'character:申鹤', 'weapon:和璞鸢',
  ]);
  assert.equal(result.targetOutcomes.some((outcome) => outcome.component === 'guide'), true);
  assert.equal(result.targetOutcomes.filter((outcome) => outcome.name === '申鹤').length, 1);
});

test('指南限时开放证据只映射到唯一秘境奖励系列', () => {
  const openings = resolveGuideDomainOpenings({
    materials: {
      low: { status: 'supported', executionType: 'domain', domainName: '太山府', sundaySelectedValue: '1' },
      high: { status: 'supported', executionType: 'domain', domainName: '太山府', sundaySelectedValue: '1' },
    },
    sourceCandidates: {
      low: { type: 'domain', gameDomainName: '精通秘境:炽炎祭场' },
      high: { type: 'domain', gameDomainName: '精通秘境：炽炎祭场' },
    },
    guideTargetData: { guide: {
      runId: 'guide-test', capturedAt: completedAt,
      limitedOpenSources: [{ characterName: '申鹤', page: '角色天赋', gameDomainName: '精通秘境:炽炎祭场' }],
    } },
  });
  assert.deepEqual(openings.map(({ domainName, sundaySelectedValue }) => ({ domainName, sundaySelectedValue })), [
    { domainName: '太山府', sundaySelectedValue: '1' },
  ]);
});

test('纯指南无待办时禁止圣遗物和路线兜底，失败项不误报全部完成', () => {
  assert.deepEqual(classifyResolvedTargetState({
    targets: [], guideRecord: { runId: 'guide-test' }, targetOutcomes: [],
  }), { suppressExecution: true, allSatisfied: true, incomplete: false });
  assert.deepEqual(classifyResolvedTargetState({
    targets: [], guideRecord: { runId: 'guide-test' },
    targetOutcomes: [{ status: 'failed', component: 'guide' }],
  }), { suppressExecution: true, allSatisfied: false, incomplete: true });
  assert.equal(classifyResolvedTargetState({ targets: [] }).suppressExecution, false);
});
