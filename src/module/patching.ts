import { log, warn, debug, i18n, error, getCanvas } from "../midi-qol.js";
import { doItemRoll, doAttackRoll, doDamageRoll, templateTokens } from "./itemhandling.js";
import { configSettings, autoFastForwardAbilityRolls, criticalDamage } from "./settings.js";
import { bonusDialog, expireRollEffect, getOptionalCountRemainingShortFlag, getSpeaker, testKey } from "./utils.js";
import { installedModules } from "./setupModules.js";
import { libWrapper } from "./lib/shim.js";

var d20Roll;

function _isVisionSource(wrapped) {
  const isVisionSource = wrapped();
  //@ts-ignore
  if (this.data.hidden && (game.user.isGM || this.actor?.testUserPermission(game.user, "OWNER"))) {
    console.error("Setting as vision source");
    return true;
  }
  return isVisionSource;
}

function isVisible(wrapped) {
  const isVisible = wrapped();
  if (this.actor?.testUserPermission(game.user, "OWNER")) {
    return true;
  }
  return isVisible;
}

export const advantageEvent = { shiftKey: false, altKey: true, ctrlKey: false, metaKey: false, fastKey: false };
export const disadvantageEvent = { shiftKey: false, altKey: false, ctrlKey: true, metaKey: true, fastKey: false };
export const fastforwardEvent = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, fastKey: true };
export const baseEvent = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, fastKey: false };

function mapSpeedKeys(event) {
  if (configSettings.speedItemRolls && configSettings.speedAbilityRolls && !installedModules.get("betterrolls5e")) {
    if (game.system.id === "sw5e") {
      var advKey = testKey(configSettings.keyMapping["SW5E.Advantage"], event);
      var disKey = testKey(configSettings.keyMapping["SW5E.Disadvantage"], event);
    } else {
      var advKey = testKey(configSettings.keyMapping["DND5E.Advantage"], event);
      var disKey = testKey(configSettings.keyMapping["DND5E.Disadvantage"], event);
    }
  } else {
    var advKey = event?.altKey ? true : false;
    var disKey = (event?.ctrlKey | event?.metaKey) ? true : false;
  };
  if (advKey && disKey)
    event = fastforwardEvent;
  else if (disKey) event = disadvantageEvent;
  else if (advKey) event = advantageEvent;
  else
    event = baseEvent;
  return event;
}

interface Options {
  event: any,
  advantage: boolean | undefined,
  disadvantage: boolean | undefined,
  fastForward: boolean | undefined,
  parts: [] | undefined,
  chatMessage: boolean | undefined
};

async function bonusCheck(actor, result: Roll, checkName) : Promise<Roll> {
  if (!installedModules.get("betterrolls5e")) {
    const bonusFlags = Object.keys(actor.data.flags["midi-qol"]?.optional ?? [])
      .filter(flag => {
        if (!actor.data.flags["midi-qol"].optional[flag][checkName]) return false;
        if (!actor.data.flags["midi-qol"].optional[flag].count) return true;
        return getOptionalCountRemainingShortFlag(actor, flag) > 0;
      })
      .map(flag => `flags.midi-qol.optional.${flag}`);
    if (bonusFlags.length > 0) {
      const data = {
        actor,
        roll: result,
        rollHTML: await result.render(),
        rollTotal: result.total,
      }
      await bonusDialog.bind(data)(bonusFlags, checkName, true, `${actor.name} - ${i18n("midi-qol.ability-check")}`, "roll", "rollTotal", "rollHTML")
      result = data.roll;
    }
  }
  return result;
}

async function doRollSkill(wrapped, ...args) {
  const [skillId, options = { event: {}, parts: [], avantage: false, disadvantage: false }] = args;
  const chatMessage = options.chatMessage;
  options.event = mapSpeedKeys(options.event);
  if (options.event === advantageEvent || options.event === disadvantageEvent)
    options.fastForward = true;
  let procOptions: Options = procAdvantage(this, "check", this.data.data.skills[skillId].ability, options)
  procOptions = procAdvantageSkill(this, skillId, procOptions)
  if (procAutoFailSkill(this, skillId) || procAutoFail(this, "check", this.data.data.skills[skillId].ability)) {
    options.parts = ["-100"];
  }
  
  options.event = {};
  procOptions.chatMessage = false;
  let result = await wrapped.call(this, skillId, procOptions);
  result = await bonusCheck(this, result, "skill")
  if (chatMessage !== false) result.toMessage({speaker: getSpeaker(this), "flags.dnd5e.roll": {type: "skill", skillId }});
  expireRollEffect.bind(this)("Skill", skillId);
  return result;
}

