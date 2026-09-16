// Proven Training Guide recognition migrated from bettergi-growth-planner.
// This module only reads and validates guide state. It does not plan or execute game tasks.

let GUIDE_IDENTITIES;
let BOSS_CATALOG;
let ARTIFACT_CATALOG;

function readGuideJson(path) {
  return JSON.parse(file.ReadTextSync(path));
}
// ---- Migrated from bettergi-growth-planner/src/guide-reader.js ----
function parseGuideHome(snapshot) {
  function fail(message) {
    return { ok: false, error: message };
  }

  if (!snapshot || snapshot.ok !== true || !snapshot.screen || !Array.isArray(snapshot.regions)) {
    return fail("Invalid OCR snapshot");
  }

  const width = Number(snapshot.screen.width);
  const height = Number(snapshot.screen.height);
  if (!(width > 0 && height > 0) || Math.abs(width / height - 16 / 9) > 0.02) {
    return fail("Unsupported screen geometry");
  }

  const sx = width / 1920;
  const sy = height / 1080;
  const regions = snapshot.regions.map(function (region) {
    return {
      text: String(region.text || "").trim(),
      x: Number(region.x),
      y: Number(region.y),
      width: Number(region.width),
      height: Number(region.height)
    };
  });
  if (regions.some(function (region) {
    return !region.text || !Number.isFinite(region.x) || !Number.isFinite(region.y) ||
      !Number.isFinite(region.width) || !Number.isFinite(region.height) ||
      region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0;
  })) return fail("Invalid OCR region");
  const title = regions.find(function (region) {
    return region.text === "提升指南" && region.y < 100 * sy;
  });
  if (!title) return fail("Not on the 提升指南 home screen");

  const headerMatches = regions.map(function (region) {
    const match = region.text.match(/^培养计划角色列表[（(](\d+)\/(\d+)[）)]$/);
    return match ? { region: region, count: Number(match[1]), capacity: Number(match[2]) } : null;
  }).filter(Boolean);
  if (headerMatches.length !== 1) return fail("Missing or ambiguous plan header");

  const header = headerMatches[0];
  if (header.count > header.capacity) return fail("Plan count exceeds capacity");
  const partyHeader = regions.find(function (region) {
    return /^队伍内角色实力/.test(region.text) && region.y > header.region.y;
  });
  const sectionBottom = partyHeader ? partyHeader.y : height;
  const badges = regions.filter(function (region) {
    return /^(培养中|已完成)$/.test(region.text) && region.y > header.region.y && region.y < sectionBottom;
  });

  if (header.count === 0) {
    return badges.length === 0
      ? { ok: true, count: 0, capacity: header.capacity, incomplete: false, characters: [] }
      : fail("Plan header count does not match visible badges");
  }
  if (badges.length === 0 || badges.length > header.count) {
    return fail("Plan header count does not match visible badges");
  }
  if (partyHeader && badges.length !== header.count) {
    return fail("Plan header count does not match visible badges");
  }

  const characters = [];
  for (const badge of badges) {
    const names = regions.filter(function (region) {
      const centerDelta = Math.abs((region.y + region.height / 2) - (badge.y + badge.height / 2));
      return region.x >= 700 * sx && region.x < 1200 * sx && centerDelta <= 25 * sy;
    });
    const levels = regions.filter(function (region) {
      return /^Lv\.\d+$/i.test(region.text) && region.x >= 620 * sx && region.x < 850 * sx &&
        region.y > badge.y + 55 * sy && region.y < badge.y + 135 * sy;
    });
    const upgrades = regions.filter(function (region) {
      return region.text === "提升" && region.x > 1550 * sx &&
        region.y >= badge.y && region.y < badge.y + 90 * sy;
    });
    if (names.length !== 1 || levels.length !== 1 || upgrades.length !== 1) {
      return fail("Could not identify one complete enabled-character row");
    }

    characters.push({
      name: names[0].text,
      guideStatus: badge.text,
      level: Number(levels[0].text.slice(3)),
      upgradePoint: {
        x: upgrades[0].x + upgrades[0].width / 2,
        y: upgrades[0].y + upgrades[0].height / 2
      }
    });
  }

  const names = characters.map(function (character) { return character.name; });
  if (new Set(names).size !== names.length) return fail("Duplicate enabled-character names");
  return {
    ok: true,
    count: header.count,
    capacity: header.capacity,
    incomplete: characters.length < header.count,
    characters: characters.sort(function (a, b) { return a.upgradePoint.y - b.upgradePoint.y; })
  };
}

// ---- Migrated from bettergi-growth-planner/src/artifact-guide.js ----
function artifactText(value) {
  return String(value === undefined || value === null ? "" : value)
    .normalize("NFKC").replace(/\s+/g, "").replace(/:/g, "：").replace(/[x×]/g, "×")
    .replace(/[『【\[]/g, "「").replace(/[』】\]]/g, "」");
}

function artifactSnapshotRegions(snapshot) {
  if (!snapshot || snapshot.ok !== true || !snapshot.screen ||
      !(Number(snapshot.screen.width) > 0) || !(Number(snapshot.screen.height) > 0) ||
      !Array.isArray(snapshot.regions)) return null;
  const sx = 1920 / Number(snapshot.screen.width);
  const sy = 1080 / Number(snapshot.screen.height);
  const regions = [];
  for (const region of snapshot.regions) {
    if (!region || ![region.x, region.y, region.width, region.height].every(value =>
        Number.isFinite(Number(value))) || !(Number(region.width) > 0) || !(Number(region.height) > 0)) return null;
    regions.push({
      text: String(region.text || "").trim(),
      x: Number(region.x) * sx,
      y: Number(region.y) * sy,
      width: Number(region.width) * sx,
      height: Number(region.height) * sy
    });
  }
  return regions;
}

function artifactRegionEvidence(region, snapshot) {
  if (!region) return null;
  return {
    run_id: snapshot.run_id,
    snapshot_id: snapshot.snapshot_id,
    captured_at: snapshot.captured_at,
    text: region.text,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height
  };
}

function parseArtifactRecommendation(snapshot, characterName, catalog) {
  const issues = [];
  const result = {
    incomplete: true,
    issues: issues,
    character: null,
    set: null,
    recognizedSets: [],
    domain: null,
    challengeBase: null,
    challenge: null,
    status: "incomplete",
    reason: null,
    policy: "first_guide_recommendation",
    currentState: null,
    evidence: {
      run_id: snapshot && snapshot.run_id || null,
      snapshot_id: snapshot && snapshot.snapshot_id || null,
      captured_at: snapshot && snapshot.captured_at || null,
      characterHeader: null,
      pageTitle: null,
      recommendationTitle: null,
      schemeOne: null,
      scopeEnd: null,
      source: null
    }
  };
  const regions = artifactSnapshotRegions(snapshot);
  if (!regions) issues.push("invalid_artifact_snapshot");
  if (!snapshot || typeof snapshot.run_id !== "string" || !snapshot.run_id ||
      typeof snapshot.snapshot_id !== "string" || !snapshot.snapshot_id ||
      typeof snapshot.captured_at !== "string" || !Number.isFinite(Date.parse(snapshot.captured_at))) {
    issues.push("artifact_snapshot_provenance_missing");
  }
  if (typeof characterName !== "string" || !characterName.trim()) issues.push("character_name_missing");
  if (!catalog || catalog.schemaVersion !== 1 || !catalog.sets || Array.isArray(catalog.sets) ||
      !catalog.domains || Array.isArray(catalog.domains)) issues.push("invalid_artifact_catalog");
  if (!regions || issues.length) return result;

  const expectedCharacter = artifactText(characterName);
  const characterHeaders = regions.filter(region => region.x >= 700 && region.x < 1450 &&
    region.y >= 70 && region.y < 210 && artifactText(region.text) === expectedCharacter);
  if (characterHeaders.length !== 1) issues.push("artifact_character_header_missing_or_ambiguous");
  else {
    result.character = characterName.trim();
    result.evidence.characterHeader = artifactRegionEvidence(characterHeaders[0], snapshot);
  }

  const pageTitles = regions.filter(region => region.x >= 625 && region.x < 1500 &&
    region.y >= 300 && region.y <= 350 && artifactText(region.text) === "强化当前圣遗物");
  if (pageTitles.length !== 1) issues.push("artifact_page_title_missing_or_ambiguous");
  else result.evidence.pageTitle = artifactRegionEvidence(pageTitles[0], snapshot);

  const recommendationTitles = regions.filter(region => region.x >= 625 && region.x < 1850 &&
    region.y > 350 && region.y < 1000 &&
    artifactText(region.text) === "推荐圣遗物搭配方案");
  if (recommendationTitles.length !== 1 || pageTitles.length === 1 &&
      recommendationTitles[0].y <= pageTitles[0].y) {
    issues.push("artifact_recommendation_title_missing_or_ambiguous");
  } else result.evidence.recommendationTitle = artifactRegionEvidence(recommendationTitles[0], snapshot);

  const schemeOneRows = regions.filter(region => region.x >= 625 && region.x < 1850 &&
    /^方案一：/.test(artifactText(region.text)));
  const schemeTwoRows = regions.filter(region => region.x >= 625 && region.x < 1850 &&
    /^方案二：/.test(artifactText(region.text)));
  const schemeOne = schemeOneRows.length === 1 ? schemeOneRows[0] : null;
  const schemeTwo = schemeTwoRows.length === 1 ? schemeTwoRows[0] : null;
  if (!schemeOne || recommendationTitles.length !== 1 || schemeOne.y <= recommendationTitles[0].y) {
    issues.push("artifact_scheme_one_missing_or_ambiguous");
  } else result.evidence.schemeOne = artifactRegionEvidence(schemeOne, snapshot);
  if (!schemeTwo || !schemeOne || schemeTwo.y <= schemeOne.y) {
    issues.push("artifact_scheme_two_scope_end_missing_or_ambiguous");
  } else result.evidence.scopeEnd = artifactRegionEvidence(schemeTwo, snapshot);

  let setName = null;
  let unsupportedReason = null;
  if (schemeOne) {
    const schemeText = artifactText(schemeOne.text);
    const fourPiece = schemeText.match(/^方案一：(.+)×4$/);
    if (fourPiece) {
      const setMatches = Object.keys(catalog.sets).filter(name => artifactText(name) === fourPiece[1]);
      if (setMatches.length !== 1 || !catalog.sets[setMatches[0]] ||
          typeof catalog.sets[setMatches[0]].supported !== "boolean") {
        issues.push("artifact_set_unknown_or_ambiguous");
      } else {
        result.recognizedSets = [{ name: setMatches[0], pieces: 4 }];
        if (catalog.sets[setMatches[0]].supported === true) setName = setMatches[0];
        else {
          unsupportedReason = "catalog_set_unsupported";
          issues.push("artifact_set_unsupported");
        }
      }
    } else {
      const pair = schemeText.replace(/^方案一：/, "").split("×2");
      const names = pair.length === 3 && pair[2] === "" ? pair.slice(0, 2).map(text =>
        Object.keys(catalog.sets).filter(name => artifactText(name) === text)) : [];
      if (names.length === 2 && names.every(matches => matches.length === 1 &&
          catalog.sets[matches[0]] && typeof catalog.sets[matches[0]].supported === "boolean")) {
        result.recognizedSets = names.map(matches => ({ name: matches[0], pieces: 2 }));
        unsupportedReason = "two_plus_two_not_supported";
        issues.push("artifact_first_scheme_two_plus_two_unsupported");
      } else issues.push("artifact_first_scheme_not_exact_four_piece");
    }
  }

  let sourceBase = null;
  if (schemeOne && schemeTwo && schemeTwo.y > schemeOne.y) {
    const sourceRows = regions.filter(region => region.x >= 625 && region.x < 1850 &&
      region.y > schemeOne.y && region.y < schemeTwo.y &&
      artifactText(region.text).startsWith("成功挑战「祝圣秘境："));
    if (sourceRows.length !== 1) issues.push("artifact_first_scheme_source_missing_or_ambiguous");
    else {
      result.evidence.source = artifactRegionEvidence(sourceRows[0], snapshot);
      const match = artifactText(sourceRows[0].text).match(/^成功挑战「(祝圣秘境：.+)」获得$/);
      if (!match) issues.push("artifact_first_scheme_source_invalid");
      else sourceBase = match[1];
    }
  }

  if (setName && sourceBase) {
    const setRecord = catalog.sets[setName];
    const domains = Object.entries(catalog.domains).filter(([name, domain]) =>
      domain && domain.supported === true && Array.isArray(setRecord.domains) &&
      setRecord.domains.includes(name) && Array.isArray(domain.sets) && domain.sets.includes(setName) &&
      artifactText(domain.challengeBase) === sourceBase && typeof domain.challenge === "string" && domain.challenge);
    if (domains.length !== 1) {
      unsupportedReason = "source_catalog_mismatch_or_ambiguous";
      issues.push("artifact_source_catalog_mismatch_or_ambiguous");
    }
    else {
      result.set = setName;
      result.domain = domains[0][0];
      result.challengeBase = domains[0][1].challengeBase;
      result.challenge = domains[0][1].challenge;
    }
  }

  if (pageTitles.length === 1 && recommendationTitles.length === 1) {
    const currentStates = regions.filter(region => region.y > pageTitles[0].y &&
      region.y < recommendationTitles[0].y && artifactText(region.text) === "已达可观水准");
    if (currentStates.length === 1) result.currentState = "已达可观水准";
  }
  const scopeProven = characterHeaders.length === 1 && pageTitles.length === 1 &&
    recommendationTitles.length === 1 && schemeOne && schemeTwo && schemeTwo.y > schemeOne.y;
  if (scopeProven && unsupportedReason) {
    result.status = "unsupported";
    result.reason = unsupportedReason;
  } else if (!issues.length) result.status = "supported";
  else result.reason = issues[0];
  result.incomplete = issues.length > 0;
  return result;
}

