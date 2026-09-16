import { buildAutomaticProfileTargets, buildTargetSummary, readCharacterProfile } from './character-profile.js';

const MAX_GUIDE_AGE_MS = 5 * 60 * 1000;
const TALENT_SLOT_KEYS = Object.freeze({
  combat1: 'normal',
  combat2: 'skill',
  combat3: 'burst',
});

/** Use the guide as desired state and BetterGI's profile API as current state. */
export async function buildGuideTargetData({
  snapshot,
  identities,
  rulebook,
  service,
  profilesByCharacter = {},
  nowMs = Date.now(),
}) {
  const { collection, preview } = requireFreshGuideSnapshot(snapshot, nowMs);
  const requests = prepareRequests(preview, identities, rulebook);
  const targets = [];
  const targetSummary = [];
  const targetOutcomes = [];
  const profiles = [];

  for (const request of requests) {
    const cachedProfile = profilesByCharacter?.[request.characterName];
    const profile = cachedProfile ?? await readCharacterProfile(service, {
      characterName: request.characterName,
      categories: '属性;武器;天赋',
    });
    if (profile?.characterName !== request.characterName) {
      throw new Error(`角色档案返回“${profile?.characterName ?? '未知角色'}”，与提升指南“${request.characterName}”不一致`);
    }
    const settings = buildProfileSettings(request, profile);
    const generated = buildAutomaticProfileTargets(profile, settings, rulebook, {
      characterName: request.characterName,
      cultivationMode: '培养角色和当前佩戴武器',
      requiresProfile: true,
      previewOnly: false,
    });
    const failures = generated.targetOutcomes.filter((outcome) => outcome.status === 'failed');
    if (failures.length > 0) {
      throw new Error(`提升指南角色“${request.characterName}”无法生成完整目标：${failures.map((item) => item.message).join('；')}`);
    }
    targets.push(...generated.targets);
    targetSummary.push(...generated.summary);
    targetOutcomes.push(...generated.targetOutcomes);
    profiles.push(profile);
  }

  return {
    targets,
    inventory: {},
    targetSummary,
    targetOutcomes,
    profiles,
    guide: {
      runId: collection.run_id,
      startedAt: collection.started_at,
      capturedAt: collection.completed_at,
      characters: requests.map((request) => request.characterName),
      targetRequests: requests,
    },
  };
}

/** Append non-duplicate guide targets without changing original targets or inventory. */
export function appendGuideTargetData({
  originalTargetData,
  guideTargetData,
  originalTargetSummary = [],
  originalTargetOutcomes = [],
}) {
  const originalTargets = requireTargets(originalTargetData, '原有培养目标');
  const guideTargets = requireTargets(guideTargetData, '提升指南培养目标');
  const originalOutcomes = Array.isArray(originalTargetOutcomes) ? originalTargetOutcomes : [];
  const seen = new Set([...originalTargets, ...originalOutcomes]
    .map((target) => targetIdentity(target)).filter(Boolean));
  const appendedGuideTargets = [];
  const skippedGuideTargets = [];

  for (const target of guideTargets) {
    const identity = targetIdentity(target);
    if (!identity) throw new Error('提升指南生成了缺少类型或名称的目标');
    if (seen.has(identity)) {
      skippedGuideTargets.push(target);
      continue;
    }
    seen.add(identity);
    appendedGuideTargets.push({ ...target });
  }

  const appendedIdentities = new Set(appendedGuideTargets.map(targetIdentity));
  const guideOutcomes = Array.isArray(guideTargetData?.targetOutcomes)
    ? guideTargetData.targetOutcomes.filter((outcome) => appendedIdentities.has(targetIdentity(outcome))) : [];
  const targetSummary = [
    ...(Array.isArray(originalTargetSummary) ? originalTargetSummary : []),
    ...buildTargetSummary(appendedGuideTargets),
  ];
  return {
    targetData: {
      ...originalTargetData,
      targets: [...originalTargets, ...appendedGuideTargets],
    },
    targetSummary,
    targetOutcomes: [
      ...originalOutcomes,
      ...guideOutcomes,
    ],
    guide: {
      ...guideTargetData.guide,
      appendedTargets: appendedGuideTargets.map((target) => ({ kind: target.kind, name: target.name })),
      skippedTargets: skippedGuideTargets.map((target) => ({ kind: target.kind, name: target.name })),
    },
    appendedGuideTargets,
    skippedGuideTargets,
  };
}