function rollDeathSave(wrapped, ...args) {
  const [options] = args;
  const event = mapSpeedKeys(options.event);
  const advFlags = getProperty(this.data.flags, "midi-qol")?.advantage ?? {};
  const disFlags = getProperty(this.data.flags, "midi-qol")?.disadvantage ?? {};
  var withAdvantage = options.event?.altKey || options.advantage;
  var withDisadvantage = options.event?.ctrlKey || options.event?.metaKey || options.disadvantage;
  options.fastForward = autoFastForwardAbilityRolls ? !options.event.fastKey : options.event.fastKey;
  withAdvantage = advFlags.deathSave || advFlags.all;
  withDisadvantage = disFlags.deathSave || disFlags.all;
  options.advantage = withAdvantage && !withDisadvantage;
  options.disadvantage = withDisadvantage && !withAdvantage;
  options.event = {};

  if (options.advantage && options.disadvantage) {
    options.advantage = options.disadvantage = false;
  }
  return wrapped.call(this, ...args);
}

function configureDamage(wrapped) {
  if (!this.isCritical || criticalDamage === "default") return wrapped();
  let flatBonus = 0;
  if (criticalDamage === "doubleDice") this.options.multiplyNumeric = true;
  if (criticalDamage === "baseDamage") this.options.criticalMultiplier = 1;
  this.terms = this.terms.filter(term=> !term.options.critOnly)
  for (let [i, term] of this.terms.entries()) {
    // Multiply dice terms
    if (term instanceof DiceTerm) {
      const termOptions: any = term.options;
      termOptions.baseNumber = termOptions.baseNumber ?? term.number; // Reset back
      term.number = termOptions.baseNumber;
      let cm = this.options.criticalMultiplier ?? 2;
      let cb = (this.options.criticalBonusDice && (i === 0)) ? this.options.criticalBonusDice : 0;
      // {default: "DND5e default", maxDamage:  "base max only", maxCrit: "max critical dice", maxAll: "max all dice", doubleDice: "double dice value"},
      switch (criticalDamage) {
        case "maxDamage":
          term.modifiers.push(`min${term.faces}`)
          cm = 1;
          flatBonus = 0;
          break;
        case "maxCrit":
          flatBonus += (term.number + cb) * term.faces;
          cm = Math.max(1, cm - 1);
          term.alter(cm, cb);
          break;
        case "maxAll":
          term.modifiers.push(`min${term.faces}`);
          term.alter(cm, cb);
          flatBonus = 0;
          break;
        case "doubleDice":
          cm = 1;
          break;
        default: break;
      }
      termOptions.critical = true;
    }

    // Multiply numeric terms
    else if (this.options.multiplyNumeric && (term instanceof NumericTerm)) {
      const termOptions: any = term.options;
      termOptions.baseNumber = termOptions.baseNumber ?? term.number; // Reset back
      term.number = termOptions.baseNumber;
      if (this.isCritical) {
        term.number *= (this.options.criticalMultiplier ?? 2);
        termOptions.critical = true;
      }
    }
  }

  if (flatBonus > 0) {
    this.terms.push(new CONFIG.Dice.termTypes.OperatorTerm({ operator: "+" , options: {critOnly: true}}));
    this.terms.push(new CONFIG.Dice.termTypes.NumericTerm({ number: flatBonus, options: { critOnly: true}}));
  }
  if (criticalDamage === "doubleDice") {
    let newTerms: RollTerm[] = [];
    for (let term of this.terms) {
      if (term instanceof DiceTerm) {
        //@ts-ignore types don't allow for optional roll in constructor
        newTerms.push(new ParentheticalTerm({ term: `2*${term.formula}`, options: {} }))
      } else if( !term)
        newTerms.push(term);
    }
    this.terms = newTerms;
  }
  // Re-compile the underlying formula
  this._formula = this.constructor.getFormula(this.terms);
}
async function rollAbilityTest(wrapped, ...args) {
  const [abilityId, options = { event: {}, parts: [], chatMessage: undefined }] = args;
  const chatMessage = options.chatMessage;
  if (procAutoFail(this, "check", abilityId)) options.parts = ["-100"];
  options.event = mapSpeedKeys(options.event);
  if (options.event === advantageEvent || options.event === disadvantageEvent)
    options.fastForward = true;
  let procOptions = procAdvantage(this, "check", abilityId, options);

  options.event = {};
  const flags = getProperty(this.data.flags, "midi-qol.MR.ability") ?? {};
  const minimumRoll = (flags.check && (flags.check.all || flags.save[abilityId])) ?? 0;

  procOptions.chatMessage = false;
  let result = await wrapped(abilityId, procOptions);
  result = await bonusCheck(this, result, "check")
  if (chatMessage !== false) result.toMessage({speaker: getSpeaker(this), "flags.dnd5e.roll": {type: "ability", abilityId }});
  expireRollEffect.bind(this)("Check", abilityId);
  return result;
}