function parseArtifactPage(page, characterName, catalog) {
  const snapshots = page && Array.isArray(page.snapshots) ? page.snapshots : [];
  const parsed = snapshots.map(snapshot => parseArtifactRecommendation(snapshot, characterName, catalog));
  const issues = [];
  if (!page || page.incomplete !== false) issues.push("artifact_page_completeness_unconfirmed");
  if (!page || page.top_reset_confirmed !== true) issues.push("artifact_page_top_reset_unconfirmed");
  if (snapshots.length < 2) issues.push("artifact_confirmation_snapshots_insufficient");
  const runIds = snapshots.map(snapshot => snapshot && snapshot.run_id);
  const snapshotIds = snapshots.map(snapshot => snapshot && snapshot.snapshot_id);
  if (snapshots.length && (new Set(runIds).size !== 1 || typeof runIds[0] !== "string" || !runIds[0])) {
    issues.push("artifact_confirmation_run_mismatch");
  }
  if (new Set(snapshotIds).size !== snapshotIds.length ||
      snapshotIds.some(id => typeof id !== "string" || !id)) {
    issues.push("artifact_confirmation_snapshot_id_missing_or_duplicate");
  }
  for (const [index, recommendation] of parsed.entries()) {
    for (const issue of recommendation.issues) issues.push("snapshot_" + (index + 1) + ":" + issue);
  }
  const semantic = parsed.map(value => JSON.stringify([
    value.character, value.set, value.domain, value.challengeBase, value.challenge,
    value.policy, value.currentState, value.status, value.reason, value.recognizedSets
  ]));
  const semanticsAgree = parsed.length >= 2 && semantic.every(value => value === semantic[0]);
  const confirmationProven = snapshots.length >= 2 && new Set(runIds).size === 1 &&
    typeof runIds[0] === "string" && !!runIds[0] && new Set(snapshotIds).size === snapshotIds.length &&
    snapshotIds.every(id => typeof id === "string" && !!id);
  if (parsed.length >= 2 && (!semanticsAgree ||
      parsed.some(value => value.incomplete))) issues.push("artifact_confirmation_semantics_mismatch");

  const complete = issues.length === 0;
  const agreed = complete ? parsed[0] : null;
  const unsupported = confirmationProven && semanticsAgree && page && page.top_reset_confirmed === true &&
    parsed[0].status === "unsupported" ? parsed[0] : null;
  return {
    incomplete: !complete,
    issues: issues,
    character: agreed ? agreed.character : null,
    set: agreed ? agreed.set : null,
    recognizedSets: agreed ? agreed.recognizedSets : (unsupported ? unsupported.recognizedSets : []),
    domain: agreed ? agreed.domain : null,
    challengeBase: agreed ? agreed.challengeBase : null,
    challenge: agreed ? agreed.challenge : null,
    status: agreed ? "supported" : (unsupported ? "unsupported" : "incomplete"),
    reason: unsupported ? unsupported.reason : (!complete ? issues[0] || "artifact_recognition_incomplete" : null),
    policy: "first_guide_recommendation",
    currentState: agreed ? agreed.currentState : (unsupported ? unsupported.currentState : null),
    evidence: {
      run_id: agreed || unsupported ? snapshots[0].run_id : null,
      snapshots: parsed.map(value => value.evidence),
      sources: parsed.map(value => value.evidence.source).filter(Boolean)
    }
  };
}

// ---- Migrated from bettergi-growth-planner/src/guide-details.js ----
const DAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function validSnapshot(snapshot) {
  return snapshot && snapshot.ok === true && snapshot.screen &&
    snapshot.screen.width > 0 && snapshot.screen.height > 0 && Array.isArray(snapshot.regions) &&
    snapshot.regions.every(function (region) {
      return region && Number.isFinite(Number(region.x)) && Number.isFinite(Number(region.y)) &&
        Number.isFinite(Number(region.width)) && Number.isFinite(Number(region.height)) &&
        Number(region.width) > 0 && Number(region.height) > 0;
    });
}

function pageRegions(page) {
  if (!page || !Array.isArray(page.snapshots)) throw new Error("Invalid guide page");
  const output = [];
  for (const snapshot of page.snapshots) {
    if (!validSnapshot(snapshot)) throw new Error("Invalid guide page snapshot");
    const sx = 1920 / snapshot.screen.width;
    const sy = 1080 / snapshot.screen.height;
    for (const region of snapshot.regions) {
      output.push({
        text: String(region.text || "").trim().replace(/^lv\.(\d+)$/i, "Lv.$1"),
        x: Number(region.x) * sx,
        y: Number(region.y) * sy,
        width: Number(region.width) * sx,
        height: Number(region.height) * sy,
        snapshot: snapshot.snapshot_id || null
      });
    }
  }
  return output;
}

function oneValue(values) {
  const known = values.filter(function (value) { return value !== null && value !== undefined; });
  return known.length && known.every(function (value) { return value === known[0]; }) ? known[0] : null;
}

function isUpgradeGoalLabel(text) {
  return text === "升级至" || /^需要角色突破到\s*\d+\s*阶$/.test(text);
}

function isGuideMaterialSource(text, tab) {
  return /^(?:精通秘境|炼武秘境)\s*[:：]/.test(text) || /^\d+\s*级以上.*掉落$/.test(text) ||
    (tab === "角色等级" && text === "冒险之证讨伐页签查看");
}

function parseLevelPage(page) {
  const regions = pageRegions(page);
  const homeLevel = Number(page && page.home_level);
  const noUpgradeEvidence = regions.filter(function (region) {
    return region.text === "角色等级方面暂无可提升事项，可查看其他提升事项";
  });
  const current = regions.map(function (region) {
    const match = region.x >= 620 && region.x < 900 && region.y > 300 && region.y < 500 &&
      region.text.match(/^等级\s*(\d+)$/);
    return match ? Number(match[1]) : null;
  });
  const targets = regions.filter(function (region) {
    return /^\d+$/.test(region.text) && region.x > 1500 && region.x < 1800 && region.y > 300 && region.y < 500;
  }).map(function (region) { return Number(region.text); });
  const currentLevel = oneValue(current);
  const targetLevel = oneValue(targets);
  const materialStatuses = regions.filter(region => region.x >= 620 && region.x < 1000 &&
    region.y > 350 && region.y < 450 && /^(可升级|材料不足)$/.test(region.text));
  const materialStatus = oneValue(materialStatuses.map(region => region.text));
  const statusConfirmed = materialStatus !== null && new Set(materialStatuses.filter(region =>
    region.text === materialStatus).map(region => region.snapshot).filter(Boolean)).size >= 2;
  if (noUpgradeEvidence.length > 0) {
    const validHomeLevel = Number.isSafeInteger(homeLevel) && homeLevel >= 1 && homeLevel <= 100;
    const confirmingSnapshots = new Set(noUpgradeEvidence.map(function (region) { return region.snapshot; }).filter(Boolean));
    return {
      incomplete: !!page.incomplete || confirmingSnapshots.size < 2 || !validHomeLevel ||
        current.some(value => value !== null) || targets.length > 0,
      current: validHomeLevel ? homeLevel : null,
      target: null,
      materialStatus: null,
      noUpgradeNeeded: true,
      noUpgradeEvidence: noUpgradeEvidence.map(function (region) { return region.snapshot; })
    };
  }
  const validCurrent = Number.isSafeInteger(currentLevel) && currentLevel >= 1 && currentLevel <= 100;
  const validTarget = Number.isSafeInteger(targetLevel) && targetLevel >= 1 && targetLevel <= 100;
  const confirmingSnapshots = new Set((page.snapshots || []).filter(function (snapshot) {
    const frame = pageRegions({ snapshots: [snapshot] });
    const frameCurrent = oneValue(frame.map(function (region) {
      const match = region.x >= 620 && region.x < 900 && region.y > 300 && region.y < 500 &&
        region.text.match(/^等级\s*(\d+)$/);
      return match ? Number(match[1]) : null;
    }));
    const frameTarget = oneValue(frame.filter(function (region) {
      return /^\d+$/.test(region.text) && region.x > 1500 && region.x < 1800 && region.y > 300 && region.y < 500;
    }).map(function (region) { return Number(region.text); }));
    return frameCurrent === currentLevel && frameTarget === targetLevel;
  }).map(function (snapshot) { return snapshot.snapshot_id; }).filter(Boolean));
  return {
    incomplete: !!page.incomplete || !validCurrent || !validTarget || confirmingSnapshots.size < 2 || !statusConfirmed,
    current: validCurrent ? currentLevel : null,
    target: validTarget ? targetLevel : null,
    materialStatus: materialStatus,
    noUpgradeNeeded: false
  };
}

function materialPageCoverage(page, observations) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  function counters(record) {
    const recognized = record.material_source_rows_recognized;
    const captured = record.material_popups_captured;
    return {
      recognized: count(recognized) ? recognized : null,
      captured: count(captured) ? captured : null,
      complete: count(recognized) && recognized > 0 &&
        count(captured) && captured === recognized
    };
  }
  const totals = counters(page);
  const needsReread = [];
  // A known short read anywhere on the page cannot be hidden by a good earlier frame.
  const badCounts = [totals.recognized, totals.captured, totals.read].includes(0) ||
    [page].concat(page.snapshots || []).some(record => {
    const recognized = record.material_source_rows_recognized;
    return (recognized !== undefined && !count(recognized)) ||
      [record.material_popups_captured].some(value =>
        value !== undefined && (!count(value) || (count(recognized) && value !== recognized)));
    });
  const groups = new Map();
  for (const observation of observations) {
    const key = observation.name || observation;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  for (const cards of groups.values()) {
    if (!cards.some(card => card.materialsInsufficient)) continue;
    const covered = cards.some(card => {
      if (!card.materialsInsufficient || card.materialSources.length === 0) return false;
      const snapshot = page.snapshots[card.snapshotIndex];
      const readings = counters(snapshot);
      return readings.complete && card.materialSources.length <= readings.recognized;
    });
    if (!covered || badCounts || (page.unread_material_popups || []).length) needsReread.push({
      name: cards[0].name, reason: "material_coverage_unconfirmed",
      snapshots: cards.map(card => card.snapshot),
      detail: "Material-insufficient card needs visible sources and matching successful popup/read counts; zero or missing counts do not prove coverage"
    });
  }
  return { complete: needsReread.length === 0, counts: totals, needsReread: needsReread };
}

function materialSourceRegions(regions, top, bottom) {
  return regions.filter(region => region.x >= 780 && region.x < 1500 &&
    region.y > Math.max(top, 330) && region.y < Math.min(bottom, 1020) &&
    (/^(?:精通秘境|炼武秘境)\s*[:：]/.test(region.text) || /^\d+\s*级以上.*掉落$/.test(region.text)));
}

function parseWeaponPage(page) {
  const observations = [];
  for (const [snapshotIndex, snapshot] of (page.snapshots || []).entries()) {
    const regions = pageRegions({ snapshots: [snapshot] });
    const heading = regions.find(function (region) { return region.text === "强化当前武器"; });
    const boundary = regions.find(function (region) { return region.text === "使用率较高的武器参考"; });
    if (!heading) continue;
    const cardBottom = Math.min(boundary ? boundary.y : heading.y + 165, heading.y + 165);
    const between = regions.filter(function (region) {
      return region.y > heading.y && region.y < cardBottom;
    });
    const name = between.filter(function (region) {
      return region.x >= 760 && region.x < 1200 && !/^Lv\./.test(region.text) &&
        !/^(已达|可升级|升级材料|材料不足)/.test(region.text);
    }).sort(function (a, b) { return a.y - b.y; })[0];
    const currentValues = between.map(function (region) {
      const match = region.x >= 620 && region.x < 780 && region.text.match(/^Lv\.(\d+)$/);
      return match ? Number(match[1]) : null;
    }).filter(function (value) { return value !== null; });
    const targetValues = between.map(function (region) {
      return region.x > 1500 && region.x < 1800 && /^\d+$/.test(region.text)
        ? Number(region.text) : null;
    }).filter(function (value) { return value !== null; });
    const level = oneValue(currentValues);
    const numericTarget = oneValue(targetValues);
    const reachedTarget = between.some(function (region) { return region.text === "已达可观水准"; });
    const target = numericTarget !== null ? numericTarget : (reachedTarget ? level : null);
    const conflictingFields = new Set(currentValues).size > 1 || new Set(targetValues).size > 1 ||
      (reachedTarget && numericTarget !== null && (level === null || numericTarget !== level));
    observations.push({
      name: name ? name.text : null,
      current: level,
      target: target,
      conflictingFields: conflictingFields,
      snapshot: snapshot.snapshot_id || null, snapshotIndex: snapshotIndex, y: heading.y,
      materialsInsufficient: between.some(region => /^(升级)?材料不足$/.test(region.text)),
      materialSources: materialSourceRegions(regions, heading.y, boundary ? boundary.y : 1040)
    });
  }
  const materialCoverage = materialPageCoverage(page, observations);
  const conflictingFields = observations.some(function (item) { return item.conflictingFields; });
  const name = oneValue(observations.map(function (item) { return item.name; }));
  const current = oneValue(observations.map(function (item) { return item.current; }));
  const target = oneValue(observations.map(function (item) { return item.target; }));
  const missingFields = [["name", name], ["current", current], ["target", target]]
    .filter(function (entry) { return entry[1] === null; })
    .map(function (entry) { return entry[0]; });
  const needsReread = materialCoverage.needsReread.slice();
  const validLevels = Number.isSafeInteger(current) && current >= 1 && current <= 90 &&
    Number.isSafeInteger(target) && target >= 1 && target <= 90;
  const confirmingSnapshots = new Set(observations.filter(function (item) {
    return !item.conflictingFields && item.name === name && item.current === current && item.target === target &&
      typeof item.snapshot === "string" && item.snapshot;
  }).map(function (item) { return item.snapshot; }));
  if (missingFields.length > 0) needsReread.push({
    name: name,
    reason: "incomplete_weapon_fields",
    fields: missingFields,
    snapshots: observations.map(function (item) { return item.snapshot; })
  });
  if (!validLevels) needsReread.push({
    name: name, reason: "invalid_weapon_level_range",
    snapshots: observations.map(function (item) { return item.snapshot; })
  });
  if (confirmingSnapshots.size < 2) needsReread.push({
    name: name, reason: "weapon_fields_need_two_fresh_snapshots",
    snapshots: Array.from(confirmingSnapshots)
  });
  return {
    incomplete: !!page.incomplete || conflictingFields || !materialCoverage.complete ||
      missingFields.length > 0 || !validLevels || confirmingSnapshots.size < 2,
    name: name,
    current: current,
    target: target,
    observations: observations,
    materialCoverage: materialCoverage,
    needsReread: needsReread
  };
}

