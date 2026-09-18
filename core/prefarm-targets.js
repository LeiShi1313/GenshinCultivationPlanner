import { readCharacterProfile } from './character-profile.js';

const LEVEL_LIMITS = new Set([20, 40, 50, 60, 70, 80, 90]);
const COMPLETED_CHARACTER_LIMITS = new Set([90, 95, 100]);
const TALENT_KEYS = Object.freeze(['normal', 'skill', 'burst']);

/** Validate persistent prefarm configuration before any game API is called. */
export function validatePlannedTargets(targets, rulebook) {
  if (!Array.isArray(targets)) throw new Error('持久培养目标必须是数组');
  if (!rulebook || typeof rulebook !== 'object') throw new Error('持久培养目标缺少规则库');
  const seen = new Set();
  return targets.map((target, index) => {
    const label = `持久培养目标第 ${index + 1} 项`;
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error(`${label}必须是对象`);
    if (target.kind !== 'character' && target.kind !== 'weapon') throw new Error(`${label}类型无效`);
    const name = requiredName(target.name, `${label}名称`);
    requireUnique(seen, `${target.kind}\u0000${name}`, `${label}与前面的${target.kind === 'character' ? '角色' : '武器'}目标重复：${name}`);
    const level = validateLevelPlan(target.level, `${label}等级`);
    if (target.kind === 'weapon') {
      if (!hasOwn(rulebook.weapons, name)) throw new Error(`${label}武器“${name}”不在当前规则库中`);
      return { kind: 'weapon', name, level };
    }
    if (!hasOwn(rulebook.characters, name)) throw new Error(`${label}角色“${name}”不在当前规则库中`);
    if (target.allowUnowned !== true && target.allowUnowned !== false && target.allowUnowned != null) {
      throw new Error(`${label}的 allowUnowned 必须是布尔值`);
    }
    const talents = validateTalents(target.talents, `${label}天赋`);
    let weapon;
    if (target.weapon != null) {
      if (typeof target.weapon !== 'object' || Array.isArray(target.weapon)) throw new Error(`${label}的武器目标必须是对象`);
      const weaponName = requiredName(target.weapon.name, `${label}的武器名称`);
      requireUnique(seen, `weapon\u0000${weaponName}`, `${label}的武器与前面的武器目标重复：${weaponName}`);
      if (!hasOwn(rulebook.weapons, weaponName)) throw new Error(`${label}的武器“${weaponName}”不在当前规则库中`);
      weapon = { name: weaponName, level: validateLevelPlan(target.weapon.level, `${label}的武器等级`) };
    }
    return { kind: 'character', name, allowUnowned: target.allowUnowned === true, level, talents, ...(weapon ? { weapon } : {}) };
  });
}

/** Resolve configured prefarm goals with current-run native profiles when available. */
export async function resolvePlannedTargets({
  targets,
  rulebook,
  service,
  observedCharacters = {},
  profilesByCharacter = {},
}) {
  const plans = validatePlannedTargets(targets, rulebook);
  const resolvedTargets = [];
  const targetSummary = [];
  const targetOutcomes = [];
  const profiles = [];
  const warnings = [];
  const observed = copyObservedCharacters(observedCharacters);

  for (const plan of plans) {
    if (plan.kind === 'weapon') {
      resolveStandaloneWeapon(plan, resolvedTargets, targetSummary, targetOutcomes);
      continue;
    }
    let profile = profilesByCharacter?.[plan.name] ?? null;
    let fallback = false;
    try {
      if (!profile) {
        profile = await readCharacterProfile(service, {
          characterName: plan.name,
          categories: plan.weapon ? '属性;武器;天赋' : '属性;天赋',
        });
      }
      if (profile?.characterName !== plan.name) {
        throw new Error(`角色档案返回“${profile?.characterName ?? '未知角色'}”，与持久目标“${plan.name}”不一致`);
      }
      // A genuine profile remains observed even when one component later fails validation.
      observed[plan.name] = true;
      profiles.push(profile);
    } catch (error) {
      if (plan.allowUnowned && observed[plan.name] !== true && isFirstUnownedError(error, plan.name)) {
        fallback = true;
        const warning = `角色 ${plan.name} 档案未确认；本轮按配置预刷（角色 ${formatProgress(plan.level.current, plan.level.currentLimit)}，天赋采用配置值，未伪造档案）`;
        warnings.push(warning);
        targetSummary.push(warning);
      } else {
        appendFailure(plan, errorMessage(error), targetSummary, targetOutcomes);
        continue;
      }
    }

    resolveCharacter(plan, profile, fallback, rulebook, resolvedTargets, targetSummary, targetOutcomes);
  }

  return {
    targets: resolvedTargets,
    targetSummary,
    targetOutcomes,
    profiles,
    observedCharacters: observed,
    warnings,
  };
}

