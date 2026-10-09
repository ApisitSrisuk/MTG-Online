'use strict';

const socket = io();
const $ = (sel) => document.querySelector(sel);

const ZONE_LABEL = { library: 'Library', hand: 'มือ', battlefield: 'สนาม', graveyard: 'สุสาน', exile: 'Exile', command: 'Command Zone' };
const PILE_ICON = { library: '📚', hand: '✋', graveyard: '🪦', exile: '🌀', command: '👑' };
const PUBLIC_PILES = ['graveyard', 'exile', 'command'];
const STEPS = [['upkeep', 'Upkeep'], ['main1', 'Main 1'], ['combat', 'Combat'], ['main2', 'Main 2'], ['end', 'End']];
const NEXT_STEP = { untap: 'upkeep', upkeep: 'main1', draw: 'main1', main1: 'combat', combat: 'main2', main2: 'end' };
const MANA_NAME = { W: 'ขาว', U: 'น้ำเงิน', B: 'ดำ', R: 'แดง', G: 'เขียว', C: 'ไม่มีสี' };
const TOKENS = [
  ['Treasure', '', '💰'], ['Clue', '', '🔍'], ['Food', '', '🍖'], ['Goblin', '1/1', '👺'], ['Soldier', '1/1', '🛡️'],
  ['Spirit', '1/1', '👻'], ['Zombie', '2/2', '🧟'], ['Wolf', '2/2', '🐺'], ['Beast', '3/3', '🐗'], ['Angel', '4/4', '👼'],
];

let state = null;
let joined = null; // { roomId, name } once in a room
let zoneView = null; // { pid, zone, n?, cards? }
let drag = null; // { iid, from, dx, dy }

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const playerId = store.get('mtg.playerId') || randomId();
store.set('mtg.playerId', playerId);

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === false || child == null) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// "{2}{R}" -> coloured mana symbols
function manaSymbols(text) {
  const parts = String(text).split(/(\{[^}]+\})/g).filter(Boolean);
  return parts.map((part) => {
    const m = part.match(/^\{([^}]+)\}$/);
    if (!m) return part;
    const sym = m[1].replace('/', '');
    return h('i', { class: `ms ms-${/^[WUBRGC]$/.test(sym) ? sym : 'N'}`, title: part }, /^[WUBRGC]$/.test(sym) ? '' : m[1]);
  });
}

let toastTimer;
function toast(text, kind = 'error') {
  const el = $('#toast');
  el.textContent = text;
  el.className = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

const send = (event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

async function emit(event, payload) {
  const res = await send(event, payload);
  if (!res.ok) toast(res.error);
  return res;
}

// Runs a game action. Rule violations ask whether to override (the override is logged for everyone).
async function act(type, extra = {}) {
  const res = await send('act', { type, ...extra });
  if (res.ok) return res;
  if (!res.rule) {
    toast(res.error);
    return res;
  }
  const override = await ask({
    title: '⚠️ ผิดกติกา',
    text: res.error,
    buttons: [['ยกเลิก', false], ['ข้ามกติกาแล้วทำต่อ', true, 'danger']],
  });
  return override ? act(type, { ...extra, force: true }) : res;
}

// In-page replacement for prompt()/confirm(). Resolves with the chosen value, or null if dismissed.
function ask({ title, text = '', body = null, buttons = [['ยกเลิก', null], ['ตกลง', true, 'primary']], read = () => true }) {
  return new Promise((resolve) => {
    const dlg = $('#askDialog');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(value === true ? read() : value);
    };
    $('#askTitle').textContent = title;
    $('#askText').replaceChildren(...manaSymbols(text));
    $('#askText').hidden = !text;
    $('#askBody').replaceChildren(...(body ? [body] : []));
    $('#askButtons').replaceChildren(
      h('span', { class: 'grow' }),
      ...buttons.map(([label, value, cls]) => h('button', { type: 'button', class: cls || '', onclick: () => finish(value) }, label)),
    );
    $('#askForm').onsubmit = (e) => { e.preventDefault(); finish(true); };
    dlg.oncancel = () => finish(null);
    dlg.finish = finish;
    dlg.showModal();
    body?.querySelector('input')?.select();
  });
}

function askNumber(title, value = 1) {
  const input = h('input', { type: 'number', min: '1', max: '99', value: String(value), class: 'num' });
  return ask({ title, body: input, read: () => Number.parseInt(input.value, 10) || null });
}

const confirmAsk = (title, text, okLabel = 'ตกลง') => ask({ title, text, buttons: [['ยกเลิก', false], [okLabel, true, 'primary']] });

const me = () => state?.players.find((p) => p.id === state.you);
const faceImage = (c) => (c.transformed && c.back ? c.back : c.img);
const myTurn = () => state?.turn?.active === state?.you;

// ---------- lobby ----------

$('#nameInput').value = store.get('mtg.name') || '';
$('#roomInput').value = location.hash.slice(1).toUpperCase();

$('#lobbyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#nameInput').value.trim();
  const roomId = $('#roomInput').value.trim().toUpperCase();
  const res = await send('join', { roomId, playerId, name });
  if (!res.ok) {
    $('#lobbyError').textContent = res.error;
    return;
  }
  store.set('mtg.name', name);
  joined = { roomId: res.data.roomId, name };
  location.hash = res.data.roomId;
  $('#lobby').hidden = true;
  $('#game').hidden = false;
  if (!me()?.hasDeck) openDeckDialog();
});

