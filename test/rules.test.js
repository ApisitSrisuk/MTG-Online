'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../game');
const { payCost, parseCost, emptyPool, planAutoTap } = require('../public/rules');

const pool = (spec) => ({ ...emptyPool(), ...spec });

test('parseCost understands generic, colored, hybrid and phyrexian symbols', () => {
  assert.deepEqual(parseCost('{2}{R}{R}'), { generic: 2, colored: { R: 2 }, hybrid: [], phyrexian: [] });
  assert.deepEqual(parseCost('{X}{W/U}{G/P}{2/B}'), { generic: 0, colored: {}, hybrid: [['W', 'U'], ['B', '2']], phyrexian: ['G'] });
});

test('payCost spends colored mana first, then generic from what is left', () => {
  assert.deepEqual(payCost('{1}{R}', pool({ R: 1, G: 1 })).pool, pool({}));
  assert.deepEqual(payCost('{U}{U}', pool({ U: 3 })).pool, pool({ U: 1 }));
  assert.equal(payCost('{G/P}', pool({})).life, 2);
});

test('payCost reports what is missing', () => {
  assert.throws(() => payCost('{1}{R}{R}', pool({ R: 1, G: 1 })), /ขาดอีก R×1/);
  assert.throws(() => payCost('{3}', pool({ W: 1 })), /ไม่ระบุสี×2/);
});

const card = (name, typeLine, extra = {}) => ({ name, img: null, section: 'main', typeLine, ...extra });
const mountain = card('Mountain', 'Basic Land — Mountain', { producedMana: ['R'] });
const bolt = card('Lightning Bolt', 'Instant', { manaCost: '{R}' });
const guide = card('Goblin Guide', 'Creature — Goblin Scout', { manaCost: '{R}' });
const spike = card('Lava Spike', 'Sorcery — Arcane', { manaCost: '{R}' });

// Alice is forced to go first with a hand of [Mountain, Mountain, Goblin Guide, Lightning Bolt, Lava Spike].
function game() {
  const room = new Room('RULE');
  room.join('alice-0001', 'Alice');
  room.join('bob-000002', 'Bob');
  for (const pid of ['alice-0001', 'bob-000002']) room.setDeck(pid, [mountain, mountain, guide, bolt, spike, ...Array(40).fill(mountain)]);
  const alice = room.players.get('alice-0001');
  const byName = (n) => alice.zones.hand.find((c) => c.name === n) || alice.zones.library.find((c) => c.name === n);
  alice.zones.hand = [byName('Mountain'), alice.zones.library.find((c) => c.name === 'Mountain' && c !== byName('Mountain')), byName('Goblin Guide'), byName('Lightning Bolt'), byName('Lava Spike')];
  room.turn = { active: 'alice-0001', number: 1, phase: 'main1' };
  const hand = (n) => alice.zones.hand.find((c) => c.name === n);
  return { room, alice, hand, act: (a) => room.act('alice-0001', a), bobAct: (a) => room.act('bob-000002', a) };
}

test('only one land per turn, and it can be overridden', () => {
  const { act, alice, hand } = game();
  act({ type: 'cast', iid: hand('Mountain').iid });
  assert.throws(() => act({ type: 'cast', iid: hand('Mountain').iid }), (e) => e.rule && /เทิร์นละ 1 ใบ/.test(e.message));
  act({ type: 'cast', iid: hand('Mountain').iid, force: true });
  assert.equal(alice.zones.battlefield.length, 2);
});

test('planAutoTap picks the right sources and gives up when mana is short', () => {
  const sources = [{ iid: 'dual', colors: ['W', 'U'] }, { iid: 'm1', colors: ['R'] }, { iid: 'm2', colors: ['R'] }];
  assert.deepEqual(planAutoTap('{1}{R}', emptyPool(), sources), [{ iid: 'm1', color: 'R' }, { iid: 'm2', color: 'R' }]);
  assert.deepEqual(planAutoTap('{U}', emptyPool(), sources), [{ iid: 'dual', color: 'U' }]);
  assert.equal(planAutoTap('{G}', emptyPool(), sources), null);
  assert.equal(planAutoTap('{4}', emptyPool(), sources), null);
});

test('casting without enough lands is refused', () => {
  const { act, hand } = game();
  assert.throws(() => act({ type: 'cast', iid: hand('Goblin Guide').iid }), (e) => e.rule && /มานาไม่พอ/.test(e.message));
});

test('casting taps lands automatically when the pool is short', () => {
  const { act, alice, hand } = game();
  act({ type: 'cast', iid: hand('Mountain').iid });
  act({ type: 'cast', iid: hand('Goblin Guide').iid });
  assert.equal(alice.zones.battlefield.find((c) => c.name === 'Mountain').tapped, true);
  assert.equal(alice.pool.R, 0);
  assert.ok(alice.zones.battlefield.some((c) => c.name === 'Goblin Guide'));
});

test('casting spends mana already in the pool; spells go to the graveyard', () => {
  const { room, act, alice, hand } = game();
  act({ type: 'cast', iid: hand('Mountain').iid });

  act({ type: 'tap', iid: alice.zones.battlefield[0].iid });
  assert.equal(alice.pool.R, 1);
  act({ type: 'cast', iid: hand('Lava Spike').iid });
  assert.equal(alice.pool.R, 0);
  assert.equal(alice.zones.graveyard[0].name, 'Lava Spike');
  assert.match(room.log.at(-1).text, /ร่าย Lava Spike จ่าย \{R\}/);
});

test('mana empties when the phase changes', () => {
  const { act, alice, hand } = game();
  act({ type: 'cast', iid: hand('Mountain').iid });
  act({ type: 'tap', iid: alice.zones.battlefield[0].iid });
  act({ type: 'phase', phase: 'combat' });
  assert.equal(alice.pool.R, 0);
});

test('sorcery-speed cards need your own main phase; instants do not', () => {
  const { room, act, alice, hand } = game();
  act({ type: 'cast', iid: hand('Mountain').iid });
  act({ type: 'phase', phase: 'combat' });
  act({ type: 'tap', iid: alice.zones.battlefield[0].iid });
  assert.throws(() => act({ type: 'cast', iid: hand('Goblin Guide').iid }), /Main 1 \/ Main 2/);
  act({ type: 'cast', iid: hand('Lightning Bolt').iid });

  room.turn.active = 'bob-000002';
  assert.throws(() => act({ type: 'cast', iid: hand('Lava Spike').iid, }), /เฉพาะในเทิร์นของคุณ/);
});

test('reaching 0 life is announced', () => {
  const { room, act } = game();
  act({ type: 'life', delta: -20 });
  assert.match(room.log.at(-1).text, /Alice แพ้/);
});