function parseTalentPage(page) {
  const observations = [];
  for (const [snapshotIndex, snapshot] of (page.snapshots || []).entries()) {
    const regions = pageRegions({ snapshots: [snapshot] });
    const markers = regions.filter(function (region) {
      return isUpgradeGoalLabel(region.text) && region.x > 1500 && region.y >= 295 && region.y < 1040;
    }).sort((a, b) => a.y - b.y);
    for (const [index, marker] of markers.entries()) {
      const row = regions.filter(function (region) {
        return region.y >= marker.y && region.y < Math.min(marker.y + 105, 1040);
      });
      const names = row.filter(function (region) {
        return region.x >= 760 && region.x < 1200 &&
          !/^(已达到目标|升级材料不足|可升级|升级至|Lv\.)/.test(region.text);
      });
      const name = names.length === 1 ? names[0].text : null;
      const currentValues = row.map(function (region) {
        const match = region.x >= 620 && region.x < 780 && region.text.match(/^Lv\.(\d+)$/);
        return match ? Number(match[1]) : null;
      }).filter(value => value !== null);
      const targetValues = row.map(function (region) {
        return region.x + region.width / 2 >= 1605 && region.x + region.width / 2 <= 1675 &&
          /^\d+$/.test(region.text) ? Number(region.text) : null;
      }).filter(value => value !== null);
      const statusValues = row.filter(region => /^(已达到目标|升级材料不足|可升级)$/.test(region.text))
        .map(region => region.text);
      observations.push({
        name: name, nameCandidates: names.map(region => region.text),
        displayedCurrent: oneValue(currentValues), target: oneValue(targetValues),
        requiredAscensionStage: marker.text === "升级至" ? 0 :
          Number(marker.text.match(/^需要角色突破到\s*(\d+)\s*阶$/)[1]),
        goalStatus: oneValue(statusValues),
        conflictingFields: new Set(currentValues).size > 1 || new Set(targetValues).size > 1,
        fields: row,
        snapshot: snapshot.snapshot_id || null, snapshotIndex: snapshotIndex, y: marker.y,
        materialsInsufficient: row.some(region => region.text === "升级材料不足"),
        materialSources: materialSourceRegions(regions, marker.y + 105,
          markers[index + 1] ? markers[index + 1].y : 1040)
      });
    }
    // Keep unanchored numeric evidence, but never attach it to a guessed/truncated name.
    const orphanFields = regions.filter(region => region.y >= 295 && region.y < 1040 &&
      ((region.x + region.width / 2 >= 1605 && region.x + region.width / 2 <= 1675 && /^\d+$/.test(region.text)) ||
       (region.x >= 620 && region.x < 780 && /^Lv\.\d+$/.test(region.text))) &&
      !markers.some(marker => region.y >= marker.y && region.y < marker.y + 105));
    for (const field of orphanFields) observations.push({
      name: null,
      displayedCurrent: /^Lv\./.test(field.text) ? Number(field.text.slice(3)) : null,
      target: /^\d+$/.test(field.text) ? Number(field.text) : null,
      orphanFields: [field], snapshot: snapshot.snapshot_id || null, snapshotIndex: snapshotIndex,
      y: field.y, materialsInsufficient: false, materialSources: []
    });
  }
  // Scroll edges stay in observations but are not additional talent cards.
  const cards = observations.filter(item => !item.orphanFields && item.y + 105 <= 1040);
  const unresolvedOrphans = observations.filter(function (item) { return item.orphanFields; }).filter(function (orphan) {
    const candidates = cards.filter(function (card) {
      if (card.snapshotIndex === orphan.snapshotIndex || card.name === null ||
          card.displayedCurrent === null || card.target === null || card.conflictingFields) return false;
      if (orphan.displayedCurrent !== null && card.displayedCurrent !== orphan.displayedCurrent) return false;
      if (orphan.target !== null && card.target !== orphan.target) return false;
      const shifts = [];
      for (const left of cards) {
        if (left.snapshotIndex !== orphan.snapshotIndex || left.name === null ||
            left.displayedCurrent === null || left.conflictingFields) continue;
        for (const right of cards) {
          if (right.snapshotIndex === card.snapshotIndex && right.name === left.name &&
            right.displayedCurrent === left.displayedCurrent &&
              (right.target === null || left.target === null || right.target === left.target) &&
              !right.conflictingFields) shifts.push(right.y - left.y);
        }
      }
      // Translate the numeric field using other fully identified cards. A number's
      // own Y is not the card heading Y; comparing those directly rejected genuine
      // top-edge fragments even when adjacent complete cards proved the scroll.
      if (!shifts.length || shifts.some(shift => Math.abs(shift - shifts[0]) > 12)) return false;
      return orphan.orphanFields.every(field => {
        const y = field.y + field.height / 2 + shifts[0];
        return y >= card.y && y < card.y + 105;
      });
    });
    return new Set(candidates.map(card => JSON.stringify([card.name, card.displayedCurrent, card.target]))).size !== 1;
  });
  const observationsByName = new Map();
  for (const item of cards) {
    if (item.name === null) continue;
    if (!observationsByName.has(item.name)) observationsByName.set(item.name, []);
    observationsByName.get(item.name).push(item);
  }
  function samePositionedMaterialSource(left, right) {
    return left.materialSources.some(function (leftSource) {
      return right.materialSources.some(function (rightSource) {
        return leftSource.text === rightSource.text &&
          Math.abs((leftSource.y - left.y) - (rightSource.y - right.y)) <= 12;
      });
    });
  }
  const canonicalNames = new Map();
  for (const [shortName, shortObservations] of observationsByName) {
    const longerNames = Array.from(observationsByName.keys()).filter(function (name) {
      return name !== shortName && name.startsWith(shortName);
    });
    if (longerNames.length !== 1) continue;
    const longName = longerNames[0];
    const longObservations = observationsByName.get(longName);
    const longSnapshots = new Set(longObservations.map(item => item.snapshot).filter(Boolean));
    if (longSnapshots.size < 2) continue;
    if (shortObservations.some(shortItem =>
        longObservations.some(longItem => longItem.snapshot === shortItem.snapshot))) continue;
    const allShortObservationsBridged = shortObservations.every(function (shortItem) {
      return shortItem.displayedCurrent !== null && shortItem.target !== null &&
        longObservations.some(function (longItem) {
          return longItem.displayedCurrent !== null && longItem.target !== null &&
            Math.abs(longItem.snapshotIndex - shortItem.snapshotIndex) === 1 &&
            Math.abs(longItem.y - shortItem.y) <= 180 &&
            longItem.displayedCurrent === shortItem.displayedCurrent &&
            longItem.target === shortItem.target && samePositionedMaterialSource(shortItem, longItem);
        });
    });
    if (allShortObservationsBridged) canonicalNames.set(shortName, longName);
  }
  const grouped = new Map();
  for (const item of cards) {
    const key = item.name === null ? item : (canonicalNames.get(item.name) || item.name);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const materialCoverage = materialPageCoverage(page, cards);
  const needsReread = materialCoverage.needsReread.slice();
  if (unresolvedOrphans.length) needsReread.push({
    name: null, reason: "unresolved_orphan_talent_fields",
    snapshots: unresolvedOrphans.map(function (item) { return item.snapshot; })
  });
  const talents = Array.from(grouped, function (pair) {
    const talent = {
      name: typeof pair[0] === "string" ? pair[0] : null,
      displayedCurrent: oneValue(pair[1].map(function (item) { return item.displayedCurrent; })),
      target: oneValue(pair[1].map(function (item) { return item.target; })),
      requiredAscensionStage: oneValue(pair[1].map(item => item.requiredAscensionStage)),
      goalStatus: oneValue(pair[1].map(function (item) { return item.goalStatus; })),
      observations: pair[1]
    };
    const validLevels = Number.isSafeInteger(talent.displayedCurrent) && talent.displayedCurrent >= 1 &&
      talent.displayedCurrent <= 15 && Number.isSafeInteger(talent.target) &&
      talent.target >= 1 && talent.target <= 15;
    const confirmingSnapshots = new Set(pair[1].filter(function (item) {
      return !item.conflictingFields && item.displayedCurrent === talent.displayedCurrent &&
        item.target === talent.target && typeof item.snapshot === "string" && item.snapshot;
    }).map(function (item) { return item.snapshot; }));
    if (talent.name === null || talent.displayedCurrent === null || talent.target === null ||
        pair[1].some(item => item.conflictingFields)) needsReread.push({
      name: talent.name, reason: "incomplete_or_conflicting_talent",
      snapshots: pair[1].map(item => item.snapshot)
    });
    if (!validLevels) needsReread.push({
      name: talent.name, reason: "invalid_talent_level_range",
      snapshots: pair[1].map(function (item) { return item.snapshot; })
    });
    const statusConfirmed = new Set(pair[1].filter(item => item.goalStatus === talent.goalStatus &&
      item.displayedCurrent === talent.displayedCurrent && item.target === talent.target)
      .map(item => item.snapshot).filter(Boolean)).size >= 2;
    if (!Number.isSafeInteger(talent.requiredAscensionStage) || talent.requiredAscensionStage < 0 ||
        talent.requiredAscensionStage > 6 || new Set(pair[1].filter(item =>
          item.requiredAscensionStage === talent.requiredAscensionStage)
          .map(item => item.snapshot).filter(Boolean)).size < 2) {
      needsReread.push({ name: talent.name, reason: "talent_ascension_prerequisite_unconfirmed",
        snapshots: pair[1].map(item => item.snapshot) });
    }
    if (talent.goalStatus === null || !statusConfirmed || (validLevels &&
        (talent.goalStatus === "已达到目标") !== (talent.target <= talent.displayedCurrent))) {
      needsReread.push({ name: talent.name, reason: "talent_goal_status_missing_or_inconsistent",
        snapshots: pair[1].map(item => item.snapshot) });
    }
    if (confirmingSnapshots.size < 2) needsReread.push({
      name: talent.name, reason: "talent_fields_need_two_fresh_snapshots",
      snapshots: Array.from(confirmingSnapshots)
    });
    return talent;
  });
  const names = talents.map(talent => talent.name).filter(name => name !== null);
  for (const name of names) {
    const possibleNames = names.filter(other => other !== name && (other.startsWith(name) || name.startsWith(other)));
    if (possibleNames.length) needsReread.push({
      name: name, reason: "possible_truncated_name", possibleNames: possibleNames,
      snapshots: grouped.get(name).map(item => item.snapshot)
    });
  }
  return {
    incomplete: !!page.incomplete || needsReread.length > 0,
    talents: talents, observations: observations,
    materialCoverage: materialCoverage, needsReread: needsReread
  };
}

function materialSourceIdentity(source) {
  if (!source) return source;
  const identity = Object.assign({}, source);
  delete identity.raw;
  return identity;
}

function parseMaterialPopup(snapshot, bossCatalog) {
  if (!validSnapshot(snapshot)) throw new Error("Invalid material popup snapshot");
  function inspect(frame) {
    if (!validSnapshot(frame)) throw new Error("Invalid material popup snapshot");
    const sx = frame.screen.width / 1920;
    const sy = frame.screen.height / 1080;
    const regions = frame.regions.map(function (region) {
      return { text: String(region.text || "").trim(), x: Number(region.x), y: Number(region.y) };
    });
    const categories = regions.filter(function (region) {
      return /^(?:角色.*|武器.*)?(?:培养|天赋|突破)素材$/.test(region.text);
    });
    if (categories.length !== 1) throw new Error("Material popup category is missing or ambiguous");
    const category = categories[0];
    // The popup viewport clips its scrolling title at y=78; OCR of that
    // remaining border is not identity evidence. Use the fresh original header.
    const titles = regions.filter(function (region) {
      return region.text.length >= 2 && region.x >= 700 * sx && region.x < 1220 * sx &&
        Math.abs(region.x - category.x) <= 20 * sx &&
        region.y >= 90 * sy && region.y >= category.y - 90 * sy && region.y <= category.y - 15 * sy;
    }).sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    const needs = regions.filter(function (region) {
      return region.x >= 800 * sx && region.x < 1250 * sx && region.y >= 820 * sy && region.y < 1030 * sy &&
        /^培养需求\s*[:：]?\s*\d+\s*\/\s*\d+$/.test(region.text);
    });
    if (needs.length !== 1) throw new Error("Material popup requirement is missing or spatially ambiguous");
    const need = needs[0].text.match(/^培养需求\s*[:：]?\s*(\d+)\s*\/\s*(\d+)$/);
    return { snapshot: frame, sx: sx, sy: sy, regions: regions, category: category,
      titles: titles, needRegion: needs[0], need: need };
  }

  const current = inspect(snapshot);
  let identity = current;
  if (snapshot.popupHeader !== undefined) {
    const header = snapshot.popupHeader;
    if (!header || Object.prototype.hasOwnProperty.call(header, "popupHeader")) {
      throw new Error("Material popup header provenance is nested or missing");
    }
    identity = inspect(header);
    const headerTime = Date.parse(header.captured_at);
    const currentTime = Date.parse(snapshot.captured_at);
    if (typeof header.run_id !== "string" || !header.run_id || header.run_id !== snapshot.run_id ||
        typeof header.snapshot_id !== "string" || !header.snapshot_id ||
        typeof snapshot.snapshot_id !== "string" || !snapshot.snapshot_id ||
        header.snapshot_id === snapshot.snapshot_id || !Number.isFinite(headerTime) ||
        !Number.isFinite(currentTime) || currentTime <= headerTime || currentTime - headerTime > 30000) {
      throw new Error("Material popup header provenance is invalid or stale");
    }
    if (identity.titles.length !== 1 || identity.category.text !== current.category.text) {
      throw new Error("Material popup header identity/category is missing or changed");
    }
    if (identity.need[1] !== current.need[1] || identity.need[2] !== current.need[2]) {
      throw new Error("Material popup requirement changed while scrolling");
    }
    if (current.titles.length > 1 || current.titles.some(value => value.text !== identity.titles[0].text)) {
      throw new Error("Material popup visible title changed while scrolling");
    }
  } else if (current.titles.length !== 1) {
    throw new Error("Material popup title is missing or ambiguous");
  }
  const title = identity.titles[0];
  // OCR can render the decorative book-name quotes as square brackets.
  // Normalize only those delimiters; the Chinese identity remains untouched.
  const bookTitle = title.text.match(/^[「『【\[]([\u3400-\u9fff]{1,12})[」』】\]]的(教导|指引|哲学)$/);
  const materialName = bookTitle ? "「" + bookTitle[1] + "」的" + bookTitle[2] : title.text;
  const category = current.category;
  const bossMaterial = bossCatalog && bossCatalog.materials && bossCatalog.materials[materialName];
  if (bossCatalog && (!bossMaterial || category.text !== "角色培养素材")) {
    throw new Error("Boss material identity/category is not in the confirmed catalog");
  }

  const raw = current.regions.map(function (region) { return region.text; }).join(" ");
  const craftables = current.regions.filter(function (region) {
    return region.x >= 680 * current.sx && region.x < 1150 * current.sx &&
      region.y > category.y && region.y < current.needRegion.y &&
      /^可合成数量\s*[:：]?\s*\d+$/.test(region.text);
  });
  if (craftables.length !== (bossMaterial ? 0 : 1)) {
    throw new Error("Material popup counts are missing or spatially ambiguous");
  }
  const craftable = bossMaterial ? null : craftables[0].text.match(/^可合成数量\s*[:：]?\s*(\d+)$/);
  function findSource(view) {
    const labels = view.regions.filter(function (region) {
      // OCR sometimes includes the adjacent map-pin glyph as a filled circle.
      return /^[●○]?来源$/.test(region.text.replace(/\s+/g, "")) && region.x >= 700 * view.sx && region.x < 1000 * view.sx &&
        region.y > view.category.y && region.y < view.needRegion.y;
    });
    if (labels.length !== 1) return [];
    return view.regions.filter(function (region) {
      return region.x >= 700 * view.sx && region.x < 1300 * view.sx &&
        region.y > labels[0].y && region.y < view.needRegion.y &&
        (bossMaterial ? Array.isArray(bossMaterial.sourceTexts) && bossMaterial.sourceTexts.includes(region.text) :
          /^(精通秘境|炼武秘境)\s*[:：]\s*[^（(]+\s*[（(][^）)]+[）)]$/.test(region.text));
    });
  }
  const sourceRequired = bossMaterial || /角色天赋素材|武器突破素材/.test(category.text);
  const sourceCandidates = findSource(current);
  if (sourceRequired && sourceCandidates.length !== 1) {
    throw new Error("Material popup source is missing or spatially ambiguous");
  }
  if (identity !== current && sourceRequired) {
    const headerSources = findSource(identity);
    if (headerSources.length !== 1 ||
        headerSources[0].text.normalize("NFKC").replace(/\s+/g, "") !==
          sourceCandidates[0].text.normalize("NFKC").replace(/\s+/g, "")) {
      throw new Error("Material popup source changed while scrolling");
    }
  }
  const source = !bossMaterial && sourceCandidates.length === 1
    ? sourceCandidates[0].text.match(/^(精通秘境|炼武秘境)\s*[:：]\s*([^（(]+)\s*[（(]([^）)]+)[）)]$/) : null;
  const counts = [Number(current.need[1]), Number(current.need[2])]
    .concat(bossMaterial ? [] : [Number(craftable[1])]);
  if (counts.some(function (value) { return !Number.isSafeInteger(value) || value < 0 || value > 999999; })) {
    throw new Error("Material popup count is outside the supported range");
  }
  return {
    name: materialName,
    owned: counts[0],
    required: counts[1],
    craftable: bossMaterial ? null : counts[2],
    source: bossMaterial ? { kind: "boss", boss: bossMaterial.boss, raw: sourceCandidates[0].text } : source ? {
      kind: source[1],
      domain: source[2].trim(),
      weekdays: DAY_NAMES.filter(function (day) { return source[3].includes(day); }),
      limitedOpening: source[3].includes("限时开放"),
      raw: source[0]
    } : null,
    raw: raw,
    popupEvidence: (identity === current ? [snapshot] : [identity.snapshot, snapshot]).map(function (frame) {
      return {
        run_id: typeof frame.run_id === "string" ? frame.run_id : null,
        snapshot_id: typeof frame.snapshot_id === "string" ? frame.snapshot_id : null,
        captured_at: typeof frame.captured_at === "string" ? frame.captured_at : null
      };
    })
  };
}

function mergeMaterialPopups(entries, bossCatalog) {
  const grouped = new Map();
  for (const entry of entries || []) {
    const snapshots = entry && entry.snapshot
      ? [entry.snapshot].concat(Array.isArray(entry.confirmations) ? entry.confirmations : []) : [];
    const parsedSnapshots = snapshots.length ? snapshots.map(snapshot => parseMaterialPopup(snapshot, bossCatalog)) : [entry];
    const parsed = parsedSnapshots[0];
    if (!parsed || !parsed.name) continue;
    const characterNames = Array.isArray(entry.characterNames) ? entry.characterNames :
      (entry.characterName ? [entry.characterName] : []);
    const tuples = parsedSnapshots.map(function (item) {
      return JSON.stringify([item.name, item.owned, item.required, item.craftable, materialSourceIdentity(item.source)]);
    });
    const runIds = snapshots.map(snapshot => snapshot && snapshot.run_id);
    const snapshotIds = snapshots.map(snapshot => snapshot && snapshot.snapshot_id);
    const confirmed = snapshots.length >= 2 && new Set(runIds).size === 1 &&
      typeof runIds[0] === "string" && !!runIds[0] && new Set(snapshotIds).size === snapshots.length &&
      snapshotIds.every(id => typeof id === "string" && !!id) &&
      tuples.every(function (value) { return value === tuples[0]; });
    for (const item of parsedSnapshots) {
      const variant = Object.assign({}, item, { characterNames: characterNames, confirmed: confirmed });
      if (!grouped.has(item.name)) grouped.set(item.name, []);
      grouped.get(item.name).push(variant);
    }
  }
  return Array.from(grouped, function (pair) {
    const variants = pair[1];
    function agreed(field) {
      const values = variants.map(function (item) { return item[field]; });
      return values.every(function (value) { return value === values[0]; }) ? values[0] : null;
    }
    const sources = variants.map(function (item) { return JSON.stringify(materialSourceIdentity(item.source)); });
    const popupEvidence = variants.flatMap(function (item) {
      return Array.isArray(item.popupEvidence) ? item.popupEvidence : [];
    });
    const characterNames = Array.from(new Set(variants.flatMap(function (item) {
      return item.characterNames;
    })));
    return {
      name: pair[0],
      characterNames: characterNames,
      owned: agreed("owned"),
      required: agreed("required"),
      craftable: agreed("craftable"),
      source: sources.every(function (value) { return value === sources[0]; }) ? variants[0].source : null,
      ambiguous: (bossCatalog ? ["owned", "required"] : ["owned", "required", "craftable"])
        .some(function (field) { return agreed(field) === null; }) ||
        !sources.every(function (value) { return value === sources[0]; }) ||
        variants.some(function (item) { return item.confirmed !== true; }),
      raw: variants.map(function (item) { return item.raw; }),
      popupEvidence: popupEvidence.filter((frame, index, all) =>
        all.findIndex(other => JSON.stringify(other) === JSON.stringify(frame)) === index)
    };
  });
}

function serverGameDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid date");
  const shifted = new Date(date.getTime() + 4 * 60 * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    weekdayName: DAY_NAMES[shifted.getUTCDay()]
  };
}