// After a page refresh, go straight back into the room in the URL.
if ($('#roomInput').value && $('#nameInput').value) $('#lobbyForm').requestSubmit();

// Rejoin automatically after a dropped connection or server restart.
socket.on('connect', async () => {
  if (!joined) return;
  const res = await send('join', { roomId: joined.roomId, playerId, name: joined.name });
  if (!res.ok) {
    joined = null;
    $('#game').hidden = true;
    $('#lobby').hidden = false;
    $('#lobbyError').textContent = res.error;
  }
});

socket.on('state', (s) => {
  state = s;
  render();
});

// ---------- playability (mirrors the server's rule checks) ----------

function canPlay(c, p) {
  if (!state.turn || !c.typeLine) return false;
  try {
    RULES.checkTiming(c, state.you, state.turn);
    if (RULES.isLand(c)) return p.landsPlayed < 1;
    const sources = p.battlefield
      .filter((x) => !x.tapped && !x.faceDown && x.producedMana?.length)
      .map((x) => ({ iid: x.iid, colors: x.producedMana }));
    return RULES.planAutoTap(c.manaCost, p.pool, sources) !== null;
  } catch {
    return false;
  }
}

// ---------- rendering ----------

function render() {
  const mine = me();
  if (!mine) return;
  $('#roomCode').textContent = state.roomId;

  const opponents = state.players.filter((p) => p.id !== state.you);
  $('#opponents').replaceChildren(
    ...(opponents.length
      ? opponents.map((p) => playerEl(p, false))
      : [h('div', { class: 'waiting' }, h('div', { class: 'waiting-icon' }, '🃏'), 'รอเพื่อนเข้าห้อง…',
        h('button', { class: 'primary', onclick: copyLink }, '🔗 คัดลอกลิงก์ชวนเพื่อน'))]),
  );
  $('#me').replaceChildren(playerEl(mine, true));
  $('#hand').replaceChildren(...mine.hand.map((c) => {
    const el = cardEl(c, 'hand', true);
    if (canPlay(c, mine)) el.classList.add('playable');
    return el;
  }));
  renderTurnBar();
  renderHint(mine);
  renderLog();
  if (zoneView) refreshZoneView();
}

function nextStep() {
  if (!myTurn()) return;
  const { phase } = state.turn;
  if (phase === 'end') act('endTurn');
  else act('phase', { phase: NEXT_STEP[phase] });
}

