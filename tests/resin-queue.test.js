import test from 'node:test';
import assert from 'node:assert/strict';
import { appendArtifactFallbackTask } from '../core/artifact-executor.js';
import { combineRunExecutions, createRunExecution } from '../core/execution-outcome.js';
import { compileResinPolicyV2 } from '../core/resin-policy-v2.js';
import { buildRunSummary } from '../core/report.js';
import {
  compileResinExecutionQueue,
  MAX_RESIN_QUEUE_TASKS,
  runBoundedResinQueue,
  shouldStopResinQueue,
} from '../core/resin-queue.js';
import { buildDomainResinPolicy, limitDomainResinPolicy } from '../core/resin.js';

const tasks = {
  boss: {
    materialId: 'boss', materialName: '首领材料', executionType: 'boss', bossName: '急冻树',
    status: 'supported', materials: [{ materialId: 'boss', materialName: '首领材料', shortage: 6 }],
  },
  limited: {
    materialId: 'limited', materialName: '限时材料', executionType: 'domain', domainName: '太山府',
    limited: true, status: 'supported', materials: [], day: 1,
  },
  domain: {
    materialId: 'domain', materialName: '普通材料', executionType: 'domain', domainName: '塞西莉亚苗圃',
    limited: false, status: 'supported', materials: [], day: 1,
  },
  artifact: {
    materialId: 'artifact:月童的库藏', materialName: '月童的库藏', executionType: 'artifactDomain',
    domainName: '月童的库藏', limited: false, status: 'supported', materials: [],
  },
};

const settings = {
  bossExecutionEnabled: true,
  bossTeamName: 'Boss队',
  domainTeamName: '秘境队',
  artifactDomainEnabled: true,
  artifactTeamName: '圣遗物队',
};

function customPolicy(overrides = {}) {
  return compileResinPolicyV2({
    ...settings,
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
    ...overrides,
  });
}

test('自定义模式按四类优先级编译有界队列', () => {
  const result = compileResinExecutionQueue({
    plan: { todayQueue: [tasks.domain, tasks.boss, tasks.artifact, tasks.limited] },
    settings,
    policy: customPolicy(),
    domainResinPolicy: buildDomainResinPolicy(settings),
  });
  assert.equal(result.entries.length, MAX_RESIN_QUEUE_TASKS);
  assert.deepEqual(result.entries.map((entry) => entry.category), [
    'boss', 'limitedDomain', 'domain', 'artifactDomain',
  ]);
  assert.equal(result.entries[0].config.specifyRunCount, true);
  assert.equal(result.entries[0].config.runCount, 1);
  assert.equal(result.entries[1].config.resinPolicy.condensedResinUseCount, 2);
  assert.equal(result.entries[1].config.resinPolicy.originalResinUseCount, 0);
  assert.equal(result.entries[2].config.resinPolicy.condensedResinUseCount, 3);
  assert.equal(result.entries[3].config.resinPolicy.boundedResinType, undefined);
});

test('有限秘境预算只交给一种已授权树脂，避免每种树脂各刷 N 次', () => {
  const limited = limitDomainResinPolicy(buildDomainResinPolicy({
    domainUseCondensedResin: false,
    domainUseOriginalResin: true,
    domainUseTransientResin: true,
  }), 4);
  assert.deepEqual(limited.priority, ['原粹树脂']);
  assert.equal(limited.originalResinUseCount, 4);
  assert.equal(limited.transientResinUseCount, 0);
  assert.equal(limited.maxClaims, 4);
  assert.throws(() => limitDomainResinPolicy(buildDomainResinPolicy({
    domainUseCondensedResin: false,
    domainUseOriginalResin: false,
  }), 1), /没有可用的秘境树脂类型/);
});

test('同类多个目标只选择排序最前一项并留下明确原因', () => {
  const anotherDomain = { ...tasks.domain, materialId: 'domain-2', domainName: '震雷连山密宫' };
  const result = compileResinExecutionQueue({
    plan: { todayQueue: [tasks.domain, anotherDomain] },
    settings,
    policy: customPolicy(),
    domainResinPolicy: buildDomainResinPolicy(settings),
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].task.domainName, '塞西莉亚苗圃');
  assert.equal(result.omitted.length, 1);
  assert.equal(result.omitted[0].code, 'same_category_deferred');
});

test('兼容模式仍只编译当天第一个已启用任务', () => {
  const result = compileResinExecutionQueue({
    plan: { todayQueue: [tasks.boss, tasks.limited, tasks.domain] },
    settings,
    policy: compileResinPolicyV2(settings),
    domainResinPolicy: buildDomainResinPolicy(settings),
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].task.bossName, '急冻树');
  assert.equal(result.entries[0].config.specifyRunCount, false);
});

