import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import seed from './collection.json';
import seedCovers from './covers.json';

// ---------------------------------------------------------------------------
// Collection state (persisted in localStorage, seeded from the spreadsheet)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'manga-shelf-v1';
const MAX_COUNT = 999;
const MAX_UNDO = 50;

let nextId = 1;
const newId = () => `s${Date.now().toString(36)}-${nextId++}`;

function normalize(items) {
  if (!Array.isArray(items)) throw new Error('Expected a list of series');
  return items
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : newId(),
      title: String(item.title ?? '').trim().replace(/\s+/g, ' '),
      author: String(item.author ?? '').trim().replace(/\s+/g, ' '),
      count: Math.min(MAX_COUNT, Math.max(1, Math.round(Number(item.count)) || 1)),
    }))
    .filter((item) => item.title)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

function load() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalize(JSON.parse(saved));
  } catch (err) {
    console.warn('Saved collection was unreadable, starting from the spreadsheet', err);
  }
  return normalize(seed);
}

// Free float positions: where each book was put by hand, as { shelf, x, y, z, flat } per
// "seriesId:volume", measured from the left end of its shelf board. `cases` is the number of
// bookcases to show even when some are empty. Treated as immutable so undo can keep old copies.
const FREE_KEY = 'manga-shelf-free-v1';

function loadFree() {
  try {
    const saved = JSON.parse(localStorage.getItem(FREE_KEY));
    if (saved && saved.books && typeof saved.books === 'object') {
      const books = {};
      for (const [key, p] of Object.entries(saved.books)) {
        if (p && [p.shelf, p.x, p.y, p.z].every(Number.isFinite) && p.shelf >= 0) {
          books[key] = { shelf: Math.floor(p.shelf), x: p.x, y: p.y, z: p.z, flat: Boolean(p.flat) };
        }
      }
      return { cases: Math.max(1, Math.floor(Number(saved.cases)) || 1), books };
    }
  } catch (err) {
    console.warn('Saved book positions were unreadable, starting over', err);
  }
  return { cases: 1, books: {} };
}

let series = load();
let free = loadFree();
let selectedId = null;
const undoStack = []; // { series, free } before each change

function snapshot() {
  undoStack.push({ series, free });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function commit(next) {
  snapshot();
  apply(normalize(next));
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(series));
  localStorage.setItem(FREE_KEY, JSON.stringify(free));
}

function apply(next, nextFree = free) {
  series = next;
  free = nextFree;
  if (!series.some((s) => s.id === selectedId)) selectedId = null;
  save();
  renderList();
  syncScene();
}

function changeCount(id, delta) {
  const current = series.find((s) => s.id === id);
  if (!current || current.count + delta < 1 || current.count + delta > MAX_COUNT) return;
  commit(
    series.map((s) =>
      s.id === id ? { ...s, count: Math.min(MAX_COUNT, Math.max(1, s.count + delta)) } : s,
    ),
  );
}

// ---------------------------------------------------------------------------
// Shelf layout. Units: 1 = 10 cm.
// ---------------------------------------------------------------------------

// Bookcase: Room Essentials 5 Shelf Bookcase from Target, black.
// 71.18 in high x 24.49 in wide x 11.57 in deep, 23.2 in between the side panels,
// bottom shelf 0.8 in off the floor. Shelf spacing is adjustable on the real one; here it is even.
const INCH = 0.254;
const SHELVES = 5;
const CASE_W = 24.49 * INCH;
const SHELF_W = 23.2 * INCH;
const SIDE = (CASE_W - SHELF_W) / 2;
const CASE_H = 71.18 * INCH;
const CASE_D = 11.57 * INCH;
const BOARD = 0.16;
const BASE = 0.8 * INCH;
const PITCH = (CASE_H - BOARD - BASE) / SHELVES;
const BOOK_D = 1.15;
const BOOK_Z = CASE_D / 2 - 0.15 - BOOK_D / 2; // spines sit just behind the front edge
const SERIES_GAP = 0.05;

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Every series gets a stable colour and book size derived from its title.
function lookOf(s) {
  const h = hash(s.title.toLowerCase());
  return {
    hue: h % 360,
    sat: 45 + ((h >>> 9) % 30),
    light: 30 + ((h >>> 14) % 26),
    thickness: 0.14 + ((h >>> 19) % 6) * 0.01,
    height: 1.72 + ((h >>> 23) % 5) * 0.05,
  };
}

const cssColor = (look) => `hsl(${look.hue} ${look.sat}% ${look.light}%)`;
const caseX = (index, cases) => (index - (cases - 1) / 2) * CASE_W;
const shelfY = (row) => BASE + (SHELVES - 1 - row) * PITCH + BOARD;

// Efficient layout, per shelf:
//   1. a front row of upright books on the shelf board,
//   2. a second row behind it, standing on a riser so its spines show over the front row,
//   3. flat stacks lying on top of the back row, filling the headroom up to the next board.
// Stacks are kept off the front row so the raised back row stays visible.
//
// Dense layout: the same two rows, but with no riser and with flat stacks on top of both rows.
// It holds the most books, and the back row is hidden behind the front one.
const LAYOUT_KEY = 'manga-shelf-layout-v1';
const CLEAR = PITCH - BOARD - 0.04; // usable height between two boards
const RISER_H = 0.6;
const BACK_Z = BOOK_Z - BOOK_D - 0.04;
const MAX_BOOK_H = 1.92;
const STACK_W = MAX_BOOK_H + 0.03; // a flat book lies with its height along the shelf

