'use strict';
// Thai explanations shown under the card preview.
// CARD_TH covers every card in the preset decks; KEYWORD_TH explains keywords on any card.

const KEYWORD_TH = {
  Flying: 'บินได้: บล็อกได้เฉพาะ creature ที่มี Flying หรือ Reach',
  Reach: 'บล็อก creature ที่บินได้',
  Haste: 'โจมตีหรือ tap ใช้ความสามารถได้ทันทีในเทิร์นที่ลงสนาม',
  Trample: 'ถ้าโดนบล็อก damage ที่เกินพลังป้องกันของตัวบล็อกจะทะลุไปถึงผู้เล่น',
  Vigilance: 'โจมตีโดยไม่ต้อง tap',
  Lifelink: 'ทำ damage เท่าไร เจ้าของได้ Life เท่านั้น',
  Deathtouch: 'damage แม้แค่ 1 แต้มก็ทำให้ creature ที่โดนตาย',
  'First strike': 'ทำ damage ในการต่อสู้ก่อนฝ่ายที่ไม่มี First strike',
  'Double strike': 'ทำ damage ในการต่อสู้ 2 ครั้ง (ก่อนและพร้อมกับคนอื่น)',
  Flash: 'ร่ายได้ทุกเมื่อเหมือน Instant แม้แต่ในตาคู่แข่ง',
  Hexproof: 'คู่แข่งเลือกเป็นเป้าหมายของสเปลหรือความสามารถไม่ได้',
  Indestructible: 'ไม่ตายจาก damage และไม่ถูกทำลายด้วยคำว่า "destroy"',
  Menace: 'ต้องใช้ creature บล็อก 2 ตัวขึ้นไป',
  Defender: 'โจมตีไม่ได้',
  Prowess: 'ทุกครั้งที่คุณร่ายสเปลที่ไม่ใช่ creature ได้ +1/+1 จนจบเทิร์น',
  Undying: 'เมื่อตายโดยไม่มี +1/+1 counter จะกลับสนามพร้อม +1/+1 counter 1 อัน',
  Persist: 'เมื่อตายโดยไม่มี -1/-1 counter จะกลับสนามพร้อม -1/-1 counter 1 อัน',
  Ward: 'ถ้าคู่แข่งเลือกเป็นเป้าหมาย เขาต้องจ่ายค่า Ward ไม่งั้นสเปลจะถูก counter',
  Scry: 'ดูการ์ดบนสุดของ Library ตามจำนวน แล้วเลือกวางไว้บนหรือล่างสุด (คลิกขวาที่ Library → ดูบนสุด)',
  Surveil: 'ดูการ์ดบนสุดของ Library แล้วเลือกเก็บไว้บนสุดหรือทิ้งลงสุสาน',
  Investigate: 'สร้าง Clue token (จ่าย {2} แล้ว sacrifice เพื่อจั่ว 1 ใบ)',
  Landfall: 'ทำงานเมื่อคุณลง Land',
  Kicker: 'จ่ายเพิ่มตอนร่ายได้ ถ้าจ่ายจะได้ผลเพิ่ม',
  Suspend: 'จ่ายค่า Suspend แล้ว exile การ์ดพร้อม time counter ต้นเทิร์นคุณเอา counter ออก 1 อัน หมดเมื่อไรร่ายฟรี',
  Spectacle: 'ถ้าคู่แข่งเสีย Life ในเทิร์นนี้แล้ว ร่ายด้วยค่า Spectacle ที่ถูกกว่าได้',
  Bloodthirst: 'ถ้าคู่แข่งโดน damage ในเทิร์นนี้แล้ว จะลงสนามพร้อม +1/+1 counter',
  Revolt: 'ทำงานถ้ามี permanent ของคุณออกจากสนามในเทิร์นนี้',
  Adventure: 'ร่ายฝั่ง Adventure (สเปลเล็ก) ก่อนได้ แล้ว exile ไว้ ทีหลังค่อยร่ายเป็น creature จาก exile',
  Protection: 'ป้องกันจากสีหรือสิ่งที่ระบุ: ไม่โดน damage ไม่ถูกบล็อก ไม่ถูกเลือกเป็นเป้าหมาย และติด Aura ไม่ได้',
  Enchant: 'Aura: ติดอยู่บนสิ่งที่ระบุ',
  Equip: 'จ่ายค่า Equip เพื่อติดอุปกรณ์ให้ creature ของคุณ (ทำได้แค่จังหวะ sorcery)',
  Cycling: 'จ่ายค่า Cycling แล้วทิ้งการ์ดใบนี้ เพื่อจั่ว 1 ใบ',
  Flashback: 'ร่ายจากสุสานได้อีกครั้งด้วยค่า Flashback แล้วการ์ดจะถูก exile',
  Convoke: 'tap creature ของคุณช่วยจ่ายค่าร่ายได้ (ตัวละ 1 มานา)',
  Delve: 'exile การ์ดจากสุสานช่วยจ่ายค่ามานาแบบไม่ระบุสีได้ (ใบละ 1)',
  Cascade: 'เมื่อร่าย เปิดการ์ดจาก Library จนเจอใบที่ถูกกว่า แล้วร่ายใบนั้นฟรี',
  Mill: 'เอาการ์ดบนสุดของ Library ลงสุสาน',
  Toxic: 'ทำ damage ใส่ผู้เล่นแล้วผู้เล่นได้ Poison counter ตามจำนวน (ครบ 10 แพ้)',
  Infect: 'ทำ damage เป็น -1/-1 counter ใส่ creature และเป็น Poison ใส่ผู้เล่น',
  Affinity: 'ถูกลง 1 ต่อสิ่งที่ระบุแต่ละอันที่คุณควบคุม',
  Fabricate: 'ลงสนามแล้วเลือก: ใส่ +1/+1 counter หรือสร้าง Servo 1/1',
  Treasure: 'Treasure token: tap และ sacrifice เพื่อได้มานา 1 สีใดก็ได้',
  Food: 'Food token: จ่าย {2} tap และ sacrifice เพื่อได้ 3 Life',
  Clue: 'Clue token: จ่าย {2} และ sacrifice เพื่อจั่ว 1 ใบ',
};