function resolveCharacter(plan, profile, fallback, rulebook, targets, summary, outcomes) {
  let currentLevel = null;
  try {
    currentLevel = fallback
      ? { level: plan.level.current, levelLimit: plan.level.currentLimit }
      : requireCharacterProgress(profile?.character, `角色 ${plan.name} 等级`);
  } catch (error) {
    appendFailure(plan, errorMessage(error), summary, outcomes, 'level');
  }
  const desiredLevel = { level: plan.level.target, levelLimit: plan.level.targetLimit };
  const levelPending = currentLevel != null && compareProgress(currentLevel, desiredLevel) < 0;
  if (currentLevel) {
    outcomes.push(outcome(plan, 'level', levelPending, currentLevel, desiredLevel));
    summary.push(`角色 ${plan.name}：${formatProgress(currentLevel.level, currentLevel.levelLimit)} → ${formatProgress(desiredLevel.level, desiredLevel.levelLimit)}`
      + `${levelPending ? '' : '（已达到，跳过等级）'}`);
  }

  const talents = {};
  const talentSummary = [];
  for (const key of TALENT_KEYS) {
    const desired = plan.talents[key];
    if (!desired) continue;
    try {
      const current = fallback ? desired.current : requireTalentLevel(profile?.talents?.[key], talentLabel(key));
      const pending = current < desired.target;
      outcomes.push(outcome(plan, key, pending, current, desired.target));
      talentSummary.push(`${talentShortLabel(key)}${current}→${desired.target}${pending ? '' : '（已达到）'}`);
      if (pending) talents[key] = { current, target: desired.target };
    } catch (error) {
      const message = errorMessage(error);
      outcomes.push({ kind: 'character', component: key, status: 'failed', name: plan.name, message });
      talentSummary.push(`${talentShortLabel(key)}读取失败`);
    }
  }

  if (talentSummary.length > 0) summary.push(`角色 ${plan.name} 天赋：${talentSummary.join('，')}`);
  if (levelPending || Object.keys(talents).length > 0) {
    targets.push({
      kind: 'character',
      name: plan.name,
      ...(levelPending ? { level: {
        current: currentLevel.level,
        currentLimit: currentLevel.levelLimit,
        target: desiredLevel.level,
        targetLimit: desiredLevel.levelLimit,
      } } : {}),
      talents,
    });
  }
  if (plan.weapon) resolveAttachedWeapon(plan, profile, fallback, rulebook, targets, summary, outcomes);
}

function resolveAttachedWeapon(plan, profile, fallback, rulebook, targets, summary, outcomes) {
  const configured = plan.weapon;
  const name = fallback ? configured.name : String(profile?.weapon?.name ?? '').trim();
  try {
    if (!name) throw new Error(`角色 ${plan.name} 的原生档案缺少当前佩戴武器名称`);
    if (!hasOwn(rulebook.weapons, name)) throw new Error(`当前佩戴武器“${name}”不在当前规则库中`);
    const current = fallback
      ? { level: configured.level.current, levelLimit: configured.level.currentLimit }
      : requireWeaponProgress(profile?.weapon, `武器 ${name} 等级`);
    appendWeaponResult(name, current, configured.level, targets, summary, outcomes, plan.name);
  } catch (error) {
    const message = errorMessage(error);
    outcomes.push({ kind: 'weapon', component: 'level', status: 'failed', name: name || configured.name, owner: plan.name, message });
    summary.push(`角色 ${plan.name} 的武器：读取失败（${message}）`);
  }
}

function resolveStandaloneWeapon(plan, targets, summary, outcomes) {
  appendWeaponResult(
    plan.name,
    { level: plan.level.current, levelLimit: plan.level.currentLimit },
    plan.level,
    targets,
    summary,
    outcomes,
  );
}

function appendWeaponResult(name, current, desired, targets, summary, outcomes, owner = null) {
  const target = { level: desired.target, levelLimit: desired.targetLimit };
  const pending = compareProgress(current, target) < 0;
  outcomes.push({
    kind: 'weapon', component: 'level', status: pending ? 'pending' : 'completed', name, ...(owner ? { owner } : {}),
    current, target, message: pending ? '需要培养' : '当前进度已达到或超过目标',
  });
  summary.push(`${owner ? `角色 ${owner} 当前佩戴` : ''}武器 ${name}：${formatProgress(current.level, current.levelLimit)} → ${formatProgress(target.level, target.levelLimit)}${pending ? '' : '（已达到）'}`);
  if (pending) {
    targets.push({
      kind: 'weapon', name,
      level: {
        current: current.level, currentLimit: current.levelLimit,
        target: target.level, targetLimit: target.levelLimit,
      },
    });
  }
}

function validateLevelPlan(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  const current = value.current == null ? 1 : requireInteger(value.current, 1, 90, `${label}当前等级`);
  const currentLimit = value.currentLimit == null
    ? inferCurrentLimit(current)
    : requireInteger(value.currentLimit, 20, 90, `${label}当前等级上限`);
  if (!LEVEL_LIMITS.has(currentLimit) || current > currentLimit) throw new Error(`${label}当前进度无效：${current}/${currentLimit}`);
  const target = requireInteger(value.target, 1, 90, `${label}目标等级`);
  const targetLimit = value.targetLimit == null
    ? inferTargetLimit(target)
    : requireInteger(value.targetLimit, 20, 90, `${label}目标等级上限`);
  if (!LEVEL_LIMITS.has(targetLimit) || target > targetLimit) throw new Error(`${label}目标进度无效：${target}/${targetLimit}`);
  if (compareProgress(
    { level: current, levelLimit: currentLimit },
    { level: target, levelLimit: targetLimit },
  ) > 0) throw new Error(`${label}当前进度不能高于目标进度`);
  return { current, currentLimit, target, targetLimit };
}