function renderTurnBar() {
  const bar = $('#turnBar');
  const { turn } = state;
  if (!turn) {
    bar.replaceChildren(state.players.length >= 2
      ? h('button', { class: 'primary big', onclick: () => act('startGame') }, '🎲 สุ่มคนเริ่มเกม')
      : h('span', { class: 'muted' }, 'รอผู้เล่นคนที่ 2…'));
    return;
  }
  const active = state.players.find((p) => p.id === turn.active);
  const mine = myTurn();
  const shownPhase = turn.phase === 'untap' || turn.phase === 'draw' ? 'upkeep' : turn.phase;
  bar.replaceChildren(
    h('span', { class: `turn-who${mine ? ' mine' : ''}` }, h('small', {}, `เทิร์น ${turn.number}`), mine ? 'ตาคุณ' : `ตา ${active?.name ?? '?'}`),
    h('div', { class: 'phases' }, STEPS.map(([id, label]) => h('button', {
      class: `phase${shownPhase === id ? ' current' : ''}`,
      disabled: !mine,
      title: mine ? `ไปขั้น ${label}` : '',
      onclick: () => act('phase', { phase: id }),
    }, label))),
  );
  if (mine) {
    bar.append(h('button', { class: 'primary big', title: 'คีย์ลัด N', onclick: nextStep },
      turn.phase === 'end' ? 'จบเทิร์น ➜' : 'ขั้นต่อไป ➜'));
  }
}

function renderHint(mine) {
  const { turn } = state;
  let text;
  if (!mine.hasDeck) text = '📋 เริ่มจากโหลดเด็ค: กด ⚙ เครื่องมือ → โหลดเด็ค';
  else if (state.players.length < 2) text = '🔗 กดปุ่ม "ห้อง" ด้านบนเพื่อคัดลอกลิงก์ส่งให้เพื่อน';
  else if (!turn) text = '🎲 ทั้งสองฝั่งพร้อมแล้ว กด "สุ่มคนเริ่มเกม" ด้านบน';
  else if (!myTurn()) {
    const name = state.players.find((p) => p.id === turn.active)?.name;
    text = `⏳ ตาของ ${name} · คุณยังร่าย Instant หรือ Flash ได้ (การ์ดที่เรืองแสง)`;
  } else {
    text = {
      untap: '☀️ เริ่มเทิร์น: กด ขั้นต่อไป ➜',
      upkeep: '☀️ Upkeep: ถ้าไม่มีความสามารถช่วงต้นเทิร์น กด ขั้นต่อไป ➜ เพื่อเข้า Main 1',
      draw: '☀️ จั่วให้แล้ว กด ขั้นต่อไป ➜',
      main1: `🃏 Main 1: ${mine.landsPlayed ? 'ลง Land ไปแล้ว' : 'ลง Land ได้ 1 ใบ'} · ดับเบิลคลิกการ์ดที่เรืองแสงเพื่อร่าย (ระบบ tap land ให้อัตโนมัติ)`,
      combat: '⚔️ Combat: ดับเบิลคลิก creature เพื่อ tap โจมตี แล้วกด − ที่ Life คู่แข่งตาม damage',
      main2: `🃏 Main 2: ร่ายต่อได้ ${mine.landsPlayed ? '' : '· ยังลง Land ได้ 1 ใบ '}· เสร็จแล้วกด ขั้นต่อไป ➜`,
      end: '🌙 End: กด จบเทิร์น ➜ เพื่อส่งตาให้คู่แข่ง (เขาจะ untap และจั่วอัตโนมัติ)',
    }[turn.phase];
  }
  $('#hint').replaceChildren(h('span', {}, text));
}

function lifeEl(p, mine) {
  const change = (d) => act('life', { delta: d, target: p.id });
  return h('div', { class: 'life' },
    h('button', { title: mine ? 'เสีย 1 Life' : 'ทำ 1 damage', onclick: () => change(-1) }, '−'),
    h('b', { title: 'Life' }, p.life),
    h('button', { title: 'ได้ 1 Life', onclick: () => change(1) }, '+'),
  );
}

function poisonEl(p, mine) {
  if (!p.poison && !mine) return null;
  return h('div', { class: 'poison', title: 'Poison counter (ครบ 10 แพ้)' },
    '☠ ', h('b', {}, p.poison),
    mine && h('button', { onclick: () => act('poison', { delta: 1 }) }, '+'),
    mine && p.poison > 0 && h('button', { onclick: () => act('poison', { delta: -1 }) }, '−'));
}