function packEfficientShelf(queue, start, shelf, out, risers, dense) {
  let i = start;
  const row = (floor, z, pullable) => {
    const placed = [];
    let x = 0;
    while (i < queue.length && x + queue[i].look.thickness <= SHELF_W) {
      const book = queue[i++];
      const { thickness, height } = book.look;
      placed.push({ ...book, shelf, x: x + thickness / 2, y: floor + height / 2, z, flat: false, pullable });
      x += thickness;
    }
    out.push(...placed);
    return placed;
  };
  const stacks = (under, floor, z) => {
    const count = Math.floor(SHELF_W / STACK_W);
    const margin = (SHELF_W - count * STACK_W) / 2;
    for (let n = 0; n < count && i < queue.length; n++) {
      const x = margin + STACK_W * (n + 0.5);
      // Every book that reaches under the stack, including ones that only poke in at the edges.
      const below = under.filter((book) => Math.abs(book.x - x) < STACK_W / 2 + book.look.thickness / 2);
      // A stack needs books under its whole length to rest on.
      if (!below.length || below.at(-1).x < x + STACK_W / 2 - 0.3) break;
      let y = floor + Math.max(...below.map((book) => book.look.height));
      while (i < queue.length && y + queue[i].look.thickness <= CLEAR) {
        const book = queue[i++];
        out.push({ ...book, shelf, x, y: y + book.look.thickness / 2, z, flat: true, pullable: true });
        y += book.look.thickness;
      }
    }
  };

  const front = row(0, BOOK_Z, true);
  if (i >= queue.length) return i;
  const backFloor = dense ? 0 : RISER_H;
  if (!dense) risers.push(shelf);
  const back = row(backFloor, BACK_Z, false);
  stacks(back, backFloor, BACK_Z);
  if (dense) stacks(front, 0, BOOK_Z);
  return i;
}

// Free float layout: every book sits where it was dropped. A book rests on the shelf board or on
// whatever is under it, and never passes through another book.
const Z_MIN = -CASE_D / 2 + 0.05 + BOOK_D / 2; // spine-to-wall limit: the back panel
const SNAP = 0.1; // how far a dropped book slides sideways to slot in next to its neighbours
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const seriesIdOf = (key) => key.slice(0, key.lastIndexOf(':'));
// Width along the shelf and height off it. A flat book lies with its height along the shelf.
const extent = (look, flat) =>
  flat ? { w: look.height, h: look.thickness } : { w: look.thickness, h: look.height };
let lookById = new Map(); // series id -> look, refreshed on every sync

function bodiesIn(books, shelf, skip) {
  const out = [];
  for (const key in books) {
    const p = books[key];
    if (p.shelf !== shelf || key === skip) continue;
    const look = lookById.get(seriesIdOf(key));
    if (look) out.push({ key, ...p, ...extent(look, p.flat) });
  }
  return out;
}

const overlaps = (body, x, z, w) =>
  Math.abs(body.x - x) < (body.w + w) / 2 - 1e-4 && Math.abs(body.z - z) < BOOK_D - 1e-4;

function restOn(bodies, x, z, w) {
  let top = 0;
  for (const body of bodies) if (overlaps(body, x, z, w)) top = Math.max(top, body.y + body.h / 2);
  return top;
}

// Where a book comes to rest if it is let go at x, z on a shelf holding `bodies`.
// Returns null when it does not fit under the board above.
function dropSpot(bodies, look, x, z, flat) {
  const { w, h } = extent(look, flat);
  const fit = (value) => clamp(value, w / 2, SHELF_W - w / 2);
  x = fit(x);
  z = clamp(z, Z_MIN, BOOK_Z);
  let floor = restOn(bodies, x, z, w);
  if (floor > 0) {
    // It landed on something. If there is a lower spot right beside it, slide into that instead.
    const raw = x;
    for (const body of bodies) {
      if (!overlaps(body, raw, z, w)) continue;
      for (const beside of [body.x - (body.w + w) / 2, body.x + (body.w + w) / 2]) {
        if (beside !== fit(beside) || Math.abs(beside - raw) > SNAP) continue;
        const level = restOn(bodies, beside, z, w);
        if (level < floor - 1e-6) {
          floor = level;
          x = beside;
        }
      }
    }
  }
  if (floor + h > CLEAR + 1e-6) return null;
  return { x, y: floor + h / 2, z, flat };
}

// Let every book on a shelf fall until it rests on something. Edits `books` in place.
function settle(books, shelf) {
  const bodies = bodiesIn(books, shelf).sort((a, b) => a.y - a.h / 2 - (b.y - b.h / 2));
  const done = [];
  for (const body of bodies) {
    const y = restOn(done, body.x, body.z, body.w) + body.h / 2;
    if (Math.abs(y - body.y) > 1e-6) books[body.key] = { shelf, x: body.x, y, z: body.z, flat: body.flat };
    done.push({ ...body, y });
  }
}

// Start free float from one of the packed layouts.
function seedFree(mode) {
  const books = {};
  const packed = computeLayout(series, mode);
  for (const { key, shelf, x, y, z, flat } of packed.slots) books[key] = { shelf, x, y, z, flat };
  // Risers are not part of free float, so books that stood on one drop to the board.
  if (packed.risers.length) for (let shelf = 0; shelf < packed.cases * SHELVES; shelf++) settle(books, shelf);
  return { cases: 1, books };
}

// The first gap in the front row that is wide enough, on the first shelf that has one.
function firstGap(books, width) {
  for (let shelf = 0; ; shelf++) {
    const row = bodiesIn(books, shelf)
      .filter((body) => Math.abs(body.z - BOOK_Z) < BOOK_D)
      .sort((a, b) => a.x - a.w / 2 - (b.x - b.w / 2));
    let x = 0;
    for (const body of row) {
      if (body.x - body.w / 2 - x >= width - 1e-6) break;
      x = Math.max(x, body.x + body.w / 2);
    }
    if (x + width <= SHELF_W + 1e-6) return { shelf, x: x + width / 2 };
  }
}

