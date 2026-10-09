'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, instantiate } = require('../game');

const A = 'alice-0001';
const B = 'bob-000002';

// Minimal card data, shaped like what scryfall.js produces.
const CARDS = {
  Mountain: { typeLine: 'Basic Land — Mountain', producedMana: ['R'] },
  Island: { typeLine: 'Basic Land — Island', producedMana: ['U'] },
  Swamp: { typeLine: 'Basic Land — Swamp', producedMana: ['B'] },
  Forest: { typeLine: 'Basic Land — Forest', producedMana: ['G'] },
  'Lightning Bolt': { typeLine: 'Instant', manaCost: '{R}', cmc: 1 },
  Counterspell: { typeLine: 'Instant', manaCost: '{U}{U}', cmc: 2 },
  Thoughtseize: { typeLine: 'Sorcery', manaCost: '{B}', cmc: 1 },
  'Goblin Guide': { typeLine: 'Creature — Goblin Scout', manaCost: '{R}', cmc: 1, power: 2, toughness: 2, keywords: ['Haste'] },
  'Young Wolf': { typeLine: 'Creature — Wolf', manaCost: '{G}', cmc: 1, power: 1, toughness: 1, keywords: ['Undying'] },
  'Grizzly Bears': { typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: 2, toughness: 2 },
  'Garruk\'s Companion': { typeLine: 'Creature — Beast', manaCost: '{G}{G}', cmc: 2, power: 3, toughness: 2, keywords: ['Trample'] },
  Rancor: { typeLine: 'Enchantment — Aura', manaCost: '{G}', cmc: 1 },
  'Murderous Rider': { typeLine: 'Creature — Human Assassin', manaCost: '{1}{B}{B}', cmc: 3, power: 2, toughness: 3, keywords: ['Lifelink'] },
  'Gray Merchant of Asphodel': { typeLine: 'Creature — Zombie', manaCost: '{3}{B}{B}', cmc: 5, power: 2, toughness: 4 },
  'Eidolon of the Great Revel': { typeLine: 'Enchantment Creature — Spirit', manaCost: '{R}{R}', cmc: 2, power: 2, toughness: 2 },
};
const card = (name) => ({ name, img: null, section: 'main', manaCost: '', cmc: 0, keywords: [], ...CARDS[name] });

// Two players with 40-card decks; each test then sets hands and battlefields directly.
function setup() {
  const room = new Room('ENG');
  room.join(A, 'Alice');
  room.join(B, 'Bob');
  room.setDeck(A, Array(40).fill(card('Mountain')));
  room.setDeck(B, Array(40).fill(card('Island')));
  room.turn = { active: A, number: 3, phase: 'main1' };
  const alice = room.players.get(A);
  const bob = room.players.get(B);
  const give = (p, names) => {
    p.zones.hand = names.map((n) => instantiate(card(n)));
    return p.zones.hand;
  };
  const put = (p, names) => names.map((n) => {
    const c = instantiate(card(n));
    room.enterBattlefield(p, c);
    c.enteredTurn = 1; // been there since an earlier turn
    return c;
  });
  return { room, alice, bob, give, put, act: (pid, a) => room.act(pid, a) };
}

const named = (cards, name) => cards.find((c) => c.name === name);

test('Lightning Bolt to the face lowers life', () => {
  const { room, alice, bob, give, put, act } = setup();
  put(alice, ['Mountain']);
  give(alice, ['Lightning Bolt']);
  act(A, { type: 'cast', iid: alice.zones.hand[0].iid, target: { type: 'player', pid: B } });
  assert.equal(bob.life, 17);
  assert.equal(alice.zones.graveyard[0].name, 'Lightning Bolt');
  assert.equal(room.stack.length, 0);
});

test('Lightning Bolt kills a creature', () => {
  const { alice, bob, give, put, act } = setup();
  put(alice, ['Mountain']);
  const [bear] = put(bob, ['Grizzly Bears']);
  give(alice, ['Lightning Bolt']);
  act(A, { type: 'cast', iid: alice.zones.hand[0].iid, target: { type: 'card', pid: B, iid: bear.iid } });
  assert.equal(bob.zones.battlefield.length, 0);
  assert.equal(bob.zones.graveyard[0].name, 'Grizzly Bears');
});

test('a player who can respond gets to counter the spell', () => {
  const { room, alice, bob, give, put, act } = setup();
  put(alice, ['Mountain']);
  put(bob, ['Island', 'Island']);
  give(alice, ['Lightning Bolt']);
  give(bob, ['Counterspell']);
  act(A, { type: 'cast', iid: alice.zones.hand[0].iid, target: { type: 'player', pid: B } });
  assert.equal(room.stack.length, 1, 'Bob holds Counterspell with mana up, so Bolt waits');
  assert.throws(() => act(A, { type: 'pass' }), /รอคู่แข่ง/);

  const bolt = room.stack[0];
  act(B, { type: 'cast', iid: bob.zones.hand[0].iid, target: { type: 'spell', sid: bolt.sid } });
  assert.equal(room.stack.length, 0);
  assert.equal(bob.life, 20);
  assert.deepEqual(alice.zones.graveyard.map((c) => c.name), ['Lightning Bolt']);
});

test('passing lets the spell resolve', () => {
  const { room, alice, bob, give, put, act } = setup();
  put(alice, ['Mountain']);
  put(bob, ['Island', 'Island']);
  give(alice, ['Lightning Bolt']);
  give(bob, ['Counterspell']);
  act(A, { type: 'cast', iid: alice.zones.hand[0].iid, target: { type: 'player', pid: B } });
  act(B, { type: 'pass' });
  assert.equal(room.stack.length, 0);
  assert.equal(bob.life, 17);
});