function poolEl(p, mine) {
  const chips = Object.entries(p.pool || {}).filter(([, n]) => n > 0).map(([c, n]) => h('span', {
    class: 'pool-chip',
    title: mine ? `มานา${MANA_NAME[c]} ×${n} (คลิกขวาเพื่อลบ)` : `มานา${MANA_NAME[c]}`,
    oncontextmenu: mine && ((e) => { e.preventDefault(); act('pool', { color: c, delta: -1 }); }),
  }, h('i', { class: `ms ms-${c}` }), n));
  return h('div', { class: 'pool', title: 'Mana pool: มานาที่ยังไม่ได้ใช้ (หายเมื่อเปลี่ยนขั้น)' },
    chips.length ? chips : h('span', { class: 'muted' }, 'ไม่มีมานา'),
    mine && h('button', { class: 'tiny', title: 'เพิ่มมานาเอง (เช่นจาก Ritual)', onclick: (e) => openMenu(e, Object.keys(MANA_NAME)
      .map((c) => [h('span', {}, h('i', { class: `ms ms-${c}` }), ` มานา${MANA_NAME[c]}`), () => act('pool', { color: c, delta: 1 })])) }, '+'));
}

function pileEl(p, zone, mine) {
  const count = zone === 'library' ? p.libraryCount : zone === 'hand' ? p.handCount : p[zone].length;
  const top = PUBLIC_PILES.includes(zone) ? p[zone].at(-1) : null;
  const el = h('div', { class: `pile pile-${zone}`, title: ZONE_LABEL[zone] },
    h('span', { class: 'pile-icon' }, PILE_ICON[zone]), h('b', {}, count), h('small', {}, ZONE_LABEL[zone]));
  if (top) el.addEventListener('mouseenter', () => showPreview(top));
  if (zone === 'library' && mine) {
    el.title = 'คลิก = เมนู Library (จั่ว, Scry, ค้นหา, Mulligan…)';
    el.addEventListener('click', (e) => openMenu(e, libraryMenu()));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(e, libraryMenu()); });
  } else if (PUBLIC_PILES.includes(zone)) {
    el.title = `ดู${ZONE_LABEL[zone]}`;
    el.addEventListener('click', () => openZone(p.id, zone));
  }
  if (mine && zone !== 'hand') makeDropZone(el, zone, () => (zone === 'library' ? { pos: 'top' } : {}));
  return el;
}

function playerEl(p, mine) {
  const active = state.turn?.active === p.id;
  const piles = ['library', ...(mine ? [] : ['hand']), 'graveyard', 'exile', ...(p.command.length || mine ? ['command'] : [])];
  const strip = h('div', { class: 'strip' },
    h('div', { class: 'who' },
      h('span', { class: `dot ${p.connected ? 'on' : 'off'}`, title: p.connected ? 'ออนไลน์' : 'หลุด' }),
      h('span', { class: 'pname' }, p.name), mine && h('span', { class: 'badge' }, 'คุณ'), active && h('span', { class: 'badge turn' }, '⏳ ตานี้')),
    lifeEl(p, mine),
    poisonEl(p, mine),
    poolEl(p, mine),
    h('div', { class: 'piles' }, piles.map((z) => pileEl(p, z, mine))),
  );
  const battlefield = h('div', { class: 'battlefield', 'data-empty': mine ? 'ดับเบิลคลิกหรือลากการ์ดจากมือมาวางที่นี่' : 'สนามของคู่แข่ง' },
    p.battlefield.map((c) => cardEl(c, 'battlefield', mine)));
  if (mine) {
    makeDropZone(battlefield, 'battlefield', (e, d) => {
      const r = battlefield.getBoundingClientRect();
      return { x: ((e.clientX - r.left - d.dx) / r.width) * 100, y: ((e.clientY - r.top - d.dy) / r.height) * 100 };
    });
  }
  return h('div', { class: `player${mine ? ' mine' : ''}${active ? ' active' : ''}` }, strip, battlefield);
}

function tapCard(c, e) {
  const colors = c.producedMana || [];
  if (!c.tapped && colors.length > 1) {
    openMenu(e, colors.map((col) => [h('span', {}, h('i', { class: `ms ms-${col}` }), ` tap ได้มานา${MANA_NAME[col]}`), () => act('tap', { iid: c.iid, color: col })]));
  } else {
    act('tap', { iid: c.iid });
  }
}

