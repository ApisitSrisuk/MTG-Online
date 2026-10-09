'use strict';
// Decklist parsing and card lookup via the Scryfall API (https://scryfall.com/docs/api).

const COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const BATCH_SIZE = 75; // Scryfall's limit per /cards/collection request
const MAX_CARDS = 300;
const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'MTGOnline/0.1 (personal tabletop)',
};

const SECTION_RE = /^(?:\/\/\s*)?(commanders?|companion|deck|main|mainboard|sideboard|maybeboard|considering)\s*:?\s*$/i;
const LINE_RE = /^(?:(\d+)\s*x?\s+)?(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)(?:\s+(\S+))?)?$/;

const cache = new Map();
const normName = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sectionOf(word) {
  const w = word.toLowerCase();
  if (w.startsWith('commander')) return 'commander';
  if (w === 'deck' || w.startsWith('main')) return 'main';
  return 'side';
}

// Accepts the common export formats (MTG Arena, Moxfield, Archidekt, plain "4 Card Name").
function parseDecklist(text) {
  const entries = [];
  let section = 'main';
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const header = line.match(SECTION_RE);
    if (header) {
      section = sectionOf(header[1]);
      continue;
    }
    if (/^(#|\/\/|about$|name\s)/i.test(line)) continue;

    let lineSection = section;
    if (/^SB:\s*/i.test(line)) {
      lineSection = 'side';
      line = line.replace(/^SB:\s*/i, '');
    }
    if (/\*CMDR\*/i.test(line)) lineSection = 'commander';
    line = line
      .replace(/\s\*[A-Z]+\*/gi, '') // *F*, *E*, *CMDR*
      .replace(/\s\[[^\]]*\]/g, '') // Archidekt categories
      .replace(/\s\^[^^]*\^/g, '') // Archidekt labels
      .trim();

    const m = line.match(LINE_RE);
    if (!m || !m[2]) continue;
    entries.push({
      qty: Math.min(250, Math.max(1, Number.parseInt(m[1] || '1', 10))),
      name: m[2].trim(),
      set: m[3] || null,
      cn: m[4] || null,
      section: lineSection,
    });
  }
  return entries;
}

// "3" -> 3, "*" or "1+*" -> 0 (variable stats are tracked by hand), missing -> null
const toStat = (v) => (v == null ? null : Number.parseInt(v, 10) || 0);

function summarize(card) {
  const faces = card.card_faces || [];
  const front = card.image_uris || faces[0]?.image_uris;
  const backFace = !card.image_uris && faces[1]?.image_uris ? faces[1] : null;
  // Multi-face cards (transform, adventure, split) are cast using their first face.
  const main = faces[0] || card;
  return {
    name: backFace ? faces[0].name : card.name,
    img: front?.normal || null,
    back: backFace ? backFace.image_uris.normal : null,
    backName: backFace ? backFace.name : null,
    typeLine: main.type_line || card.type_line || '',
    manaCost: main.mana_cost ?? card.mana_cost ?? '',
    producedMana: (card.produced_mana || []).filter((m) => 'WUBRGC'.includes(m)),
    keywords: card.keywords || [],
    cmc: card.cmc ?? 0,
    power: toStat(main.power ?? card.power),
    toughness: toStat(main.toughness ?? card.toughness),
    oracleText: faces.length
      ? faces.map((f) => `${f.name}: ${f.oracle_text || ''}`).join('\n\n')
      : card.oracle_text || '',
  };
}

const nameKey = (name) => `n:${normName(name)}`;
const printKey = (set, cn) => `s:${set.toLowerCase()}:${String(cn).toLowerCase()}`;
const keyOf = (e) => (e.set && e.cn ? printKey(e.set, e.cn) : nameKey(e.name));

function register(card) {
  const summary = summarize(card);
  cache.set(printKey(card.set, card.collector_number), summary);
  for (const name of [card.name, ...(card.card_faces || []).map((f) => f.name)]) {
    if (!cache.has(nameKey(name))) cache.set(nameKey(name), summary);
  }
}

async function fetchCollection(identifiers) {
  for (let i = 0; i < identifiers.length; i += BATCH_SIZE) {
    if (i) await sleep(120); // stay well under Scryfall's rate limit
    const res = await fetch(COLLECTION_URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ identifiers: identifiers.slice(i, i + BATCH_SIZE) }),
    });
    if (!res.ok) throw new Error(`Scryfall ตอบกลับผิดพลาด (${res.status})`);
    const json = await res.json();
    for (const card of json.data || []) register(card);
  }
}

// Returns one entry per physical card (quantities expanded) plus names Scryfall couldn't find.
async function resolveDeck(entries) {
  const total = entries.reduce((sum, e) => sum + e.qty, 0);
  if (total > MAX_CARDS) throw new Error(`เด็คใหญ่เกินไป (${total} ใบ, สูงสุด ${MAX_CARDS})`);

  const uniqueMissing = (list, key) => [...new Map(list.filter((e) => !cache.has(key(e))).map((e) => [key(e), e])).values()];

  const missing = uniqueMissing(entries, keyOf);
  await fetchCollection(
    missing.map((e) => (e.set && e.cn ? { set: e.set, collector_number: e.cn } : { name: e.name })),
  );
  // A specific printing that wasn't found falls back to lookup by name.
  const fallback = uniqueMissing(entries.filter((e) => !cache.has(keyOf(e))), (e) => nameKey(e.name));
  await fetchCollection(fallback.map((e) => ({ name: e.name })));

  const cards = [];
  const notFound = [];
  for (const e of entries) {
    const summary = cache.get(keyOf(e)) || cache.get(nameKey(e.name));
    if (!summary) {
      notFound.push(e.name);
      continue;
    }
    if (e.section === 'side') continue;
    for (let i = 0; i < e.qty; i++) cards.push({ ...summary, section: e.section });
  }
  return { cards, notFound: [...new Set(notFound)] };
}

module.exports = { parseDecklist, resolveDeck, summarize };