function parseCharacterProgress(character) {
  const pages = character && character.pages ? character.pages : {};
  function safely(parser, page, fallback) {
    try {
      return page ? parser(page) : fallback;
    } catch (error) {
      return Object.assign({}, fallback, { error: String(error.message || error) });
    }
  }
  return {
    name: character && character.name ? character.name : null,
    homeLevel: character && Number.isFinite(character.home_level) ? character.home_level : null,
    level: safely(parseLevelPage, pages["角色等级"], { incomplete: true, current: null, target: null }),
    weapon: safely(parseWeaponPage, pages["武器"], {
      incomplete: true, name: null, current: null, target: null, observations: []
    }),
    talents: safely(parseTalentPage, pages["角色天赋"], { incomplete: true, talents: [] }),
    artifact: safely(page => parseArtifactPage(page, character.name, ARTIFACT_CATALOG),
      pages["圣遗物"], { incomplete: true, issues: ["artifact_page_not_read"] })
  };
}

function buildPlanPreview(collection, now, identities) {
  const pageNames = ["角色等级", "武器", "角色天赋"];
  const pagesIncomplete = collection && Array.isArray(collection.characters) &&
    collection.characters.some(function (character) {
      return !character.pages || pageNames.some(function (name) {
        return !character.pages[name] || character.pages[name].incomplete;
      });
    });
  const characterProgress = collection && Array.isArray(collection.characters)
    ? collection.characters.map(parseCharacterProgress) : [];
  const provenanceIssues = [];
  const started = collection && Date.parse(collection.started_at);
  const completed = collection && Date.parse(collection.completed_at);
  const seenSnapshotIds = new Set();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    provenanceIssues.push("Collection time range is missing or invalid");
  }
  const evidenceSnapshots = [];
  if (collection && collection.home_snapshot) evidenceSnapshots.push(collection.home_snapshot);
  for (const character of collection && Array.isArray(collection.characters) ? collection.characters : []) {
    for (const page of Object.values(character.pages || {})) {
      for (const snapshot of page && Array.isArray(page.snapshots) ? page.snapshots : []) {
        const sx = snapshot && snapshot.screen ? snapshot.screen.width / 1920 : NaN;
        const sy = snapshot && snapshot.screen ? snapshot.screen.height / 1080 : NaN;
        const headers = snapshot && Array.isArray(snapshot.regions) ? snapshot.regions.filter(function (region) {
          return region.text === character.name && region.x >= 700 * sx && region.x < 1450 * sx &&
            region.y >= 70 * sy && region.y < 210 * sy;
        }) : [];
        if (headers.length !== 1) provenanceIssues.push(character.name + ": detail snapshot header mismatch");
      }
      Array.prototype.push.apply(evidenceSnapshots, page && Array.isArray(page.snapshots) ? page.snapshots : []);
    }
    for (const material of (character.materials || []).concat(character.bossMaterials || [])) {
      if (material.snapshot) evidenceSnapshots.push(material.snapshot);
      Array.prototype.push.apply(evidenceSnapshots,
        Array.isArray(material.confirmations) ? material.confirmations : []);
    }
  }
  const popupHeaders = new Map();
  for (const snapshot of evidenceSnapshots.slice()) {
    if (!snapshot || !snapshot.popupHeader) continue;
    const header = snapshot.popupHeader;
    const serialized = JSON.stringify(header);
    if (!popupHeaders.has(header.snapshot_id) || popupHeaders.get(header.snapshot_id) !== serialized) {
      evidenceSnapshots.push(header);
      popupHeaders.set(header.snapshot_id, serialized);
    }
  }
  for (const snapshot of evidenceSnapshots) {
    const captured = snapshot && Date.parse(snapshot.captured_at);
    if (!validSnapshot(snapshot) || snapshot.run_id !== collection.run_id ||
        typeof snapshot.snapshot_id !== "string" || !snapshot.snapshot_id ||
        seenSnapshotIds.has(snapshot.snapshot_id) || !Number.isFinite(captured) ||
        (Number.isFinite(started) && captured < started) ||
        (Number.isFinite(completed) && captured > completed)) {
      provenanceIssues.push("Snapshot provenance is missing, duplicated, or outside the collection");
      break;
    }
    seenSnapshotIds.add(snapshot.snapshot_id);
  }
  if (Number.isFinite(started) && Number.isFinite(completed) &&
      serverGameDay(new Date(started)).date !== serverGameDay(new Date(completed)).date) {
    provenanceIssues.push("Collection crossed an Asia server-day boundary");
  }
  const homeCharacters = collection && collection.home && Array.isArray(collection.home.characters)
    ? collection.home.characters : [];
  const collectedCharacters = collection && Array.isArray(collection.characters) ? collection.characters : [];
  if (homeCharacters.length !== collectedCharacters.length || homeCharacters.some(function (home, index) {
      const detail = collectedCharacters[index];
      return !detail || home.name !== detail.name || home.level !== detail.home_level;
    })) {
    provenanceIssues.push("Guide home rows do not match collected character details");
  }
  if (!collection || collection.ok !== true || collection.incomplete || pagesIncomplete || provenanceIssues.length ||
      typeof collection.run_id !== "string" || !collection.run_id || !collection.started_at ||
      !collection.completed_at || !collection.home ||
      collection.home.incomplete || !Array.isArray(collection.characters) ||
      collection.characters.length !== collection.home.count) {
    return {
      actionable: false,
      run_id: collection && collection.run_id ? collection.run_id : null,
      error: "Collection is failed, changed, or incomplete",
      issues: provenanceIssues,
      characterProgress: characterProgress
    };
  }
  const materials = mergeMaterialPopups(collection.characters.flatMap(function (character) {
    return (character.materials || []).map(function (material) {
      return Object.assign({}, material, { characterName: character.name });
    });
  }));
  const day = serverGameDay(now);
  const deficits = materials.map(function (material) {
    const deficit = material.owned === null || material.required === null
      ? null : Math.max(material.required - material.owned, 0);
    return Object.assign({}, material, {
      deficitBeforeCrafting: deficit,
      farmDeficit: deficit > 0 && material.craftable === 0 ? deficit : null,
      openToday: !!(material.source && (material.source.limitedOpening === true ||
        material.source.weekdays.includes(day.weekdayName)))
    });
  });
  const issues = [];
  const identityCatalogValid = identities && identities.schemaVersion === 1 &&
    identities.characters && typeof identities.characters === "object" && !Array.isArray(identities.characters) &&
    identities.weapons && typeof identities.weapons === "object" && !Array.isArray(identities.weapons);
  if (!identityCatalogValid) issues.push("Guide identity catalog is missing or invalid");
  for (const [index, character] of characterProgress.entries()) {
    if (character.name === null) issues.push("Unknown character name");
    for (const [label, detail] of [["level", character.level], ["weapon", character.weapon], ["talents", character.talents]]) {
      if (detail.incomplete) issues.push(character.name + ": " + label + " requires targeted reread");
    }
    if (character.homeLevel === null || character.level.current !== character.homeLevel) {
      issues.push(character.name + ": guide home and current character level disagree or are missing");
    }
    const characterIdentity = identityCatalogValid && character.name !== null
      ? identities.characters[character.name] : null;
    const canonicalTalents = characterIdentity && characterIdentity.talentIdentity === "exact" &&
      Array.isArray(characterIdentity.combatSkills)
      ? characterIdentity.combatSkills.map(function (skill) { return skill && skill.canonicalName; }) : [];
    if (!characterIdentity || characterIdentity.talentIdentity !== "exact" || canonicalTalents.length === 0 ||
        canonicalTalents.some(function (name) {
        return typeof name !== "string" || !name;
      }) || new Set(canonicalTalents).size !== canonicalTalents.length) {
      issues.push(character.name + ": character/talent identity is unknown or ambiguous");
    }
    const requiresMaterials = [character.weapon, character.talents].some(detail =>
      (detail.observations || []).some(card => card.materialsInsufficient));
    const popupEntries = collection.characters[index].materials;
    if (requiresMaterials && (!Array.isArray(popupEntries) || popupEntries.length === 0)) {
      issues.push(character.name + ": material popup evidence missing for material-insufficient cards");
    }
    if (character.weapon.name === null || character.weapon.current === null || character.weapon.target === null) {
      issues.push(character.name + ": unknown current weapon level or target");
    } else if (!identityCatalogValid || !Array.isArray(identities.weapons[character.weapon.name]) ||
        identities.weapons[character.weapon.name].length !== 1) {
      issues.push(character.name + ": weapon identity is unknown or ambiguous");
    }
    if (character.talents.talents.length === 0) {
      issues.push(character.name + ": no talent rows recognized");
    }
    for (const talent of character.talents.talents) {
      if (talent.name === null || talent.displayedCurrent === null || talent.target === null) {
        issues.push(character.name + ": incomplete talent observation");
      } else if (!canonicalTalents.includes(talent.name)) {
        issues.push(character.name + ": talent identity is not an exact canonical match: " + talent.name);
      }
    }
  }
  for (const material of deficits) {
    if (material.ambiguous || material.owned === null || material.required === null || material.craftable === null) {
      issues.push(material.name + ": incomplete material counts");
    }
    if (material.source && material.characterNames.length > 1) {
      issues.push(material.name + ": shared demand across " + material.characterNames.join(", ") +
        " requires aggregate-scope verification");
    }
  }
  return {
    actionable: issues.length === 0,
    run_id: collection.run_id,
    evidence_started_at: collection.started_at,
    captured_at: collection.completed_at,
    characterProgress: characterProgress,
    gameDay: day,
    issues: issues,
    priorities: issues.length ? [] : deficits.filter(function (item) {
      return item.farmDeficit > 0 && item.openToday;
    }).map(function (item) {
      return { type: "domain", material: item.name, domain: item.source.domain, amount: item.farmDeficit };
    }),
    materials: deficits,
    artifactStatus: characterProgress.every(character => !character.artifact.incomplete)
      ? "first_recommendations_read" : "recommendations_require_reread"
  };
}