function validateTalents(value, label) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  for (const key of Object.keys(value)) {
    if (!TALENT_KEYS.includes(key)) throw new Error(`${label}含未知项目：${key}`);
  }
  return Object.fromEntries(TALENT_KEYS.filter((key) => value[key] != null).map((key) => {
    const item = value[key];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label}.${key} 必须是对象`);
    const current = item.current == null ? 1 : requireInteger(item.current, 1, 10, `${label}.${key} 当前等级`);
    const target = requireInteger(item.target, 1, 10, `${label}.${key} 目标等级`);
    if (current > target) throw new Error(`${label}.${key} 当前等级不能高于目标等级`);
    return [key, { current, target }];
  }));
}

function requireCharacterProgress(value, label) {
  const level = value?.level;
  const levelLimit = value?.levelLimit;
  if (!Number.isInteger(level) || !Number.isInteger(levelLimit)) throw new Error(`${label}档案字段不完整`);
  if (level >= 90 && level <= 100 && COMPLETED_CHARACTER_LIMITS.has(levelLimit) && level <= levelLimit) {
    return { level: 90, levelLimit: 90 };
  }
  if (level < 1 || level > 90 || !LEVEL_LIMITS.has(levelLimit) || level > levelLimit) {
    throw new Error(`${label}档案无效：${level}/${levelLimit}`);
  }
  return { level, levelLimit };
}

function requireWeaponProgress(value, label) {
  const level = value?.level;
  const levelLimit = value?.levelLimit;
  if (!Number.isInteger(level) || !Number.isInteger(levelLimit)
      || level < 1 || level > 90 || !LEVEL_LIMITS.has(levelLimit) || level > levelLimit) {
    throw new Error(`${label}档案无效：${level ?? '未知'}/${levelLimit ?? '未知'}`);
  }
  return { level, levelLimit };
}

function requireTalentLevel(value, label) {
  if (!Number.isInteger(value?.displayLevel) || typeof value?.hasBonus !== 'boolean') throw new Error(`${label}档案字段不完整`);
  const level = value.displayLevel - (value.hasBonus ? 3 : 0);
  if (level < 1 || level > 10) throw new Error(`${label}命座加成还原后的实际等级无效`);
  return level;
}

function isFirstUnownedError(error, name) {
  for (const cause of errorChain(error)) {
    const message = String(cause?.message ?? cause ?? '').trim();
    if (message === `未找到目标角色 ${name}。`) return true;
    if (message === `角色名称校验失败：${name}`) return true;
  }
  return false;
}

function errorChain(error) {
  const chain = [];
  let current = error;
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function appendFailure(plan, message, summary, outcomes, component = 'profile') {
  outcomes.push({ kind: plan.kind, component, status: 'failed', name: plan.name, message });
  summary.push(`${plan.kind === 'character' ? '角色' : '武器'} ${plan.name}：目标失败（${message}）`);
}

function outcome(plan, component, pending, current, target) {
  return {
    kind: 'character', component, status: pending ? 'pending' : 'completed', name: plan.name,
    current, target, message: pending ? '需要培养' : '当前进度已达到或超过目标',
  };
}

function requiredName(value, label) {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  const name = value.trim();
  if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error(`${label}无效`);
  return name;
}

function requireInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min} 到 ${max} 的整数`);
  return value;
}

function inferCurrentLimit(level) {
  return [...LEVEL_LIMITS].find((limit) => limit >= level) ?? 90;
}

function inferTargetLimit(level) {
  return [...LEVEL_LIMITS].find((limit) => limit > level) ?? 90;
}

function compareProgress(left, right) {
  if (left.level !== right.level) return left.level - right.level;
  return left.levelLimit - right.levelLimit;
}

function hasOwn(value, key) {
  return value != null && Object.hasOwn(value, key);
}

function copyObservedCharacters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('预培养实读记录必须是对象');
  }
  const observed = {};
  for (const [name, wasObserved] of Object.entries(value)) {
    if (!name.trim() || ['__proto__', 'constructor', 'prototype'].includes(name) || wasObserved !== true) {
      throw new Error('预培养实读记录损坏，拒绝回退到初始进度');
    }
    observed[name] = true;
  }
  return observed;
}

function requireUnique(seen, identity, message) {
  if (seen.has(identity)) throw new Error(message);
  seen.add(identity);
}

function errorMessage(error) {
  return error?.message ?? String(error);
}

function formatProgress(level, limit) {
  return `${level}/${limit}`;
}

function talentLabel(key) {
  return ({ normal: '普通攻击', skill: '元素战技', burst: '元素爆发' })[key];
}

function talentShortLabel(key) {
  return ({ normal: '普攻', skill: '战技', burst: '爆发' })[key];
}
