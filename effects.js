'use strict';
// Scripted effects for the cards in the preset decks.
//
// target: chosen while casting. 'any' (player or creature) | 'player' | 'opponent' | 'creature'
//         | 'oppCreature' | 'myCreature' | 'spell' (something on the stack)
// optional: the spell/permanent may be cast with no target (ETB just does nothing).
// resolve(g, ctx): instant/sorcery effect.  etb(g, ctx): permanent entering the battlefield.
// ctx = { p (controller), card, target (resolved, see Room.resolveTarget) }
//
// Cards with keyword/trigger behaviour handled by the engine itself are listed in TRIGGER_CARDS.

const { RuleError } = require('./public/rules');

const damage = (n) => ({ target: 'any', resolve: (g, ctx) => g.damage(ctx, ctx.target, n) });

const EFFECTS = {
  // 🔥 Burn
  'Lightning Bolt': damage(3),
  'Chain Lightning': damage(3),
  'Lightning Strike': damage(3),
  'Rift Bolt': damage(3),
  'Skewer the Critics': {
    ...damage(3),
    // Spectacle: costs {R} once an opponent has lost life this turn.
    altCost: (g, ctx) => (g.opponentsOf(ctx.p).some((o) => o.damagedThisTurn) ? '{R}' : null),
  },
  'Lava Spike': { target: 'player', resolve: (g, ctx) => g.damage(ctx, ctx.target, 3) },
  'Searing Blaze': {
    target: 'oppCreature',
    resolve: (g, ctx) => {
      const n = ctx.p.landsPlayed > 0 ? 3 : 1; // Landfall
      g.damage(ctx, ctx.target, n);
      g.damage(ctx, g.playerTarget(ctx.target.pid), n);
    },
  },

  // 🌲 Stompy
  'Giant Growth': { target: 'creature', resolve: (g, ctx) => g.pump(ctx.target, 3, 3) },
  'Blossoming Defense': { target: 'myCreature', resolve: (g, ctx) => g.pump(ctx.target, 2, 2) },
  'Vines of Vastwood': {
    target: 'creature',
    // Kicker {G}: pays the extra G automatically when it can.
    resolve: (g, ctx) => (g.tryPay(ctx.p, '{G}', 'Kicker') ? g.pump(ctx.target, 4, 4) : g.addLog(`${ctx.card.name}: ไม่ได้จ่าย Kicker`)),
  },
  Rancor: { target: 'creature', aura: { power: 2, toughness: 0, keywords: ['Trample'] } },

  // 💧 Azorius
  'Swords to Plowshares': {
    target: 'creature',
    resolve: (g, ctx) => {
      const power = Math.max(0, g.stats(ctx.target.card).power);
      g.exileFromBattlefield(ctx.target);
      g.gainLife(ctx.target.owner, power);
    },
  },
  Counterspell: { target: 'spell', resolve: (g, ctx) => g.counterSpell(ctx.target) },
  'Mana Leak': { target: 'spell', resolve: (g, ctx) => g.counterUnlessPay(ctx.target, '{3}') },
  Opt: { resolve: (g, ctx) => g.draw(ctx.p, 1) },
  'Thraben Inspector': { etb: (g, ctx) => g.createToken(ctx.p, 'Clue') },
  'Faerie Duelist': { target: 'oppCreature', optional: true, etb: (g, ctx) => ctx.target && g.pump(ctx.target, -2, 0) },
  'Spell Queller': {
    target: 'spell',
    optional: true,
    etb: (g, ctx) => {
      if (!ctx.target) return;
      if (ctx.target.item.card.cmc > 4) g.addLog(`${ctx.card.name}: ${ctx.target.item.card.name} มีค่ามานาเกิน 4 exile ไม่ได้`);
      else g.exileSpell(ctx.target);
    },
  },
  'Restoration Angel': {
    target: 'myCreature',
    optional: true,
    etb: (g, ctx) => {
      if (!ctx.target || ctx.target.card === ctx.card) return;
      if (/\bAngel\b/.test(ctx.target.card.typeLine)) g.addLog(`${ctx.card.name}: blink Angel ไม่ได้`);
      else g.blink(ctx.target);
    },
  },

  // 💀 Black
  'Fatal Push': {
    target: 'creature',
    check: (g, ctx) => {
      const limit = ctx.p.revolt ? 4 : 2;
      if (ctx.target.card.cmc > limit) throw new RuleError(`Fatal Push ทำลายได้เฉพาะ creature ค่ามานาไม่เกิน ${limit}`);
    },
    resolve: (g, ctx) => g.destroy(ctx.target),
  },
  Thoughtseize: {
    target: 'player',
    resolve: (g, ctx) => {
      g.loseLife(ctx.p, 2);
      g.chooseDiscard(ctx.p, ctx.target.player, (c) => !c.typeLine.includes('Land'), 'Thoughtseize: เลือกการ์ดที่ไม่ใช่ Land ให้ทิ้ง');
    },
  },
  Duress: {
    target: 'opponent',
    resolve: (g, ctx) => g.chooseDiscard(ctx.p, ctx.target.player,
      (c) => !/\b(Land|Creature)\b/.test(c.typeLine), 'Duress: เลือกการ์ดที่ไม่ใช่ creature และไม่ใช่ Land ให้ทิ้ง'),
  },
  "Liliana's Triumph": {
    resolve: (g, ctx) => {
      for (const o of g.opponentsOf(ctx.p)) g.chooseSacrifice(o, `Liliana's Triumph: เลือก creature ของคุณ 1 ตัวเพื่อ sacrifice`);
    },
  },
  'Phyrexian Rager': {
    etb: (g, ctx) => {
      g.draw(ctx.p, 1);
      g.loseLife(ctx.p, 1);
    },
  },
  'Gray Merchant of Asphodel': {
    etb: (g, ctx) => {
      // Devotion to black: {B} symbols among mana costs of permanents you control.
      const devotion = ctx.p.zones.battlefield.reduce((n, c) => n + (c.manaCost.match(/\{B\}/g) || []).length, 0);
      let drained = 0;
      for (const o of g.opponentsOf(ctx.p)) drained += g.loseLife(o, devotion);
      g.gainLife(ctx.p, drained);
    },
  },
};

// Behaviour implemented directly in the engine (keywords and triggers).
const TRIGGER_CARDS = new Set([
  'Monastery Swiftspear', 'Goblin Guide', 'Eidolon of the Great Revel', 'Young Wolf', 'Strangleroot Geist',
  'Skarrgan Pit-Skulk', "Garruk's Companion", 'Dark Confidant', 'Bloodghast', 'Murderous Rider',
  'Sheoldred, the Apocalypse', 'Llanowar Elves', 'Elvish Mystic', 'Brazen Borrower', 'Spectral Sailor',
  'Nettle Sentinel', 'Plains', 'Island', 'Swamp', 'Mountain', 'Forest',
]);

module.exports = { EFFECTS, TRIGGER_CARDS };