// ---- Migrated from bettergi-growth-planner/src/guide-coverage.js ----
function readGuideFrameCoverage(capture, tab) {
  const Size = OpenCvSharp.OpenCvSharp.Size;
  const TemplateMatchModes = OpenCvSharp.OpenCvSharp.TemplateMatchModes;
  const width = Number(capture.Width);
  const height = Number(capture.Height);
  const sx = width / 1920;
  const sy = height / 1080;
  if (Math.abs(sx - sy) > 0.01) {
    throw new Error("提升指南结构识别仅支持16:9画面");
  }

  function findTemplate(assetName, reference, threshold, maxMatches, options) {
    const asset = file.ReadImageMatSync("guide-reader/assets/" + assetName);
    let template = null;
    let recognizer = null;
    const matches = [];
    try {
      if (Number(asset.Width) <= 0 || Number(asset.Height) <= 0) {
        throw new Error("无法读取提升指南结构模板：" + assetName);
      }
      template = asset.Resize(new Size(
        Math.max(1, Math.round(Number(asset.Width) * sx)),
        Math.max(1, Math.round(Number(asset.Height) * sy))));
      recognizer = RecognitionObject.TemplateMatch(template,
        reference.x * sx, reference.y * sy,
        reference.width * sx, reference.height * sy);
      if (options && options.mode) recognizer.TemplateMatchMode = options.mode;
      if (options && options.use3Channels) recognizer.Use3Channels = true;
      recognizer.Threshold = threshold;
      recognizer.MaxMatchCount = maxMatches;
      const found = capture.FindMulti(recognizer);
      try {
        for (let i = 0; i < found.Count; i++) {
          matches.push({
            x: Number(found[i].X),
            y: Number(found[i].Y),
            width: Number(found[i].Width),
            height: Number(found[i].Height),
            score: Number(found[i].MatchScore)
          });
        }
      } finally {
        for (let i = 0; i < found.Count; i++) found[i].Dispose();
      }
    } finally {
      if (recognizer && recognizer.TemplateImageGreyMat) {
        recognizer.TemplateImageGreyMat.Dispose();
      }
      if (template) template.Dispose();
      asset.Dispose();
    }
    matches.sort((a, b) => a.y - b.y || b.score - a.score);
    const rows = [];
    for (const match of matches) {
      const previous = rows.length ? rows[rows.length - 1] : null;
      if (previous && Math.abs(match.y - previous.y) < match.height * 0.7) {
        if (match.score > previous.score) rows[rows.length - 1] = match;
      } else {
        rows.push(match);
      }
    }
    return rows;
  }

  const cardRows = findTemplate("guide_talent_card_arrow.png",
    { x: 1735, y: 300, width: 115, height: 735 }, 0.94, 8);
  const sourceRows = findTemplate("guide_material_source_pin.png",
    { x: 1735, y: 300, width: 115, height: 735 }, 0.94, 12);
  const thumbTop = findTemplate("guide_scroll_thumb_top.png",
    { x: 1840, y: 298, width: 38, height: 55 }, 0.96, 1);
  const thumbEnd = findTemplate("guide_scroll_thumb_end.png",
    { x: 1840, y: 300, width: 38, height: 720 }, 0.96, 1);
  // These uniform/fixed-position signals deliberately use SqDiffNormed. A
  // correlation matcher cannot safely distinguish a near-constant strip.
  const noScrollbar = findTemplate("guide_scroll_absent.png",
    { x: 1850, y: 300, width: 15, height: 721 }, 0.99999, 1,
    { mode: TemplateMatchModes.SqDiffNormed, use3Channels: true });
  const levelNoScrollbar = tab === "角色等级" ? findTemplate("guide_level_scroll_absent.png",
    { x: 1850, y: 300, width: 15, height: 721 }, 0.99999, 1,
    { mode: TemplateMatchModes.SqDiffNormed, use3Channels: true }) : [];
  const thumbAtBottom = findTemplate("guide_scroll_thumb_bottom.png",
    { x: 1850, y: 970, width: 15, height: 51 }, 0.99999, 1,
    { mode: TemplateMatchModes.SqDiffNormed, use3Channels: true });
  const hasNoScrollbar = noScrollbar.length === 1 || levelNoScrollbar.length === 1;
  const hasThumbTop = thumbTop.length === 1;
  const hasThumbEnd = thumbEnd.length === 1;
  const hasThumbBottom = thumbAtBottom.length === 1;
  const hasScrollbar = hasThumbTop || hasThumbEnd || hasThumbBottom;
  const conflicting = (hasNoScrollbar && hasScrollbar) ||
    (hasThumbTop && hasThumbBottom);
  return {
    screen: { width, height },
    cardRows,
    sourceRows,
    scrollbar: {
      observed: conflicting ? null : hasScrollbar ? true : hasNoScrollbar ? false : null,
      shortPage: !conflicting && hasNoScrollbar && !hasScrollbar ? true : null,
      thumbTop: hasThumbTop ? thumbTop[0].y : null,
      thumbBottom: hasThumbEnd
        ? thumbEnd[0].y + Math.round(12 * sy) : null,
      bottomAnchor: hasThumbBottom ? thumbAtBottom[0].y : null,
      atTop: !conflicting && hasThumbTop && !hasThumbBottom ? true : null,
      atBottom: !conflicting && hasThumbBottom && !hasThumbTop ? true : null,
      conflicting
    }
  };
}

function validateGuideFrameCoverage(snapshot, tab) {
  if (tab !== "角色等级" && tab !== "角色天赋" && tab !== "武器") {
    return { ok: null, supported: false, tab,
      issues: ["当前页签没有经过独立结构覆盖验证"] };
  }
  const coverage = snapshot && snapshot.visualCoverage;
  const screen = snapshot && snapshot.screen;
  if (!coverage || !screen || !Array.isArray(snapshot.regions)) {
    return { ok: false, supported: true, tab,
      issues: ["缺少画面结构识别结果"] };
  }
  const sx = Number(screen.width) / 1920;
  const sy = Number(screen.height) / 1080;
  const topEdgeY = 350 * sy;
  const bottomEdgeY = 995 * sy;
  const centerY = item => Number(item.y) + Number(item.height) / 2;
  const splitAtEdges = (items, projectedCenter) => ({
    top: items.filter(item => projectedCenter(item) < topEdgeY),
    complete: items.filter(item => projectedCenter(item) >= topEdgeY &&
      projectedCenter(item) < bottomEdgeY),
    bottom: items.filter(item => projectedCenter(item) >= bottomEdgeY)
  });
  const boundaries = tab === "武器" ? snapshot.regions.filter(region =>
    region.text === "使用率较高的武器参考" && region.x >= 625 * sx && region.x < 1500 * sx &&
    region.y >= 295 * sy && region.y + region.height < 1040 * sy) : [];
  const referenceBoundary = boundaries.length === 1 ? boundaries[0] : null;
  const beforeReferenceBoundary = item => !referenceBoundary ||
    centerY(item) < centerY(referenceBoundary);
  const arrows = splitAtEdges(coverage.cardRows || [], centerY);
  const pins = splitAtEdges((coverage.sourceRows || []).filter(beforeReferenceBoundary), centerY);
  const markers = splitAtEdges(snapshot.regions.filter(region =>
    region.x > 1500 * sx && (region.text === "升级至" ||
      /^需要角色突破到\s*\d+\s*阶$/.test(region.text))),
    marker => centerY(marker) + 33 * sy);
  const sources = splitAtEdges(snapshot.regions.filter(region =>
    region.x >= 780 * sx && region.x < 1500 * sx && region.y > 330 * sy &&
    isGuideMaterialSource(region.text, tab))
    .filter(beforeReferenceBoundary),
    source => centerY(source) + 15 * sy);

  function pair(left, right, expectedRightY, tolerance) {
    const unused = right.slice();
    const pairs = [];
    const unmatchedLeft = [];
    for (const item of left) {
      const expected = expectedRightY(item);
      let best = -1;
      let distance = Infinity;
      for (let i = 0; i < unused.length; i++) {
        const candidateDistance = Math.abs(centerY(unused[i]) - expected);
        if (candidateDistance < distance) {
          best = i;
          distance = candidateDistance;
        }
      }
      if (best >= 0 && distance <= tolerance) {
        pairs.push({ left: item, right: unused[best], distance });
        unused.splice(best, 1);
      } else {
        unmatchedLeft.push(item);
      }
    }
    return { pairs, unmatchedLeft, unmatchedRight: unused };
  }

  const cardPairs = tab === "角色天赋" ? pair(markers.complete, arrows.complete,
    marker => centerY(marker) + 33 * sy, 22 * sy) :
    { pairs: [], unmatchedLeft: [], unmatchedRight: [] };
  const sourcePairs = pair(sources.complete, pins.complete,
    source => centerY(source) + 15 * sy, 20 * sy);
  const issues = [];
  if (coverage.scrollbar && coverage.scrollbar.conflicting === true) {
    issues.push("滚动条结构信号互相冲突");
  }
  if (tab === "角色天赋" && !arrows.complete.length) {
    issues.push("当前帧没有识别到完整天赋卡片");
  }
  if (tab === "角色天赋" &&
      (cardPairs.unmatchedLeft.length || cardPairs.unmatchedRight.length)) {
    issues.push("天赋卡片箭头与升级目标文字未能逐行对应");
  }
  if (sourcePairs.unmatchedLeft.length || sourcePairs.unmatchedRight.length) {
    issues.push("材料来源定位图标与来源文字未能逐行对应");
  }
  const hasUnconfirmedEdge = (tab === "角色天赋" &&
    (arrows.bottom.length > 0 || markers.bottom.length > 0)) ||
    pins.bottom.length > 0 || sources.bottom.length > 0;
  const physicalEnd = coverage.scrollbar &&
    (coverage.scrollbar.shortPage === true || coverage.scrollbar.atBottom === true);
  const scopeComplete = tab === "武器" ? !!referenceBoundary : !!physicalEnd;
  return {
    ok: issues.length === 0,
    frameComplete: issues.length === 0 && !hasUnconfirmedEdge && scopeComplete,
    hasUnconfirmedEdge,
    scopeComplete,
    supported: true,
    tab,
    verified: { cardRows: cardPairs.pairs, sourceRows: sourcePairs.pairs },
    unmatched: {
      cardArrows: cardPairs.unmatchedRight,
      upgradeMarkers: cardPairs.unmatchedLeft,
      sourcePins: sourcePairs.unmatchedRight,
      sourceAnchors: sourcePairs.unmatchedLeft
    },
    topEdge: {
      cardArrows: arrows.top,
      upgradeMarkers: markers.top,
      sourcePins: pins.top,
      sourceAnchors: sources.top
    },
    unconfirmedEdge: {
      cardArrows: arrows.bottom,
      upgradeMarkers: markers.bottom,
      sourcePins: pins.bottom,
      sourceAnchors: sources.bottom
    },
    issues
  };
}

