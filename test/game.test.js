'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../game');
const { parseDecklist } = require('../scryfall');

const card = (name, section = 'main') => ({ name, img: `https://img/${name}.jpg`, section });
const deck = (n = 40) => Array.from({ length: n }, (_, i) => card(`Card ${i}`));

function roomWithTwo() {
  const room = new Room('TEST');
  room.join('alice-0001', 'Alice');
  room.join('bob-000002', 'Bob');
  room.setDeck('alice-0001', deck());
  room.setDeck('bob-000002', deck());
  return room;
}

test('setDeck shuffles and draws an opening hand of 7', () => {
  const room = roomWithTwo();
  const view = room.viewFor('alice-0001');
  const alice = view.players[0];
  assert.equal(alice.hand.length, 7);
  assert.equal(alice.libraryCount, 33);
  assert.equal(alice.life, 20);
});

test('commander decks start with 40 life and the commander in the command zone', () => {
  const room = new Room('CMDR');
  room.join('carl-00001', 'Carl');
  room.setDeck('carl-00001', [...deck(99), card('Atraxa', 'commander')]);
  const carl = room.viewFor('carl-00001').players[0];
  assert.equal(carl.life, 40);
  assert.deepEqual(carl.command.map((c) => c.name), ['Atraxa']);
});

test('opponents never see your hand or face-down cards', () => {
  const room = roomWithTwo();
  const alice = room.players.get('alice-0001');
  const iid = alice.zones.hand[0].iid;
  room.act('alice-0001', { type: 'move', iid, to: 'battlefield', faceDown: true });

  const bobView = room.viewFor('bob-000002').players[0];
  assert.equal(bobView.hand, null);
  assert.equal(bobView.handCount, 6);
  assert.equal(bobView.battlefield[0].name, undefined);
  assert.equal(bobView.battlefield[0].faceDown, true);
  assert.ok(!room.log.at(-1).text.includes(alice.zones.battlefield[0].name));

  const aliceView = room.viewFor('alice-0001').players[0];
  assert.equal(aliceView.battlefield[0].name, alice.zones.battlefield[0].name);
});

test('cards leaving the battlefield lose tapped state and counters', () => {
  const room = roomWithTwo();
  const iid = room.players.get('alice-0001').zones.hand[0].iid;
  room.act('alice-0001', { type: 'move', iid, to: 'battlefield', x: 10, y: 10 });
  room.act('alice-0001', { type: 'tap', iid });
  room.act('alice-0001', { type: 'counter', iid, kind: '+1/+1', delta: 2 });
  room.act('alice-0001', { type: 'move', iid, to: 'graveyard' });
  const [c] = room.players.get('alice-0001').zones.graveyard;
  assert.equal(c.tapped, false);
  assert.deepEqual(c.counters, {});
});

test('library top/bottom placement and tokens vanish off the battlefield', () => {
  const room = roomWithTwo();
  const p = room.players.get('alice-0001');
  const [a, b] = p.zones.hand;
  room.act('alice-0001', { type: 'move', iid: a.iid, to: 'library', pos: 'top' });
  room.act('alice-0001', { type: 'move', iid: b.iid, to: 'library', pos: 'bottom' });
  assert.equal(p.zones.library[0].iid, a.iid);
  assert.equal(p.zones.library.at(-1).iid, b.iid);

  room.act('alice-0001', { type: 'token', name: 'Goblin', pt: '1/1' });
  const token = p.zones.battlefield[0];
  room.act('alice-0001', { type: 'move', iid: token.iid, to: 'graveyard' });
  assert.equal(p.zones.graveyard.length, 0);
});

test('a player cannot act on another player\'s cards', () => {
  const room = roomWithTwo();
  const bobCard = room.players.get('bob-000002').zones.hand[0].iid;
  assert.throws(() => room.act('alice-0001', { type: 'move', iid: bobCard, to: 'battlefield' }));
});

test('rooms are capped at 4 players', () => {
  const room = new Room('FULL');
  for (let i = 0; i < 4; i++) room.join(`player-000${i}`, `P${i}`);
  assert.throws(() => room.join('player-0004', 'P4'));
  assert.doesNotThrow(() => room.join('player-0001', 'P1 again'));
});

test('ending a turn passes to the opponent, untapping and drawing for them', () => {
  const room = roomWithTwo();
  assert.throws(() => room.act('alice-0001', { type: 'endTurn' }), /ยังไม่ได้เริ่มเกม/);
  room.act('alice-0001', { type: 'startGame' });
  const first = room.turn.active;
  const second = first === 'alice-0001' ? 'bob-000002' : 'alice-0001';
  assert.throws(() => room.act(second, { type: 'endTurn' }), /ยังไม่ใช่เทิร์นของคุณ/);

  const p2 = room.players.get(second);
  room.act(second, { type: 'move', iid: p2.zones.hand[0].iid, to: 'battlefield' });
  room.act(second, { type: 'tap', iid: p2.zones.battlefield[0].iid });

  room.act(first, { type: 'endTurn' });
  assert.deepEqual(room.turn, { active: second, number: 2, phase: 'upkeep' });
  assert.equal(p2.zones.battlefield[0].tapped, false);
  assert.equal(p2.zones.hand.length, 7); // 7 - 1 played + 1 drawn

  room.act(second, { type: 'phase', phase: 'combat' });
  assert.equal(room.viewFor(first).turn.phase, 'combat');
});

test('parseDecklist handles Arena, Moxfield and plain formats', () => {
  const entries = parseDecklist(`Commander
1 Atraxa, Praetors' Voice

Deck
4 Lightning Bolt
1x Sol Ring (CMM) 400 *F*
Delver of Secrets // Insectile Aberration
SB: 2 Pyroblast

Sideboard
3 Abrade`);
  assert.deepEqual(entries.map((e) => [e.qty, e.name, e.section]), [
    [1, "Atraxa, Praetors' Voice", 'commander'],
    [4, 'Lightning Bolt', 'main'],
    [1, 'Sol Ring', 'main'],
    [1, 'Delver of Secrets // Insectile Aberration', 'main'],
    [2, 'Pyroblast', 'side'],
    [3, 'Abrade', 'side'],
  ]);
  assert.equal(entries[2].set, 'CMM');
  assert.equal(entries[2].cn, '400');
});

test('every preset deck has exactly 60 main-deck cards', () => {
  const { PRESET_DECKS } = require('../public/decks');
  for (const deck of PRESET_DECKS) {
    const total = parseDecklist(deck.list).reduce((sum, e) => sum + e.qty, 0);
    assert.equal(total, 60, deck.id);
  }
});

test('every card in the preset decks has a Thai explanation', () => {
  const { PRESET_DECKS } = require('../public/decks');
  const { CARD_TH } = require('../public/thai');
  const missing = PRESET_DECKS.flatMap((d) => parseDecklist(d.list)).map((e) => e.name).filter((n) => !CARD_TH[n]);
  assert.deepEqual(missing, []);
});

test('parseDecklist recognises Moxfield *CMDR* markers', () => {
  const [e] = parseDecklist('1 Krenko, Mob Boss *CMDR*');
  assert.equal(e.section, 'commander');
  assert.equal(e.name, 'Krenko, Mob Boss');
});