function cardEl(c, zone, mine) {
  const hidden = c.faceDown && !mine;
  const el = h('div', { class: 'card' });
  if (c.tapped) el.classList.add('tapped');
  if (c.faceDown) el.classList.add('facedown');
  if (c.token) el.classList.add('token');

  if (hidden) el.classList.add('back');
  else if (faceImage(c)) el.append(h('img', { src: faceImage(c), alt: c.name, draggable: 'false', loading: 'lazy' }));
  else el.append(h('div', { class: 'token-face' }, h('b', {}, c.name), c.pt ? h('span', {}, c.pt) : ''));

  if (c.faceDown && mine) el.append(h('span', { class: 'fd-tag' }, 'คว่ำ'));
  const counters = Object.entries(c.counters || {});
  if (counters.length) el.append(h('div', { class: 'counters' }, counters.map(([k, v]) => h('span', { class: 'ctr' }, `${k} ×${v}`))));
  if (zone === 'battlefield') {
    // The opponent sits across the table, so their side is rotated 180°.
    el.style[mine ? 'left' : 'right'] = `${c.x}%`;
    el.style[mine ? 'top' : 'bottom'] = `${c.y}%`;
  }
  if (!hidden) el.addEventListener('mouseenter', () => showPreview(c));

  if (mine) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      const r = el.getBoundingClientRect();
      drag = { iid: c.iid, from: zone, dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.dataTransfer.setData('text/plain', c.iid);
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('dragging');
    });
    el.addEventListener('dragend', () => { drag = null; document.body.classList.remove('dragging'); });
    el.addEventListener('dblclick', (e) => {
      if (zone === 'battlefield') tapCard(c, e);
      else if (zone === 'hand') act('cast', { iid: c.iid });
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(e, cardMenu(c, zone)); });
  } else if (!hidden) {
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(e, [['📖 คำอธิบายภาษาไทย', () => explain(c)]]); });
  }
  return el;
}

function makeDropZone(el, zone, extra = () => ({})) {
  el.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-hover');
    document.body.classList.remove('dragging');
    if (!drag) return;
    const d = drag;
    drag = null;
    // Hand -> battlefield is casting the card, which goes through the rule checks.
    if (zone === 'battlefield' && d.from === 'hand') act('cast', { iid: d.iid, ...extra(e, d) });
    else act('move', { iid: d.iid, to: zone, ...extra(e, d) });
  });
}
makeDropZone($('#handBar'), 'hand');

function thaiText(c) {
  const box = h('div', { class: 'th-box' });
  const own = CARD_TH[c.name];
  const typeLine = c.typeLine ? h('div', { class: 'th-type' }, c.manaCost ? manaSymbols(c.manaCost) : '', ' ', c.typeLine) : null;
  if (typeLine) box.append(typeLine);
  if (own) box.append(h('p', { class: 'th-main' }, manaSymbols(own)));
  const kws = (c.keywords || []).filter((k) => KEYWORD_TH[k]);
  if (kws.length) {
    box.append(h('dl', { class: 'th-kw' }, kws.map((k) => [h('dt', {}, k), h('dd', {}, KEYWORD_TH[k])])));
  }
  if (!own && c.oracleText) {
    box.append(h('p', { class: 'th-note' }, 'ยังไม่มีคำแปลเต็มของการ์ดใบนี้ ข้อความต้นฉบับ:'), h('p', { class: 'th-oracle' }, manaSymbols(c.oracleText)));
  }
  if (!box.childNodes.length) box.append(h('p', { class: 'muted' }, 'ไม่มีข้อมูลความสามารถ'));
  return box;
}

function previewContent(c) {
  const images = h('div', { class: `pv-images${c.back ? ' dfc' : ''}` });
  if (faceImage(c)) {
    images.append(h('img', { src: faceImage(c), alt: c.name }));
    if (c.back) images.append(h('img', { src: c.transformed ? c.img : c.back, alt: c.backName || '' }));
  } else {
    images.append(h('div', { class: 'card pv-token' }, h('div', { class: 'token-face' }, h('b', {}, c.name), c.pt ? h('span', {}, c.pt) : '')));
  }
  return [h('h3', { class: 'pv-name' }, c.name), thaiText(c), images];
}

function showPreview(c) {
  $('#preview').replaceChildren(...previewContent(c));
}

// Full explanation in a dialog, for small screens where the side panel is hidden.
function explain(c) {
  ask({ title: '📖 คำอธิบาย', body: h('div', {}, previewContent(c)), buttons: [['ปิด', null, 'primary']] });
}