// Bring the saved positions in line with the collection: forget books that are gone, let whatever
// stood on them fall, and find a spot for books that have none. Returns the new free state, or
// the current one when nothing changed.
function reconcileFree(seedMode) {
  const wanted = [];
  for (const s of series) for (let vol = 1; vol <= s.count; vol++) wanted.push({ s, vol, key: `${s.id}:${vol}` });
  const live = new Set(wanted.map((book) => book.key));
  const keys = Object.keys(free.books);
  const kept = keys.filter((key) => live.has(key));
  if (!kept.length) return wanted.length || keys.length ? seedFree(seedMode) : free;
  const missing = wanted.filter((book) => !free.books[book.key]);
  if (kept.length === keys.length && !missing.length) return free;

  const books = {};
  for (const key of kept) books[key] = free.books[key];
  const emptied = new Set(keys.filter((key) => !live.has(key)).map((key) => free.books[key].shelf));
  for (const shelf of emptied) settle(books, shelf);
  for (const { s, vol, key } of missing) {
    const look = lookById.get(s.id);
    const { w, h } = extent(look, false);
    // Next to the previous volume when there is room on the board there, else the first gap.
    const prev = books[`${s.id}:${vol - 1}`];
    let place = null;
    if (prev && !prev.flat) {
      const x = prev.x + look.thickness / 2 + w / 2;
      const spot = x + w / 2 <= SHELF_W && dropSpot(bodiesIn(books, prev.shelf), look, x, prev.z, false);
      if (spot && Math.abs(spot.x - x) < 1e-6 && Math.abs(spot.y - h / 2) < 1e-6) place = { shelf: prev.shelf, ...spot };
    }
    if (!place) {
      const gap = firstGap(books, w);
      place = { shelf: gap.shelf, x: gap.x, y: h / 2, z: BOOK_Z, flat: false };
    }
    books[key] = place;
  }
  return { cases: free.cases, books };
}

function computeLayout(list, mode = 'standard') {
  let slots = [];
  const risers = []; // shelf indexes that carry a riser
  let shelf = 0;
  let minCases = 1;
  if (mode === 'free') {
    minCases = free.cases;
    const byShelf = new Map();
    for (const s of list) {
      const look = lookOf(s);
      for (let vol = 1; vol <= s.count; vol++) {
        const key = `${s.id}:${vol}`;
        const p = free.books[key];
        if (!p) continue;
        const slot = { key, series: s, vol, look, ...p, ...extent(look, p.flat), pullable: true };
        slots.push(slot);
        shelf = Math.max(shelf, p.shelf);
        if (!byShelf.has(p.shelf)) byShelf.set(p.shelf, []);
        byShelf.get(p.shelf).push(slot);
      }
    }
    // A book with another one in front of it cannot be pulled forward on hover.
    for (const group of byShelf.values()) {
      for (const a of group) {
        a.pullable = !group.some(
          (b) => b.z > a.z + 0.2 && Math.abs(b.x - a.x) < (a.w + b.w) / 2 && Math.abs(b.y - a.y) < (a.h + b.h) / 2,
        );
      }
    }
  } else if (mode !== 'standard') {
    const queue = [];
    for (const s of list) {
      const look = lookOf(s);
      for (let vol = 1; vol <= s.count; vol++) queue.push({ key: `${s.id}:${vol}`, series: s, vol, look });
    }
    let i = 0;
    while (i < queue.length) i = packEfficientShelf(queue, i, shelf++, slots, risers, mode === 'dense');
    shelf = Math.max(0, shelf - 1);
  } else {
    let x = 0;
    for (const s of list) {
      const look = lookOf(s);
      for (let vol = 1; vol <= s.count; vol++) {
        if (x + look.thickness > SHELF_W) {
          shelf++;
          x = 0;
        }
        slots.push({
          key: `${s.id}:${vol}`, series: s, vol, look, shelf,
          x: x + look.thickness / 2, y: look.height / 2, z: BOOK_Z, flat: false, pullable: true,
        });
        x += look.thickness;
      }
      x += SERIES_GAP;
    }
  }
  const cases = Math.max(minCases, Math.ceil((shelf + 1) / SHELVES));
  const origin = (index) => ({ x: caseX(Math.floor(index / SHELVES), cases), y: shelfY(index % SHELVES) });
  for (const slot of slots) {
    const o = origin(slot.shelf);
    slot.position = new THREE.Vector3(o.x - SHELF_W / 2 + slot.x, o.y + slot.y, slot.z);
  }
  return {
    slots,
    cases,
    risers: risers.map((index) => {
      const o = origin(index);
      return new THREE.Vector3(o.x, o.y + RISER_H / 2, BACK_Z);
    }),
  };
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const canvas = document.getElementById('scene');
const panel = document.getElementById('panel');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x17130f);
scene.fog = new THREE.Fog(0x17130f, 60, 140);

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 300);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.minDistance = 2;
controls.maxDistance = 90;

scene.add(new THREE.HemisphereLight(0xfff1dc, 0x3a2a1c, 1.1));
const sun = new THREE.DirectionalLight(0xfff4e2, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x8b6a4a, roughness: 0.85 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 80),
  new THREE.MeshStandardMaterial({ color: 0xbfb8aa, roughness: 1 }),
);
wall.position.set(0, 40, -CASE_D / 2 - 0.05);
wall.receiveShadow = true;
scene.add(floor, wall);

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const woodMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.55 }); // black wood finish
const pagesMaterial = new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.95 });

const caseGroup = new THREE.Group();
const bookGroup = new THREE.Group();
scene.add(caseGroup, bookGroup);

