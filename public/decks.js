'use strict';
// Ready-made 60-card decks of similar power, so two players can start right away.
// Loaded by the browser (window.PRESET_DECKS) and by the test that checks every name on Scryfall.

const PRESET_DECKS = [
  {
    id: 'burn',
    name: '🔥 Mono-Red Burn',
    style: 'Aggro: ยิงหน้าคู่แข่งให้ตายเร็วที่สุด เล่นง่ายที่สุด',
    list: `Deck
20 Mountain
4 Lightning Bolt
4 Monastery Swiftspear
4 Goblin Guide
4 Lava Spike
4 Rift Bolt
4 Skewer the Critics
4 Searing Blaze
4 Eidolon of the Great Revel
4 Chain Lightning
4 Lightning Strike`,
  },
  {
    id: 'stompy',
    name: '🌲 Mono-Green Stompy',
    style: 'Creature: ลงตัวถูก ๆ เร็ว ๆ แล้วบัฟให้ใหญ่',
    list: `Deck
17 Forest
4 Llanowar Elves
4 Elvish Mystic
4 Young Wolf
4 Nettle Sentinel
4 Skarrgan Pit-Skulk
4 Garruk's Companion
4 Strangleroot Geist
4 Rancor
4 Vines of Vastwood
4 Giant Growth
3 Blossoming Defense`,
  },
  {
    id: 'azorius',
    name: '💧 Azorius Tempo',
    style: 'Control: ตัวบินกับ counterspell ต้องคิดเยอะ เหมาะกับคนชอบวางแผน',
    list: `Deck
11 Plains
10 Island
4 Thraben Inspector
4 Spectral Sailor
4 Faerie Duelist
4 Spell Queller
4 Counterspell
4 Mana Leak
4 Swords to Plowshares
4 Brazen Borrower
3 Restoration Angel
4 Opt`,
  },
  {
    id: 'black',
    name: '💀 Mono-Black Midrange',
    style: 'Midrange: ทิ้งไพ่ ฆ่าตัว แล้วดูดเลือดปิดเกม',
    list: `Deck
22 Swamp
4 Thoughtseize
4 Duress
4 Fatal Push
4 Dark Confidant
4 Bloodghast
4 Phyrexian Rager
4 Murderous Rider
4 Liliana's Triumph
4 Gray Merchant of Asphodel
2 Sheoldred, the Apocalypse`,
  },
];

if (typeof module !== 'undefined') module.exports = { PRESET_DECKS };
else window.PRESET_DECKS = PRESET_DECKS;