function requireTargets(targetData, label) {
  if (!targetData || !Array.isArray(targetData.targets)) throw new Error(`${label}无效`);
  return targetData.targets;
}

function targetIdentity(target) {
  return typeof target?.kind === 'string' && target.kind
    && typeof target?.name === 'string' && target.name
    ? `${target.kind}\u0000${target.name}` : null;
}

function requireFreshGuideSnapshot(snapshot, nowMs) {
  const collection = snapshot?.collection;
  const preview = snapshot?.preview;
  if (!collection || collection.ok !== true || collection.incomplete !== false) {
    throw new Error('提升指南读取不完整');
  }
  if (!preview || !Array.isArray(preview.characterProgress)) throw new Error('提升指南角色预览缺失');
  const runId = collection.run_id;
  if (typeof runId !== 'string' || !runId || preview.run_id !== runId) {
    throw new Error('提升指南读取批次不一致');
  }
  const startedAt = Date.parse(collection.started_at);
  const completedAt = Date.parse(collection.completed_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt
    || preview.evidence_started_at !== collection.started_at
    || preview.captured_at !== collection.completed_at) {
    throw new Error('提升指南读取时间范围无效');
  }
  if (!Number.isFinite(nowMs) || completedAt > nowMs || nowMs - completedAt > MAX_GUIDE_AGE_MS) {
    throw new Error('提升指南读取结果已过期');
  }
  const homeCharacters = collection.home?.characters;
  if (!Array.isArray(homeCharacters) || homeCharacters.length !== preview.characterProgress.length
    || homeCharacters.some((character, index) => character.name !== preview.characterProgress[index]?.name
      || character.level !== preview.characterProgress[index]?.homeLevel
      || character.level !== preview.characterProgress[index]?.level?.current)) {
    throw new Error('提升指南角色列表与预览不一致');
  }
  return { collection, preview };
}