async function rollAbilitySave(wrapped, ...args) {
  const [abilityId, options = { event: {}, parts: [], chatMessage: undefined }] = args;
  if (procAutoFail(this, "save", abilityId)) {
    options.parts = ["-100"];
  }
  const chatMessage = options.chatMessage;
  options.event = mapSpeedKeys(options.event);
  if (options.event === advantageEvent || options.event === disadvantageEvent)
    options.fastForward = true;
  let procOptions = procAdvantage(this, "save", abilityId, options);
  const flags = getProperty(this.data.flags, "midi-qol.MR.ability") ?? {};
  const minimumRoll = (flags.save && (flags.save.all || flags.save[abilityId])) ?? 0;
  procOptions.chatMessage = false;
  let result = await wrapped(abilityId, procOptions);
  result = await bonusCheck(this, result, "save")
  if (chatMessage !== false) result.toMessage({speaker: getSpeaker(this),  "flags.dnd5e.roll": {type: "save", abilityId }});
  expireRollEffect.bind(this)("Save", abilityId);
  return result;
  /* TODO work out how to do minimum rolls properly
  return wrapped.call(this, wrapped, abilityId, procOptions).then(roll => {
    console.error("mini check save", roll.total, minimumRoll, roll.total < minimumRoll, (new Roll(`${minimumRoll}`)).roll())
    if (roll.total < minimumRoll) return (new Roll(`${minimumRoll}`)).roll()
    else return roll
  });
  */
}

function procAutoFail(actor, rollType: string, abilityId: string): boolean {
  const midiFlags = actor.data.flags["midi-qol"] ?? {};
  const fail = midiFlags.fail ?? {};
  if (fail.ability || fail.all) {
    const rollFlags = (fail.ability && fail.ability[rollType]) ?? {};
    const autoFail = fail.all || fail.ability.all || rollFlags.all || rollFlags[abilityId];
    return autoFail;
  }
  return false;
}

function procAutoFailSkill(actor, skillId): boolean {
  const midiFlags = actor.data.flags["midi-qol"] ?? {};
  const fail = midiFlags.fail ?? {};
  if (fail.skill || fail.all) {
    const rollFlags = (fail.skill && fail.skill[skillId]) || false;
    const autoFail = fail.all || fail.skill.all || rollFlags;
    return autoFail;
  }
  return false;
}

function procAdvantage(actor, rollType, abilityId, options: Options): Options {
  const midiFlags = actor.data.flags["midi-qol"] ?? {};
  const advantage = midiFlags.advantage ?? {};
  const disadvantage = midiFlags.disadvantage ?? {};
  var withAdvantage = options.event?.altKey || options.advantage;
  var withDisadvantage = options.event?.ctrlKey || options.event?.metaKey || options.disadvantage;

  options.fastForward = options.fastForward || (autoFastForwardAbilityRolls ? !options.event.fastKey : options.event.fastKey);
  if (advantage.ability || advantage.all) {
    const rollFlags = (advantage.ability && advantage.ability[rollType]) ?? {};
    withAdvantage = withAdvantage || advantage.all || advantage.ability.all || rollFlags.all || rollFlags[abilityId];
  }
  if (disadvantage.ability || disadvantage.all) {
    const rollFlags = (disadvantage.ability && disadvantage.ability[rollType]) ?? {};
    withDisadvantage = withDisadvantage || disadvantage.all || disadvantage.ability.all || rollFlags.all || rollFlags[abilityId];
  }
  options.advantage = withAdvantage && !withDisadvantage;
  options.disadvantage = withDisadvantage && !withAdvantage;
  options.event = {};
  return options;
}

