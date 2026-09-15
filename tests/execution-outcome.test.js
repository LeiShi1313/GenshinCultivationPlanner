import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendExecutionWarning,
  createExecutionOutcome,
  createRunExecution,
  normalizeLegacyExecution,
  updatePrimaryTaskOutcome,
} from '../core/execution-outcome.js';
import { classifyExecutionError, withExecutionContext } from '../core/error-classifier.js';

test('统一结果必须使用稳定状态、阶段和状态码', () => {
  const outcome = createExecutionOutcome({
    taskId: 'boss:急冻树', taskType: 'boss', targetName: '急冻树',
    status: 'completed', code: 'task_completed', stage: 'task', message: '调用完成',
  });
  assert.equal(outcome.severity, 'info');
  assert.equal(outcome.retryable, false);
  assert.throws(() => createExecutionOutcome({ status: 'pending', code: 'x' }), /未知执行状态/);
  assert.throws(() => createExecutionOutcome({ status: 'failed', code: '' }), /稳定状态码/);
});

test('运行结果保留旧字段并同步首个任务的奖励结论', () => {
  const execution = createRunExecution({
    task: { executionType: 'boss', bossName: '急冻树', materialId: 'boss:急冻树' },
    status: 'completed', code: 'task_completed', message: '任务调用结束',
  });
  updatePrimaryTaskOutcome(execution, {
    status: 'unconfirmed', code: 'reward_unconfirmed', stage: 'reward',
    message: '未确认领取奖励', evidence: { taskRecognizedRewards: {} },
  });
  assert.equal(execution.status, 'unconfirmed');
  assert.equal(execution.reason, '未确认领取奖励');
  assert.equal(execution.tasks[0].targetName, '急冻树');
  assert.equal(execution.tasks[0].evidence.taskRecognizedRewards != null, true);
});

test('清理失败只追加告警，不覆盖主任务结果', () => {
  const execution = createRunExecution({
    task: { executionType: 'boss', bossName: '急冻树' },
    status: 'completed', code: 'reward_confirmed', message: '已确认收益',
  });
  appendExecutionWarning(execution, { message: '传送神像失败', targetName: '急冻树' });
  assert.equal(execution.status, 'completed');
  assert.equal(execution.code, 'reward_confirmed');
  assert.equal(execution.warnings[0].code, 'cleanup_failed');
});

test('旧执行记录可以迁移且不丢失旧字段', () => {
  const migrated = normalizeLegacyExecution({
    status: 'failed', reason: '切换失败', task: { executionType: 'domain', domainName: '太山府' },
    trackedRewards: { 测试材料: 1 },
  });
  assert.equal(migrated.code, 'external_task_error');
  assert.equal(migrated.tasks[0].targetName, '太山府');
  assert.deepEqual(migrated.trackedRewards, { 测试材料: 1 });
});

test('错误分类优先使用调用上下文，只有明确树脂不足才细分', () => {
  const partyError = withExecutionContext(new Error('未能打开队伍配置界面'), {
    code: 'party_switch_failed', stage: 'party', retryable: true,
  });
  const classifiedPartyError = classifyExecutionError(partyError);
  assert.equal(classifiedPartyError.status, 'failed');
  assert.equal(classifiedPartyError.code, 'party_switch_failed');
  assert.equal(classifiedPartyError.stage, 'party');
  assert.equal(classifiedPartyError.severity, 'fatal');
  assert.equal(classifiedPartyError.retryable, true);
  assert.equal(classifiedPartyError.message, '未能打开队伍配置界面');
  assert.ok(classifiedPartyError.endedAt);
  const emptyReward = classifyExecutionError(new Error('奖励识别结果为空'));
  assert.equal(emptyReward.code, 'external_task_error');
  const noResin = classifyExecutionError(new Error('原粹树脂不足'));
  assert.equal(noResin.code, 'no_resin');
  assert.equal(noResin.status, 'skipped');
});
