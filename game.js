'use strict';
// Game state for one room. The server is the source of truth: clients only send
// intents ("cast card X targeting Y"), and each client receives a view filtered
// so hidden information (library, opponents' hands, face-down cards) never leaks.
//
// The rules engine is deliberately light: spells go on a stack the opponent can respond to,
// scripted cards (effects.js) resolve automatically, combat damage and creature death are
// computed, and anything unscripted can still be done by hand.

const crypto = require('crypto');
const {
  COLORS, RuleError, emptyPool, isLand, isPermanent, isInstantSpeed, payCost, planAutoTap, checkTiming,
} = require('./public/rules');
const { EFFECTS, TRIGGER_CARDS } = require('./effects');

const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
const PUBLIC_ZONES = ['battlefield', 'graveyard', 'exile', 'command'];
const ZONE_LABEL = {
  library: 'Library',
  hand: 'มือ',
  battlefield: 'สนาม',
  graveyard: 'สุสาน',
  exile: 'Exile',
  command: 'Command Zone',
};
const MAX_PLAYERS = 4;
const PHASES = ['untap', 'upkeep', 'draw', 'main1', 'combat', 'main2', 'end'];
const LOG_LIMIT = 200;
const TOKEN_TYPES = {
  Treasure: { typeLine: 'Token Artifact — Treasure', producedMana: ['W', 'U', 'B', 'R', 'G'] },
  Clue: { typeLine: 'Token Artifact — Clue' },
  Food: { typeLine: 'Token Artifact — Food' },
};

const uid = () => crypto.randomBytes(6).toString('hex');
const emptyZones = () => Object.fromEntries(ZONES.map((z) => [z, []]));
const isCreature = (card) => /\bCreature\b/.test(card.typeLine || '');
const hasKeyword = (card, kw) => (card.keywords || []).includes(kw);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function toInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toPercent(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(0, n)) * 10) / 10;
}

function instantiate(card) {
  const effect = EFFECTS[card.name];
  return {
    iid: uid(),
    name: card.name,
    img: card.img || null,
    back: card.back || null,
    backName: card.backName || null,
    typeLine: card.typeLine || '',
    manaCost: card.manaCost || '',
    cmc: card.cmc ?? 0,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    producedMana: card.producedMana || [],
    keywords: card.keywords || [],
    oracleText: card.oracleText || '',
    // What the client needs to know to ask for a target and label the card.
    targetSpec: effect?.target || null,
    targetOptional: Boolean(effect?.optional),
    automated: Boolean(effect) || TRIGGER_CARDS.has(card.name),
    tapped: false,
    faceDown: false,
    transformed: false,
    counters: {},
    x: 0,
    y: 0,
    token: false,
    ...freshBattlefieldState(),
  };
}

function freshBattlefieldState() {
  return { damage: 0, deathtouched: false, buff: { power: 0, toughness: 0 }, attacking: false, blocking: null, attachedTo: null, enteredTurn: null };
}