function renderLog() {
  const list = $('#log');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.replaceChildren(...state.log.map((entry) => h('li', {
    class: entry.text.startsWith('──') ? 'sep' : entry.text.includes('⚠️') ? 'warn' : entry.text.startsWith('💀') ? 'dead' : entry.text.startsWith('💬') ? 'chat' : '',
  }, h('time', {}, new Date(entry.t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })), manaSymbols(entry.text))));
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ---------- context menu ----------

function openMenu(e, items) {
  e.stopPropagation();
  const menu = $('#menu');
  menu.replaceChildren(...items.map((item) => (item === '-'
    ? h('hr')
    : h('button', { onclick: () => { closeMenu(); item[1](); } }, item[0]))));
  menu.hidden = false;
  const { innerWidth: w, innerHeight: hgt } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(e.clientX, w - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(e.clientY, hgt - r.height - 8))}px`;
}
function closeMenu() { $('#menu').hidden = true; }
document.addEventListener('click', (e) => { if (!$('#menu').contains(e.target)) closeMenu(); });
window.addEventListener('blur', closeMenu);

async function customCounter(iid) {
  const kind = h('input', { value: 'loyalty', placeholder: 'เช่น loyalty, charge, time, -1/-1' });
  const count = h('input', { type: 'number', min: '1', max: '99', value: '1', class: 'num' });
  const result = await ask({
    title: 'ใส่ Counter',
    body: h('div', { class: 'form-grid' }, h('label', {}, 'ชนิด', kind), h('label', {}, 'จำนวน', count)),
    read: () => ({ kind: kind.value.trim(), n: Number.parseInt(count.value, 10) || 1 }),
  });
  if (result?.kind) act('counter', { iid, kind: result.kind, delta: result.n });
}

function cardMenu(c, zone) {
  const iid = c.iid;
  const move = (to, extra = {}) => () => act('move', { iid, to, ...extra });
  const items = [['📖 คำอธิบายภาษาไทย', () => explain(c)], '-'];
  if (zone === 'battlefield') {
    items.push(
      [c.tapped ? '↺ Untap' : '↻ Tap (ดับเบิลคลิก)', () => act('tap', { iid })],
      [c.faceDown ? 'หงายหน้า' : 'คว่ำหน้า', () => act('faceDown', { iid })],
    );
    if (c.back) items.push(['🔄 พลิกด้าน (Transform)', () => act('transform', { iid })]);
    items.push('-');
    const kinds = Object.keys(c.counters || {});
    if (!kinds.includes('+1/+1')) items.push(['➕ +1/+1 counter', () => act('counter', { iid, kind: '+1/+1', delta: 1 })]);
    for (const k of kinds) {
      items.push([`➕ ${k} counter`, () => act('counter', { iid, kind: k, delta: 1 })]);
      items.push([`➖ ${k} counter`, () => act('counter', { iid, kind: k, delta: -1 })]);
    }
    items.push(['Counter อื่น ๆ…', () => customCounter(iid)]);
  } else if (zone === 'hand') {
    items.push(
      ['✨ ร่าย / ลงสนาม (ดับเบิลคลิก)', () => act('cast', { iid })],
      ['วางลงสนามโดยไม่ร่าย (จากผลของการ์ด)', move('battlefield')],
      ['วางลงสนามแบบคว่ำหน้า', move('battlefield', { faceDown: true })],
      ['👁 เปิดให้คู่แข่งดู', () => act('reveal', { iid })],
    );
  } else {
    items.push(['วางลงสนาม', move('battlefield')]);
  }
  items.push('-');
  for (const to of ['hand', 'graveyard', 'exile', 'command']) {
    if (to !== zone) items.push([`→ ${PILE_ICON[to]} ${ZONE_LABEL[to]}`, move(to)]);
  }
  items.push(['→ 📚 บนสุดของ Library', move('library', { pos: 'top' })], ['→ 📚 ล่างสุดของ Library', move('library', { pos: 'bottom' })]);
  return items;
}

function libraryMenu() {
  return [
    ['จั่ว 1 ใบ  (D)', () => act('draw', { n: 1 })],
    ['จั่วหลายใบ…', async () => { const n = await askNumber('จั่วกี่ใบ?'); if (n) act('draw', { n }); }],
    ['🔀 สับ Library', () => act('shuffle')],
    '-',
    ['🔍 ดูบนสุด (Scry / Surveil)…', async () => { const n = await askNumber('ดูการ์ดบนสุดกี่ใบ?'); if (n) openLibraryView(n); }],
    ['🔎 ค้นหาทั้ง Library', () => openLibraryView(0)],
    ['🪦 Mill…', async () => { const n = await askNumber('Mill (ทิ้งการ์ดบนสุดลงสุสาน) กี่ใบ?'); if (n) act('mill', { n }); }],
    '-',
    ['♻️ Mulligan', mulligan],
  ];
}

async function mulligan() {
  if (await confirmAsk('Mulligan', 'เก็บไพ่ในมือกลับเข้า Library สับ แล้วจั่วใหม่ 7 ใบ จากนั้นเลือกการ์ดวางล่างสุดของ Library ตามจำนวนครั้งที่ mulligan (คลิกขวาที่การ์ด)', 'Mulligan')) act('mulligan');
}

// ---------- zone viewer ----------

function openZone(pid, zone) {
  zoneView = { pid, zone };
  refreshZoneView();
  if (!$('#zoneDialog').open) $('#zoneDialog').show();
}

async function openLibraryView(n) {
  const res = await act('peek', { n });
  if (!res.ok) return;
  zoneView = { pid: state.you, zone: 'library', n, cards: res.data };
  refreshZoneView();
  if (!$('#zoneDialog').open) $('#zoneDialog').show();
}

function refreshZoneView() {
  const p = state.players.find((x) => x.id === zoneView.pid);
  if (!p) return closeZone();
  const mine = p.id === state.you;
  const isLibrary = zoneView.zone === 'library';

  if (isLibrary && !zoneView.fresh) {
    // Library contents aren't in the shared state; fetch them again without logging.
    send('act', { type: 'peek', n: zoneView.n, silent: true }).then((res) => {
      if (!res.ok || zoneView?.zone !== 'library') return;
      zoneView.cards = res.data;
      zoneView.fresh = true;
      refreshZoneView();
    });
  }
  if (isLibrary) zoneView.fresh = false;

  const cards = isLibrary ? zoneView.cards : [...p[zoneView.zone]].reverse();
  $('#zoneTitle').textContent = isLibrary
    ? (zoneView.n ? `📚 Library: บนสุด ${zoneView.n} ใบ` : `🔎 ค้นหา Library (${cards.length} ใบ)`)
    : `${PILE_ICON[zoneView.zone]} ${ZONE_LABEL[zoneView.zone]} ของ ${p.name} (${cards.length})`;
  $('#zoneHint').textContent = mine
    ? (isLibrary ? 'ซ้ายสุด = บนสุด · คลิกขวาที่การ์ดเพื่อย้าย หรือลากไปวางบนสนาม/มือ · ค้นหาเสร็จอย่าลืมสับ Library' : 'ใบล่าสุดอยู่ซ้ายสุด · คลิกขวาหรือลากการ์ดเพื่อย้าย')
    : 'ใบล่าสุดอยู่ซ้ายสุด';
  $('#zoneCards').replaceChildren(...cards.map((c) => cardEl(c, zoneView.zone, mine)));
}

function closeZone() {
  zoneView = null;
  $('#zoneDialog').close();
}
$('#zoneClose').addEventListener('click', closeZone);

// ---------- deck dialog ----------

function openDeckDialog() {
  $('#deckText').value = store.get('mtg.deck') || '';
  $('#deckStatus').textContent = '';
  $('#deckDialog').showModal();
}

$('#presetGrid').append(...PRESET_DECKS.map((d) => h('button', {
  type: 'button',
  class: 'preset',
  onclick: () => {
    $('#deckText').value = d.list;
    document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('selected', b.textContent.startsWith(d.name)));
  },
}, h('b', {}, d.name), h('small', {}, d.style))));
$('#deckCancel').addEventListener('click', () => $('#deckDialog').close());
$('#deckForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#deckText').value;
  const status = $('#deckStatus');
  const button = $('#deckSubmit');
  status.textContent = '⏳ กำลังดึงข้อมูลการ์ดจาก Scryfall…';
  button.disabled = true;
  const res = await send('deck', { text });
  button.disabled = false;
  if (!res.ok) {
    status.textContent = `❌ ${res.error}`;
    return;
  }
  store.set('mtg.deck', text);
  if (res.data.notFound.length) {
    status.textContent = `โหลดแล้ว ${res.data.count} ใบ แต่หาไม่เจอ: ${res.data.notFound.join(', ')}`;
  } else {
    $('#deckDialog').close();
    toast(`✅ โหลดเด็คแล้ว ${res.data.count} ใบ`, 'info');
  }
});

// ---------- tokens, tools, help ----------

async function createToken() {
  const name = h('input', { placeholder: 'ชื่อ Token' });
  const pt = h('input', { placeholder: 'เช่น 1/1', class: 'num' });
  const dlg = $('#askDialog');
  const presets = h('div', { class: 'token-grid' }, TOKENS.map(([n, p, icon]) => h('button', {
    type: 'button',
    onclick: () => dlg.finish({ name: n, pt: p }),
  }, h('span', {}, icon), h('b', {}, n), p && h('small', {}, p))));
  const result = await ask({
    title: '➕ สร้าง Token',
    body: h('div', {}, presets, h('p', { class: 'sub' }, 'หรือสร้างเอง:'), h('div', { class: 'form-grid' }, h('label', {}, 'ชื่อ', name), h('label', {}, 'P/T', pt))),
    buttons: [['ยกเลิก', null], ['สร้าง', true, 'primary']],
    read: () => (name.value.trim() ? { name: name.value.trim(), pt: pt.value.trim() } : null),
  });
  if (result) act('token', result);
}

async function copyLink() {
  const link = `${location.origin}/#${state.roomId}`;
  try {
    await navigator.clipboard.writeText(link);
    toast(`🔗 คัดลอกลิงก์แล้ว ส่งให้เพื่อนได้เลย: ${link}`, 'info');
  } catch {
    ask({ title: 'ลิงก์ชวนเพื่อน', body: h('input', { value: link, readonly: '' }), buttons: [['ปิด', null, 'primary']] });
  }
}

