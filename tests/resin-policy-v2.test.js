import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileResinPolicyV2,
  formatResinPolicyPreview,
  getTaskPolicyType,
} from '../core/resin-policy-v2.js';
import { normalizeScriptSettings } from '../core/settings.js';

const customDefaults = {
  resinRuleMode: '按顺序刷多类',
  resinTaskPriority1: '世界 Boss',
  resinTaskPriority2: '限时培养秘境',
  resinTaskPriority3: '普通培养秘境',
  resinTaskPriority4: '圣遗物填充',
  bossMaxClaims: '1',
  limitedDomainMaxClaims: '2',
  domainMaxClaims: '3',
  artifactDomainMaxClaims: '全部',
  routeTiming: '树脂任务后',
};

test('推荐模式复现当前任务顺序并忽略高级字段', () => {
  const policy = compileResinPolicyV2({
    resinRuleMode: '一次只刷一类（推荐）',
    resinTaskPriority1: '圣遗物填充',
    bossMaxClaims: '0',
    routeTiming: '树脂任务前',
  });
  assert.equal(policy.mode, 'legacy');
  assert.deepEqual(policy.taskOrder, ['boss', 'limitedDomain', 'domain', 'artifactDomain']);
  assert.deepEqual(policy.taskLimits, {
    boss: { maxClaims: null },
    limitedDomain: { maxClaims: null },
    domain: { maxClaims: null },
    artifactDomain: { maxClaims: null },
  });
  assert.equal(policy.routeTiming, 'afterResin');
  assert.deepEqual(policy.resinTypes, {
    original: true, condensed: true, transient: false, fragile: false,
  });
});

test('旧版树脂模式名称仍可读取', () => {
  assert.equal(compileResinPolicyV2({ resinRuleMode: '兼容当前规则' }).mode, 'legacy');
  assert.equal(compileResinPolicyV2({ ...customDefaults, resinRuleMode: '自定义顺序与上限' }).mode, 'custom');
});

test('旧 resinStrategy 会迁移为 V2 允许树脂集合', () => {
  const settings = normalizeScriptSettings({ resinStrategy: '浓缩→原粹→须臾' });
  const policy = compileResinPolicyV2(settings);
  assert.deepEqual(policy.resinTypes, {
    original: true, condensed: true, transient: true, fragile: false,
  });
});

test('自定义模式编译任务顺序、领取上限和路线时机', () => {
  const policy = compileResinPolicyV2({
    ...customDefaults,
    resinTaskPriority1: '限时培养秘境',
    resinTaskPriority2: '世界 Boss',
    routeTiming: '树脂任务前',
    domainUseOriginalResin: true,
    domainUseCondensedResin: false,
    domainUseTransientResin: false,
    domainUseFragileResin: true,
    artifactDomainEnabled: true,
  });
  assert.deepEqual(policy.taskOrder, ['limitedDomain', 'boss', 'domain', 'artifactDomain']);
  assert.equal(policy.taskLimits.boss.maxClaims, 1);
  assert.equal(policy.taskLimits.limitedDomain.maxClaims, 2);
  assert.equal(policy.taskLimits.domain.maxClaims, 3);
  assert.equal(policy.taskLimits.artifactDomain.maxClaims, null);
  assert.equal(policy.routeTiming, 'beforeResin');
  assert.equal(policy.artifactFallbackEnabled, true);
  assert.deepEqual(policy.resinTypes, {
    original: true, condensed: false, transient: false, fragile: true,
  });
});

test('任务与领奖次数可以由同一个级联选项配置', () => {
  const policy = compileResinPolicyV2({
    resinRuleMode: '按顺序刷多类',
    resinTaskPriority1: '限时培养秘境｜2 次',
    resinTaskPriority2: '世界 Boss｜1 次',
    resinTaskPriority3: '普通培养秘境｜3 次',
    resinTaskPriority4: '圣遗物填充｜用完可用树脂',
  });
  assert.deepEqual(policy.taskOrder, ['limitedDomain', 'boss', 'domain', 'artifactDomain']);
  assert.equal(policy.taskLimits.limitedDomain.maxClaims, 2);
  assert.equal(policy.taskLimits.boss.maxClaims, 1);
  assert.equal(policy.taskLimits.domain.maxClaims, 3);
  assert.equal(policy.taskLimits.artifactDomain.maxClaims, null);
});

test('自定义任务顺序拒绝重复、遗漏和未知项', () => {
  assert.throws(() => compileResinPolicyV2({
    ...customDefaults,
    resinTaskPriority4: '世界 Boss',
  }), /树脂任务存在重复项：世界 Boss/);
  assert.throws(() => compileResinPolicyV2({
    ...customDefaults,
    resinTaskPriority2: '',
  }), /树脂任务 2 无效/);
  assert.throws(() => compileResinPolicyV2({
    ...customDefaults,
    resinTaskPriority2: '周本',
  }), /树脂任务 2 无效/);
});

test('自定义领取上限只接受正整数或用完可用树脂，并兼容旧版全部', () => {
  for (const value of ['0', '-1', '1.5', 'abc', '10000']) {
    assert.throws(() => compileResinPolicyV2({
      ...customDefaults,
      bossMaxClaims: value,
    }), /世界 Boss领奖上限/);
  }
  assert.equal(compileResinPolicyV2({ ...customDefaults, bossMaxClaims: '9999' })
    .taskLimits.boss.maxClaims, 9999);
  assert.equal(compileResinPolicyV2({ ...customDefaults, bossMaxClaims: '用完可用树脂' })
    .taskLimits.boss.maxClaims, null);
  assert.equal(compileResinPolicyV2({ ...customDefaults, bossMaxClaims: '全部' })
    .taskLimits.boss.maxClaims, null);
});

test('V2 策略及嵌套值不可变', () => {
  const policy = compileResinPolicyV2(customDefaults);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.taskOrder), true);
  assert.equal(Object.isFrozen(policy.taskLimits.boss), true);
  assert.throws(() => policy.taskOrder.push('boss'), TypeError);
  assert.throws(() => { policy.taskLimits.boss.maxClaims = 5; }, TypeError);
});

test('任务类型区分限时秘境、普通秘境、Boss 和圣遗物', () => {
  assert.equal(getTaskPolicyType({ executionType: 'boss' }), 'boss');
  assert.equal(getTaskPolicyType({ executionType: 'domain', limited: true }), 'limitedDomain');
  assert.equal(getTaskPolicyType({ executionType: 'domain', limited: false }), 'domain');
  assert.equal(getTaskPolicyType({ executionType: 'artifactDomain' }), 'artifactDomain');
  assert.equal(getTaskPolicyType({ executionType: 'route' }), null);
});

test('策略预览直接来自编译结果', () => {
  const preview = formatResinPolicyPreview(compileResinPolicyV2({
    ...customDefaults,
    domainUseOriginalResin: true,
    domainUseCondensedResin: false,
    domainUseTransientResin: true,
  }));
  assert.equal(preview.mode, '按顺序刷多类');
  assert.match(preview.order, /^世界 Boss（最多 1 次） → 限时培养秘境（最多 2 次）/);
  assert.equal(preview.resinTypes, '原粹 → 须臾');
  assert.equal(preview.routeTiming, '树脂任务后');
});