const basic = (color) => `Land พื้นฐาน: tap เพื่อได้มานา${color} 1`;

const CARD_TH = {
  // Lands
  Mountain: basic('แดง {R}'),
  Forest: basic('เขียว {G}'),
  Plains: basic('ขาว {W}'),
  Island: basic('น้ำเงิน {U}'),
  Swamp: basic('ดำ {B}'),

  // Tokens
  Treasure: 'tap และ sacrifice: ได้มานา 1 สีใดก็ได้',
  Clue: 'จ่าย {2} แล้ว sacrifice: จั่ว 1 ใบ',
  Food: 'จ่าย {2} tap แล้ว sacrifice: ได้ 3 Life',

  // 🔥 Burn
  'Lightning Bolt': 'Instant: ทำ 3 damage ใส่เป้าหมายใดก็ได้ (creature, ผู้เล่น หรือ planeswalker)',
  'Chain Lightning': 'Sorcery: ทำ 3 damage ใส่เป้าหมายใดก็ได้ จากนั้นผู้เล่นหรือเจ้าของ permanent ที่โดน จ่าย {R}{R} เพื่อ copy สเปลนี้ยิงกลับได้',
  'Lightning Strike': 'Instant: ทำ 3 damage ใส่เป้าหมายใดก็ได้',
  'Monastery Swiftspear': 'creature 1/2 มี Haste (โจมตีได้ทันที) และ Prowess (ร่ายสเปลที่ไม่ใช่ creature แล้วได้ +1/+1 จนจบเทิร์น)',
  'Goblin Guide': 'creature 2/2 มี Haste ทุกครั้งที่โจมตี ฝ่ายป้องกันเปิดการ์ดบนสุดของ Library ถ้าเป็น Land เขาได้เก็บเข้ามือ',
  'Lava Spike': 'Sorcery: ทำ 3 damage ใส่ผู้เล่นหรือ planeswalker เท่านั้น (ใส่ creature ไม่ได้)',
  'Rift Bolt': 'Sorcery: ทำ 3 damage ใส่เป้าหมายใดก็ได้ ปกติต้องจ่าย {2}{R} แต่ใช้ Suspend 1 ได้ คือจ่าย {R} แล้ว exile ไว้ เทิร์นหน้าร่ายฟรี (ในแอปให้ย้ายไป Exile แล้วใส่ time counter เอง)',
  'Skewer the Critics': 'Sorcery: ทำ 3 damage ใส่เป้าหมายใดก็ได้ ถ้าคู่แข่งเสีย Life ในเทิร์นนี้แล้ว (Spectacle) จ่ายแค่ {R} ได้ (ให้กดข้ามกติกาแล้วลดมานาเอง)',
  'Searing Blaze': 'Instant: เลือกผู้เล่นหนึ่งคนและ creature ของเขา ทำ 1 damage ใส่ทั้งคู่ ถ้าคุณลง Land ในเทิร์นนี้แล้ว (Landfall) ทำ 3 damage แทน',
  'Eidolon of the Great Revel': 'Enchantment creature 2/2: ทุกครั้งที่ผู้เล่นคนไหนร่ายสเปลค่ามานาไม่เกิน 3 ผู้เล่นคนนั้นโดน 2 damage (โดนทั้งสองฝ่าย!)',

  // 🌲 Stompy
  'Llanowar Elves': 'creature 1/1: tap เพื่อได้มานาเขียว {G} 1 (ใช้ในเทิร์นที่ลงไม่ได้)',
  'Elvish Mystic': 'creature 1/1: tap เพื่อได้มานาเขียว {G} 1 (ใช้ในเทิร์นที่ลงไม่ได้)',
  'Young Wolf': 'creature 1/1 มี Undying: ตายครั้งแรกแล้วกลับสนามพร้อม +1/+1 counter (กลายเป็น 2/2)',
  'Nettle Sentinel': 'creature 2/2: ไม่ untap เองตอนต้นเทิร์น แต่ทุกครั้งที่คุณร่ายสเปลสีเขียว untap มันได้ (ระบบ untap ให้อัตโนมัติ ถ้าจะเล่นตรงกติกาให้ tap กลับเอง)',
  'Skarrgan Pit-Skulk': 'creature 1/1 มี Bloodthirst 1 (ถ้าคู่แข่งโดน damage ในเทิร์นนี้ ลงสนามพร้อม +1/+1 counter) และ creature ที่ power น้อยกว่ามันบล็อกมันไม่ได้',
  "Garruk's Companion": 'creature 3/2 มี Trample (damage เกินทะลุถึงผู้เล่น) และ Protection from red (สเปลแดงทำอะไรมันไม่ได้)',
  'Strangleroot Geist': 'creature 2/1 มี Haste และ Undying (ตายครั้งแรกกลับมาเป็น 3/2)',
  Rancor: 'Aura: creature ที่ติดได้ +2/+0 และ Trample ถ้า Rancor ลงสุสานจากสนาม จะกลับเข้ามือคุณ',
  'Vines of Vastwood': 'Instant: creature เป้าหมายจนจบเทิร์น คู่แข่งเลือกมันเป็นเป้าหมายไม่ได้ ถ้าจ่าย Kicker {G} เพิ่ม ได้ +4/+4 ด้วย',
  'Giant Growth': 'Instant: creature เป้าหมายได้ +3/+3 จนจบเทิร์น',
  'Blossoming Defense': 'Instant: creature ของคุณได้ +2/+2 และ Hexproof จนจบเทิร์น (ใช้หลบสเปลฆ่า)',

  // 💧 Azorius
  'Thraben Inspector': 'creature 1/2: เมื่อลงสนาม Investigate คือสร้าง Clue token (จ่าย {2} แล้ว sacrifice เพื่อจั่ว 1)',
  'Spectral Sailor': 'creature 1/1 มี Flash และ Flying จ่าย {3}{U}: จั่ว 1 ใบ',
  'Faerie Duelist': 'creature 1/2 มี Flash และ Flying เมื่อลงสนาม creature ของคู่แข่ง 1 ตัวได้ -2/-0 จนจบเทิร์น (ใช้กันตอนโดนโจมตี)',
  'Spell Queller': 'creature 2/3 มี Flash และ Flying เมื่อลงสนาม exile สเปลค่ามานาไม่เกิน 4 ที่คู่แข่งกำลังร่าย ถ้า Queller ออกจากสนาม เจ้าของสเปลได้ร่ายใบนั้นฟรี',
  Counterspell: 'Instant: ยกเลิก (counter) สเปลที่คู่แข่งกำลังร่าย 1 ใบ',
  'Mana Leak': 'Instant: ยกเลิกสเปลเป้าหมาย เว้นแต่เจ้าของจะจ่ายเพิ่ม {3}',
  'Swords to Plowshares': 'Instant: exile creature เป้าหมาย 1 ตัว เจ้าของมันได้ Life เท่ากับ power ของมัน',
  'Brazen Borrower': 'creature 3/1 มี Flash และ Flying บล็อกได้เฉพาะตัวบิน ร่ายฝั่ง Petty Theft ({1}{U} Instant) ก่อนได้: ส่ง permanent ของคู่แข่งกลับมือ แล้ว exile ไว้ ทีหลังค่อยร่ายเป็น creature',
  'Restoration Angel': 'creature 3/4 มี Flash และ Flying เมื่อลงสนาม exile creature ของคุณที่ไม่ใช่ Angel แล้วคืนกลับสนามทันที (ใช้ช่วยตัวที่กำลังจะตาย หรือใช้ความสามารถตอนลงสนามซ้ำ)',
  Opt: 'Instant: Scry 1 (ดูใบบนสุด เลือกวางบนหรือล่าง) แล้วจั่ว 1 ใบ',

  // 💀 Black
  Thoughtseize: 'Sorcery: ดูมือผู้เล่นเป้าหมาย เลือกการ์ดที่ไม่ใช่ Land 1 ใบให้ทิ้ง แล้วคุณเสีย 2 Life',
  Duress: 'Sorcery: ดูมือคู่แข่ง เลือกการ์ดที่ไม่ใช่ creature และไม่ใช่ Land 1 ใบให้ทิ้ง',
  'Fatal Push': 'Instant: ทำลาย creature ค่ามานาไม่เกิน 2 ถ้ามี permanent ของคุณออกจากสนามในเทิร์นนี้ (Revolt) ทำลายได้ถึงค่า 4',
  'Dark Confidant': 'creature 2/1: ต้นเทิร์นคุณ (Upkeep) เปิดการ์ดบนสุดของ Library เก็บเข้ามือ แล้วเสีย Life เท่ากับค่ามานาของใบนั้น',
  Bloodghast: 'creature 2/1 บล็อกไม่ได้ ถ้าคู่แข่งเหลือ Life ไม่เกิน 10 ได้ Haste เมื่อคุณลง Land ขณะที่มันอยู่ในสุสาน คืนมันกลับสนามได้',
  'Phyrexian Rager': 'creature 3/2: เมื่อลงสนาม จั่ว 1 ใบ และเสีย 1 Life',
  'Murderous Rider': 'creature 2/3 มี Lifelink ร่ายฝั่ง Swift End ({1}{B}{B} Instant) ก่อนได้: ทำลาย creature หรือ planeswalker 1 ตัว แล้วเสีย 2 Life เมื่อ Rider ตาย ให้วางไว้ล่างสุดของ Library',
  "Liliana's Triumph": 'Instant: คู่แข่งแต่ละคนต้องเลือก sacrifice creature ของตัวเอง 1 ตัว (ถ้าคุณมี Liliana planeswalker เขาต้องทิ้งไพ่ 1 ใบด้วย)',
  'Gray Merchant of Asphodel': 'creature 2/4: เมื่อลงสนาม คู่แข่งเสีย Life เท่ากับจำนวนสัญลักษณ์ {B} ใน mana cost ของ permanent ทั้งหมดของคุณ (Devotion) แล้วคุณได้ Life เท่ากัน',
  'Sheoldred, the Apocalypse': 'creature 4/5 มี Deathtouch ทุกครั้งที่คุณจั่ว ได้ 2 Life ทุกครั้งที่คู่แข่งจั่ว เขาเสีย 2 Life',
};

if (typeof module !== 'undefined') module.exports = { KEYWORD_TH, CARD_TH };
else Object.assign(window, { KEYWORD_TH, CARD_TH });