function addBoard(width, height, depth, x, y, z) {
  const board = new THREE.Mesh(unitBox, woodMaterial);
  board.scale.set(width, height, depth);
  board.position.set(x, y, z);
  board.castShadow = true;
  board.receiveShadow = true;
  caseGroup.add(board);
}

let caseCount = 0;
function buildCases(cases) {
  if (cases === caseCount) return;
  caseCount = cases;
  caseGroup.clear();
  for (let i = 0; i < cases; i++) {
    const x = caseX(i, cases);
    addBoard(CASE_W, CASE_H, 0.04, x, CASE_H / 2, -CASE_D / 2 + 0.02); // thin back panel
    addBoard(SIDE, CASE_H, CASE_D, x - CASE_W / 2 + SIDE / 2, CASE_H / 2, 0);
    addBoard(SIDE, CASE_H, CASE_D, x + CASE_W / 2 - SIDE / 2, CASE_H / 2, 0);
    addBoard(SHELF_W, BASE, 0.16, x, BASE / 2, CASE_D / 2 - 0.2); // kick plate
    for (let row = 0; row <= SHELVES; row++) {
      addBoard(SHELF_W, BOARD, CASE_D, x, BASE + row * PITCH + BOARD / 2, 0);
    }
  }
  // Keep the whole row of bookcases inside the shadow map.
  const half = (cases * CASE_W) / 2 + 2;
  sun.position.set(half * 0.3, CASE_H + 14, 16);
  sun.target.position.set(0, CASE_H / 2, 0);
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: 16, bottom: -16, near: 1, far: 90 });
  sun.shadow.camera.updateProjectionMatrix();
}

// Cover art. src/covers.json is generated by scripts/fetch-covers.mjs; series added in the app
// are looked up on AniList once and remembered in localStorage.
const COVER_CACHE_KEY = 'manga-shelf-covers-v1';
const titleKey = (title) => title.trim().toLowerCase().replace(/\s+/g, ' ');
let lookedUp = {};
try {
  lookedUp = JSON.parse(localStorage.getItem(COVER_CACHE_KEY)) || {};
} catch {
  lookedUp = {};
}

function coverOf(s) {
  const k = titleKey(s.title);
  return seedCovers[k] || lookedUp[k] || null;
}

async function lookupCover(title) {
  const k = titleKey(title);
  if (seedCovers[k] || k in lookedUp) return;
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query:
          'query($s:String){Page(perPage:1){media(search:$s,type:MANGA,format_in:[MANGA,ONE_SHOT],sort:SEARCH_MATCH){id title{romaji english} coverImage{extraLarge large color}}}}',
        variables: { s: title },
      }),
    });
    if (!res.ok) return;
    const media = (await res.json()).data?.Page?.media?.[0];
    lookedUp[k] = media
      ? {
          id: media.id,
          match: media.title.english || media.title.romaji,
          cover: media.coverImage.large,
          coverLarge: media.coverImage.extraLarge,
          color: media.coverImage.color,
        }
      : false;
    localStorage.setItem(COVER_CACHE_KEY, JSON.stringify(lookedUp));
    if (media) {
      renderList();
      syncScene();
    }
  } catch (err) {
    console.warn(`No cover found for ${title}`, err);
  }
}

const images = new Map(); // url -> Promise<HTMLImageElement>
function loadImage(url) {
  let promise = images.get(url);
  if (!promise) {
    promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${url}`));
      img.src = url;
    });
    images.set(url, promise);
  }
  return promise;
}

function imageTexture(img) {
  const texture = new THREE.Texture(img);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

// Spines are drawn, not scanned: nobody publishes spine images. Each one uses the cover's main
// colour, a crop of the cover art at the top, and the title.
function drawSpine(canvas, s, color, img) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const { r, g, b } = new THREE.Color(color);
  const ink = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.25 ? 'rgba(20,14,10,0.92)' : 'rgba(255,250,240,0.95)';
  let textTop = 44;
  if (img) {
    const art = 104;
    const sh = img.height * 0.5;
    const sw = Math.min(img.width, sh * (canvas.width / art) * 0.76); // spine pixels are not square
    ctx.drawImage(img, (img.width - sw) / 2, img.height * 0.1, sw, sh, 0, 0, canvas.width, art);
    textTop = art + 16;
  }
  ctx.fillStyle = ink;
  if (!img) ctx.fillRect(0, 22, canvas.width, 5);
  ctx.fillRect(0, canvas.height - 27, canvas.width, 5);
  ctx.translate(canvas.width / 2, textTop);
  ctx.rotate(Math.PI / 2);
  ctx.textBaseline = 'middle';
  const room = canvas.height - textTop - 100; // leave the foot of the spine for the volume badge
  let size = 34;
  do {
    ctx.font = `700 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
    size -= 2;
  } while (ctx.measureText(s.title).width > room && size > 12);
  ctx.fillText(s.title, 0, 2, room);
}

const seriesMaterials = new Map(); // series id -> { title, coverUrl, materials, textures, ... }

function materialsFor(s, look) {
  const cover = coverOf(s);
  const coverUrl = cover ? cover.cover : null;
  const cached = seriesMaterials.get(s.id);
  if (cached && cached.title === s.title && cached.coverUrl === coverUrl) return cached.materials;
  if (cached) disposeMaterials(s.id);

  const color = (cover && cover.color) || cssColor(look);
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 512;
  drawSpine(canvas, s, color, null);
  const spineTexture = new THREE.CanvasTexture(canvas);
  spineTexture.colorSpace = THREE.SRGBColorSpace;
  spineTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const front = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.6 });
  const back = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.6 });
  const spine = new THREE.MeshStandardMaterial({ map: spineTexture, roughness: 0.6 });
  // BoxGeometry face order: +x (front cover), -x (back cover), +y, -y, +z (spine, faces the room), -z
  const materials = [front, back, pagesMaterial, pagesMaterial, spine, pagesMaterial];
  const entry = { title: s.title, coverUrl, cover, materials, textures: [spineTexture], large: false };
  seriesMaterials.set(s.id, entry);

  if (coverUrl) {
    loadImage(coverUrl)
      .then((img) => {
        if (seriesMaterials.get(s.id) !== entry) return; // replaced or removed while loading
        if (!front.map) {
          front.map = imageTexture(img);
          front.color.set(0xffffff);
          front.needsUpdate = true;
          entry.textures.push(front.map);
        }
        drawSpine(canvas, s, color, img);
        spineTexture.needsUpdate = true;
      })
      .catch((err) => console.warn(err.message));
  }
  return materials;
}