function prepareRequests(preview, identities, rulebook) {
  if (!identities?.characters || !identities?.weapons || !rulebook?.characters || !rulebook?.weapons) {
    throw new Error('提升指南目标映射缺少身份或规则目录');
  }
  const names = new Set();
  return preview.characterProgress.map((character) => {
    const characterName = requireText(character?.name, '提升指南角色名称');
    if (names.has(characterName)) throw new Error(`提升指南角色重复：“${characterName}”`);
    names.add(characterName);
    if (!rulebook.characters[characterName]) throw new Error(`规则库中没有提升指南角色：“${characterName}”`);

    const identity = identities.characters[characterName];
    const skills = identity?.talentIdentity === 'exact' ? identity.combatSkills : null;
    if (!Array.isArray(skills) || skills.length !== 3) {
      throw new Error(`提升指南角色“${characterName}”缺少精确天赋身份`);
    }
    const talentKeyByName = new Map();
    const talentKeys = new Set();
    for (const skill of skills) {
      const key = TALENT_SLOT_KEYS[skill?.slot];
      const name = skill?.canonicalName;
      if (!key || typeof name !== 'string' || !name || talentKeyByName.has(name) || talentKeys.has(key)) {
        throw new Error(`提升指南角色“${characterName}”的天赋身份无效`);
      }
      talentKeyByName.set(name, key);
      talentKeys.add(key);
    }
    if (talentKeyByName.size !== 3 || talentKeys.size !== 3) {
      throw new Error(`提升指南角色“${characterName}”的天赋身份不完整`);
    }

    const level = character.level;
    if (level?.incomplete !== false) throw new Error(`提升指南角色“${characterName}”的等级目标不完整`);
    requirePositiveInteger(level.current, `提升指南角色“${characterName}”的当前等级`);
    let targetLevel = level.target;
    if (targetLevel === null && level.noUpgradeNeeded === true && level.current === 90) targetLevel = 90;
    else if (targetLevel === null && level.noUpgradeNeeded === true) {
      throw new Error(`提升指南角色“${characterName}”的无升级等级 ${level.current} 暂不受规则库支持`);
    }
    else requirePositiveInteger(targetLevel, `提升指南角色“${characterName}”的目标等级`);

    const weapon = character.weapon;
    if (weapon?.incomplete !== false) throw new Error(`提升指南角色“${characterName}”的武器目标不完整`);
    const weaponName = requireText(weapon.name, `提升指南角色“${characterName}”的武器名称`);
    if (!Array.isArray(identities.weapons[weaponName]) || identities.weapons[weaponName].length !== 1) {
      throw new Error(`提升指南武器身份不明确：“${weaponName}”`);
    }
    if (!rulebook.weapons[weaponName]) throw new Error(`规则库中没有提升指南武器：“${weaponName}”`);
    requirePositiveInteger(weapon.current, `提升指南武器“${weaponName}”的当前等级`);
    requirePositiveInteger(weapon.target, `提升指南武器“${weaponName}”的目标等级`);

    const talents = {};
    if (character.talents?.incomplete !== false || !Array.isArray(character.talents.talents)
      || character.talents.talents.length === 0) {
      throw new Error(`提升指南角色“${characterName}”的天赋目标不完整`);
    }
    for (const talent of character.talents.talents) {
      const talentName = requireText(talent?.name, `提升指南角色“${characterName}”的天赋名称`);
      const key = talentKeyByName.get(talentName);
      if (!key || talents[key]) throw new Error(`提升指南角色“${characterName}”的天赋身份不明确：“${talentName}”`);
      requirePositiveInteger(talent.displayedCurrent, `提升指南天赋“${talentName}”的当前等级`);
      requirePositiveInteger(talent.target, `提升指南天赋“${talentName}”的目标等级`);
      talents[key] = {
        name: talentName,
        displayedCurrent: talent.displayedCurrent,
        displayedTarget: talent.target,
      };
    }

    return {
      characterName,
      level: { current: level.current, target: targetLevel },
      weapon: { name: weaponName, current: weapon.current, target: weapon.target },
      talents,
    };
  });
}

function buildProfileSettings(request, profile) {
  if (profile.character.level !== request.level.current) {
    throw new Error(`角色“${request.characterName}”的提升指南等级与档案不一致`);
  }
  if (profile.weapon.name !== request.weapon.name || profile.weapon.level !== request.weapon.current) {
    throw new Error(`角色“${request.characterName}”的提升指南武器与档案不一致`);
  }

  const targetFields = {
    normal: 'autoNormalAttackTargetLevel',
    skill: 'autoElementalSkillTargetLevel',
    burst: 'autoElementalBurstTargetLevel',
  };
  const settings = {
    autoCharacterTargetLevel: String(request.level.target),
    autoWeaponMode: '培养角色和当前佩戴武器',
    autoWeaponTargetLevel: String(request.weapon.target),
  };
  for (const [key, field] of Object.entries(targetFields)) {
    const desired = request.talents[key];
    if (!desired) {
      settings[field] = '不培养';
      continue;
    }
    const current = profile.talents?.[key];
    if (!Number.isInteger(current?.displayLevel) || typeof current.hasBonus !== 'boolean'
      || current.displayLevel !== desired.displayedCurrent) {
      throw new Error(`角色“${request.characterName}”的天赋“${desired.name}”与档案不一致`);
    }
    const baseTarget = desired.displayedTarget - (current.hasBonus ? 3 : 0);
    const baseCurrent = current.displayLevel - (current.hasBonus ? 3 : 0);
    if (!Number.isInteger(baseTarget) || baseTarget < 1 || baseTarget > 10 || baseCurrent < 1 || baseCurrent > 10) {
      throw new Error(`角色“${request.characterName}”的天赋“${desired.name}”基础目标无效`);
    }
    settings[field] = baseTarget === 1 ? '不培养' : String(baseTarget);
  }
  return settings;
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label}无效`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}无效`);
}