// ---- Migrated from bettergi-growth-planner/src/collect-guide.js ----
function requireCompleteHome(snapshot, parser) {
  const home = parser(snapshot);
  if (!home.ok) throw new Error(home.error);
  if (home.count > home.capacity) throw new Error("Plan count exceeds capacity");
  if (home.incomplete || home.characters.length !== home.count) {
    throw new Error("Enabled-character list is not fully visible");
  }
  return home;
}

function toReferencePoint(point, screen) {
  if (!screen || !(screen.width > 0) || !(screen.height > 0)) {
    throw new Error("Invalid screen geometry");
  }
  return {
    x: point.x * 1920 / screen.width,
    y: point.y * 1080 / screen.height
  };
}

function sameHome(left, right) {
  if (left.count !== right.count || left.capacity !== right.capacity ||
      left.characters.length !== right.characters.length) return false;
  for (let i = 0; i < left.characters.length; i++) {
    if (left.characters[i].name !== right.characters[i].name ||
        left.characters[i].guideStatus !== right.characters[i].guideStatus ||
        left.characters[i].level !== right.characters[i].level) return false;
  }
  return true;
}

function canonicalLevelText(value) {
  const match = String(value || "").match(/^lv\.(\d+)$/i);
  return match ? "Lv." + match[1] : null;
}

function normalizeGuideAnchorText(value) {
  const level = canonicalLevelText(value);
  return level || String(value || "").normalize("NFKC").replace(/\s+/g, "");
}