test('unblocked attackers hit the player; blocked ones trade', () => {
  const { room, alice, bob, put, act } = setup();
  const [guide, bear] = put(alice, ['Goblin Guide', 'Grizzly Bears']);
  const [blocker] = put(bob, ['Grizzly Bears']);
  act(A, { type: 'phase', phase: 'combat' });
  act(A, { type: 'attack', iid: guide.iid });
  act(A, { type: 'attack', iid: bear.iid });
  act(B, { type: 'block', iid: blocker.iid, attacker: bear.iid });
  act(A, { type: 'phase', phase: 'main2' });

  assert.equal(bob.life, 18); // Goblin Guide unblocked
  assert.ok(!alice.zones.battlefield.includes(bear));
  assert.equal(bob.zones.battlefield.length, 0);
  assert.equal(room.turn.phase, 'main2');
});

test('summoning-sick creatures cannot attack; trample and lifelink work', () => {
  const { alice, bob, put, act, room } = setup();
  const [companion, rider] = put(alice, ["Garruk's Companion", 'Murderous Rider']);
  const [wolf] = put(bob, ['Young Wolf']);
  const [fresh] = put(alice, ['Grizzly Bears']);
  fresh.enteredTurn = room.turn.number;
  act(A, { type: 'phase', phase: 'combat' });
  assert.throws(() => act(A, { type: 'attack', iid: fresh.iid }), /summoning sickness/);

  act(A, { type: 'attack', iid: companion.iid });
  act(A, { type: 'attack', iid: rider.iid });
  act(B, { type: 'block', iid: wolf.iid, attacker: companion.iid });
  alice.life = 10;
  act(A, { type: 'phase', phase: 'main2' });

  assert.equal(bob.life, 20 - 2 - 2); // 2 trample over the 1/1 wolf + 2 from the Rider
  assert.equal(alice.life, 12); // Lifelink
  // Young Wolf died without a +1/+1 counter, so Undying brought it back.
  const back = named(bob.zones.battlefield, 'Young Wolf');
  assert.equal(back.counters['+1/+1'], 1);
});

test('Thoughtseize lets the caster pick a card from the opponent\'s hand', () => {
  const { room, alice, bob, give, put, act } = setup();
  put(alice, ['Swamp']);
  give(alice, ['Thoughtseize']);
  give(bob, ['Counterspell', 'Island']);
  act(A, { type: 'cast', iid: alice.zones.hand[0].iid, target: { type: 'player', pid: B } });
  assert.equal(alice.life, 18);
  assert.equal(room.choice.pid, A);
  assert.equal(room.choice.options.length, 1, 'lands cannot be chosen');
  assert.ok(room.viewFor(A).choice.cards.some((c) => c.name === 'Counterspell'));
  assert.equal(room.viewFor(B).choice.waitingFor, 'Alice');

  act(A, { type: 'choose', iid: room.choice.options[0] });
  assert.deepEqual(bob.zones.hand.map((c) => c.name), ['Island']);
  assert.equal(bob.zones.graveyard[0].name, 'Counterspell');
});

test('Gray Merchant drains for devotion to black', () => {
  const { alice, bob, give, put, act } = setup();
  put(alice, ['Swamp', 'Swamp', 'Swamp', 'Swamp', 'Swamp', 'Murderous Rider']);
  give(alice, ['Gray Merchant of Asphodel']);
  act(A, { type: 'cast', iid: alice.zones.hand[0].iid });
  // {B}{B} on the Merchant + {B}{B} on the Rider = 4
  assert.equal(bob.life, 16);
  assert.equal(alice.life, 24);
});

test('Rancor gives +2/+0 and trample, and returns to hand when its creature dies', () => {
  const { room, alice, bob, give, put, act } = setup();
  put(alice, ['Forest', 'Mountain']);
  const [bear] = put(alice, ['Grizzly Bears']);
  give(alice, ['Rancor', 'Lightning Bolt']);
  act(A, { type: 'cast', iid: named(alice.zones.hand, 'Rancor').iid, target: { type: 'card', pid: A, iid: bear.iid } });
  const s = room.stats(bear);
  assert.equal(s.power, 4);
  assert.ok(s.keywords.includes('Trample'));

  act(A, { type: 'cast', iid: named(alice.zones.hand, 'Lightning Bolt').iid, target: { type: 'card', pid: A, iid: bear.iid } });
  assert.ok(named(alice.zones.hand, 'Rancor'));
  assert.equal(bob.life, 20);
});

test('Eidolon punishes cheap spells, including its controller\'s', () => {
  const { alice, give, put, act } = setup();
  put(alice, ['Mountain', 'Eidolon of the Great Revel']);
  give(alice, ['Lightning Bolt']);
  act(A, { type: 'cast', iid: alice.zones.hand[0].iid, target: { type: 'player', pid: B } });
  assert.equal(alice.life, 18);
});

test('ending the turn clears damage and pumps', () => {
  const { room, alice, bob, put, act } = setup();
  const [bear] = put(bob, ['Grizzly Bears']);
  bear.damage = 1;
  bear.buff = { power: 3, toughness: 3 };
  act(A, { type: 'endTurn' });
  assert.equal(bear.damage, 0);
  assert.deepEqual(bear.buff, { power: 0, toughness: 0 });
  assert.equal(room.turn.active, B);
  assert.ok(alice);
});
