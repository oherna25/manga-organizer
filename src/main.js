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

let series = load();
let selectedId = null;
const undoStack = [];

function commit(next) {
  undoStack.push(series);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  apply(normalize(next));
}

function apply(next) {
  series = next;
  if (!series.some((s) => s.id === selectedId)) selectedId = null;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(series));
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

function computeLayout(list, mode = 'standard') {
  let slots = [];
  const risers = []; // shelf indexes that carry a riser
  let shelf = 0;
  if (mode !== 'standard') {
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
  const cases = Math.max(1, Math.ceil((shelf + 1) / SHELVES));
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
  const room = canvas.height - textTop - 44;
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

const books = new Map(); // "seriesId:volume" -> mesh
let layout = { slots: [], cases: 1, risers: [] };
const LAYOUT_MODES = ['standard', 'efficient', 'dense'];
let layoutMode = LAYOUT_MODES.includes(localStorage.getItem(LAYOUT_KEY)) ? localStorage.getItem(LAYOUT_KEY) : 'standard';
const riserGroup = new THREE.Group();
scene.add(riserGroup);
const riserMaterial = new THREE.MeshStandardMaterial({
  color: 0xdcecff, roughness: 0.15, transparent: true, opacity: 0.55, // clear acrylic
});
let firstSync = true;
let inspectedKey = null; // the book pulled out and turned to show its cover

function syncScene() {
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
      books.set(slot.key, mesh);
      bookGroup.add(mesh);
    }
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

canvas.addEventListener('pointermove', (event) => {
  hovered = event.buttons ? null : pick(event);
  showTooltip(event);
});
canvas.addEventListener('pointerleave', () => {
  hovered = null;
  tooltip.hidden = true;
});
canvas.addEventListener('pointerdown', (event) => (downAt = [event.clientX, event.clientY]));
canvas.addEventListener('pointerup', (event) => {
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
};

function renderLayoutNote() {
  for (const button of layoutButtons) {
    const mode = button.dataset.mode;
    const cases = mode === layoutMode ? layout.cases : computeLayout(series, mode).cases;
    button.querySelector('small').textContent = `${cases} bookcase${cases === 1 ? '' : 's'}`;
    button.setAttribute('aria-pressed', String(mode === layoutMode));
  }
  layoutNoteEl.textContent = LAYOUT_NOTES[layoutMode];
}

document.getElementById('layout-modes').addEventListener('click', (event) => {
  const mode = event.target.closest('button')?.dataset.mode;
  if (!mode || mode === layoutMode) return;
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
  if (undoStack.length) apply(undoStack.pop());
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
    goal.copy(slot.position);
    const inspected = slot.key === inspectedKey;
    if (inspected) goal.z = INSPECT_Z;
    else if (!slot.pullable) {
      // Back-row books stay put: the front row is in the way.
    } else if (mesh === hovered) goal.z += 0.45;
    else if (slot.series.id === selectedId) goal.z += 0.2;
    mesh.position.lerp(goal, ease);
    // Turn the pulled-out book so its front cover (+x face) faces the room.
    mesh.rotation.y += ((inspected ? -Math.PI / 2 : 0) - mesh.rotation.y) * ease;
    // Stacked books lie flat with the spine out and the title reading left to right.
    mesh.rotation.z += ((slot.flat && !inspected ? Math.PI / 2 : 0) - mesh.rotation.z) * ease;
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
  limits: { SHELF_W, CLEAR, BOOK_D, CASE_D },
};