test('编译整条队列时会提前发现后续任务配置缺失', () => {
  assert.throws(() => compileResinExecutionQueue({
    plan: { todayQueue: [tasks.boss, tasks.artifact] },
    settings: { ...settings, artifactTeamName: '' },
    policy: customPolicy(),
    domainResinPolicy: buildDomainResinPolicy(settings),
  }), /未配置圣遗物秘境队伍/);
});

test('自定义模式允许把圣遗物作为培养任务后的最后兜底', () => {
  const plan = { todayQueue: [tasks.domain] };
  appendArtifactFallbackTask(plan, {
    ...settings, artifactDomainName: '月童的库藏',
  }, customPolicy());
  assert.deepEqual(plan.todayQueue.map((task) => task.executionType), ['domain', 'artifactDomain']);

  const legacyPlan = { todayQueue: [tasks.domain] };
  appendArtifactFallbackTask(legacyPlan, {
    ...settings, artifactDomainName: '月童的库藏',
  }, compileResinPolicyV2(settings));
  assert.deepEqual(legacyPlan.todayQueue.map((task) => task.executionType), ['domain']);
});

test('未确认、失败或明确无树脂会停止后续树脂队列', () => {
  assert.equal(shouldStopResinQueue(createRunExecution({
    task: tasks.domain, status: 'completed', code: 'task_completed', message: '完成',
  })), false);
  assert.equal(shouldStopResinQueue(createRunExecution({
    task: tasks.domain, status: 'unconfirmed', code: 'reward_unconfirmed', message: '未知',
  })), true);
  assert.equal(shouldStopResinQueue(createRunExecution({
    task: tasks.domain, status: 'failed', code: 'external_task_error', message: '失败',
  })), true);
  assert.equal(shouldStopResinQueue(createRunExecution({
    task: tasks.domain, status: 'skipped', code: 'no_resin', message: '树脂不足',
  })), true);
  assert.equal(shouldStopResinQueue(createRunExecution({
    task: tasks.domain, status: 'completed', code: 'task_completed', message: '完成',
  }), { maxClaims: null }), true);
});

test('有界运行器在完成时继续，在未确认时停止且不会循环调用', async () => {
  const entries = [
    { queueId: '1', maxClaims: 1 },
    { queueId: '2', maxClaims: 1 },
    { queueId: '3', maxClaims: 1 },
  ];
  const called = [];
  const results = await runBoundedResinQueue(entries, async (entry, index) => {
    called.push(entry.queueId);
    return createRunExecution({
      task: tasks.domain,
      status: index === 1 ? 'unconfirmed' : 'completed',
      code: index === 1 ? 'reward_unconfirmed' : 'task_completed',
      message: index === 1 ? '未知' : '完成',
    });
  });
  assert.deepEqual(called, ['1', '2']);
  assert.equal(results.length, 2);

  const unboundedCalled = [];
  await runBoundedResinQueue([
    { queueId: 'all', maxClaims: null },
    { queueId: 'later', maxClaims: 1 },
  ], async (entry) => {
    unboundedCalled.push(entry.queueId);
    return createRunExecution({
      task: tasks.domain, status: 'completed', code: 'task_completed', message: '完成',
    });
  });
  assert.deepEqual(unboundedCalled, ['all']);
});

test('连续任务结果合并奖励、警告和任务顺序且不重复计数', () => {
  const first = createRunExecution({
    task: tasks.boss, status: 'completed', code: 'task_completed', message: 'Boss完成',
    taskRecognizedRewards: { 首领材料: 3 }, rewards: { 首领材料: 3 },
  });
  const second = createRunExecution({
    task: tasks.domain, status: 'completed', code: 'task_completed', message: '秘境完成',
    taskRecognizedRewards: { 普通材料: 2 }, rewards: { 普通材料: 2 },
  });
  const combined = combineRunExecutions([first, second]);
  assert.equal(combined.status, 'completed');
  assert.equal(combined.task, tasks.boss);
  assert.equal(combined.taskCount, 2);
  assert.deepEqual(combined.tasks.map((task) => task.targetName), ['急冻树', '塞西莉亚苗圃']);
  assert.deepEqual(combined.taskRecognizedRewards, { 首领材料: 3, 普通材料: 2 });
  const summary = buildRunSummary({
    todayQueue: [], displayShortages: [], weeklyStrategy: [], manualItems: [],
  }, {}, { executionEnabled: true, execution: combined });
  assert.match(summary, /世界 Boss：急冻树（已完成）/);
  assert.match(summary, /培养秘境：塞西莉亚苗圃（已完成）/);
});