function clearBattlefieldState(card) {
  card.tapped = false;
  card.faceDown = false;
  card.transformed = false;
  card.counters = {};
  Object.assign(card, freshBattlefieldState());
}

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.order = [];
    this.log = [];
    this.turn = null; // { active: pid, number, phase } once someone starts the game
    this.stack = []; // [{ sid, pid, card, target, x, y }], last item resolves first
    this.choice = null; // { pid, fromPid, action: 'discard'|'sacrifice', options: [iid], title }
    this.lastActive = Date.now();
  }

  requireActive(pid) {
    if (!this.turn) throw new Error('ยังไม่ได้เริ่มเกม กด "สุ่มคนเริ่ม" ก่อน');
    if (this.turn.active !== pid) throw new Error('ยังไม่ใช่เทิร์นของคุณ');
  }

  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  join(pid, name) {
    const existing = this.players.get(pid);
    if (existing) {
      existing.name = name;
      existing.connected = true;
      this.addLog(`${name} กลับเข้าห้อง`);
      return existing;
    }
    if (this.players.size >= MAX_PLAYERS) throw new Error(`ห้องเต็มแล้ว (สูงสุด ${MAX_PLAYERS} คน)`);
    const player = {
      id: pid,
      name,
      life: 20,
      poison: 0,
      pool: emptyPool(),
      landsPlayed: 0,
      damagedThisTurn: false,
      revolt: false,
      deck: null,
      zones: emptyZones(),
      connected: true,
    };
    this.players.set(pid, player);
    this.order.push(pid);
    this.addLog(`${name} เข้าห้อง`);
    return player;
  }

  disconnect(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    p.connected = false;
    this.addLog(`${p.name} หลุดจากห้อง`);
    this.autoPass(); // don't leave the other player waiting on someone who left
  }

  get anyoneConnected() {
    return [...this.players.values()].some((p) => p.connected);
  }

  player(pid) {
    const p = this.players.get(pid);
    if (!p) throw new Error('ไม่พบผู้เล่นในห้องนี้');
    return p;
  }

  opponentsOf(p) {
    return [...this.players.values()].filter((q) => q !== p);
  }

  setDeck(pid, cards) {
    const p = this.player(pid);
    p.deck = cards;
    this.reset(pid);
    const main = cards.filter((c) => c.section === 'main').length;
    const cmd = cards.filter((c) => c.section === 'commander').length;
    this.addLog(`${p.name} โหลดเด็ค ${main} ใบ${cmd ? ` + Commander ${cmd} ใบ` : ''}`);
  }

  // Starts a fresh game for this player: rebuilds zones from the decklist,
  // shuffles and draws an opening hand.
  reset(pid) {
    const p = this.player(pid);
    if (!p.deck) throw new Error('ยังไม่ได้โหลดเด็ค');
    this.stack = this.stack.filter((s) => s.pid !== pid);
    if (this.choice && (this.choice.pid === pid || this.choice.fromPid === pid)) this.choice = null;
    p.zones = emptyZones();
    for (const card of p.deck) {
      if (card.section === 'main') p.zones.library.push(instantiate(card));
      else if (card.section === 'commander') p.zones.command.push(instantiate(card));
    }
    shuffle(p.zones.library);
    p.life = p.zones.command.length ? 40 : 20;
    p.poison = 0;
    p.pool = emptyPool();
    p.landsPlayed = 0;
    p.damagedThisTurn = false;
    p.revolt = false;
    this.drawCards(p, 7, { triggers: false });
  }

  drawCards(p, n, { triggers = true } = {}) {
    const drawn = p.zones.library.splice(0, n);
    p.zones.hand.push(...drawn);
    if (triggers && drawn.length) {
      // Sheoldred, the Apocalypse: you gain 2 per card you draw, opponents lose 2 per card they draw.
      for (const q of this.players.values()) {
        for (const s of q.zones.battlefield.filter((c) => c.name === 'Sheoldred, the Apocalypse' && !c.faceDown)) {
          if (q === p) this.gainLife(p, 2 * drawn.length, s.name);
          else this.loseLife(p, 2 * drawn.length, s.name);
        }
      }
    }
    return drawn.length;
  }

  draw(p, n) {
    const drawn = this.drawCards(p, n);
    this.addLog(`${p.name} จั่ว ${drawn} ใบ`);
  }

  find(p, iid) {
    for (const zone of ZONES) {
      const index = p.zones[zone].findIndex((c) => c.iid === iid);
      if (index !== -1) return { zone, index, card: p.zones[zone][index] };
    }
    return null;
  }

  battlefieldCard(p, iid) {
    const card = p.zones.battlefield.find((c) => c.iid === iid);
    if (!card) throw new Error('ไม่พบการ์ดบนสนาม');
    return card;
  }

  placeOnBattlefield(p, card, x, y) {
    const px = toPercent(x, 94);
    const py = toPercent(y, 85);
    if (px !== null && py !== null) {
      card.x = px;
      card.y = py;
      return;
    }
    // No drop position: lands line up along the back row, everything else in front.
    const rowY = isLand(card) ? 58 : 6;
    const spot = (slot) => ({ x: 2 + (slot % 11) * 8.5, y: rowY + Math.floor(slot / 11) * 14 });
    const others = p.zones.battlefield.filter((c) => c !== card);
    let slot = 0;
    const isTaken = ({ x: sx, y: sy }) => others.some((c) => Math.abs(c.x - sx) < 4 && Math.abs(c.y - sy) < 7);
    while (slot < 21 && isTaken(spot(slot))) slot += 1;
    Object.assign(card, spot(slot));
  }

  label(card, visible) {
    return visible ? card.name : 'การ์ด 1 ใบ';
  }

  // ---------- life and damage ----------

  checkLoss(q, beforeLife) {
    if (beforeLife > 0 && q.life <= 0) this.addLog(`💀 ${q.name} แพ้! (Life เหลือ ${q.life})`);
  }

  loseLife(q, n, source = '') {
    if (n <= 0) return 0;
    const before = q.life;
    q.life -= n;
    this.addLog(`🩸 ${q.name} เสีย ${n} Life${source ? ` จาก ${source}` : ''} (${before} → ${q.life})`);
    this.checkLoss(q, before);
    return n;
  }

  gainLife(q, n, source = '') {
    if (n <= 0) return;
    const before = q.life;
    q.life += n;
    this.addLog(`💚 ${q.name} ได้ ${n} Life${source ? ` จาก ${source}` : ''} (${before} → ${q.life})`);
  }

  // Deals damage from a source ({ card, p }) to a resolved target (player or creature).
  damage(src, target, n) {
    if (!target || n <= 0) return;
    const from = src.card.name;
    if (target.type === 'player') {
      const q = target.player;
      const before = q.life;
      q.life -= n;
      q.damagedThisTurn = true;
      this.addLog(`🔥 ${from} ทำ ${n} damage ใส่ ${q.name} (Life ${before} → ${q.life})`);
      this.checkLoss(q, before);
    } else if (target.type === 'card') {
      target.card.damage += n;
      if (this.stats(src.card).keywords.includes('Deathtouch')) target.card.deathtouched = true;
      this.addLog(`🔥 ${from} ทำ ${n} damage ใส่ ${target.card.name}`);
    }
    if (src.p && this.stats(src.card).keywords.includes('Lifelink')) this.gainLife(src.p, n, `${from} (Lifelink)`);
  }

  // Effective power/toughness/keywords including counters, until-end-of-turn buffs and auras.
  stats(card) {
    let power = card.power ?? 0;
    let toughness = card.toughness ?? 0;
    const keywords = new Set(card.keywords || []);
    const plus = card.counters?.['+1/+1'] || 0;
    const minus = card.counters?.['-1/-1'] || 0;
    power += plus - minus + (card.buff?.power || 0);
    toughness += plus - minus + (card.buff?.toughness || 0);
    for (const q of this.players.values()) {
      for (const aura of q.zones.battlefield) {
        const bonus = aura.attachedTo === card.iid && EFFECTS[aura.name]?.aura;
        if (!bonus) continue;
        power += bonus.power;
        toughness += bonus.toughness;
        for (const kw of bonus.keywords) keywords.add(kw);
      }
    }
    return { power, toughness, keywords: [...keywords] };
  }

  pump(target, power, toughness) {
    target.card.buff.power += power;
    target.card.buff.toughness += toughness;
    const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
    this.addLog(`💪 ${target.card.name} ได้ ${sign(power)}/${sign(toughness)} จนจบเทิร์น`);
  }

  // ---------- moving cards in and out of play ----------

  enterBattlefield(p, card, { x, y, counters } = {}) {
    Object.assign(card, freshBattlefieldState());
    card.enteredTurn = this.turn?.number ?? 0;
    if (counters) card.counters = { ...counters };
    // Bloodthirst 1: enters with a +1/+1 counter if an opponent was damaged this turn.
    if (hasKeyword(card, 'Bloodthirst') && this.opponentsOf(p).some((o) => o.damagedThisTurn)) {
      card.counters['+1/+1'] = (card.counters['+1/+1'] || 0) + 1;
      this.addLog(`🩸 ${card.name}: Bloodthirst ได้ +1/+1 counter`);
    }
    this.placeOnBattlefield(p, card, x, y);
    p.zones.battlefield.push(card);
  }

  // Takes a card off the battlefield into `to` ('graveyard' | 'exile' | 'hand' | 'libraryBottom').
  leaveBattlefield(owner, card, to) {
    const index = owner.zones.battlefield.indexOf(card);
    if (index === -1) return;
    owner.zones.battlefield.splice(index, 1);
    owner.revolt = true;
    // Blockers of an attacker that left stop blocking; auras on it fall off.
    for (const q of this.players.values()) {
      for (const c of q.zones.battlefield) if (c.blocking === card.iid) c.blocking = null;
    }
    const auras = [...this.players.values()].flatMap((q) => q.zones.battlefield.filter((c) => c.attachedTo === card.iid).map((c) => [q, c]));
    clearBattlefieldState(card);
    if (card.token) {
      this.addLog(`${card.name} (Token) ออกจากเกม`);
    } else if (to === 'libraryBottom') {
      owner.zones.library.push(card);
    } else {
      owner.zones[to].push(card);
    }
    for (const [q, aura] of auras) this.auraFallsOff(q, aura);
  }

  auraFallsOff(owner, aura) {
    // Rancor returns to its owner's hand instead of staying in the graveyard.
    const to = aura.name === 'Rancor' ? 'hand' : 'graveyard';
    this.leaveBattlefield(owner, aura, to);
    this.addLog(`${aura.name} หลุดออก → ${ZONE_LABEL[to]}`);
  }

  dies(owner, card, reason = '') {
    const undying = hasKeyword(card, 'Undying') && !card.counters['+1/+1'] && !card.token;
    // Murderous Rider goes to the bottom of its owner's library instead of the graveyard.
    const to = card.name === 'Murderous Rider' ? 'libraryBottom' : 'graveyard';
    this.leaveBattlefield(owner, card, to);
    this.addLog(`💥 ${card.name} ตาย${reason}${to === 'libraryBottom' ? ' → ล่างสุดของ Library' : ''}`);
    if (undying) {
      owner.zones.graveyard.splice(owner.zones.graveyard.indexOf(card), 1);
      this.enterBattlefield(owner, card, { counters: { '+1/+1': 1 } });
      this.addLog(`🐺 ${card.name}: Undying กลับสนามพร้อม +1/+1 counter`);
    }
  }

  destroy(target) {
    this.dies(target.owner, target.card, ' (ถูกทำลาย)');
  }

  exileFromBattlefield(target) {
    this.leaveBattlefield(target.owner, target.card, 'exile');
    this.addLog(`🌀 ${target.card.name} ถูก exile`);
  }

  blink(target) {
    const { owner, card } = target;
    this.leaveBattlefield(owner, card, 'exile');
    owner.zones.exile.splice(owner.zones.exile.indexOf(card), 1);
    this.enterBattlefield(owner, card);
    this.addLog(`✨ ${card.name} ถูก blink (exile แล้วกลับสนาม)`);
    const etb = EFFECTS[card.name]?.etb;
    if (etb && !EFFECTS[card.name].target) etb(this, { p: owner, card, target: null });
  }

  createToken(p, name, pt = '') {
    const preset = TOKEN_TYPES[name] || {};
    const [power, toughness] = pt.split('/').map((v) => Number.parseInt(v, 10));
    const card = {
      ...instantiate({ name, typeLine: preset.typeLine || (pt ? `Token Creature — ${name}` : `Token — ${name}`), producedMana: preset.producedMana }),
      token: true,
      pt,
      power: Number.isFinite(power) ? power : null,
      toughness: Number.isFinite(toughness) ? toughness : null,
    };
    this.enterBattlefield(p, card);
    this.addLog(`${p.name} สร้าง Token ${name}${pt ? ` ${pt}` : ''}`);
    return card;
  }

  // State-based actions: creatures with lethal damage or 0 toughness die; orphaned auras fall off.
  checkState() {
    for (let guard = 0; guard < 50; guard++) {
      let changed = false;
      for (const q of this.players.values()) {
        for (const card of [...q.zones.battlefield]) {
          // Creatures with unknown stats (e.g. hand-made tokens without P/T) are left to the players.
          if (isCreature(card) && !card.faceDown && card.toughness != null) {
            const { toughness } = this.stats(card);
            if (toughness <= 0 || card.damage >= toughness || (card.deathtouched && card.damage > 0)) {
              this.dies(q, card);
              changed = true;
            }
          } else if (card.attachedTo && !this.findOnBattlefield(card.attachedTo)) {
            this.auraFallsOff(q, card);
            changed = true;
          }
        }
      }
      if (!changed) return;
    }
  }

  findOnBattlefield(iid) {
    for (const q of this.players.values()) {
      const card = q.zones.battlefield.find((c) => c.iid === iid);
      if (card) return { owner: q, card };
    }
    return null;
  }

  // ---------- manual moves ----------

  move(p, { iid, to, x, y, pos, faceDown }) {
    if (!ZONES.includes(to)) throw new Error('โซนปลายทางไม่ถูกต้อง');
    const found = this.find(p, iid);
    if (!found) throw new Error('ไม่พบการ์ด');
    const { zone: from, card } = found;

    if (from === 'battlefield' && to === 'battlefield') {
      this.placeOnBattlefield(p, card, x, y);
      return;
    }
    if (from === to && to !== 'library') return;

    const wasHidden = from === 'battlefield' && card.faceDown;
    if (from === 'battlefield') {
      this.leaveBattlefield(p, card, to === 'library' ? 'library' : to);
      if (card.token) return;
      // leaveBattlefield appended the card; put library cards where the player asked.
      if (to === 'library') {
        p.zones.library.pop();
        if (pos === 'bottom') p.zones.library.push(card);
        else p.zones.library.unshift(card);
      }
    } else {
      p.zones[from].splice(found.index, 1);
      if (to === 'battlefield') {
        this.enterBattlefield(p, card, { x, y });
        card.faceDown = Boolean(faceDown);
      } else if (to === 'library' && pos === 'bottom') {
        p.zones.library.push(card);
      } else if (to === 'library') {
        p.zones.library.unshift(card);
      } else {
        p.zones[to].push(card);
      }
    }

    const isPublic = (z) => PUBLIC_ZONES.includes(z);
    const visible =
      (isPublic(from) && !wasHidden) || (isPublic(to) && !(to === 'battlefield' && card.faceDown));
    const where = to === 'library' ? `${pos === 'bottom' ? 'ล่างสุด' : 'บนสุด'}ของ Library` : ZONE_LABEL[to];
    this.addLog(`${p.name} ย้าย ${this.label(card, visible)}: ${ZONE_LABEL[from]} → ${where}`);
    this.checkState();
  }

  // Mana empties from every pool whenever the step or phase changes.
  emptyPools() {
    for (const q of this.players.values()) q.pool = emptyPool();
  }

  manaSources(p) {
    return p.zones.battlefield
      .filter((c) => !c.tapped && !c.faceDown && c.producedMana?.length)
      .map((c) => ({ iid: c.iid, colors: c.producedMana }));
  }

  // Pays `cost` from the mana pool, tapping untapped lands/mana creatures for whatever is missing.
  payWithAutoTap(p, cost) {
    try {
      return payCost(cost, p.pool);
    } catch (err) {
      const plan = planAutoTap(cost, p.pool, this.manaSources(p));
      if (!plan) throw err;
      for (const { iid, color } of plan) {
        p.zones.battlefield.find((c) => c.iid === iid).tapped = true;
        p.pool[color] += 1;
      }
      const names = plan.map(({ iid, color }) => `${p.zones.battlefield.find((c) => c.iid === iid).name} (${color})`);
      this.addLog(`${p.name} tap อัตโนมัติ: ${names.join(', ')}`);
      return payCost(cost, p.pool);
    }
  }

  // Pays an optional extra cost if possible (Kicker, Mana Leak). Returns whether it was paid.
  tryPay(p, cost, why) {
    try {
      const { pool, life } = this.payWithAutoTap(p, cost);
      p.pool = pool;
      p.life -= life;
      this.addLog(`${p.name} จ่าย ${cost} (${why})`);
      return true;
    } catch {
      return false;
    }
  }

  canAfford(p, cost) {
    try {
      payCost(cost, p.pool);
      return true;
    } catch {
      return planAutoTap(cost, p.pool, this.manaSources(p)) !== null;
    }
  }

  // ---------- targets ----------

  playerTarget(pid) {
    const player = this.players.get(pid);
    return player ? { type: 'player', pid, player } : null;
  }

  // Raw target from the client -> live objects, or null if it no longer exists.
  resolveTarget(t) {
    if (!t || typeof t !== 'object') return null;
    if (t.type === 'player') return this.playerTarget(t.pid);
    if (t.type === 'card') {
      const owner = this.players.get(t.pid);
      const card = owner?.zones.battlefield.find((c) => c.iid === t.iid);
      return card ? { type: 'card', pid: owner.id, owner, card } : null;
    }
    if (t.type === 'spell') {
      const item = this.stack.find((s) => s.sid === t.sid);
      return item ? { type: 'spell', item } : null;
    }
    return null;
  }

  checkTarget(spec, target, p) {
    const creature = target.type === 'card' && isCreature(target.card) && !target.card.faceDown;
    const ok = {
      any: target.type === 'player' || creature,
      player: target.type === 'player',
      opponent: target.type === 'player' && target.pid !== p.id,
      creature,
      oppCreature: creature && target.pid !== p.id,
      myCreature: creature && target.pid === p.id,
      spell: target.type === 'spell',
    }[spec];
    if (!ok) throw new RuleError('เป้าหมายนี้ใช้กับการ์ดใบนี้ไม่ได้');
    const kws = target.type === 'card' ? this.stats(target.card).keywords : [];
    if (kws.includes('Hexproof') && target.pid !== p.id) throw new RuleError(`${target.card.name} มี Hexproof เลือกเป็นเป้าหมายไม่ได้`);
  }

  describeTarget(target) {
    if (!target) return '';
    if (target.type === 'player') return ` → 🎯 ${target.player.name}`;
    if (target.type === 'card') return ` → 🎯 ${target.card.name}`;
    return ` → 🎯 สเปล ${target.item.card.name}`;
  }

  // ---------- casting and the stack ----------

  // Playing a card from hand the normal way: checks timing, land drops, targets and mana,
  // unless the player chose to override (a.force), which is logged for everyone.
  cast(p, { iid, x, y, force, target: rawTarget }) {
    const card = p.zones.hand.find((c) => c.iid === iid);
    if (!card) throw new Error('ไม่พบการ์ดในมือ');
    const effect = EFFECTS[card.name];
    const forced = force ? ' ⚠️ (ข้ามกติกา)' : '';

    if (isLand(card)) {
      if (!force) {
        checkTiming(card, p.id, this.turn);
        if (this.stack.length) throw new RuleError('ลง Land ได้เฉพาะตอน stack ว่าง');
        if (p.landsPlayed >= 1) throw new RuleError('ลง Land ได้เทิร์นละ 1 ใบ เทิร์นนี้ลงไปแล้ว');
      }
      p.zones.hand.splice(p.zones.hand.indexOf(card), 1);
      p.landsPlayed += 1;
      this.enterBattlefield(p, card, { x, y });
      this.addLog(`${p.name} ลง Land ${card.name}${forced}`);
      this.landfall(p);
      return;
    }

    const target = this.resolveTarget(rawTarget);
    if (effect?.target && !target && !effect.optional) throw new Error('ต้องเลือกเป้าหมายก่อน');
    if (!force) {
      checkTiming(card, p.id, this.turn);
      if (this.stack.length && !isInstantSpeed(card)) throw new RuleError('ร่ายได้เฉพาะตอน stack ว่าง (ยกเว้น Instant/Flash)');
      if (target) {
        this.checkTarget(effect.target, target, p);
        effect.check?.(this, { p, card, target });
      }
    }

    let paid = '';
    if (!force) {
      const cost = effect?.altCost?.(this, { p, card }) || card.manaCost;
      const payment = this.payWithAutoTap(p, cost);
      p.pool = payment.pool;
      if (payment.life) this.loseLife(p, payment.life, 'Phyrexian mana');
      paid = ` จ่าย ${cost || '0'}`;
    }

    p.zones.hand.splice(p.zones.hand.indexOf(card), 1);
    const item = { sid: uid(), pid: p.id, card, target: target ? rawTarget : null, x, y };
    this.stack.push(item);
    this.addLog(`${p.name} ร่าย ${card.name}${paid}${this.describeTarget(target)}${forced}`);
    this.castTriggers(p, card);
    this.autoPass();
  }

  castTriggers(p, card) {
    // Prowess: noncreature spells pump your Prowess creatures.
    if (!isCreature(card)) {
      for (const c of p.zones.battlefield.filter((x) => hasKeyword(x, 'Prowess') && !x.faceDown)) {
        c.buff.power += 1;
        c.buff.toughness += 1;
        this.addLog(`⚡ ${c.name}: Prowess +1/+1`);
      }
    }
    // Eidolon of the Great Revel: whoever casts a spell with mana value 3 or less takes 2.
    if (card.cmc <= 3) {
      for (const q of this.players.values()) {
        for (const e of q.zones.battlefield.filter((x) => x.name === 'Eidolon of the Great Revel' && !x.faceDown)) {
          this.damage({ card: e, p: q }, this.playerTarget(p.id), 2);
        }
      }
    }
  }

  landfall(p) {
    // Bloodghast returns from the graveyard whenever its owner plays a land.
    for (const ghost of p.zones.graveyard.filter((c) => c.name === 'Bloodghast')) {
      p.zones.graveyard.splice(p.zones.graveyard.indexOf(ghost), 1);
      this.enterBattlefield(p, ghost);
      this.addLog(`👻 Bloodghast กลับจากสุสานสู่สนาม (Landfall)`);
    }
  }

  // The player who gets to respond to the top of the stack: the next player after its controller.
  responderFor(item) {
    const i = this.order.indexOf(item.pid);
    return this.players.get(this.order[(i + 1) % this.order.length]);
  }

  canRespond(q) {
    return q.zones.hand.some((c) => isInstantSpeed(c) && !isLand(c) && this.canAfford(q, c.manaCost));
  }

  // Resolves the stack until someone who could respond needs to decide.
  autoPass() {
    for (let guard = 0; guard < 30 && this.stack.length; guard++) {
      const responder = this.responderFor(this.stack.at(-1));
      if (responder && responder !== this.players.get(this.stack.at(-1).pid) && responder.connected && this.canRespond(responder)) return;
      this.resolveTop();
    }
  }

  resolveTop() {
    const item = this.stack.pop();
    const p = this.players.get(item.pid);
    const { card } = item;
    const effect = EFFECTS[card.name];
    const target = this.resolveTarget(item.target);
    const lostTarget = item.target && !target;
    const ctx = { p, card, target };

    if (isPermanent(card)) {
      if (effect?.aura) {
        if (!target) {
          p.zones.graveyard.push(card);
          this.addLog(`${card.name} ไม่มีเป้าหมาย → สุสาน`);
          return;
        }
        this.enterBattlefield(p, card);
        card.attachedTo = target.card.iid;
        card.x = Math.min(94, target.card.x + 2);
        card.y = Math.min(85, target.card.y + 6);
        this.addLog(`✅ ${card.name} ติดบน ${target.card.name}`);
      } else {
        this.enterBattlefield(p, card, { x: item.x, y: item.y });
        this.addLog(`✅ ${card.name} ลงสนาม`);
        if (effect?.etb && !lostTarget) effect.etb(this, ctx);
      }
    } else {
      if (lostTarget) {
        this.addLog(`💨 ${card.name} ไม่มีผล (เป้าหมายหายไปแล้ว)`);
      } else if (effect?.resolve) {
        this.addLog(`✅ ${card.name} ทำงาน`);
        effect.resolve(this, ctx);
      } else {
        this.addLog(`📝 ${card.name}: ยังไม่มีเอฟเฟคอัตโนมัติ ทำตามคำอธิบายการ์ดเอง`);
      }
      p.zones.graveyard.push(card);
    }
    this.checkState();
  }

  removeFromStack(item, to) {
    const i = this.stack.indexOf(item);
    if (i === -1) return;
    this.stack.splice(i, 1);
    this.players.get(item.pid).zones[to].push(item.card);
  }

  counterSpell(target) {
    this.removeFromStack(target.item, 'graveyard');
    this.addLog(`🚫 ${target.item.card.name} ถูก counter`);
  }

  counterUnlessPay(target, cost) {
    const owner = this.players.get(target.item.pid);
    if (this.tryPay(owner, cost, `เพื่อไม่ให้ ${target.item.card.name} ถูก counter`)) return;
    this.counterSpell(target);
  }

  exileSpell(target) {
    this.removeFromStack(target.item, 'exile');
    this.addLog(`🌀 สเปล ${target.item.card.name} ถูก exile`);
  }

  // ---------- choices (Thoughtseize, Liliana's Triumph...) ----------

  chooseDiscard(chooser, from, filter, title) {
    const options = from.zones.hand.filter(filter).map((c) => c.iid);
    this.addLog(`👁 ${chooser.name} ดูมือของ ${from.name}: ${from.zones.hand.map((c) => c.name).join(', ') || '(ว่าง)'}`);
    if (!options.length) {
      this.addLog('ไม่มีการ์ดที่เลือกได้');
      return;
    }
    this.choice = { pid: chooser.id, fromPid: from.id, action: 'discard', options, title };
  }

  chooseSacrifice(chooser, title) {
    const options = chooser.zones.battlefield.filter((c) => isCreature(c)).map((c) => c.iid);
    if (!options.length) {
      this.addLog(`${chooser.name} ไม่มี creature ให้ sacrifice`);
      return;
    }
    this.choice = { pid: chooser.id, fromPid: chooser.id, action: 'sacrifice', options, title };
  }

  choose(p, iid) {
    const choice = this.choice;
    if (!choice || choice.pid !== p.id) throw new Error('ไม่มีอะไรให้คุณเลือกตอนนี้');
    if (!choice.options.includes(iid)) throw new Error('เลือกการ์ดใบนี้ไม่ได้');
    const from = this.players.get(choice.fromPid);
    this.choice = null;
    if (choice.action === 'discard') {
      const card = from.zones.hand.find((c) => c.iid === iid);
      from.zones.hand.splice(from.zones.hand.indexOf(card), 1);
      from.zones.graveyard.push(card);
      this.addLog(`🗑 ${p.name} ให้ ${from.name} ทิ้ง ${card.name}`);
    } else {
      const card = from.zones.battlefield.find((c) => c.iid === iid);
      this.dies(from, card, ' (sacrifice)');
    }
    this.checkState();
  }

  // ---------- combat ----------

  attack(p, iid, force) {
    this.requireActive(p.id);
    const card = this.battlefieldCard(p, iid);
    if (card.attacking) {
      card.attacking = false;
      if (!hasKeyword(card, 'Vigilance')) card.tapped = false;
      this.addLog(`${p.name} ยกเลิกการโจมตีของ ${card.name}`);
      return;
    }
    if (!force) {
      if (this.turn.phase !== 'combat') throw new RuleError('ประกาศโจมตีได้ในขั้น Combat (กด ขั้นต่อไป ➜ ไป Combat ก่อน)');
      if (!isCreature(card)) throw new RuleError('โจมตีได้เฉพาะ creature');
      if (card.tapped) throw new RuleError(`${card.name} tap อยู่ โจมตีไม่ได้`);
      if (hasKeyword(card, 'Defender')) throw new RuleError(`${card.name} มี Defender โจมตีไม่ได้`);
      if (card.enteredTurn === this.turn.number && !this.stats(card).keywords.includes('Haste')) {
        throw new RuleError(`${card.name} เพิ่งลงสนามเทิร์นนี้ (summoning sickness) โจมตีไม่ได้ถ้าไม่มี Haste`);
      }
    }
    card.attacking = true;
    if (!hasKeyword(card, 'Vigilance')) card.tapped = true;
    this.addLog(`⚔️ ${p.name}: ${card.name} โจมตี!`);

    // Goblin Guide: the defending player reveals their top card and takes it if it's a land.
    if (card.name === 'Goblin Guide') {
      for (const o of this.opponentsOf(p)) {
        const top = o.zones.library[0];
        if (!top) continue;
        if (isLand(top)) {
          o.zones.library.shift();
          o.zones.hand.push(top);
        }
        this.addLog(`👺 Goblin Guide: ${o.name} เปิดการ์ดบนสุด ${top.name}${isLand(top) ? ' เป็น Land เก็บเข้ามือ' : ''}`);
      }
    }
  }

  block(p, iid, attackerIid, force) {
    if (!this.turn || this.turn.active === p.id) throw new Error('บล็อกได้เฉพาะตอนคู่แข่งโจมตี');
    const blocker = this.battlefieldCard(p, iid);
    if (blocker.blocking && (!attackerIid || blocker.blocking === attackerIid)) {
      blocker.blocking = null;
      this.addLog(`${p.name}: ${blocker.name} ยกเลิกการบล็อก`);
      return;
    }
    const attacker = this.findOnBattlefield(attackerIid)?.card;
    if (!attacker?.attacking) throw new Error('ต้องเลือก creature ที่กำลังโจมตี');
    if (!force) {
      if (!isCreature(blocker)) throw new RuleError('บล็อกได้เฉพาะ creature');
      if (blocker.tapped) throw new RuleError(`${blocker.name} tap อยู่ บล็อกไม่ได้`);
      if (blocker.name === 'Bloodghast') throw new RuleError('Bloodghast บล็อกไม่ได้');
      const atk = this.stats(attacker).keywords;
      const blk = this.stats(blocker).keywords;
      if (atk.includes('Flying') && !blk.includes('Flying') && !blk.includes('Reach')) {
        throw new RuleError(`${attacker.name} บินได้ ต้องบล็อกด้วย creature ที่มี Flying หรือ Reach`);
      }
      if (attacker.name === 'Brazen Borrower') { /* can block only fliers; irrelevant for being blocked */ }
      if (blocker.name === 'Brazen Borrower' && !atk.includes('Flying')) throw new RuleError('Brazen Borrower บล็อกได้เฉพาะ creature ที่บินได้');
      if (attacker.name === 'Skarrgan Pit-Skulk' && this.stats(blocker).power < this.stats(attacker).power) {
        throw new RuleError('creature ที่ power น้อยกว่า Skarrgan Pit-Skulk บล็อกมันไม่ได้');
      }
    }
    blocker.blocking = attacker.iid;
    this.addLog(`🛡 ${p.name}: ${blocker.name} บล็อก ${attacker.name}`);
  }

  // Combat damage, all at once (no first-strike step).
  resolveCombat() {
    const atkP = this.players.get(this.turn.active);
    const attackers = atkP.zones.battlefield.filter((c) => c.attacking);
    if (!attackers.length) return;
    const defenders = this.opponentsOf(atkP);
    const blockersOf = (a) => defenders.flatMap((q) => q.zones.battlefield.filter((c) => c.blocking === a.iid).map((card) => ({ card, owner: q })));
    const hits = []; // [src, target, amount], applied after everything is computed

    for (const a of attackers) {
      const as = this.stats(a);
      const blockers = blockersOf(a);
      if (!blockers.length) {
        hits.push([{ card: a, p: atkP }, this.playerTarget(defenders[0].id), as.power]);
        continue;
      }
      let remaining = as.power;
      blockers.forEach((b, i) => {
        const bs = this.stats(b.card);
        const lethal = as.keywords.includes('Deathtouch') ? 1 : Math.max(0, bs.toughness - b.card.damage);
        const last = i === blockers.length - 1;
        const amount = last && !as.keywords.includes('Trample') ? remaining : Math.min(remaining, lethal);
        remaining -= amount;
        hits.push([{ card: a, p: atkP }, { type: 'card', pid: b.owner.id, owner: b.owner, card: b.card }, amount]);
        hits.push([{ card: b.card, p: b.owner }, { type: 'card', pid: atkP.id, owner: atkP, card: a }, bs.power]);
      });
      if (remaining > 0 && as.keywords.includes('Trample')) {
        hits.push([{ card: a, p: atkP }, this.playerTarget(blockers[0].owner.id), remaining]);
      }
    }

    this.addLog('── ⚔️ คิด damage การต่อสู้ ──');
    for (const [src, target, amount] of hits) this.damage(src, target, amount);
    for (const q of this.players.values()) {
      for (const c of q.zones.battlefield) {
        c.attacking = false;
        c.blocking = null;
      }
    }
    this.checkState();
  }

  // ---------- turn structure ----------

  setPhase(phase) {
    if (this.stack.length) throw new Error('ต้องให้ stack ว่างก่อน (รอคู่แข่งตอบโต้หรือกดปล่อยผ่าน)');
    if (this.turn.phase === 'combat' && phase !== 'combat') this.resolveCombat();
    if (this.turn.phase !== phase) this.emptyPools();
    this.turn.phase = phase;
  }

  endTurn(p) {
    this.requireActive(p.id);
    if (this.stack.length) throw new Error('ต้องให้ stack ว่างก่อนจบเทิร์น');
    if (this.turn.phase === 'combat') this.resolveCombat();
    // Cleanup: damage and "until end of turn" effects wear off.
    for (const q of this.players.values()) {
      q.damagedThisTurn = false;
      q.revolt = false;
      for (const c of q.zones.battlefield) {
        c.damage = 0;
        c.deathtouched = false;
        c.buff = { power: 0, toughness: 0 };
        c.attacking = false;
        c.blocking = null;
      }
    }
    const next = this.players.get(this.order[(this.order.indexOf(p.id) + 1) % this.order.length]);
    for (const card of next.zones.battlefield) card.tapped = false;
    this.emptyPools();
    next.landsPlayed = 0;
    this.turn = { active: next.id, number: this.turn.number + 1, phase: 'upkeep' };
    this.addLog(`── เทิร์น ${this.turn.number}: ${next.name} ──`);

    // Upkeep trigger: Dark Confidant reveals the top card, puts it in hand, loses life equal to its mana value.
    for (const bob of next.zones.battlefield.filter((c) => c.name === 'Dark Confidant' && !c.faceDown)) {
      const top = next.zones.library.shift();
      if (!top) continue;
      next.zones.hand.push(top);
      this.addLog(`🃏 Dark Confidant เปิด ${top.name} เข้ามือ`);
      this.loseLife(next, top.cmc || 0, bob.name);
    }
    const drew = this.drawCards(next, 1);
    this.addLog(`${next.name} untap ทั้งหมด${drew ? ' และจั่ว 1 ใบ' : ' (Library หมด!)'} อัตโนมัติ`);
  }

  act(pid, a) {
    const p = this.player(pid);
    this.lastActive = Date.now();
    switch (a.type) {
      case 'draw':
        this.draw(p, toInt(a.n, 1, 60, 1));
        return null;
      case 'shuffle':
        shuffle(p.zones.library);
        this.addLog(`${p.name} สับ Library`);
        return null;
      case 'mill': {
        const milled = p.zones.library.splice(0, toInt(a.n, 1, 60, 1));
        p.zones.graveyard.push(...milled);
        this.addLog(`${p.name} mill ${milled.length} ใบ: ${milled.map((c) => c.name).join(', ') || '-'}`);
        return null;
      }
      case 'mulligan': {
        p.zones.library.push(...p.zones.hand.splice(0));
        shuffle(p.zones.library);
        this.drawCards(p, 7, { triggers: false });
        this.addLog(`${p.name} mulligan (จั่วใหม่ 7 ใบ)`);
        return null;
      }
      case 'reset':
        this.reset(pid);
        this.addLog(`${p.name} เริ่มเกมใหม่ (สับเด็คและจั่ว 7 ใบ)`);
        return null;
      case 'move':
        this.move(p, a);
        return null;
      case 'cast':
        this.cast(p, a);
        return null;
      case 'pass': {
        const top = this.stack.at(-1);
        if (!top) throw new Error('ไม่มีอะไรอยู่บน stack');
        if (this.responderFor(top) !== p) throw new Error('รอคู่แข่งตัดสินใจ');
        this.addLog(`${p.name} ปล่อยผ่าน`);
        this.resolveTop();
        this.autoPass();
        return null;
      }
      case 'choose':
        this.choose(p, a.iid);
        return null;
      case 'attack':
        this.attack(p, a.iid, a.force);
        return null;
      case 'block':
        this.block(p, a.iid, a.attacker, a.force);
        return null;
      case 'pool': {
        if (!COLORS.includes(a.color)) throw new Error('สีมานาไม่ถูกต้อง');
        p.pool[a.color] = Math.max(0, Math.min(99, p.pool[a.color] + toInt(a.delta, -99, 99, 1)));
        return null;
      }
      case 'tap': {
        const card = this.battlefieldCard(p, a.iid);
        card.tapped = !card.tapped;
        const makes = card.tapped && !card.faceDown && !a.noMana ? card.producedMana || [] : [];
        const color = makes.includes(a.color) ? a.color : makes[0];
        if (color) p.pool[color] += 1;
        this.addLog(`${p.name} ${card.tapped ? 'tap' : 'untap'} ${this.label(card, !card.faceDown)}${color ? ` → มานา ${color}` : ''}`);
        return null;
      }
      case 'untapAll':
        for (const card of p.zones.battlefield) card.tapped = false;
        this.addLog(`${p.name} untap ทั้งหมด`);
        return null;
      case 'faceDown': {
        const card = this.battlefieldCard(p, a.iid);
        card.faceDown = !card.faceDown;
        this.addLog(card.faceDown ? `${p.name} คว่ำ ${card.name}` : `${p.name} หงาย ${card.name}`);
        return null;
      }
      case 'transform': {
        const card = this.battlefieldCard(p, a.iid);
        if (!card.back) throw new Error('การ์ดใบนี้ไม่มีด้านหลัง');
        card.transformed = !card.transformed;
        this.addLog(`${p.name} พลิก ${card.transformed ? card.backName || card.name : card.name}`);
        return null;
      }
      case 'counter': {
        const card = this.battlefieldCard(p, a.iid);
        const kind = String(a.kind || '').trim().slice(0, 20);
        if (!kind) throw new Error('ต้องระบุชื่อ counter');
        const next = (card.counters[kind] || 0) + toInt(a.delta, -99, 99, 1);
        if (next <= 0) delete card.counters[kind];
        else card.counters[kind] = Math.min(next, 999);
        this.addLog(`${p.name}: ${this.label(card, !card.faceDown)} มี ${kind} counter ${Math.max(next, 0)}`);
        this.checkState();
        return null;
      }
      case 'life':
      case 'poison': {
        // Players may change an opponent's life too (dealing damage); the log says who did it.
        const t = a.target ? this.player(a.target) : p;
        const before = t[a.type];
        t[a.type] = Math.max(-999, Math.min(999, before + toInt(a.delta, -100, 100, 0)));
        const by = t === p ? '' : ` (โดย ${p.name})`;
        this.addLog(`${t.name} ${a.type === 'life' ? 'Life' : 'Poison'} ${before} → ${t[a.type]}${by}`);
        if (a.type === 'life') this.checkLoss(t, before);
        else if (before < 10 && t.poison >= 10) this.addLog(`💀 ${t.name} แพ้! (Poison ครบ 10)`);
        return null;
      }
      case 'token': {
        const name = String(a.name || '').trim().slice(0, 40);
        if (!name) throw new Error('ต้องระบุชื่อ Token');
        this.createToken(p, name, String(a.pt || '').trim().slice(0, 10));
        return null;
      }
      case 'peek': {
        // n = 0 means the whole library (search). Only the owner ever receives this.
        const n = toInt(a.n, 0, 250, 0);
        const cards = n ? p.zones.library.slice(0, n) : [...p.zones.library];
        if (!a.silent) this.addLog(n ? `${p.name} ดู Library บนสุด ${cards.length} ใบ` : `${p.name} ค้นหาใน Library`);
        return cards;
      }
      case 'reveal': {
        const card = p.zones.hand.find((c) => c.iid === a.iid);
        if (!card) throw new Error('ไม่พบการ์ดในมือ');
        this.addLog(`${p.name} เปิดการ์ดในมือให้ดู: ${card.name}`);
        return null;
      }
      case 'roll': {
        const sides = toInt(a.sides, 2, 100, 6);
        this.addLog(`${p.name} ทอยเต๋า d${sides} ได้ ${crypto.randomInt(sides) + 1}`);
        return null;
      }
      case 'coin':
        this.addLog(`${p.name} โยนเหรียญได้ ${crypto.randomInt(2) ? 'หัว' : 'ก้อย'}`);
        return null;
      case 'startGame': {
        if (this.order.length < 2) throw new Error('ต้องมีผู้เล่นอย่างน้อย 2 คน');
        const first = this.order[crypto.randomInt(this.order.length)];
        this.turn = { active: first, number: 1, phase: 'main1' };
        this.stack = [];
        this.choice = null;
        for (const q of this.players.values()) {
          q.pool = emptyPool();
          q.landsPlayed = 0;
          q.damagedThisTurn = false;
          q.revolt = false;
        }
        this.addLog(`🎲 สุ่มแล้ว: ${this.players.get(first).name} เริ่มก่อน (เทิร์นแรกไม่จั่ว)`);
        return null;
      }
      case 'phase':
        this.requireActive(pid);
        if (!PHASES.includes(a.phase)) throw new Error('phase ไม่ถูกต้อง');
        this.setPhase(a.phase);
        return null;
      case 'endTurn':
        this.endTurn(p);
        return null;
      case 'chat': {
        const text = String(a.text || '').trim().slice(0, 300);
        if (text) this.addLog(`💬 ${p.name}: ${text}`);
        return null;
      }
      default:
        throw new Error(`ไม่รู้จักคำสั่ง ${a.type}`);
    }
  }

  viewFor(viewerId) {
    const withStats = (c) => (isCreature(c) ? { ...c, stats: this.stats(c) } : c);
    const choice = this.choice;
    let choiceView = null;
    if (choice?.pid === viewerId) {
      const from = this.players.get(choice.fromPid);
      const zone = choice.action === 'discard' ? from.zones.hand : from.zones.battlefield.filter(isCreature);
      choiceView = { ...choice, cards: zone };
    } else if (choice) {
      choiceView = { waitingFor: this.players.get(choice.pid)?.name };
    }
    return {
      roomId: this.id,
      you: viewerId,
      players: this.order.map((pid) => {
        const p = this.players.get(pid);
        const mine = pid === viewerId;
        const hide = (c) =>
          c.faceDown && !mine ? { iid: c.iid, faceDown: true, tapped: c.tapped, x: c.x, y: c.y, counters: c.counters } : withStats(c);
        return {
          id: pid,
          name: p.name,
          life: p.life,
          poison: p.poison,
          pool: p.pool,
          landsPlayed: p.landsPlayed,
          damagedThisTurn: p.damagedThisTurn,
          connected: p.connected,
          hasDeck: Boolean(p.deck),
          libraryCount: p.zones.library.length,
          handCount: p.zones.hand.length,
          hand: mine ? p.zones.hand : null,
          battlefield: p.zones.battlefield.map(hide),
          graveyard: p.zones.graveyard,
          exile: p.zones.exile,
          command: p.zones.command,
        };
      }),
      stack: this.stack.map((s) => ({
        sid: s.sid,
        pid: s.pid,
        card: s.card,
        targetText: this.describeTarget(this.resolveTarget(s.target)).replace(' → ', ''),
        responder: this.responderFor(s)?.id,
      })),
      choice: choiceView,
      turn: this.turn,
      log: this.log.slice(-100),
    };
  }
}

module.exports = { Room, ZONES, PHASES, MAX_PLAYERS, instantiate };