function sameViewport(left, right) {
  if (!left || !right) return false;
  function anchors(snapshot) {
    return snapshot.regions.map(region => ({
      text: region.text,
      x: region.x * 1920 / snapshot.screen.width,
      y: region.y * 1080 / snapshot.screen.height,
      width: region.width * 1920 / snapshot.screen.width,
      height: region.height * 1080 / snapshot.screen.height
    })).filter(region => region.x >= 625 && region.x < 1870 &&
      region.y >= 310 && region.y < 1040 &&
      (isUpgradeGoalLabel(region.text) ||
       /^(当前武器|使用率较高的武器参考|强化当前圣遗物|推荐圣遗物搭配方案|方案[一二]：|等级\s*\d+|角色等级方面暂无可提升事项)/.test(region.text) ||
       isGuideMaterialSource(region.text, "角色等级")))
      .map(region => ({ text: normalizeGuideAnchorText(region.text),
        x: region.x + region.width / 2, y: region.y + region.height / 2 }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }
  const before = anchors(left);
  const after = anchors(right);
  // Text-box edges and animated quantities jitter even when scrolling has stopped.
  return before.length > 0 && before.length === after.length && before.every((row, i) =>
    row.text === after[i].text && Math.abs(row.x - after[i].x) <= 8 &&
    Math.abs(row.y - after[i].y) <= 8);
}

async function collectGuideSnapshot(recordFrames = false) {
    const Rect = OpenCvSharp.OpenCvSharp.Rect;
    const page = new BvPage();
    const startedAt = new Date().toISOString();
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" +
      Math.floor(Math.random() * 1000000);
    let snapshotSequence = 0;
    const tabLabelRois1080 = {
      "角色等级": { x: 700, y: 235, width: 220, height: 65 },
      "武器": { x: 1000, y: 235, width: 200, height: 65 },
      "圣遗物": { x: 1300, y: 235, width: 200, height: 65 },
      "角色天赋": { x: 1570, y: 235, width: 240, height: 65 }
    };
    const tabs = ["角色等级", "武器", "角色天赋", "圣遗物"];
    const knownPopupNames = new Set(JSON.parse(file.ReadTextSync("guide-reader/data/material-domains.json"))
      .families.flatMap(family => family.items.map(item => item.name)).concat(Object.keys(BOSS_CATALOG.materials)));
    const artifactSetNames = Object.keys(ARTIFACT_CATALOG.sets);

    function canonicalArtifactScheme(value) {
      const normalized = String(value || "").normalize("NFKC").replace(/\s+/g, "")
        .replace(/:/g, "：").replace(/[xX]/g, "×");
      if (!normalized.startsWith("方案一：")) return null;
      const body = normalized.slice("方案一：".length);
      const matches = [];
      for (const name of artifactSetNames) {
        if (body === name + "×4") {
          matches.push({ identity: "4:" + name, text: "方案一：" + name + "×4" });
        }
      }
      for (const left of artifactSetNames) {
        for (const right of artifactSetNames) {
          if (body !== left + "×2" + right + "×2") continue;
          matches.push({
            identity: "2+2:" + [left, right].sort().join("+"),
            text: "方案一：" + left + "×2 " + right + "×2"
          });
        }
      }
      const unique = [];
      for (const match of matches) {
        if (!unique.some(item => item.identity === match.identity)) unique.push(match);
      }
      return unique.length === 1 ? unique[0] : null;
    }

    function scaleRect(rect, screen) {
      return new Rect(
        Math.round(rect.x * screen.width / 1920),
        Math.round(rect.y * screen.height / 1080),
        Math.round(rect.width * screen.width / 1920),
        Math.round(rect.height * screen.height / 1080)
      );
    }

    function writeJson(path, value) {
      if (!file.WriteTextSync(path, JSON.stringify(value, null, 2))) {
        throw new Error("Failed to write " + path);
      }
    }

    function safeName(value) {
      return String(value).replace(/[\\/:*?"<>|]/g, "_");
    }

    function captureOcr(withDetailCrops = false, tab = null) {
      const capture = captureGameRegion();
      const output = [];
      try {
        const found = capture.FindMulti(RecognitionObject.OcrThis);
        for (let i = 0; i < found.Count; i++) {
          const region = found[i];
          output.push({
            text: String(region.Text).trim(),
            x: Number(region.X),
            y: Number(region.Y),
            width: Number(region.Width),
            height: Number(region.Height)
          });
          region.Dispose();
        }
        // Confirm small/coloured text at two scales; never infer a missing digit/name.
        function readCrop(reference, pattern, factors = [2, 3], threshold = false) {
          const rect = scaleRect(reference,
            { width: capture.Width, height: capture.Height });
          const crop = capture.DeriveCrop(rect);
          const values = [];
          const readings = [];
          try {
            for (const factor of factors) {
              const resized = crop.SrcMat.Resize(new OpenCvSharp.OpenCvSharp.Size(rect.Width * factor, rect.Height * factor));
              let grey = null;
              let prepared = null;
              if (threshold) {
                grey = resized.CvtColor(OpenCvSharp.OpenCvSharp.ColorConversionCodes.BGR2GRAY);
                prepared = grey.Threshold(180, 255, OpenCvSharp.OpenCvSharp.ThresholdTypes.BinaryInv);
              }
              const enlarged = new ImageRegion(prepared || resized, 0, 0);
              try {
                const digits = enlarged.FindMulti(RecognitionObject.OcrThis);
                const texts = [];
                for (let i = 0; i < digits.Count; i++) {
                  texts.push(String(digits[i].Text).trim());
                  digits[i].Dispose();
                }
                readings.push(texts);
                values.push(texts.length === 1 && pattern.test(texts[0]) ? texts[0] : null);
              } finally {
                enlarged.Dispose();
                if (grey) grey.Dispose();
                if (threshold) resized.Dispose();
              }
            }
            const recognized = values.filter(value => value !== null);
            if (threshold || recognized.length < 2 || !recognized.every(value => value === recognized[0])) {
              const path = "raw/crop-" + runId + "-" + (snapshotSequence + 1) + "-" + rect.X + "-" + rect.Y;
              writeJson(path + ".json", { reference: reference, factors: factors, threshold: threshold ? 180 : null, readings: readings });
              if (!file.WriteImageSync(path + ".png", crop.SrcMat)) log.Warn("无法保存局部识别取证：{0}", path);
            }
          } finally { crop.Dispose(); }
          const recognized = values.filter(value => value !== null);
          return recognized.length >= 2 && recognized.every(value => value === recognized[0]) ? {
            text: recognized[0], x: rect.X, y: rect.Y, width: rect.Width, height: rect.Height,
            source: threshold ? "crop-contrast-two-scales" : "crop-two-scales"
          } : null;
        }
        const sx = capture.Width / 1920;
        const sy = capture.Height / 1080;
        const homeHeader = output.find(r => /^培养计划角色列表[（(]\d+\/\d+[）)]$/.test(r.text));
        if (homeHeader) {
          const partyHeader = output.find(r => /^队伍内角色实力/.test(r.text));
          const upgradeButtons = output.filter(r => r.text === "提升" && r.x > 1550 * sx &&
            r.y > homeHeader.y && (!partyHeader || r.y < partyHeader.y));
          for (const button of upgradeButtons) {
            if (output.some(r => /^(培养中|已完成)$/.test(r.text) &&
                Math.abs(r.y - (button.y - 40 * sy)) < 20 * sy)) continue;
            const badge = readCrop({ x: 1577, y: button.y / sy - 50, width: 80, height: 45 }, /^(培养中|已完成)$/);
            if (badge) output.push(badge);
          }
          const badges = output.filter(r => /^(培养中|已完成)$/.test(r.text) && r.y > homeHeader.y &&
            (!partyHeader || r.y < partyHeader.y));
          for (const badge of badges) {
            if (output.some(r => canonicalLevelText(r.text) !== null && r.x >= 620 * sx && r.x < 850 * sx &&
                r.y > badge.y + 55 * sy && r.y < badge.y + 135 * sy)) continue;
            const level = readCrop({ x: 670, y: badge.y / sy + 75, width: 110, height: 60 }, /^lv\.\d+$/i);
            if (level) {
              level.text = canonicalLevelText(level.text);
              output.push(level);
            }
          }
        }
        const materialPopup = output.some(r => /素材$/.test(r.text) || /培养需求|可合成数量/.test(r.text));
        const popupCategories = output.filter(r => /^(?:角色.*|武器.*)?(?:培养|天赋|突破)素材$/.test(r.text));
        if (popupCategories.length === 1 && popupCategories[0].y >= 150 * sy) {
          const category = popupCategories[0];
          let title = readCrop({ x: 730, y: category.y / sy - 70, width: 465, height: 65 },
            /^[\u3400-\u9fff·「」]{2,35}$/);
          if (!title || !knownPopupNames.has(title.text)) {
            // White text on the orange title bar can lose its first glyph in
            // normal OCR. The contrast attempt is still accepted only as an
            // exact catalog identity. readCrop persists every threshold attempt.
            const contrastTitle = readCrop({ x: 740, y: category.y / sy - 65,
              width: 450, height: 50 }, /^[\u3400-\u9fff·「」]{2,35}$/, [2, 3], true);
            if (contrastTitle && knownPopupNames.has(contrastTitle.text)) title = contrastTitle;
          }
          if (title && knownPopupNames.has(title.text)) {
            const originals = output.filter(r => r.x >= 700 * sx && r.x < 1220 * sx &&
              Math.abs(r.x - category.x) <= 20 * sx && r.y >= category.y - 90 * sy && r.y <= category.y - 15 * sy);
            // A crop can restore a clipped, noncanonical prefix. Two different
            // canonical identities remain conflicting observations.
            if (!originals.some(r => knownPopupNames.has(r.text) && r.text !== title.text)) {
              for (let i = output.length - 1; i >= 0; i--) if (originals.includes(output[i])) output.splice(i, 1);
            }
            title.fullFrameTexts = originals.map(r => r.text);
            output.push(title);
          }
        }
        if (tab === "圣遗物" && !materialPopup) {
          const headings = output.filter(r => r.text === "推荐圣遗物搭配方案" &&
            r.x >= 625 * sx && r.y > 300 * sy && r.y < 900 * sy);
          if (headings.length === 1) {
            const heading = headings[0];
            const scheme = readCrop({ x: 650, y: heading.y / sy + 28, width: 900, height: 60 },
              /^方案一\s*[:：]\s*.+[xX×]\s*[24]\s*$/);
            const canonical = scheme && canonicalArtifactScheme(scheme.text);
            if (canonical) {
              const originals = output.filter(r => r.x >= 625 * sx && r.x < 1600 * sx &&
                r.y >= scheme.y && r.y < scheme.y + scheme.height &&
                /^方案一\s*[:：]/.test(String(r.text).normalize("NFKC")));
              const conflicting = originals.some(r => {
                const original = canonicalArtifactScheme(r.text);
                return original && original.identity !== canonical.identity;
              });
              // An exact crop may replace a noncanonical full-frame typo. Keep
              // every original string as provenance, and retain canonical
              // disagreement as separate evidence so parsing fails closed.
              scheme.text = canonical.text;
              scheme.fullFrameTexts = originals.map(r => r.text);
              if (!conflicting) {
                for (let i = output.length - 1; i >= 0; i--) {
                  if (originals.includes(output[i])) output.splice(i, 1);
                }
              }
              output.push(scheme);
            }
          }
        }
        // Completed weapons have no upgrade-goal label; anchor their level to the current-weapon heading.
        const weaponHeading = withDetailCrops && !materialPopup && output.find(r =>
          r.text === "强化当前武器" && r.x >= 625 * sx && r.y > 290 * sy && r.y < 800 * sy);
        if (weaponHeading && !output.some(r => canonicalLevelText(r.text) !== null &&
            r.x >= 620 * sx && r.x < 780 * sx &&
            r.y > weaponHeading.y && r.y < weaponHeading.y + 165 * sy)) {
          const current = readCrop({ x: 680, y: weaponHeading.y / sy + 110,
            width: 80, height: 35 }, /^lv\.\d+$/i, [1, 2, 3]);
          if (current) {
            current.text = canonicalLevelText(current.text);
            output.push(current);
          }
        }
        const markers = !withDetailCrops || materialPopup ? [] : output.filter(r => isUpgradeGoalLabel(r.text) && r.y > 290 * sy && r.y < 935 * sy);
        for (const marker of markers) {
          const top = marker.y / sy;
          // The full-frame detector merges cyan "11" into "1". Always read the
          // isolated number, excluding the neighbouring +/- controls. A failed
          // contrast read stays unknown; a plausible full-frame digit is no fallback.
          for (let i = output.length - 1; i >= 0; i--) {
            const r = output[i];
            if (/^\d+$/.test(r.text) && r.x > 1500 * sx &&
                r.y >= marker.y && r.y < marker.y + 100 * sy) output.splice(i, 1);
          }
          const target = readCrop({ x: 1605, y: top + 20, width: 70, height: 65 }, /^\d{1,3}$/, [2, 3], true);
          if (target) output.push(target);
          if (tab === "角色等级") continue;
          if (!output.some(r => canonicalLevelText(r.text) !== null && r.x >= 620 * sx && r.x < 780 * sx &&
              r.y >= marker.y && r.y < marker.y + 105 * sy)) {
            // Large scaling can hide this tiny white-on-dark level strip from the detector.
            const current = readCrop({ x: 680, y: top + 65, width: 80, height: 35 }, /^lv\.\d+$/i, [1, 2, 3]);
            if (current) {
              current.text = canonicalLevelText(current.text);
              output.push(current);
            }
          }
          const name = readCrop({ x: 772, y: top + 10, width: 430, height: 45 }, /^[\u3400-\u9fff·「」]{2,30}$/);
          if (name) {
            const originalNames = output.filter(r => r.x >= 772 * sx && r.x < 1202 * sx &&
              r.y >= (top + 10) * sy && r.y < (top + 55) * sy && /^[\u3400-\u9fff·「」]{2,30}$/.test(r.text) &&
              !/^(已达|升级材料|材料不足|可升级|升级至)/.test(r.text));
            // Preserve disagreeing evidence. Cropping must not silently replace
            // a full-frame name with a different valid-looking string.
            if (originalNames.some(r => r.text !== name.text)) continue;
            name.fullFrameTexts = originalNames.map(r => r.text);
            for (let i = output.length - 1; i >= 0; i--) {
              if (originalNames.includes(output[i])) output.splice(i, 1);
            }
            output.push(name);
          }
        }
        const snapshotId = runId + "-" + (++snapshotSequence);
        // Full-frame archives are for read-only diagnosis. Daily spending keeps
        // OCR/structure and targeted crops without accumulating hundreds of PNGs.
        const imagePath = recordFrames ? "raw/frame-" + snapshotId + ".png" : null;
        if (imagePath && !file.WriteImageSync(imagePath, capture.SrcMat)) throw new Error("无法保存读取证据截图");
        return {
          ok: true,
          run_id: runId,
          snapshot_id: snapshotId,
          imagePath: imagePath,
          captured_at: new Date().toISOString(),
          screen: { width: Number(capture.Width), height: Number(capture.Height) },
          visualCoverage: withDetailCrops && !materialPopup ? readGuideFrameCoverage(capture, tab) : null,
          regions: output
        };
      } finally {
        capture.Dispose();
      }
    }

    async function openGuideHome() {
      let snapshot = captureOcr();
      if (parseGuideHome(snapshot).ok) return snapshot;
      await genshin.ReturnMainUi();
      keyPress("VK_ESCAPE");
      await sleep(1000);
      const guide = page.GetByText("提升指南", new Rect(80, 310, 690, 680)).FindAll();
      try {
        if (guide.Count !== 1 || String(guide[0].Text).trim() !== "提升指南") {
          throw new Error("派蒙菜单中没有唯一的提升指南入口");
        }
        guide[0].Click();
      } finally { for (let i = 0; i < guide.Count; i++) guide[i].Dispose(); }
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(700);
        snapshot = captureOcr();
        if (parseGuideHome(snapshot).ok) break;
      }
      writeJson("raw/guide-entry.json", snapshot);
      requireCompleteHome(snapshot, parseGuideHome);
      return snapshot;
    }

    function requireCharacterHeader(snapshot, name) {
      const sx = snapshot.screen.width / 1920;
      const sy = snapshot.screen.height / 1080;
      const matches = snapshot.regions.filter(function (region) {
        return region.text === name &&
          region.x >= 700 * sx && region.x < 1450 * sx &&
          region.y >= 70 * sy && region.y < 210 * sy;
      });
      if (matches.length !== 1) {
        throw new Error("Detail header does not match selected character: " + name);
      }
    }

    function clickExactTab(label, screen) {
      const referenceRoi = tabLabelRois1080[label];
      if (!referenceRoi) throw new Error("Unknown guide tab label: " + label);
      const roi = scaleRect(referenceRoi, screen);
      const found = page.GetByText(label, roi).FindAll();
      const exact = [];
      try {
        for (let i = 0; i < found.Count; i++) {
          const observed = String(found[i].Text).trim().normalize("NFKC");
          const match = observed.match(/^[^\u3400-\u9fff]*([\u3400-\u9fff]+)$/);
          if (match && match[1] === label) exact.push(found[i]);
        }
        if (exact.length !== 1) {
          const candidates = [];
          for (let i = 0; i < found.Count; i++) {
            candidates.push({
              text: String(found[i].Text), x: Number(found[i].X), y: Number(found[i].Y),
              width: Number(found[i].Width), height: Number(found[i].Height)
            });
          }
          writeJson("raw/tab-click-failure-" + runId + "-" + safeName(label) + ".json", {
            label: label,
            screen: screen,
            reference_roi: referenceRoi,
            scaled_roi: { x: Number(roi.X), y: Number(roi.Y), width: Number(roi.Width), height: Number(roi.Height) },
            candidates: candidates
          });
          throw new Error("Expected one exact tab label: " + label);
        }
        exact[0].Click();
      } finally {
        for (let i = 0; i < found.Count; i++) found[i].Dispose();
      }
    }

    async function collectMaterialPopups(snapshot, byName, characterName, tab) {
      const sx = snapshot.screen.width / 1920;
      const sy = snapshot.screen.height / 1080;
      const sources = snapshot.regions.filter(function (region) {
        return isGuideMaterialSource(region.text, tab) && region.text !== "冒险之证讨伐页签查看" &&
          region.x >= 780 * sx && region.x < 1500 * sx &&
          region.y > 330 * sy && region.y + region.height / 2 + 15 * sy < 995 * sy;
      });
      const failed = [];
      let captured = 0;
      for (let i = 0; i < sources.length; i++) {
        const target = toReferencePoint({ x: 748 * sx, y: sources[i].y + sources[i].height / 2 + 15 * sy }, snapshot.screen);
        let popupSnapshot = null;
        let confirmationSnapshot = null;
        let popupOpened = false;
        try {
          writeJson("raw/material-attempt.json", { source: sources[i], target: target, before: snapshot });
          page.Click(target.x, target.y);
          for (let attempt = 0; attempt < 3; attempt++) {
            await sleep(500);
            popupSnapshot = captureOcr();
            popupOpened = popupSnapshot.regions.some(r => /^(?:角色.*|武器.*)?(?:培养|天赋|突破)素材$/.test(r.text));
            if (popupOpened) break;
          }
          writeJson("raw/material-attempt.json", { source: sources[i], target: target, before: snapshot, after: popupSnapshot });
          if (!popupOpened) throw new Error("点击后未出现材料弹窗，停止导航：" + sources[i].text);
          const popupCatalog = tab === "角色等级" ? BOSS_CATALOG : undefined;
          let material;
          let popupHeader = null;
          try { material = parseMaterialPopup(popupSnapshot, popupCatalog); }
          catch (initialError) {
            // Long descriptions can push crafting/source rows below the popup's
            // viewport. Keep the initial identity and fixed requirement footer;
            // the parser verifies continuity before using any scrolled evidence.
            popupHeader = popupSnapshot;
            moveMouseTo(Math.round(1120 * sx), Math.round(820 * sy));
            for (let scroll = 0; scroll < 8 && !material; scroll++) {
              verticalScroll(-1);
              await sleep(450);
              popupSnapshot = captureOcr();
              popupSnapshot.popupHeader = popupHeader;
              try { material = parseMaterialPopup(popupSnapshot, popupCatalog); }
              catch (error) { if (scroll === 7) throw error; }
            }
          }
          if (material.source && !knownPopupNames.has(material.name)) {
            throw new Error("材料名称未与目录精确匹配：" + material.name);
          }
          await sleep(350);
          confirmationSnapshot = captureOcr();
          if (popupHeader) confirmationSnapshot.popupHeader = popupHeader;
          const confirmed = parseMaterialPopup(confirmationSnapshot, popupCatalog);
          const fields = ["name", "owned", "required", "craftable", "source"];
          if (fields.some(field => JSON.stringify(field === "source" ? materialSourceIdentity(material[field]) : material[field]) !==
              JSON.stringify(field === "source" ? materialSourceIdentity(confirmed[field]) : confirmed[field]))) {
            throw new Error("材料弹窗两次读取不一致：" + material.name);
          }
          const existing = byName[material.name];
          if (existing && ["owned", "required", "craftable", "source"].some(field =>
              JSON.stringify(field === "source" ? materialSourceIdentity(existing.parsed[field]) : existing.parsed[field]) !==
              JSON.stringify(field === "source" ? materialSourceIdentity(material[field]) : material[field]))) {
            throw new Error("Conflicting aggregate requirement for material: " + material.name);
          }
          if (!existing) byName[material.name] = { parsed: material, snapshot: popupSnapshot, confirmations: [confirmationSnapshot] };
          captured++;
        } catch (error) {
          if (!popupOpened) throw error;
          failed.push({
            source_text: sources[i].text,
            error: String(error && error.message ? error.message : error),
            snapshot: popupSnapshot,
            confirmation_snapshot: confirmationSnapshot
          });
        } finally {
          if (popupOpened) {
            keyPress("VK_ESCAPE");
            let returned = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              await sleep(500);
              returned = captureOcr();
              if (!returned.regions.some(r => /^(?:角色.*|武器.*)?(?:培养|天赋|突破)素材$/.test(r.text))) break;
            }
            writeJson("raw/material-return.json", returned);
            if (returned.regions.some(r => /^(?:角色.*|武器.*)?(?:培养|天赋|突破)素材$/.test(r.text))) {
              throw new Error("材料弹窗未关闭，停止导航");
            }
            requireCharacterHeader(returned, characterName);
            const next = sources[i + 1];
            const returnedNext = next ? returned.regions.filter(r =>
              isGuideMaterialSource(r.text, tab) &&
              normalizeGuideAnchorText(r.text) === normalizeGuideAnchorText(next.text) &&
              Math.abs(r.x + r.width / 2 - next.x - next.width / 2) < 12 * sx &&
              Math.abs(r.y + r.height / 2 - next.y - next.height / 2) < 12 * sy) : [];
            if (next && returnedNext.length !== 1) {
              writeJson("raw/material-return-mismatch.json", {
                expected: next, before: snapshot, returned: returned,
                matching_candidates: returnedNext
              });
              throw new Error("关闭材料弹窗后列表位置变化，需要重新读取");
            }
          }
        }
      }
      snapshot.material_source_rows_recognized = sources.length;
      snapshot.material_popups_captured = captured;
      return { recognized: sources.length, captured: captured, failed: failed };
    }

    async function wheelRightPane(screen, direction, count) {
      moveMouseTo(
        Math.round(1840 * screen.width / 1920),
        Math.round(900 * screen.height / 1080)
      );
      for (let wheel = 0; wheel < count; wheel++) {
        verticalScroll(direction);
        await sleep(20);
      }
      await sleep(500);
    }

    function hasPageTop(snapshot, tab) {
      if (tab === "角色等级") return pageRegions({ snapshots: [snapshot] }).some(region =>
        region.x >= 625 && region.x < 1500 &&
        ((region.y >= 300 && region.y < 450 && /^等级\s*\d+(?:\s*\/\s*\d+)?$/.test(region.text)) ||
          (region.y >= 300 && region.y < 950 &&
            region.text === "角色等级方面暂无可提升事项，可查看其他提升事项")));
      const title = tab === "武器" ? "强化当前武器" :
        tab === "圣遗物" ? "强化当前圣遗物" : "推荐提升天赋等级";
      return pageRegions({ snapshots: [snapshot] }).some(region => region.text === title &&
        region.x >= 625 && region.x < 1250 && region.y >= 300 && region.y < 350);
    }

    async function resetRightPaneToTop(characterName, screen, tab) {
      let previous = captureOcr();
      requireCharacterHeader(previous, characterName);
      for (let verification = 0; verification < 12; verification++) {
        await wheelRightPane(screen, 1, 12);
        const current = captureOcr();
        requireCharacterHeader(current, characterName);
        if (sameViewport(current, previous) && hasPageTop(current, tab)) return true;
        previous = current;
      }
      return false;
    }

    async function collectArtifactPage(characterName, screen) {
      const top = await resetRightPaneToTop(characterName, screen, "圣遗物");
      const snapshots = [];
      for (let i = 0; i < 2; i++) {
        const snapshot = captureOcr(false, "圣遗物");
        requireCharacterHeader(snapshot, characterName);
        snapshots.push(snapshot);
        await sleep(350);
      }
      snapshots[1].confirmation_of = snapshots[0].snapshot_id;
      const stable = sameViewport(snapshots[0], snapshots[1]);
      const result = { snapshots, top_reset_confirmed: top, incomplete: false,
        viewport_stable: stable, scope: "first_recommendation" };
      const parsed = parseArtifactPage(result, characterName, ARTIFACT_CATALOG);
      result.incomplete = parsed.incomplete || !stable;
      result.issues = parsed.issues.concat(stable ? [] : ["artifact_viewport_moving"]);
      // An unsupported recommendation blocks recurring artifact farming, while
      // independently proven finite material requirements remain usable.
      return result;
    }

    async function collectScrollablePage(characterName, screen, tab, materialsByName, homeLevel) {
      const snapshots = [];
      const topResetConfirmed = await resetRightPaneToTop(characterName, screen, tab);
      if (!topResetConfirmed) throw new Error(characterName + "：无法确认" + tab + "页面顶部");
      let previous = null;
      let complete = false;
      let materialRows = 0;
      let materialPopups = 0;
      const unreadMaterialPopups = [];
      const coverageIssues = [];
      const identity = GUIDE_IDENTITIES.characters[characterName];
      const talentNames = identity && Array.isArray(identity.combatSkills)
        ? identity.combatSkills.map(skill => skill.canonicalName) : [];
      function scrollShift(left, right) {
        function anchors(snapshot) {
          const regions = pageRegions({ snapshots: [snapshot] });
          const verified = snapshot.coverage && snapshot.coverage.ok && snapshot.coverage.verified;
          if (!verified) return [];
          const sy = 1080 / snapshot.screen.height;
          // Edge labels can survive while their card/name is clipped. Only
          // physically paired, complete rows may establish scroll distance.
          const goalRows = verified.cardRows.map(pair => ({ y: pair.left.y * sy }));
          return regions.map(region => {
            let identity = null;
            if (talentNames.includes(region.text) && goalRows.some(marker =>
                region.y >= marker.y && region.y < marker.y + 105)) {
              identity = "talent:" + region.text;
            }
            else if (GUIDE_IDENTITIES.weapons[region.text]) identity = "weapon:" + region.text;
            else if (isGuideMaterialSource(region.text, tab) && verified.sourceRows.some(pair =>
                normalizeGuideAnchorText(pair.left.text) === normalizeGuideAnchorText(region.text) &&
                Math.abs((pair.left.y + pair.left.height / 2) * sy - region.y - region.height / 2) < 1)) {
              identity = "source:" + normalizeGuideAnchorText(region.text);
            }
            return { region: region, identity: identity };
          }).filter(item => item.identity !== null && item.region.x >= 625 && item.region.x < 1500 &&
            item.region.y >= 295 && item.region.y < 1040);
        }
        const before = anchors(left), after = anchors(right), shifts = [];
        for (const anchor of before) {
          const matches = after.filter(item => item.identity === anchor.identity);
          if (matches.length === 1 && before.filter(item => item.identity === anchor.identity).length === 1) {
            // Crop-backed names have taller boxes than full-frame OCR. Their
            // centers agree; top edges can invent a conflicting scroll distance.
            shifts.push(matches[0].region.y + matches[0].region.height / 2 -
              anchor.region.y - anchor.region.height / 2);
          }
        }
        return shifts.length && shifts.every(shift => Math.abs(shift - shifts[0]) <= 12) ? shifts[0] : null;
      }
      for (let pass = 0; pass < 16; pass++) {
        const snapshot = captureOcr(true, tab);
        requireCharacterHeader(snapshot, characterName);
        snapshots.push(snapshot);
        await sleep(350);
        const confirmation = captureOcr(true, tab);
        requireCharacterHeader(confirmation, characterName);
        confirmation.confirmation_of = snapshot.snapshot_id;
        snapshots.push(confirmation);
        if (!sameViewport(snapshot, confirmation)) throw new Error("读取时页面仍在移动：" + characterName + tab);
        snapshot.coverage = validateGuideFrameCoverage(snapshot, tab);
        confirmation.coverage = validateGuideFrameCoverage(confirmation, tab);
        for (const frame of [snapshot, confirmation]) {
          if (!frame.coverage.ok) coverageIssues.push({ snapshot: frame.snapshot_id, issues: frame.coverage.issues });
        }
        if (sameViewport(snapshot, previous)) {
          complete = snapshot.coverage.frameComplete && confirmation.coverage.frameComplete;
          break;
        }
        if (previous) {
          const shift = scrollShift(previous, snapshot);
          if (shift === null || shift >= 0 || shift < -600) {
            coverageIssues.push({ snapshot: snapshot.snapshot_id, issues: ["无法用重叠内容证明连续向下滚动"] });
          }
        }
        {
          const materialResult = await collectMaterialPopups(snapshot, materialsByName, characterName, tab);
          materialRows += materialResult.recognized;
          materialPopups += materialResult.captured;
          Array.prototype.push.apply(unreadMaterialPopups, materialResult.failed);
          log.Info("读取 {0} 第 {1} 屏：材料弹窗 {2}/{3}", characterName, pass + 1,
            materialResult.captured, materialResult.recognized);
        }
        // Weapon recommendations are outside the current-weapon demand scope.
        if (snapshot.coverage.frameComplete && confirmation.coverage.frameComplete) {
          complete = true;
          break;
        }
        previous = snapshot;
        await wheelRightPane(snapshot.screen, -1, 6);
      }
      for (const snapshot of snapshots) {
        for (const [edgeKey, textKey, verifiedKey, offset] of [
          ["cardArrows", "upgradeMarkers", "cardRows", 33], ["sourcePins", "sourceAnchors", "sourceRows", 15]
        ]) {
          if (tab !== "角色天赋" && edgeKey === "cardArrows") continue;
          const edges = (snapshot.coverage.topEdge[edgeKey] || [])
            .concat(snapshot.coverage.unconfirmedEdge[edgeKey] || []);
          for (const text of (snapshot.coverage.topEdge[textKey] || [])
              .concat(snapshot.coverage.unconfirmedEdge[textKey] || [])) {
            edges.push({ y: text.y + offset * snapshot.screen.height / 1080, height: text.height });
          }
          for (const edge of edges) {
            const resolved = snapshots.some(other => {
              if (other === snapshot || !other.coverage.ok) return false;
              const shift = scrollShift(snapshot, other);
              if (shift === null) return false;
              const y = (edge.y + edge.height / 2) * 1080 / snapshot.screen.height + shift;
              return other.coverage.verified[verifiedKey].some(pair =>
                Math.abs((pair.right.y + pair.right.height / 2) * 1080 / other.screen.height - y) <= 15);
            });
            if (!resolved) coverageIssues.push({ snapshot: snapshot.snapshot_id,
              issues: ["边缘培养卡片或材料来源未在其它画面完整确认"] });
          }
        }
      }
      const result = {
        home_level: homeLevel,
        incomplete: !topResetConfirmed || !complete || unreadMaterialPopups.length > 0 || coverageIssues.length > 0,
        top_reset_confirmed: topResetConfirmed,
        snapshots: snapshots,
        material_source_rows_recognized: materialRows,
        material_popups_captured: materialPopups,
        unread_material_popups: unreadMaterialPopups,
        coverage_issues: coverageIssues,
        end_confirmed: complete
      };
      const parsed = tab === "角色等级" ? parseLevelPage(result) :
        tab === "武器" ? parseWeaponPage(result) : parseTalentPage(result);
      result.incomplete = result.incomplete || parsed.incomplete;
      result.needs_reread = parsed.needsReread || [];
      return result;
    }

    function saveFailureScreenshot() {
      let capture = null;
      try {
        capture = captureGameRegion();
        if (!file.WriteImageSync("collection-failure.png", capture.SrcMat)) {
          log.Warn("Could not save collection-failure.png");
        }
      } catch (screenshotError) {
        log.Warn("Could not capture failure screenshot: {0}", String(screenshotError));
      } finally {
        if (capture !== null) capture.Dispose();
      }
    }

    try {
      writeJson("collection.json", {
        ok: false, incomplete: true, status: "reading", run_id: runId, started_at: startedAt
      });
      writeJson("preview.json", {
        actionable: false, status: "reading", run_id: runId, started_at: startedAt
      });
      file.CreateDirectory("raw");
      const firstSnapshot = await openGuideHome();
      const firstHome = requireCompleteHome(firstSnapshot, parseGuideHome);
      writeJson("raw/home.json", firstSnapshot);

      const collection = {
        ok: true,
        run_id: runId,
        started_at: startedAt,
        collected_at: new Date().toISOString(),
        bgi_version: String(getVersion()),
        home: firstHome,
        home_snapshot: firstSnapshot,
        page_names: tabs,
        characters: []
      };

      for (let i = 0; i < firstHome.characters.length; i++) {
        const character = firstHome.characters[i];
        const point = toReferencePoint(character.upgradePoint, firstSnapshot.screen);
        page.Click(point.x, point.y);
        await sleep(900);

        let opened = captureOcr();
        for (let tutorial = 0; tutorial < 3; tutorial++) {
          const teaching = opened.regions.some(r => r.y > opened.screen.height * 0.65 &&
            (r.text.includes("设定完成后") || r.text.includes("计划培养的角色") ||
             r.text.includes("主要产出途径") || r.text.includes("在材料详情中，也可查看")));
          if (!teaching) break;
          page.Click(960, 1020);
          await sleep(700);
          opened = captureOcr();
        }
        requireCharacterHeader(opened, character.name);
        const pages = {};
        const materialsByName = {};
        const bossMaterialsByName = {};
        const directory = "raw/" + safeName(character.name);
        file.CreateDirectory(directory);

        for (let j = 0; j < tabs.length; j++) {
          const tab = tabs[j];
          clickExactTab(tab, opened.screen);
          await sleep(700);
          const pageCollection = tab === "圣遗物"
            ? await collectArtifactPage(character.name, opened.screen)
            : await collectScrollablePage(character.name, opened.screen, tab,
              tab === "角色等级" ? bossMaterialsByName : materialsByName, character.level);
          pages[tab] = pageCollection;
          writeJson(directory + "/" + safeName(tab) + ".json", pageCollection);
        }

        collection.characters.push({
          name: character.name,
          home_level: character.level,
          pages: pages,
          materials: Object.keys(materialsByName).map(function (name) {
            return { snapshot: materialsByName[name].snapshot, confirmations: materialsByName[name].confirmations };
          }),
          bossMaterials: Object.keys(bossMaterialsByName).map(function (name) {
            return { snapshot: bossMaterialsByName[name].snapshot, confirmations: bossMaterialsByName[name].confirmations };
          })
        });
        writeJson(directory + "/character.json", collection.characters[collection.characters.length - 1]);
        log.Info("Collected guide pages for {0} ({1}/{2})", character.name, i + 1, firstHome.count);

        keyPress("VK_ESCAPE");
        await sleep(900);
        let returnedSnapshot = captureOcr();
        for (let attempt = 0; attempt < 2 && !parseGuideHome(returnedSnapshot).ok; attempt++) {
          await sleep(500);
          returnedSnapshot = captureOcr();
        }
        writeJson(directory + "/return-home.json", returnedSnapshot);
        const returnedHome = requireCompleteHome(returnedSnapshot, parseGuideHome);
        if (!sameHome(firstHome, returnedHome)) {
          throw new Error("Guide home changed after collecting " + character.name);
        }
      }

      collection.completed_at = new Date().toISOString();
      collection.collected_at = collection.completed_at;
      collection.incomplete = collection.characters.some(function (character) {
        return tabs.some(function (tab) { return tab !== "圣遗物" && character.pages[tab].incomplete; });
      });
      writeJson("collection.json", collection);
      writeJson("preview.json", buildPlanPreview(collection, new Date(), GUIDE_IDENTITIES));
      log.Info(
        "Guide collection finished: {0} enabled characters; incomplete={1}",
        collection.characters.length,
        collection.incomplete
      );
      return collection;
    } catch (error) {
      const failureMessage = String(error && error.message ? error.message : error);
      try {
        writeJson("collection.json", {
          ok: false,
          incomplete: true,
          run_id: runId,
          started_at: startedAt,
          failed_at: new Date().toISOString(),
          error: failureMessage
        });
      } catch (invalidationError) {
        log.Error("Could not invalidate collection.json: {0}", String(invalidationError));
      }
      try {
        writeJson("preview.json", {
          actionable: false,
          run_id: runId,
          error: failureMessage
        });
      } catch (invalidationError) {
        log.Error("Could not invalidate preview.json: {0}", String(invalidationError));
      }
      saveFailureScreenshot();
      log.Error("Guide collection failed: {0}", failureMessage);
      throw error;
    }
}


/**
 * Read one complete live Training Guide snapshot.
 *
 * The returned objects retain raw run/snapshot provenance. Mapping canonical
 * material IDs and constructing upstream targets belongs to core/guide-targets.js.
 */
export async function readTrainingGuideSnapshot() {
  GUIDE_IDENTITIES = readGuideJson("guide-reader/data/guide-identities.json");
  BOSS_CATALOG = readGuideJson("guide-reader/data/boss-materials.json");
  ARTIFACT_CATALOG = readGuideJson("guide-reader/data/artifact-domains.json");

  let readError = null;
  try {
    const collection = await collectGuideSnapshot(false);
    const preview = buildPlanPreview(collection, new Date(), GUIDE_IDENTITIES);
    const bossMaterials = mergeMaterialPopups(collection.characters.flatMap(character =>
      (character.bossMaterials || []).map(material =>
        Object.assign({}, material, { characterName: character.name }))),
    BOSS_CATALOG);

    if (collection.ok !== true || collection.incomplete !== false || !preview ||
        preview.run_id !== collection.run_id ||
        preview.evidence_started_at !== collection.started_at ||
        preview.captured_at !== collection.completed_at) {
      throw new Error("提升指南读取不完整：" +
        (preview && preview.issues || [preview && preview.error || "unknown guide error"]).join("；"));
    }
    return { collection, preview, bossMaterials };
  } catch (error) {
    readError = error;
    throw error;
  } finally {
    try {
      await genshin.ReturnMainUi();
    } catch (returnError) {
      if (!readError) throw returnError;
      log.Error("提升指南读取失败后返回主界面也失败：{0}",
        String(returnError && returnError.message ? returnError.message : returnError));
    }
  }
}
