/** 携带稳定状态码和执行阶段的脚本错误。 */
export class ExecutionError extends Error {
  constructor(message, {
    code = 'external_task_error',
    stage = 'task',
    severity = 'fatal',
    retryable = false,
    evidence = {},
    cause = null,
    startedAt = null,
    endedAt = null,
  } = {}) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
    this.stage = stage;
    this.severity = severity;
    this.retryable = retryable === true;
    this.evidence = evidence;
    this.startedAt = startedAt;
    this.endedAt = endedAt;
    if (cause) this.cause = cause;
  }
}

/** 为调用位置已知的异常补充上下文，避免仅靠错误文本猜测。 */
export function withExecutionContext(error, context = {}) {
  if (error instanceof ExecutionError) return error;
  const message = error?.message ?? String(error);
  return new ExecutionError(message, { ...context, cause: error });
}

/** 将异常转换为统一失败字段；只在 BetterGI 明确写出树脂不足时细分。 */
export function classifyExecutionError(error, fallback = {}) {
  const contextual = error instanceof ExecutionError
    ? error
    : withExecutionContext(error, fallback);
  const explicitNoResin = /(?:树脂不足|没有足够的树脂|insufficient resin)/i.test(contextual.message);
  const unsupported = contextual.code === 'native_unsupported';
  return {
    status: explicitNoResin || unsupported ? 'skipped' : 'failed',
    code: explicitNoResin ? 'no_resin' : contextual.code,
    stage: contextual.stage,
    severity: explicitNoResin || unsupported ? 'info' : contextual.severity,
    retryable: unsupported || (explicitNoResin ? false : contextual.retryable),
    message: contextual.message,
    evidence: contextual.evidence,
    startedAt: contextual.startedAt,
    endedAt: contextual.endedAt ?? new Date().toISOString(),
  };
}

/** Exact native rejections before battle/claim; never infer support from generic task failures. */
export function isUnsupportedNativeTask(error, task) {
  const expected = task.executionType === 'boss'
    ? `暂不支持首领：${task.bossName}`
    : task.executionType === 'domain'
      ? `未找到对应的秘境${task.domainName}的传送点`
      : null;
  if (!expected) return false;
  for (let cause = error, depth = 0; cause != null && depth < 4; cause = cause.cause, depth++) {
    if (String(cause?.message ?? cause).trim() === expected) return true;
  }
  return false;
}
