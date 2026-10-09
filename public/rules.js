'use strict';
// Shared by the server (enforcement) and the browser (highlighting playable cards).
// Light rules assistance: mana payment, land drops and casting timing.
// MTG has too many rule-changing cards to enforce strictly, so violations raise a
// RuleError that the player may override (the override is logged for everyone).

const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];
const MAIN_PHASES = ['main1', 'main2'];

class RuleError extends Error {
  constructor(message) {
    super(message);
    this.rule = true;
  }
}

const emptyPool = () => Object.fromEntries(COLORS.map((c) => [c, 0]));

const isLand = (card) => /\bLand\b/.test(card.typeLine || '');
const isInstantSpeed = (card) => /\bInstant\b/.test(card.typeLine || '') || (card.keywords || []).includes('Flash');
const isPermanent = (card) => !/\b(Instant|Sorcery)\b/.test(card.typeLine || '');

// "{2}{R}{W/U}{G/P}" -> { generic, colored: {R:1}, hybrid: [['W','U']], phyrexian: ['G'] }
function parseCost(cost) {
  const need = { generic: 0, colored: {}, hybrid: [], phyrexian: [] };
  for (const [, sym] of String(cost || '').matchAll(/\{([^}]+)\}/g)) {
    if (/^\d+$/.test(sym)) need.generic += Number(sym);
    else if (sym === 'X' || sym === 'Y' || sym === 'Z') continue; // X is paid as 0 unless the player adds more
    else if (sym === 'S') need.generic += 1;
    else if (COLORS.includes(sym)) need.colored[sym] = (need.colored[sym] || 0) + 1;
    else if (/^[WUBRG]\/P$/.test(sym)) need.phyrexian.push(sym[0]);
    else if (/^2\/[WUBRG]$/.test(sym)) need.hybrid.push([sym[2], '2']);
    else if (/^[WUBRG]\/[WUBRG]$/.test(sym)) need.hybrid.push([sym[0], sym[2]]);
  }
  return need;
}

const SYMBOL = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G', C: 'C' };
const describe = (missing) => Object.entries(missing).filter(([, n]) => n > 0).map(([c, n]) => `${SYMBOL[c] || c}×${n}`).join(' ');

// Pays `cost` out of `pool`. Returns { pool, life } (what remains / life to lose) or throws RuleError.
function payCost(cost, pool) {
  const need = parseCost(cost);
  const left = { ...pool };
  const missing = {};
  let life = 0;
  let generic = need.generic;

  for (const [c, n] of Object.entries(need.colored)) {
    const paid = Math.min(left[c], n);
    left[c] -= paid;
    if (paid < n) missing[c] = n - paid;
  }
  for (const c of need.phyrexian) {
    if (left[c] > 0) left[c] -= 1;
    else life += 2;
  }
  for (const [a, b] of need.hybrid) {
    const options = [a, b].filter((x) => x !== '2' && left[x] > 0).sort((x, y) => left[y] - left[x]);
    if (options.length) left[options[0]] -= 1;
    else if (b === '2') generic += 2;
    else missing[`${a}/${b}`] = (missing[`${a}/${b}`] || 0) + 1;
  }
  // Generic mana: spend colorless first, then whatever color is most plentiful.
  while (generic > 0) {
    const c = left.C > 0 ? 'C' : COLORS.filter((x) => left[x] > 0).sort((x, y) => left[y] - left[x])[0];
    if (!c) break;
    left[c] -= 1;
    generic -= 1;
  }
  if (generic > 0) missing.generic = generic;

  if (Object.keys(missing).length) {
    const text = describe({ ...missing, generic: undefined }) + (missing.generic ? ` ไม่ระบุสี×${missing.generic}` : '');
    throw new RuleError(`มานาไม่พอ ต้องจ่าย ${cost || '0'} ขาดอีก ${text.trim()} (tap land ก่อน)`);
  }
  return { pool: left, life };
}

// Chooses which untapped mana sources to tap so `cost` becomes payable.
// sources: [{ iid, colors: ['R'] }]. Returns [{ iid, color }] or null if even tapping everything isn't enough.
function planAutoTap(cost, pool, sources) {
  const need = parseCost(cost);
  const left = { ...pool };
  const avail = [...sources].sort((a, b) => a.colors.length - b.colors.length); // keep flexible sources for last
  const plan = [];
  const tap = (index, color) => {
    const [s] = avail.splice(index, 1);
    plan.push({ iid: s.iid, color });
    left[color] += 1;
  };
  const payable = () => {
    try {
      payCost(cost, left);
      return true;
    } catch {
      return false;
    }
  };

  for (const [c, n] of Object.entries(need.colored)) {
    while (left[c] < n) {
      const i = avail.findIndex((s) => s.colors.includes(c));
      if (i === -1) return null;
      tap(i, c);
    }
  }
  const wanted = [...new Set([...need.hybrid.flat(), ...need.phyrexian])].filter((c) => c !== '2');
  while (!payable()) {
    if (!avail.length) return null;
    const i = Math.max(0, avail.findIndex((s) => s.colors.some((c) => wanted.includes(c))));
    tap(i, avail[i].colors.find((c) => wanted.includes(c)) || avail[i].colors[0]);
  }
  return plan;
}

const PHASE_LABEL = { untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main 1', combat: 'Combat', main2: 'Main 2', end: 'End' };

// Throws RuleError if `card` can't be played right now by `pid`.
function checkTiming(card, pid, turn) {
  if (!turn) throw new RuleError('ยังไม่ได้เริ่มเกม กด "สุ่มคนเริ่มเกม" ก่อน');
  if (isInstantSpeed(card) && !isLand(card)) return;
  const what = isLand(card) ? 'ลง Land' : 'ร่ายการ์ดนี้';
  if (turn.active !== pid) throw new RuleError(`${what}ได้เฉพาะในเทิร์นของคุณ (การ์ดนี้ไม่ใช่ Instant/Flash)`);
  if (!MAIN_PHASES.includes(turn.phase)) {
    throw new RuleError(`${what}ได้เฉพาะ Main 1 / Main 2 ตอนนี้อยู่ ${PHASE_LABEL[turn.phase]} (กดเปลี่ยน phase ด้านบน)`);
  }
}

const RULES = { COLORS, RuleError, emptyPool, isLand, isPermanent, isInstantSpeed, parseCost, payCost, planAutoTap, checkTiming };
if (typeof module !== 'undefined') module.exports = RULES;
else window.RULES = RULES;