function toolsMenu() {
  return [
    ['📋 โหลดเด็ค', openDeckDialog],
    ['➕ สร้าง Token', createToken],
    '-',
    ['จั่ว 1 ใบ  (D)', () => act('draw', { n: 1 })],
    ['Untap ทั้งหมด  (U)', () => act('untapAll')],
    ['♻️ Mulligan', mulligan],
    '-',
    ['🎲 ทอยเต๋า d6', () => act('roll', { sides: 6 })],
    ['🎲 ทอยเต๋า d20', () => act('roll', { sides: 20 })],
    ['🪙 โยนเหรียญ', () => act('coin')],
    '-',
    ['🎲 สุ่มคนเริ่มเกมใหม่', async () => { if (await confirmAsk('สุ่มคนเริ่มใหม่?', 'เทิร์นจะเริ่มนับใหม่ที่ 1')) act('startGame'); }],
    ['↻ เริ่มเกมใหม่ (เด็คเดิม)', async () => {
      if (await confirmAsk('เริ่มเกมใหม่?', 'เก็บการ์ดทั้งหมดของคุณ สับเด็ค แล้วจั่ว 7 ใบ (Life กลับเป็นค่าเริ่มต้น)', 'เริ่มใหม่')) act('reset');
    }],
  ];
}

$('#toolsBtn').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu({ clientX: r.right - 220, clientY: r.bottom + 4, stopPropagation: () => e.stopPropagation() }, toolsMenu());
});
$('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
$('#copyLink').addEventListener('click', copyLink);

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (text) act('chat', { text });
  $('#chatInput').value = '';
});

document.addEventListener('keydown', (e) => {
  if (!joined || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, textarea') || document.querySelector('dialog[open]:modal')) return;
  if (e.key === 'Escape') { closeMenu(); return; }
  const key = e.key.toLowerCase();
  if (key === 'd') act('draw', { n: 1 });
  else if (key === 'u') act('untapAll');
  else if (key === 'n') nextStep();
});

if (!store.get('mtg.seenHelp')) {
  store.set('mtg.seenHelp', '1');
  setTimeout(() => { if (joined && !$('#deckDialog').open) $('#helpDialog').showModal(); }, 800);
}