// The shelf uses small covers; a book you pull out gets the full-size one.
function useLargeCover(id) {
  const entry = seriesMaterials.get(id);
  if (!entry || entry.large || !entry.cover || !entry.cover.coverLarge) return;
  entry.large = true;
  loadImage(entry.cover.coverLarge)
    .then((img) => {
      if (seriesMaterials.get(id) !== entry) return;
      const front = entry.materials[0];
      const old = front.map;
      front.map = imageTexture(img);
      front.color.set(0xffffff);
      front.needsUpdate = true;
      entry.textures.push(front.map);
      if (old) {
        entry.textures.splice(entry.textures.indexOf(old), 1);
        old.dispose();
      }
    })
    .catch((err) => console.warn(err.message));
}

function disposeMaterials(id) {
  const cached = seriesMaterials.get(id);
  if (!cached) return;
  cached.textures.forEach((texture) => texture.dispose());
  for (const index of [0, 1, 4]) cached.materials[index].dispose();
  seriesMaterials.delete(id);
}

// Volume numbers. Cover art is one image per series, so each spine carries a small numbered badge
// to tell the volumes apart. One texture per number, shared by every series.
const badgeGeometry = new THREE.PlaneGeometry(1, 1);
const badgeMaterials = new Map(); // volume number -> material
function badgeMaterial(vol) {
  let material = badgeMaterials.get(vol);
  if (!material) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(16,12,10,0.92)';
    ctx.beginPath();
    ctx.roundRect(4, 4, 88, 88, 20);
    ctx.fill();
    ctx.fillStyle = '#fffaf0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = String(vol);
    ctx.font = `700 ${text.length > 2 ? 40 : text.length > 1 ? 54 : 64}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText(text, 48, 51);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
    badgeMaterials.set(vol, material);
  }
  return material;
}

const books = new Map(); // "seriesId:volume" -> mesh
let layout = { slots: [], cases: 1, risers: [] };
const LAYOUT_MODES = ['standard', 'efficient', 'dense', 'free'];
let seedFrom = 'standard'; // the packed layout free float starts from
let layoutMode = LAYOUT_MODES.includes(localStorage.getItem(LAYOUT_KEY)) ? localStorage.getItem(LAYOUT_KEY) : 'standard';
const riserGroup = new THREE.Group();
scene.add(riserGroup);
const riserMaterial = new THREE.MeshStandardMaterial({
  color: 0xdcecff, roughness: 0.15, transparent: true, opacity: 0.55, // clear acrylic
});
let firstSync = true;
let inspectedKey = null; // the book pulled out and turned to show its cover

// The badge is a child of the scaled book, so undo that scale to keep it square, as wide as the
// spine, sitting just above the foot of the spine.
function layBadge(mesh, look, flat) {
  const { thickness, height } = look;
  const badge = mesh.children[0];
  const across = 0.92;
  const along = (thickness * 0.92) / height;
  // A flat book lies on its side, so turn its badge a quarter turn to keep the number upright.
  badge.rotation.z = flat ? -Math.PI / 2 : 0;
  badge.scale.set(flat ? along : across, flat ? across : along, 1);
  badge.position.set(0, -0.5 + (0.13 + thickness / 2) / height, 0.5 + 0.004 / BOOK_D);
}

function syncScene() {
  lookById = new Map(series.map((s) => [s.id, lookOf(s)]));
  if (layoutMode === 'free') {
    const next = reconcileFree(seedFrom);
    if (next !== free) {
      free = next;
      save();
    }
  }
  layout = computeLayout(series, layoutMode);
  buildCases(layout.cases);
  riserGroup.clear();
  for (const position of layout.risers) {
    const riser = new THREE.Mesh(unitBox, riserMaterial);
    riser.scale.set(SHELF_W, RISER_H, BOOK_D + 0.06);
    riser.position.copy(position);
    riserGroup.add(riser);
  }
  renderLayoutNote();

  const live = new Set();
  for (const slot of layout.slots) {
    live.add(slot.key);
    let mesh = books.get(slot.key);
    if (!mesh) {
      mesh = new THREE.Mesh(unitBox, materialsFor(slot.series, slot.look));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.copy(slot.position);
      if (!firstSync) mesh.position.add(new THREE.Vector3(0, 0.3, 2.5)); // new books slide in from the front
      mesh.add(new THREE.Mesh(badgeGeometry, badgeMaterial(slot.vol)));
      books.set(slot.key, mesh);
      bookGroup.add(mesh);
    }
    layBadge(mesh, slot.look, slot.flat);
    mesh.material = materialsFor(slot.series, slot.look);
    mesh.scale.set(slot.look.thickness, slot.look.height, BOOK_D);
    mesh.userData = { slot };
  }
  for (const [key, mesh] of books) {
    if (live.has(key)) continue;
    if (hovered === mesh) {
      hovered = null;
      tooltip.hidden = true;
    }
    bookGroup.remove(mesh);
    books.delete(key);
  }
  if (inspectedKey && !live.has(inspectedKey)) inspectedKey = null;
  const ids = new Set(series.map((s) => s.id));
  for (const id of [...seriesMaterials.keys()]) if (!ids.has(id)) disposeMaterials(id);
  firstSync = false;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

let cameraGoal = null; // { position, target } while flying somewhere
controls.addEventListener('start', () => (cameraGoal = null));

function usableAspect() {
  const inset = panel.getBoundingClientRect().right;
  return Math.max(0.3, (window.innerWidth - inset) / window.innerHeight);
}

function distanceToFit(width, height) {
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return Math.max(height / 2 / tan, width / 2 / tan / usableAspect()) * 1.12;
}

function flyTo(center, width, height, minDistance = 10) {
  const distance = Math.max(minDistance, distanceToFit(width, height));
  cameraGoal = {
    target: center.clone(),
    position: center.clone().add(new THREE.Vector3(0, distance * 0.06, distance)),
  };
}

function overview(instant) {
  flyTo(new THREE.Vector3(0, CASE_H / 2, 0), layout.cases * CASE_W, CASE_H);
  if (instant) {
    camera.position.copy(cameraGoal.position);
    controls.target.copy(cameraGoal.target);
    cameraGoal = null;
  }
}

function focusSeries(id) {
  const box = new THREE.Box3();
  for (const slot of layout.slots) if (slot.series.id === id) box.expandByPoint(slot.position);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  flyTo(box.getCenter(new THREE.Vector3()), size.x + 3, size.y + PITCH);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Shift the view so the scene is centred in the area not covered by the side panel.
  const inset = panel.getBoundingClientRect().right;
  camera.setViewOffset(w, h, -inset / 2, 0, w, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Picking: hover pulls a book out, click selects its series
// ---------------------------------------------------------------------------

const INSPECT_Z = CASE_D / 2 + 1.2;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
let hovered = null;
let downAt = null;

function pick(event) {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(bookGroup.children, false)[0]?.object ?? null;
}

function showTooltip(event) {
  if (!hovered) {
    tooltip.hidden = true;
    canvas.style.cursor = '';
    return;
  }
  const { series: s, vol } = hovered.userData.slot;
  tooltip.replaceChildren(`${s.title} · vol. ${vol} of ${s.count}`);
  if (s.author) {
    const small = document.createElement('small');
    small.textContent = s.author;
    tooltip.append(small);
  }
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 330)}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
  canvas.style.cursor = 'pointer';
}

// Free float: drag a book to move it. The pointer moves it along the shelf and between shelves,
// the wheel moves it front to back, and R lays it flat or stands it up.
let drag = null; // { mesh, slot, offsetX, z, flat, event, moved, spot }
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function planeHit(event, z) {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  dragPlane.constant = -z;
  return raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3());
}

// Runs before OrbitControls sees the press, so grabbing a book does not also orbit the camera.
window.addEventListener(
  'pointerdown',
  (event) => {
    if (layoutMode !== 'free' || event.button !== 0 || event.target !== canvas || drag) return;
    const mesh = pick(event);
    if (!mesh) return;
    const { slot } = mesh.userData;
    const hit = planeHit(event, slot.z + BOOK_D / 2);
    drag = {
      mesh, slot, event,
      offsetX: hit ? hit.x - slot.position.x : 0,
      z: slot.z, flat: slot.flat, moved: false, spot: null,
    };
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
  },
  true,
);

function startMoving() {
  drag.moved = true;
  inspectedKey = null;
  hovered = null;
  tooltip.hidden = true;
  canvas.style.cursor = 'grabbing';
}

// Work out where the dragged book would rest under the pointer. False when it does not fit there.
function updateDrag() {
  const hit = planeHit(drag.event, drag.z + BOOK_D / 2);
  if (!hit) return false;
  const { cases } = layout;
  const column = clamp(Math.round((hit.x - caseX(0, cases)) / CASE_W), 0, cases - 1);
  const row = SHELVES - 1 - clamp(Math.floor((hit.y - BASE) / PITCH), 0, SHELVES - 1);
  const shelf = column * SHELVES + row;
  const left = caseX(column, cases) - SHELF_W / 2;
  const spot = dropSpot(
    bodiesIn(free.books, shelf, drag.slot.key), drag.slot.look, hit.x - drag.offsetX - left, drag.z, drag.flat,
  );
  if (!spot) return false;
  drag.spot = { ...spot, shelf, position: new THREE.Vector3(left + spot.x, shelfY(row) + spot.y, spot.z) };
  return true;
}

function endDrag() {
  layBadge(drag.mesh, drag.slot.look, drag.slot.flat); // a move that goes through re-lays it
  drag = null;
  controls.enabled = true;
  canvas.style.cursor = '';
}

function moveBook(slot, spot) {
  const same = spot.shelf === slot.shelf && spot.flat === slot.flat &&
    Math.hypot(spot.x - slot.x, spot.y - slot.y, spot.z - slot.z) < 1e-4;
  if (same) return;
  snapshot();
  const books = { ...free.books, [slot.key]: { shelf: spot.shelf, x: spot.x, y: spot.y, z: spot.z, flat: spot.flat } };
  settle(books, slot.shelf); // whatever stood on it falls
  if (spot.shelf !== slot.shelf) settle(books, spot.shelf);
  apply(series, { ...free, books });
}

canvas.addEventListener(
  'wheel',
  (event) => {
    if (!drag) return;
    event.preventDefault();
    if (!drag.moved) startMoving();
    const z = drag.z;
    drag.z = clamp(z + event.deltaY * 0.002, Z_MIN, BOOK_Z); // scroll up pushes the book back
    if (!updateDrag()) drag.z = z;
  },
  { passive: false },
);
canvas.addEventListener('pointercancel', () => drag && endDrag());

canvas.addEventListener('pointermove', (event) => {
  if (drag) {
    drag.event = event;
    if (!drag.moved && downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 5) startMoving();
    if (drag.moved) updateDrag();
    return;
  }
  hovered = event.buttons ? null : pick(event);
  showTooltip(event);
});
canvas.addEventListener('pointerleave', () => {
  hovered = null;
  tooltip.hidden = true;
});
canvas.addEventListener('pointerdown', (event) => (downAt = [event.clientX, event.clientY]));
canvas.addEventListener('pointerup', (event) => {
  if (drag) {
    const { moved, slot, spot } = drag;
    endDrag();
    if (moved) {
      if (spot) moveBook(slot, spot);
      return;
    }
  }
  if (!downAt || Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 5) return; // it was a drag
  const mesh = pick(event);
  if (!mesh) {
    inspectedKey = null;
    select(null);
    return;
  }
  const { slot } = mesh.userData;
  inspectedKey = inspectedKey === slot.key ? null : slot.key;
  if (inspectedKey) {
    useLargeCover(slot.series.id);
    flyTo(new THREE.Vector3(slot.position.x, slot.position.y, INSPECT_Z), 3, 2.6, 5.5);
  }
  select(slot.series.id, { reveal: true });
});

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

const listEl = document.getElementById('list');
const totalsEl = document.getElementById('totals');
const searchEl = document.getElementById('search');
const undoEl = document.getElementById('undo');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderList() {
  const volumes = series.reduce((sum, s) => sum + s.count, 0);
  totalsEl.textContent = `${series.length} series · ${volumes} volumes`;
  undoEl.disabled = undoStack.length === 0;

  const query = searchEl.value.trim().toLowerCase();
  const shown = series.filter((s) => !query || `${s.title} ${s.author}`.toLowerCase().includes(query));
  const rows = shown.map((s) => {
    const li = el('li', s.id === selectedId ? 'selected' : '');
    li.dataset.id = s.id;
    const cover = coverOf(s);
    const swatch = el(cover ? 'img' : 'span', 'swatch');
    swatch.style.background = (cover && cover.color) || cssColor(lookOf(s));
    if (cover) {
      swatch.crossOrigin = 'anonymous';
      swatch.loading = 'lazy';
      swatch.alt = '';
      swatch.title = `Cover: ${cover.match}`;
      swatch.src = cover.cover;
    }
    const text = el('div', 'text');
    text.append(el('div', 'title', s.title), el('div', 'author', s.author || '—'));
    text.title = s.title;
    const controlsEl = el('div', 'controls');
    const dec = el('button', '', '−');
    dec.dataset.act = 'dec';
    dec.disabled = s.count <= 1;
    dec.setAttribute('aria-label', `Remove a volume of ${s.title}`);
    const inc = el('button', '', '+');
    inc.dataset.act = 'inc';
    inc.setAttribute('aria-label', `Add a volume of ${s.title}`);
    const del = el('button', 'remove', '✕');
    del.dataset.act = 'del';
    del.setAttribute('aria-label', `Remove ${s.title} from the shelf`);
    del.title = 'Remove series';
    controlsEl.append(dec, el('span', 'count', String(s.count)), inc, del);
    li.append(swatch, text, controlsEl);
    return li;
  });
  if (!rows.length) rows.push(el('li', 'empty', series.length ? 'No matches.' : 'The shelf is empty. Add a series above.'));
  const scroll = listEl.scrollTop;
  listEl.replaceChildren(...rows);
  listEl.scrollTop = scroll;
}

function select(id, { reveal = false, focus = false } = {}) {
  selectedId = id;
  if (id && reveal && searchEl.value && !listEl.querySelector(`[data-id="${CSS.escape(id)}"]`)) searchEl.value = '';
  renderList();
  if (id && reveal) listEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  if (id && focus) focusSeries(id);
}

listEl.addEventListener('click', (event) => {
  const row = event.target.closest('li[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  const act = event.target.closest('button')?.dataset.act;
  if (act === 'inc') changeCount(id, 1);
  else if (act === 'dec') changeCount(id, -1);
  else if (act === 'del') commit(series.filter((s) => s.id !== id));
  else select(id, { focus: true });
});

searchEl.addEventListener('input', renderList);

const layoutButtons = [...document.querySelectorAll('#layout-modes button')];
const layoutNoteEl = document.getElementById('layout-note');
const LAYOUT_NOTES = {
  standard: 'One row of upright books per shelf.',
  efficient: 'Two rows deep, the back row raised on risers so it shows, flat stacks on top of it.',
  dense: 'Two rows deep with flat stacks on top of both. Holds the most, but the back row is hidden.',
  free: 'Drag a book to any spot on any shelf. While dragging, scroll to push it back or pull it forward, and press R to lay it flat or stand it up.',
};
const freeTools = document.getElementById('free-tools');
const removeCaseEl = document.getElementById('remove-case');

function renderLayoutNote() {
  for (const button of layoutButtons) {
    const mode = button.dataset.mode;
    button.setAttribute('aria-pressed', String(mode === layoutMode));
    if (mode === 'free' && layoutMode !== 'free') {
      button.querySelector('small').textContent = 'placed by hand';
      continue;
    }
    const cases = mode === layoutMode ? layout.cases : computeLayout(series, mode).cases;
    button.querySelector('small').textContent = `${cases} bookcase${cases === 1 ? '' : 's'}`;
  }
  layoutNoteEl.textContent = LAYOUT_NOTES[layoutMode];
  freeTools.hidden = layoutMode !== 'free';
  removeCaseEl.disabled = layout.cases < 2 || layout.slots.some((slot) => slot.shelf >= (layout.cases - 1) * SHELVES);
}

freeTools.addEventListener('click', (event) => {
  const act = event.target.closest('button')?.id;
  if (!act || layoutMode !== 'free') return;
  snapshot();
  if (act === 'add-case') apply(series, { ...free, cases: layout.cases + 1 });
  else if (act === 'remove-case') apply(series, { ...free, cases: layout.cases - 1 });
  else apply(series, seedFree('standard')); // reset-places
  overview(false);
});

document.getElementById('layout-modes').addEventListener('click', (event) => {
  const mode = event.target.closest('button')?.dataset.mode;
  if (!mode || mode === layoutMode) return;
  if (layoutMode !== 'free') seedFrom = layoutMode;
  layoutMode = mode;
  localStorage.setItem(LAYOUT_KEY, layoutMode);
  inspectedKey = null;
  syncScene();
  overview(false);
});

document.getElementById('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const titleEl = document.getElementById('add-title');
  const authorEl = document.getElementById('add-author');
  const countEl = document.getElementById('add-count');
  const title = titleEl.value.trim().replace(/\s+/g, ' ');
  const count = Math.max(1, Math.round(Number(countEl.value)) || 1);
  if (!title) return;

  // Adding a title that is already on the shelf adds volumes to it instead of duplicating it.
  const existing = series.find((s) => s.title.toLowerCase() === title.toLowerCase());
  const id = existing ? existing.id : newId();
  if (existing) changeCount(id, count);
  else {
    commit([...series, { id, title, author: authorEl.value, count }]);
    lookupCover(title);
  }

  titleEl.value = '';
  authorEl.value = '';
  countEl.value = '1';
  select(id, { reveal: true, focus: true });
  titleEl.focus();
});

undoEl.addEventListener('click', () => {
  if (!undoStack.length) return;
  const previous = undoStack.pop();
  apply(previous.series, previous.free);
});

document.getElementById('reset').addEventListener('click', () => {
  commit(seed);
  overview(false);
});

document.getElementById('export').addEventListener('click', () => {
  const data = series.map(({ title, author, count }) => ({ title, author, count }));
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'manga-collection.json';
  link.click();
  URL.revokeObjectURL(url);
});

const importFile = document.getElementById('import-file');
document.getElementById('import').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const items = normalize(JSON.parse(await file.text()));
    commit(items.map((item) => ({ ...item, id: newId() })));
    overview(false);
  } catch (err) {
    alert(`Could not import ${file.name}: ${err.message}`);
  }
});

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return; // leave browser shortcuts alone
  if (event.target.closest('input, textarea')) return;
  if (drag) {
    if (event.key === 'Escape') endDrag(); // put the book back where it was
    if (event.key === 'r' || event.key === 'R') {
      if (!drag.moved) startMoving();
      drag.flat = !drag.flat;
      if (updateDrag()) layBadge(drag.mesh, drag.slot.look, drag.flat);
      else drag.flat = !drag.flat; // no room to turn it here
    }
    return;
  }
  if (event.key === 'Escape') {
    inspectedKey = null;
    select(null);
  }
  if (!selectedId) return;
  if (event.key === '+' || event.key === '=') changeCount(selectedId, 1);
  if (event.key === '-' || event.key === '_') changeCount(selectedId, -1);
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
const goal = new THREE.Vector3();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const ease = 1 - Math.exp(-dt * 10);

  for (const mesh of bookGroup.children) {
    const { slot } = mesh.userData;
    const held = drag && drag.mesh === mesh && drag.moved && drag.spot ? drag.spot : null;
    goal.copy(held ? held.position : slot.position);
    const inspected = slot.key === inspectedKey;
    const flat = held ? held.flat : slot.flat;
    if (held) goal.z += 0.1; // lifted a little towards you while it is in your hand
    else if (inspected) goal.z = INSPECT_Z;
    else if (!slot.pullable) {
      // Back-row books stay put: the front row is in the way.
    } else if (mesh === hovered) goal.z += 0.45;
    else if (slot.series.id === selectedId) goal.z += 0.2;
    mesh.position.lerp(goal, held ? 1 - Math.exp(-dt * 30) : ease);
    // Turn the pulled-out book so its front cover (+x face) faces the room.
    mesh.rotation.y += ((inspected ? -Math.PI / 2 : 0) - mesh.rotation.y) * ease;
    // Stacked books lie flat with the spine out and the title reading left to right.
    mesh.rotation.z += ((flat && !inspected ? Math.PI / 2 : 0) - mesh.rotation.z) * ease;
  }

  if (cameraGoal) {
    const camEase = 1 - Math.exp(-dt * 5);
    camera.position.lerp(cameraGoal.position, camEase);
    controls.target.lerp(cameraGoal.target, camEase);
    if (camera.position.distanceTo(cameraGoal.position) < 0.01) cameraGoal = null;
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

resize();
renderList();
syncScene();
overview(true);
tick();

// Handy for poking at the scene from the console.
window.__shelf = {
  get series() { return series; },
  get layout() { return layout; },
  books,
  layoutFor: (mode) => computeLayout(series, mode),
  get free() { return free; },
  // Where book `key` would rest if dropped at x, z on a shelf (null when it does not fit).
  dropSpot: (key, shelf, x, z, flat = false) =>
    dropSpot(bodiesIn(free.books, shelf, key), lookById.get(seriesIdOf(key)), x, z, flat),
  moveBook: (key, shelf, x, z, flat = false) => {
    const slot = layout.slots.find((item) => item.key === key);
    const spot = slot && window.__shelf.dropSpot(key, shelf, x, z, flat);
    if (spot) moveBook(slot, { ...spot, shelf });
    return spot;
  },
  limits: { SHELF_W, CLEAR, BOOK_D, CASE_D, BOOK_Z, Z_MIN },
};