function procAdvantageSkill(actor, skillId, options: Options): Options {
  const midiFlags = actor.data.flags["midi-qol"];
  const advantage = midiFlags?.advantage;
  const disadvantage = midiFlags?.disadvantage;
  var withAdvantage = options.advantage;
  var withDisadvantage = options.disadvantage;
  if (advantage?.skill) {
    const rollFlags = advantage.skill
    withAdvantage = withAdvantage || advantage.all || rollFlags?.all || (rollFlags && rollFlags[skillId]);
  }
  if (disadvantage?.skill) {
    const rollFlags = disadvantage.skill
    withDisadvantage = withDisadvantage || disadvantage.all || rollFlags?.all || (rollFlags && rollFlags[skillId])
  }
  options.advantage = withAdvantage && !withDisadvantage;
  options.disadvantage = withDisadvantage && !withAdvantage;
  return options;
}

function midiATRefresh(wrapped) {
  templateTokens({x: this.data.x, y: this.data.y, shape: this.shape})
  return wrapped();
}

export function readyPatching() {
  libWrapper.register("midi-qol", "game.dnd5e.canvas.AbilityTemplate.prototype.refresh", midiATRefresh, "WRAPPER")
}

export let visionPatching = () => {
  const patchVision = isNewerVersion(game.data.version, "0.7.0") && game.settings.get("midi-qol", "playerControlsInvisibleTokens")
  if (patchVision) {
    ui.notifications?.warn("Player control vision is deprecated please use the module Your Tokens Visible")
    console.warn("midi-qol | Player control vision is deprecated please use the module Your Tokens Visible")

    log("Patching Token._isVisionSource")
    libWrapper.register("midi-qol", "Token.prototype._isVisionSource", _isVisionSource, "WRAPPER");

    log("Patching Token.isVisible")
    libWrapper.register("midi-qol", "Token.prototype.isVisible", isVisible, "WRAPPER");
  }
  log("Vision patching - ", patchVision ? "enabled" : "disabled")
}

export let itemPatching = () => {
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.roll", doItemRoll, "MIXED");
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.rollAttack", doAttackRoll, "MIXED");
  libWrapper.register("midi-qol", "CONFIG.Item.documentClass.prototype.rollDamage", doDamageRoll, "MIXED");
  libWrapper.register("midi-qol", "CONFIG.Dice.DamageRoll.prototype.configureDamage", configureDamage, "MIXED");
};

export let actorAbilityRollPatching = () => {
  log("Patching rollAbilitySave")
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.rollAbilitySave", rollAbilitySave, "WRAPPER");

  log("Patching rollAbilityTest")
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.rollAbilityTest", rollAbilityTest, "WRAPPER");

  log("Patching rollSkill");
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.rollSkill", doRollSkill, "WRAPPER");

  log("Patching rollDeathSave");
  libWrapper.register("midi-qol", "CONFIG.Actor.documentClass.prototype.rollDeathSave", rollDeathSave, "WRAPPER");
}

export function patchLMRTFY() {
  if (installedModules.get("lmrtfy")) {
    log("Patching lmrtfy")
    libWrapper.register("midi-qol", "LMRTFYRoller.prototype._makeRoll", _makeRoll, "OVERRIDE");
    libWrapper.register("midi-qol", "LMRTFYRoller.prototype._tagMessage", _tagMessage, "OVERRIDE");

  }
}

export function _tagMessage(candidate, data, options) {
  let update = { flags: { lmrtfy: { "message": this.data.message, "data": this.data.attach } } };
  candidate.data.update(update);
}

export async function _makeRoll(event, rollMethod, ...args) {
  let options;
  switch (this.advantage) {
    case -1:
      options = { disadvantage: true, fastForward: true };
      break;
    case 0:
      options = { fastForward: true };
      break;
    case 1:
      options = { advantage: true, fastForward: true };
      break;
    case 2:
      options = { event: event }
      break;
  }
  const rollMode = game.settings.get("core", "rollMode");
  game.settings.set("core", "rollMode", this.mode || CONST.DICE_ROLL_MODES);
  for (let actor of this.actors) {
    Hooks.once("preCreateChatMessage", this._tagMessage.bind(this));
    await actor[rollMethod].call(actor, ...args, options);
  }
  game.settings.set("core", "rollMode", rollMode);
  event.currentTarget.disabled = true;
  if (this.element.find("button").filter((i, e) => !e.disabled).length === 0)
    this.close();
}
