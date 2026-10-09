'use strict';
// Game state for one room. The server is the source of truth: clients only send
// intents ("move card X to graveyard"), and each client receives a view filtered
// so hidden information (library, opponents' hands, face-down cards) never leaks.

const crypto = require('crypto');
const { COLORS, RuleError, emptyPool, isLand, isPermanent, payCost, planAutoTap, checkTiming } = require('./public/rules');

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

const uid = () => crypto.randomBytes(6).toString('hex');
const emptyZones = () => Object.fromEntries(ZONES.map((z) => [z, []]));

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
  return {
    iid: uid(),
    name: card.name,
    img: card.img || null,
    back: card.back || null,
    backName: card.backName || null,
    typeLine: card.typeLine || '',
    manaCost: card.manaCost || '',
    producedMana: card.producedMana || [],
    keywords: card.keywords || [],
    oracleText: card.oracleText || '',
    tapped: false,
    faceDown: false,
    transformed: false,
    counters: {},
    x: 0,
    y: 0,
    token: false,
  };
}

function clearBattlefieldState(card) {
  card.tapped = false;
  card.faceDown = false;
  card.transformed = false;
  card.counters = {};
}

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.order = [];
    this.log = [];
    this.turn = null; // { active: pid, number, phase } once someone starts the game
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
      id: pid, name, life: 20, poison: 0, pool: emptyPool(), landsPlayed: 0, deck: null, zones: emptyZones(), connected: true,
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
  }

  get anyoneConnected() {
    return [...this.players.values()].some((p) => p.connected);
  }

  player(pid) {
    const p = this.players.get(pid);
    if (!p) throw new Error('ไม่พบผู้เล่นในห้องนี้');
    return p;
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
    this.drawCards(p, 7);
  }

  drawCards(p, n) {
    const drawn = p.zones.library.splice(0, n);
    p.zones.hand.push(...drawn);
    return drawn.length;
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
    p.zones[from].splice(found.index, 1);
    if (from === 'battlefield') clearBattlefieldState(card);

    if (card.token && to !== 'battlefield') {
      this.addLog(`${p.name}: Token ${card.name} ออกจากเกม`);
      return;
    }

    if (to === 'battlefield') {
      card.faceDown = Boolean(faceDown);
      this.placeOnBattlefield(p, card, x, y);
      p.zones.battlefield.push(card);
    } else if (to === 'library' && pos === 'bottom') {
      p.zones.library.push(card);
    } else if (to === 'library') {
      p.zones.library.unshift(card);
    } else {
      p.zones[to].push(card);
    }

    const isPublic = (z) => PUBLIC_ZONES.includes(z);
    const visible =
      (isPublic(from) && !wasHidden) || (isPublic(to) && !(to === 'battlefield' && card.faceDown));
    const where = to === 'library' ? `${pos === 'bottom' ? 'ล่างสุด' : 'บนสุด'}ของ Library` : ZONE_LABEL[to];
    this.addLog(`${p.name} ย้าย ${this.label(card, visible)}: ${ZONE_LABEL[from]} → ${where}`);
  }

  // Mana empties from every pool whenever the step or phase changes.
  emptyPools() {
    for (const q of this.players.values()) q.pool = emptyPool();
  }

  // Pays from the mana pool, tapping untapped lands/mana creatures for whatever is missing.
  payWithAutoTap(p, card) {
    try {
      return payCost(card.manaCost, p.pool);
    } catch (err) {
      const sources = p.zones.battlefield
        .filter((c) => !c.tapped && !c.faceDown && c.producedMana?.length)
        .map((c) => ({ iid: c.iid, colors: c.producedMana }));
      const plan = planAutoTap(card.manaCost, p.pool, sources);
      if (!plan) throw err;
      for (const { iid, color } of plan) {
        p.zones.battlefield.find((c) => c.iid === iid).tapped = true;
        p.pool[color] += 1;
      }
      const names = plan.map(({ iid, color }) => `${p.zones.battlefield.find((c) => c.iid === iid).name} (${color})`);
      this.addLog(`${p.name} tap อัตโนมัติ: ${names.join(', ')}`);
      return payCost(card.manaCost, p.pool);
    }
  }

  // Playing a card from hand the normal way: checks timing, land drops and mana,
  // unless the player chose to override (a.force), which is logged for everyone.
  cast(p, { iid, x, y, force }) {
    const card = p.zones.hand.find((c) => c.iid === iid);
    if (!card) throw new Error('ไม่พบการ์ดในมือ');
    const land = isLand(card);
    let payment = null;
    if (!force) {
      checkTiming(card, p.id, this.turn);
      if (land && p.landsPlayed >= 1) throw new RuleError('ลง Land ได้เทิร์นละ 1 ใบ เทิร์นนี้ลงไปแล้ว');
      if (!land) payment = this.payWithAutoTap(p, card);
    }

    p.zones.hand.splice(p.zones.hand.indexOf(card), 1);
    if (payment) {
      p.pool = payment.pool;
      p.life -= payment.life;
    }
    if (land) p.landsPlayed += 1;

    const verb = land ? 'ลง Land' : 'ร่าย';
    const paid = payment ? ` จ่าย ${card.manaCost || '0'}${payment.life ? ` + Life ${payment.life}` : ''}` : '';
    const forced = force ? ' ⚠️ (ข้ามกติกา)' : '';
    if (isPermanent(card)) {
      this.placeOnBattlefield(p, card, x, y);
      p.zones.battlefield.push(card);
      this.addLog(`${p.name} ${verb} ${card.name}${paid}${forced}`);
    } else {
      p.zones.graveyard.push(card);
      this.addLog(`${p.name} ร่าย ${card.name}${paid} → สุสาน${forced}`);
    }
  }

  act(pid, a) {
    const p = this.player(pid);
    this.lastActive = Date.now();
    switch (a.type) {
      case 'draw': {
        const n = this.drawCards(p, toInt(a.n, 1, 60, 1));
        this.addLog(`${p.name} จั่ว ${n} ใบ`);
        return null;
      }
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
        this.drawCards(p, 7);
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
        const lost = a.type === 'life' ? before > 0 && t.life <= 0 : before < 10 && t.poison >= 10;
        if (lost) this.addLog(`💀 ${t.name} แพ้! (${a.type === 'life' ? 'Life เหลือ 0' : 'Poison ครบ 10'})`);
        return null;
      }
      case 'token': {
        const name = String(a.name || '').trim().slice(0, 40);
        if (!name) throw new Error('ต้องระบุชื่อ Token');
        const producedMana = /^treasure$/i.test(name) ? ['W', 'U', 'B', 'R', 'G'] : [];
        const card = { ...instantiate({ name, producedMana }), token: true, pt: String(a.pt || '').trim().slice(0, 10) };
        this.placeOnBattlefield(p, card);
        p.zones.battlefield.push(card);
        this.addLog(`${p.name} สร้าง Token ${name}${card.pt ? ` ${card.pt}` : ''}`);
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
        for (const q of this.players.values()) {
          q.pool = emptyPool();
          q.landsPlayed = 0;
        }
        this.addLog(`🎲 สุ่มแล้ว: ${this.players.get(first).name} เริ่มก่อน (เทิร์นแรกไม่จั่ว)`);
        return null;
      }
      case 'phase':
        this.requireActive(pid);
        if (!PHASES.includes(a.phase)) throw new Error('phase ไม่ถูกต้อง');
        if (this.turn.phase !== a.phase) this.emptyPools();
        this.turn.phase = a.phase;
        return null;
      case 'endTurn': {
        this.requireActive(pid);
        const next = this.players.get(this.order[(this.order.indexOf(pid) + 1) % this.order.length]);
        for (const card of next.zones.battlefield) card.tapped = false;
        const drew = this.drawCards(next, 1);
        this.emptyPools();
        next.landsPlayed = 0;
        this.turn = { active: next.id, number: this.turn.number + 1, phase: 'upkeep' };
        this.addLog(`── เทิร์น ${this.turn.number}: ${next.name} (untap ทั้งหมด${drew ? ' + จั่ว 1 ใบ' : ''} อัตโนมัติ) ──`);
        return null;
      }
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
    return {
      roomId: this.id,
      you: viewerId,
      players: this.order.map((pid) => {
        const p = this.players.get(pid);
        const mine = pid === viewerId;
        const hide = (c) =>
          c.faceDown && !mine ? { iid: c.iid, faceDown: true, tapped: c.tapped, x: c.x, y: c.y, counters: c.counters } : c;
        return {
          id: pid,
          name: p.name,
          life: p.life,
          poison: p.poison,
          pool: p.pool,
          landsPlayed: p.landsPlayed,
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
      turn: this.turn,
      log: this.log.slice(-100),
    };
  }
}

module.exports = { Room, ZONES, PHASES, MAX_PLAYERS };
