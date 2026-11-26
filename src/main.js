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

// Free float positions: where each book was put by hand, as { shelf, x, y, z, o } per
// "seriesId:volume", measured from the left end of its surface (see surface()). A negative
// shelf is the top of a bookcase. `o` is one of the 24 orientations in ORIENT. `cases` is the
// number of bookcases to show even when some are empty. Treated as immutable so undo can keep
// old copies.
const FREE_KEY = 'manga-shelf-free-v1';

function loadFree() {
  try {
    const saved = JSON.parse(localStorage.getItem(FREE_KEY));
    if (saved && saved.books && typeof saved.books === 'object') {
      const books = {};
      for (const [key, p] of Object.entries(saved.books)) {
        if (p && [p.shelf, p.x, p.y, p.z].every(Number.isFinite)) {
          // Older saves only knew upright and flat. Orientation 3 is flat (see ORIENT).
          const o = Number.isInteger(p.o) && p.o >= 0 && p.o < 24 ? p.o : p.flat ? 3 : 0;
          books[key] = { shelf: Math.floor(p.shelf), x: p.x, y: p.y, z: p.z, o };
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
const undoStack = []; // { series, free, dims, figures } before each change

function snapshot() {
  undoStack.push({ series, free, dims, figures });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function commit(next) {
  snapshot();
  apply(normalize(next));
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(series));
  localStorage.setItem(FREE_KEY, JSON.stringify(free));
  localStorage.setItem(DIMS_KEY, JSON.stringify(dims));
  localStorage.setItem(FIGURES_KEY, JSON.stringify(figures));
}

function apply(next, nextFree = free, nextDims = dims, nextFigures = figures) {
  series = next;
  free = nextFree;
  figures = nextFigures;
  if (nextDims !== dims) {
    dims = nextDims;
    deriveCase();
  }
  if (!series.some((s) => s.id === selectedId)) selectedId = null;
  save();
  renderList();
  renderDims();
  syncScene();
  renderFigures();
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

// Bookcase. The default is the Room Essentials 5 Shelf Bookcase from Target, black:
// 71.18 in high x 24.49 in wide x 11.57 in deep, 23.2 in between the side panels,
// bottom shelf 0.8 in off the floor. Height, width, depth and the number of shelves can be
// changed in the app, and each shelf board between the top and bottom ones can be moved.
const INCH = 0.254;
const SIDE = ((24.49 - 23.2) / 2) * INCH; // side panel thickness
const BOARD = 0.16;
const BASE = 0.8 * INCH;
const BOOK_D = 1.15;
const SERIES_GAP = 0.05;
const MAX_BOOK_H = 1.92;
const MAX_RISER = 0.6;
const STACK_W = MAX_BOOK_H + 0.03; // a flat book lies with its height along the shelf
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const DIMS_KEY = 'manga-shelf-case-v1';
const DEFAULT_DIMS = { height: 71.18, width: 24.49, depth: 11.57, shelves: 5 }; // inches
const DIM_LIMITS = { height: [12, 120], width: [8, 72], depth: [6, 24], shelves: [1, 20] };
// With even spacing, every shelf has to be tall enough for the tallest book to stand on.
const maxShelves = (height) =>
  Math.max(1, Math.floor((height * INCH - BOARD - BASE) / (MAX_BOOK_H + BOARD + 0.05)));
const MIN_ROW = 0.5; // the least clear height a moved board may leave above or below itself
const LIP = 0.04; // gap kept under the board above

// The underside of every board, floor upwards: the fixed bottom board, the movable ones (their
// positions in inches from the floor, or evenly spaced when `boards` is null), the fixed top.
function boardBottoms(height, shelves, boards) {
  const top = height * INCH - BOARD;
  const ys = [BASE];
  for (let k = 1; k < shelves; k++) ys.push(boards ? boards[k - 1] * INCH : BASE + (k * (top - BASE)) / shelves);
  ys.push(top);
  return ys;
}
// Clear height of each row, bottom row first.
const rowClears = (ys) => ys.slice(1).map((y, k) => y - ys[k] - BOARD - LIP);
// Boards may sit anywhere as long as no row is squeezed shut and one row still takes any book.
function validBoards(height, shelves, boards) {
  if (!Array.isArray(boards) || boards.length !== shelves - 1 || !boards.every(Number.isFinite)) return false;
  const clears = rowClears(boardBottoms(height, shelves, boards));
  return clears.every((clear) => clear >= MIN_ROW - 0.01) && clears.some((clear) => clear >= MAX_BOOK_H);
}

function cleanDims(raw) {
  const read = (name) => {
    const value = Number(raw?.[name]);
    return Number.isFinite(value) ? clamp(value, ...DIM_LIMITS[name]) : DEFAULT_DIMS[name];
  };
  const inches = (name) => Math.round(read(name) * 100) / 100;
  const height = inches('height');
  const shelves = clamp(Math.round(read('shelves')), 1, maxShelves(height));
  const boards = validBoards(height, shelves, raw?.boards)
    ? raw.boards.map((y) => Math.round(y * 100) / 100)
    : null;
  return { height, width: inches('width'), depth: inches('depth'), shelves, boards };
}

function loadDims() {
  try {
    return cleanDims(JSON.parse(localStorage.getItem(DIMS_KEY)));
  } catch {
    return cleanDims(null);
  }
}

let dims = loadDims();
// Everything below follows from `dims`; deriveCase() recomputes it after a change.
let SHELVES, CASE_W, SHELF_W, CASE_H, CASE_D;
let BOARD_Y; // underside of each board, floor upwards
let ROW_FLOOR; // top of the board each row stands on; row 0 is the top shelf
let ROW_CLEAR; // usable height of each row
let BOOK_Z; // spines sit just behind the front edge
let BACK_Z; // the second row, behind the first
let TWO_DEEP; // whether the case is deep enough for that second row
let INSPECT_Z; // where a book is held to show its cover

// The front-to-back range for the centre of something `depth` deep: back panel to front edge.
const zRange = (depth) => [-CASE_D / 2 + 0.05 + depth / 2, CASE_D / 2 - 0.15 - depth / 2];

function deriveCase() {
  SHELVES = dims.shelves;
  CASE_W = dims.width * INCH;
  SHELF_W = CASE_W - 2 * SIDE;
  CASE_H = dims.height * INCH;
  CASE_D = dims.depth * INCH;
  BOARD_Y = boardBottoms(dims.height, SHELVES, dims.boards);
  const clears = rowClears(BOARD_Y);
  ROW_FLOOR = [];
  ROW_CLEAR = [];
  for (let row = 0; row < SHELVES; row++) {
    ROW_FLOOR.push(BOARD_Y[SHELVES - 1 - row] + BOARD);
    ROW_CLEAR.push(clears[SHELVES - 1 - row]);
  }
  BOOK_Z = zRange(BOOK_D)[1];
  BACK_Z = BOOK_Z - BOOK_D - 0.04;
  TWO_DEEP = BACK_Z >= zRange(BOOK_D)[0] - 1e-9;
  INSPECT_Z = CASE_D / 2 + 1.2;
}
deriveCase();

// A shelf index names a surface that books stand on. Interior shelves count rows through every
// bookcase: case * SHELVES + row. The top of bookcase c is -(c + 1). A surface is
// { case, row, top, floorY, clear, width, walls }: the bookcase it belongs to, how high a book may
// stand there, how far x runs from the surface's left edge, and whether side panels stand at its
// ends. The top spans the whole case and has no panels, and the room wall acts as its back.
const TOP_CLEAR = 6; // 60 cm of air above a bookcase
function surface(shelf) {
  if (shelf < 0) {
    return { case: -shelf - 1, row: -1, top: true, floorY: CASE_H, clear: TOP_CLEAR, width: CASE_W, walls: false };
  }
  const row = shelf % SHELVES;
  return { case: Math.floor(shelf / SHELVES), row, top: false, floorY: ROW_FLOOR[row], clear: ROW_CLEAR[row], width: SHELF_W, walls: true };
}
const shelfOf = (bookcase, row) => (row < 0 ? -(bookcase + 1) : bookcase * SHELVES + row); // row -1 is the top
// Where a shelf index goes when the bookcase changes from `oldShelves` rows to the current count,
// or null when that row is gone. A top keeps its index.
function remapShelf(shelf, oldShelves) {
  if (shelf < 0) return shelf;
  const row = shelf % oldShelves;
  return row < SHELVES ? shelfOf(Math.floor(shelf / oldShelves), row) : null;
}
const clearOf = (shelf) => surface(shelf).clear;
// A riser is as tall as the headroom allows, and left out where a raised book would not fit.
function riserFor(clear) {
  const headroom = Math.min(MAX_RISER, clear - MAX_BOOK_H);
  return headroom >= 0.2 ? headroom : 0;
}

// Figures stand on a shelf board, in front of the books: a book may sit behind a figure but
// never in front of one. Sizes are typical for each kind, as height and base width.
const FIGURES_KEY = 'manga-shelf-figures-v1';
const FIGURE_SIZES = {
  chibi: { label: 'Chibi (Nendoroid)', h: 1.0, w: 0.7, chibi: true },
  '1/12': { label: '1/12 (figma)', h: 1.45, w: 0.8 },
  prize: { label: 'Prize / Pop Up Parade', h: 1.8, w: 1.0 },
  '1/8': { label: '1/8 scale', h: 2.1, w: 1.1 },
  '1/7': { label: '1/7 scale', h: 2.4, w: 1.3 },
  '1/6': { label: '1/6 scale', h: 2.8, w: 1.5 },
  '1/4': { label: '1/4 scale', h: 4.2, w: 2.2 },
};

function loadFigures() {
  try {
    const saved = JSON.parse(localStorage.getItem(FIGURES_KEY));
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((f) => f && FIGURE_SIZES[f.size] && [f.shelf, f.x, f.z].every(Number.isFinite) && f.shelf >= 0)
      .map((f) => ({
        id: String(f.id), name: String(f.name ?? '').slice(0, 80), size: f.size,
        shelf: Math.floor(f.shelf), x: f.x, z: f.z,
      }));
  } catch {
    return [];
  }
}

// Each figure is { id, name, size, shelf, x, z }, with x and z measured like a book's.
let figures = loadFigures();

// Where a figure of this size may stand at x, z on a shelf: under the board above, between the
// side panels, clear of the other figures. Returns { x, z } or null.
function figureFits(list, id, sizeKey, shelf, x, z) {
  const { w, h } = FIGURE_SIZES[sizeKey];
  const [back, front] = zRange(w);
  const surf = surface(shelf);
  if (surf.top || w > surf.width || back > front + 1e-9 || h > surf.clear) return null; // figures stay inside a case
  x = clamp(x, w / 2, surf.width - w / 2);
  z = clamp(z, back, Math.max(back, front));
  for (const other of list) {
    if (other.id === id || other.shelf !== shelf) continue;
    const reach = (FIGURE_SIZES[other.size].w + w) / 2 - 1e-4;
    if (Math.abs(other.x - x) < reach && Math.abs(figureZ(other) - z) < reach) return null;
  }
  return { x, z };
}

// Figures stand at the front edge in the packed layouts, and where they were put in free float.
let figuresAtFront = true;
function figureZ(f) {
  const [back, front] = zRange(FIGURE_SIZES[f.size].w);
  return figuresAtFront ? front : clamp(f.z, back, Math.max(back, front));
}

// A figure as an obstacle for the books around it.
function figureBody(f) {
  const { w, h } = FIGURE_SIZES[f.size];
  return { key: `fig:${f.id}`, fig: true, shelf: f.shelf, x: f.x, y: h / 2, z: figureZ(f), w, h, d: w, o: 0 };
}

// The stretches of a shelf that figures stand in front of, for the packed layouts. `deep` marks
// a figure that reaches into the second row as well.
function figureSpans(shelf) {
  return figures
    .filter((f) => f.shelf === shelf)
    .map((f) => {
      const { w } = FIGURE_SIZES[f.size];
      return { x0: f.x - w / 2, x1: f.x + w / 2, deep: zRange(w)[1] - w / 2 < BACK_Z + BOOK_D / 2 + 0.02 };
    });
}
const inSpan = (spans, x0, x1) => spans.find((span) => x0 < span.x1 - 1e-6 && x1 > span.x0 + 1e-6);

// The 24 ways a book can sit square to the shelf. 0 is upright with the spine out, and each of
// the others is reached from it by quarter turns. Saved positions store these numbers, so the
// order they are generated in must not change: 1, 2 and 3 are one quarter turn of an upright
// book about the shelf's x, y and z axes, which makes 3 the flat, spine-out book of a stack.
const ORIENT = []; // { quat, perm, roll }
const TURNS = []; // TURNS[o][axis] -> the orientation after a quarter turn about shelf axis 0, 1 or 2
{
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const quarter = axes.map((axis) => new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2));
  const seen = new Map();
  const add = (quat) => {
    const turned = axes.map((axis) => axis.clone().applyQuaternion(quat).round());
    const id = turned.map((v) => v.toArray().join()).join('|');
    if (!seen.has(id)) {
      seen.set(id, ORIENT.length);
      ORIENT.push({
        quat,
        // perm[j]: which side of the book (0 thickness, 1 height, 2 depth) lies along shelf axis j
        perm: [0, 1, 2].map((j) => turned.findIndex((v) => Math.abs(v.getComponent(j)) === 1)),
        // How far the spine is rolled when it faces the room, to keep the volume number upright.
        roll: turned[2].z === 1 ? Math.atan2(-turned[1].x, turned[1].y) : 0,
      });
    }
    return seen.get(id);
  };
  add(new THREE.Quaternion());
  for (let o = 0; o < ORIENT.length; o++) {
    TURNS.push(quarter.map((turn) => add(turn.clone().multiply(ORIENT[o].quat).normalize())));
  }
}
const FLAT = TURNS[0][2];

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

// Efficient layout, per shelf:
//   1. a front row of upright books on the shelf board,
//   2. a second row behind it, standing on a riser so its spines show over the front row,
//   3. flat stacks lying on top of the back row, filling the headroom up to the next board.
// Stacks are kept off the front row so the raised back row stays visible.
//
// Dense layout: the same two rows, but with no riser and with flat stacks on top of both rows.
// It holds the most books, and the back row is hidden behind the front one.
// A case too shallow for two rows gets the front row only, and a riser is used only where a
// raised book still fits under the board above. A shelf too short for the next book is skipped.
const LAYOUT_KEY = 'manga-shelf-layout-v1';

function packEfficientShelf(queue, start, shelf, out, risers, dense) {
  let i = start;
  const clear = clearOf(shelf);
  const spans = figureSpans(shelf); // books keep out of the front row where a figure stands
  const deepSpans = spans.filter((span) => span.deep);
  const row = (floor, z, pullable, blocked) => {
    const placed = [];
    let x = 0;
    while (i < queue.length) {
      const { thickness, height } = queue[i].look;
      if (x + thickness > SHELF_W || floor + height > clear) break;
      const figure = inSpan(blocked, x, x + thickness);
      if (figure) {
        x = figure.x1;
        continue;
      }
      const book = queue[i++];
      placed.push({ ...book, shelf, x: x + thickness / 2, y: floor + height / 2, z, o: 0, pullable });
      x += thickness;
    }
    out.push(...placed);
    return placed;
  };
  const stacks = (under, floor, z, blocked) => {
    const count = Math.floor(SHELF_W / STACK_W);
    const margin = (SHELF_W - count * STACK_W) / 2;
    for (let n = 0; n < count && i < queue.length; n++) {
      const x = margin + STACK_W * (n + 0.5);
      if (inSpan(blocked, x - STACK_W / 2, x + STACK_W / 2)) continue;
      // Every book that reaches under the stack, including ones that only poke in at the edges.
      const below = under.filter((book) => Math.abs(book.x - x) < STACK_W / 2 + book.look.thickness / 2);
      // A stack needs books under its whole length to rest on.
      if (!below.length || below.at(-1).x < x + STACK_W / 2 - 0.3) continue;
      let y = floor + Math.max(...below.map((book) => book.look.height));
      while (i < queue.length && y + queue[i].look.thickness <= clear) {
        const book = queue[i++];
        out.push({ ...book, shelf, x, y: y + book.look.thickness / 2, z, o: FLAT, pullable: true });
        y += book.look.thickness;
      }
    }
  };

  const front = row(0, BOOK_Z, true, spans);
  if (i >= queue.length) return i;
  if (!TWO_DEEP) {
    if (dense) stacks(front, 0, BOOK_Z, spans);
    return i;
  }
  const backFloor = dense ? 0 : riserFor(clear);
  if (backFloor > 0) risers.push({ shelf, height: backFloor });
  const back = row(backFloor, BACK_Z, false, deepSpans);
  stacks(back, backFloor, BACK_Z, deepSpans);
  if (dense) stacks(front, 0, BOOK_Z, spans);
  return i;
}

// Free float layout: every book sits where it was dropped. A book rests on the shelf board or on
// whatever is under it, and never passes through another book.
const SNAP = 0.1; // how far a dropped book slides sideways to slot in next to its neighbours
const TOUCH = 0.12; // books this close lean on each other
const MAGNET = 0.3; // a book let go this close to a wall or a neighbour is set down against it
const TIP = 2.5; // a book taller than this many times its base is too thin to stand alone
// Which way a body is thin enough to fall over: along the shelf ('x'), front to back ('z'), or not.
const tipAxis = (body) =>
  !body.fig && body.h > TIP * Math.min(body.w, body.d) ? (body.w <= body.d ? 'x' : 'z') : null;
const seriesIdOf = (key) => key.slice(0, key.lastIndexOf(':'));
// The room a book takes in orientation `o`: w along the shelf, h off it, d front to back.
function extent(look, o) {
  const size = [look.thickness, look.height, BOOK_D];
  const { perm } = ORIENT[o];
  return { w: size[perm[0]], h: size[perm[1]], d: size[perm[2]] };
}
let lookById = new Map(); // series id -> look, refreshed on every sync

function bodiesIn(books, shelf, skip) {
  const out = [];
  for (const key in books) {
    const p = books[key];
    if (p.shelf !== shelf || key === skip) continue;
    const look = lookById.get(seriesIdOf(key));
    if (look) out.push({ key, ...p, ...extent(look, p.o) });
  }
  for (const f of figures) if (f.shelf === shelf) out.push(figureBody(f));
  return out;
}

// How far forward the centre of a book `d` deep may be at x: it stays behind every figure there.
function frontLimit(bodies, x, w, d) {
  let limit = Infinity;
  for (const body of bodies) {
    if (body.fig && Math.abs(body.x - x) < (body.w + w) / 2 - 1e-4) limit = Math.min(limit, body.z - body.d / 2 - d / 2);
  }
  return limit;
}

const overlaps = (body, x, z, w, d) =>
  Math.abs(body.x - x) < (body.w + w) / 2 - 1e-4 && Math.abs(body.z - z) < (body.d + d) / 2 - 1e-4;

function restOn(bodies, x, z, w, d) {
  let top = 0;
  for (const body of bodies) if (overlaps(body, x, z, w, d)) top = Math.max(top, body.y + body.h / 2);
  return top;
}

// Where a book comes to rest if it is let go at x, z on a shelf holding `bodies`.
// Returns null when it does not fit under the board above. With `magnet`, a book that could not
// stand alone is set down against a wall or neighbour that is within reach.
function dropSpot(shelf, bodies, look, x, z, o, magnet = false) {
  const { w, h, d } = extent(look, o);
  const [back, front] = zRange(d);
  const surf = surface(shelf);
  if (w > surf.width || back > front + 1e-9) return null; // too long or too deep for this bookcase
  const fit = (value) => clamp(value, w / 2, surf.width - w / 2);
  const thin = magnet ? tipAxis({ w, h, d }) : null;
  x = fit(x);
  const limit = Math.min(front, frontLimit(bodies, x, w, d));
  if (limit < back - 1e-9) return null; // a figure stands here with no room behind it
  z = clamp(z, back, Math.max(back, limit));
  if (thin === 'z' && z - back <= MAGNET) z = back; // lean it on the back panel
  let floor = restOn(bodies, x, z, w, d);
  if (floor > 0) {
    // It landed on something. If there is a lower spot right beside it, slide into that instead.
    const raw = x;
    for (const body of bodies) {
      if (!overlaps(body, raw, z, w, d)) continue;
      for (const beside of [body.x - (body.w + w) / 2, body.x + (body.w + w) / 2]) {
        if (beside !== fit(beside) || Math.abs(beside - raw) > SNAP) continue;
        const level = restOn(bodies, beside, z, w, d);
        if (level < floor - 1e-6) {
          floor = level;
          x = beside;
        }
      }
    }
  }
  if (thin === 'x') {
    let best = null;
    const offer = (beside) => {
      const reach = Math.abs(beside - x);
      if (beside !== fit(beside) || reach > MAGNET || (best && reach >= best.reach)) return;
      if (restOn(bodies, beside, z, w, d) <= floor + 1e-6) best = { beside, reach };
    };
    if (surf.walls) {
      offer(w / 2);
      offer(surf.width - w / 2);
    }
    for (const body of bodies) {
      const level = Math.abs(body.z - z) < (body.d + d) / 2 - 1e-4 &&
        body.y + body.h / 2 > floor + 1e-6 && body.y - body.h / 2 < floor + h;
      if (!level) continue;
      offer(body.x - (body.w + w) / 2);
      offer(body.x + (body.w + w) / 2);
    }
    if (best) {
      x = best.beside;
      floor = restOn(bodies, x, z, w, d);
    }
  }
  if (floor + h > surf.clear + 1e-6) return null;
  if (z > frontLimit(bodies, x, w, d) + 1e-6) return null; // it slid in front of a figure
  return { x, y: floor + h / 2, z, o };
}

// Let every book on a shelf fall until it rests on something. Edits `books` in place.
function settle(books, shelf) {
  const bodies = bodiesIn(books, shelf).sort((a, b) => a.y - a.h / 2 - (b.y - b.h / 2));
  const done = [];
  for (const body of bodies) {
    if (body.fig) {
      done.push(body); // figures stay on the board
      continue;
    }
    const y = restOn(done, body.x, body.z, body.w, body.d) + body.h / 2;
    if (Math.abs(y - body.y) > 1e-6) books[body.key] = { shelf, x: body.x, y, z: body.z, o: body.o };
    done.push({ ...body, y });
  }
}

// Upright books that nothing holds up. A thin book stands if it leans on a side panel, on
// something beside it that reaches at least 30% of its height, or if enough thin books stand
// together to be as wide as 30% of their height. A book facing out stands if it leans on the
// back panel or on something behind or in front of it. Returns each book with where it would
// land, most likely direction first.
function unstable(bodies, surf) {
  const span = (a, b) => Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
  const besideX = (a, b) =>
    Math.abs(a.x - b.x) - (a.w + b.w) / 2 <= TOUCH && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 1e-4;
  const besideZ = (a, b) =>
    Math.abs(a.z - b.z) - (a.d + b.d) / 2 <= TOUCH && Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-4;
  const quarter = (o, axis, times) => {
    for (let n = 0; n < times; n++) o = TURNS[o][axis];
    return o;
  };
  // A quarter turn about z takes the top of a book to the left, so three of them take it right.
  const fallX = (m, dir) => ({ x: m.x + dir * (m.w / 2 + m.h / 2), z: m.z, o: quarter(m.o, 2, dir > 0 ? 3 : 1) });
  // A quarter turn about x takes the top towards the room, so three of them take it to the back.
  const fallZ = (m, dir) => ({ x: m.x, z: m.z + dir * (m.d / 2 + m.h / 2), o: quarter(m.o, 0, dir > 0 ? 1 : 3) });
  const out = [];

  const thin = bodies.filter((body) => tipAxis(body) === 'x');
  const group = new Map(thin.map((body) => [body, body]));
  const root = (body) => {
    while (group.get(body) !== body) body = group.get(body);
    return body;
  };
  for (let i = 0; i < thin.length; i++) {
    for (let j = i + 1; j < thin.length; j++) {
      const [a, b] = [thin[i], thin[j]];
      if (besideX(a, b) && span(a, b) >= 0.3 * Math.min(a.h, b.h)) group.set(root(a), root(b));
    }
  }
  const groups = new Map();
  for (const body of thin) {
    const key = root(body);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(body);
  }
  for (const members of groups.values()) {
    const propped = members.some(
      (m) =>
        (surf.walls && (m.x - m.w / 2 <= TOUCH || m.x + m.w / 2 >= surf.width - TOUCH)) ||
        bodies.some((b) => tipAxis(b) !== 'x' && besideX(m, b) && span(m, b) >= 0.3 * m.h),
    );
    const tall = Math.max(...members.map((m) => m.h));
    if (propped || members.reduce((sum, m) => sum + m.w, 0) >= 0.3 * tall) continue;
    const right = Math.max(...members.map((m) => m.x + m.w / 2));
    const left = Math.min(...members.map((m) => m.x - m.w / 2));
    const dir = right + tall <= surf.width || left - tall < 0 ? 1 : -1; // towards the side with room
    members.sort((a, b) => dir * (b.x - a.x)); // the one at the falling end goes first
    for (const m of members) out.push({ body: m, options: [fallX(m, dir), fallX(m, -dir)] });
  }

  const backPanel = -CASE_D / 2 + 0.05;
  for (const m of bodies) {
    if (tipAxis(m) !== 'z') continue;
    const propped = m.z - m.d / 2 <= backPanel + TOUCH ||
      bodies.some((b) => b !== m && besideZ(m, b) && span(m, b) >= 0.3 * m.h);
    if (!propped) out.push({ body: m, options: [fallZ(m, -1), fallZ(m, 1)] });
  }
  return out;
}

// Where a tipping book ends up when it cannot fall flat: against the nearest thing it would hit
// on the way down, nearest first. Each is { x, z } for the book still upright.
function leanSpots(m, others, surf, within = m.h) {
  if (tipAxis(m) === 'z') return [{ x: m.x, z: zRange(m.d)[0], reach: 0 }]; // back against the panel
  const spots = surf.walls
    ? [
        { x: m.w / 2, reach: m.x - m.w / 2 },
        { x: surf.width - m.w / 2, reach: surf.width - m.x - m.w / 2 },
      ]
    : [];
  for (const b of others) {
    const tall = Math.min(m.y + m.h / 2, b.y + b.h / 2) - Math.max(m.y - m.h / 2, b.y - b.h / 2) >= 0.3 * m.h;
    if (!tall || Math.abs(b.z - m.z) >= (b.d + m.d) / 2 - 1e-4) continue;
    const side = Math.sign(b.x - m.x) || 1;
    spots.push({ x: b.x - side * (b.w + m.w) / 2, reach: Math.abs(b.x - m.x) - (b.w + m.w) / 2 });
  }
  return spots
    .filter((spot) => spot.reach >= -1e-4 && spot.reach <= within)
    .sort((a, b) => a.reach - b.reach)
    .map((spot) => ({ x: spot.x, z: m.z }));
}

// Settle a shelf, tip over whatever cannot stand, and repeat until nothing moves. A book with
// something in the way of its fall comes to rest leaning on that instead, and one with no room
// to do either stays where it is.
function stabilize(books, shelf) {
  const surf = surface(shelf);
  const stuck = new Set();
  for (let pass = 0; pass < 40; pass++) {
    settle(books, shelf);
    const fallers = unstable(bodiesIn(books, shelf), surf).filter((faller) => !stuck.has(faller.body.key));
    if (!fallers.length) return;
    for (const { body, options } of fallers) {
      const others = bodiesIn(books, shelf, body.key);
      const look = lookById.get(seriesIdOf(body.key));
      const bottom = body.y - body.h / 2;
      let landed = null;
      for (const option of options) {
        const spot = dropSpot(shelf, others, look, option.x, option.z, option.o);
        // It may come down on books that fell before it, but not on top of something tall.
        if (spot && spot.y - extent(look, option.o).h / 2 <= bottom + 0.4 * body.h) {
          landed = spot;
          break;
        }
      }
      if (!landed) {
        for (const lean of leanSpots(body, others, surf)) {
          const spot = dropSpot(shelf, others, look, lean.x, lean.z, body.o);
          const moved = spot && Math.hypot(spot.x - body.x, spot.z - body.z) > 1e-6;
          if (moved && Math.abs(spot.x - lean.x) < 1e-6 && spot.y <= body.y + 1e-6) {
            landed = spot;
            break;
          }
        }
      }
      if (landed) books[body.key] = { shelf, ...landed };
      else stuck.add(body.key);
    }
  }
  settle(books, shelf);
}

// Start free float from one of the packed layouts.
function seedFree(mode) {
  const books = {};
  const packed = computeLayout(series, mode);
  for (const { key, shelf, x, y, z, o } of packed.slots) books[key] = { shelf, x, y, z, o };
  // Risers are not part of free float, so books that stood on one drop to the board.
  if (packed.risers.length) for (let shelf = 0; shelf < packed.cases * SHELVES; shelf++) settle(books, shelf);
  return { cases: 1, books };
}

// The first gap in the front row that is wide enough, on the first shelf that has one.
function firstGap(books, width, height, from = 0) {
  for (let shelf = from; ; shelf++) {
    const surf = surface(shelf);
    if (height > surf.clear) continue; // too short for this book; one row always is tall enough
    const row = bodiesIn(books, shelf)
      .filter((body) => body.fig || Math.abs(body.z - BOOK_Z) < (body.d + BOOK_D) / 2 - 1e-4)
      .sort((a, b) => a.x - a.w / 2 - (b.x - b.w / 2));
    let x = 0;
    for (const body of row) {
      if (body.x - body.w / 2 - x >= width - 1e-6) break;
      x = Math.max(x, body.x + body.w / 2);
    }
    if (x + width <= surf.width + 1e-6) return { shelf, x: x + width / 2 };
  }
}

// Keep every book behind the figures on its shelf. A book in front of one, or in its way, is
// pushed straight back; if there is no room behind, it is taken off the shelf and the caller
// finds it a new spot. Returns the books (the same object when nothing changed) and the shelves
// that changed.
function enforceFigures(books) {
  let out = books;
  const touched = new Set();
  for (const f of figures) {
    const figure = figureBody(f);
    for (const body of bodiesIn(out, f.shelf)) {
      if (body.fig || Math.abs(body.x - figure.x) >= (body.w + figure.w) / 2 - 1e-4) continue;
      const z = figure.z - figure.d / 2 - body.d / 2;
      if (body.z <= z + 1e-6) continue;
      if (out === books) out = { ...books };
      touched.add(f.shelf);
      const blocked = z < zRange(body.d)[0] - 1e-9 ||
        bodiesIn(out, f.shelf, body.key).some(
          (other) => overlaps(other, body.x, z, body.w, body.d) && Math.abs(other.y - body.y) < (other.h + body.h) / 2 - 1e-4,
        );
      if (blocked) delete out[body.key];
      else out[body.key] = { shelf: f.shelf, x: body.x, y: body.y, z, o: body.o };
    }
  }
  return { books: out, touched };
}

// Bring the saved positions in line with the collection: forget books that are gone, let whatever
// stood on them fall, and find a spot for books that have none. Returns the new free state, or
// the current one when nothing changed.
function reconcileFree(seedMode) {
  const wanted = [];
  for (const s of series) for (let vol = 1; vol <= s.count; vol++) wanted.push({ s, vol, key: `${s.id}:${vol}` });
  const live = new Set(wanted.map((book) => book.key));
  let base = free;
  if (!Object.keys(free.books).some((key) => live.has(key))) {
    if (!wanted.length && !Object.keys(free.books).length) return free;
    base = seedFree(seedMode);
  }
  const keys = Object.keys(base.books);
  const kept = keys.filter((key) => live.has(key));
  const enforced = enforceFigures(base.books);
  const missing = wanted.filter((book) => !enforced.books[book.key]);
  if (base === free && enforced.books === free.books && kept.length === keys.length && !missing.length) return free;

  const books = {};
  for (const key of kept) if (enforced.books[key]) books[key] = enforced.books[key];
  const emptied = keys.filter((key) => !live.has(key)).map((key) => base.books[key].shelf);
  const touched = new Set([...emptied, ...enforced.touched]);
  for (const { s, vol, key } of missing) {
    const look = lookById.get(s.id);
    const { w, h } = extent(look, 0);
    // Next to the previous volume when there is room on the board there, else the first gap.
    const prev = books[`${s.id}:${vol - 1}`];
    let place = null;
    if (prev && prev.o === 0 && !surface(prev.shelf).top) { // new volumes never go on a bookcase top
      const x = prev.x + look.thickness / 2 + w / 2;
      const spot = x + w / 2 <= surface(prev.shelf).width && dropSpot(prev.shelf, bodiesIn(books, prev.shelf), look, x, prev.z, 0);
      if (spot && Math.abs(spot.x - x) < 1e-6 && Math.abs(spot.y - h / 2) < 1e-6) place = { shelf: prev.shelf, ...spot };
    }
    if (!place) {
      const gap = firstGap(books, w, h);
      place = { shelf: gap.shelf, x: gap.x, y: h / 2, z: BOOK_Z, o: 0 };
    }
    books[key] = place;
    touched.add(place.shelf);
  }
  for (const shelf of touched) stabilize(books, shelf);
  return { cases: base.cases, books };
}

// After the bookcase changes size, keep every hand-placed book that still fits where it was.
// Books that no longer fit are left out, and the next reconcile finds them a new spot.
function refitFree(oldShelves) {
  const bottom = ([key, p]) => p.y - extent(lookById.get(seriesIdOf(key)), p.o).h / 2;
  const entries = Object.entries(free.books).filter(([key]) => lookById.has(seriesIdOf(key)));
  entries.sort((a, b) => a[1].shelf - b[1].shelf || bottom(a) - bottom(b));
  const books = {};
  const byShelf = new Map(); // new shelf -> bodies placed so far
  for (const [key, p] of entries) {
    const shelf = remapShelf(p.shelf, oldShelves);
    if (shelf === null) continue; // that shelf is gone
    if (!byShelf.has(shelf)) byShelf.set(shelf, figures.filter((f) => f.shelf === shelf).map(figureBody));
    const look = lookById.get(seriesIdOf(key));
    const spot = dropSpot(shelf, byShelf.get(shelf), look, p.x, p.z, p.o);
    // Keep it only if it sits where it did, not shoved aside or perched on something new.
    if (!spot || Math.abs(spot.x - p.x) > 1e-6 || Math.abs(spot.z - p.z) > 1e-6 || spot.y > p.y + 1e-6) continue;
    books[key] = { shelf, ...spot };
    byShelf.get(shelf).push({ key, ...books[key], ...extent(look, p.o) });
  }
  for (const shelf of byShelf.keys()) stabilize(books, shelf); // a book may have lost what held it up
  return { cases: free.cases, books };
}

// The first place a figure of this size can stand. It looks from the shelf the books end on,
// through one more bookcase, then back from the start, and prefers a spot with no books in it.
function findFigureSpot(list, sizeKey) {
  const { w } = FIGURE_SIZES[sizeKey];
  const last = Math.max(0, ...layout.slots.map((slot) => slot.shelf), ...list.map((f) => f.shelf));
  const end = shelfOf(surface(last).case + 2, 0);
  const order = [];
  for (let shelf = last; shelf < end; shelf++) order.push(shelf);
  for (let shelf = 0; shelf < last; shelf++) order.push(shelf);
  const crowded = (shelf, x) =>
    layout.slots.some((slot) => slot.shelf === shelf && Math.abs(slot.x - x) < (extent(slot.look, slot.o).w + w) / 2);
  for (const needEmpty of [true, false]) {
    for (const shelf of order) {
      for (let x = w / 2; x <= surface(shelf).width - w / 2 + 1e-9; x += 0.1) {
        const spot = figureFits(list, null, sizeKey, shelf, x, Infinity);
        if (spot && !(needEmpty && crowded(shelf, x))) return { shelf, ...spot };
      }
    }
  }
  return null; // no shelf is tall, wide or deep enough
}

// After the bookcase changes size, keep each figure that still fits and find the others a new
// spot. Returns the new list and how many could not be placed anywhere.
function refitFigures(oldShelves) {
  const kept = [];
  let lost = 0;
  for (const f of figures) {
    const shelf = remapShelf(f.shelf, oldShelves);
    const spot = shelf !== null ? figureFits(kept, f.id, f.size, shelf, f.x, f.z) : null;
    const place = spot ? { shelf, ...spot } : findFigureSpot(kept, f.size);
    if (place) kept.push({ ...f, ...place });
    else lost++;
  }
  return { figures: kept, lost };
}

function computeLayout(list, mode = 'standard') {
  figuresAtFront = mode !== 'free';
  try {
    return layoutFor(list, mode);
  } finally {
    figuresAtFront = layoutMode !== 'free';
  }
}

function layoutFor(list, mode) {
  let slots = [];
  const risers = []; // { shelf, height } for each shelf that carries a riser
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
        const slot = { key, series: s, vol, look, ...p, ...extent(look, p.o), pullable: true };
        slots.push(slot);
        const surf = surface(p.shelf);
        if (surf.top) minCases = Math.max(minCases, surf.case + 1);
        else shelf = Math.max(shelf, p.shelf);
        if (!byShelf.has(p.shelf)) byShelf.set(p.shelf, []);
        byShelf.get(p.shelf).push(slot);
      }
    }
    // A book with another one, or a figure, in front of it cannot be pulled forward on hover.
    for (const [index, group] of byShelf) {
      const inFront = [...group, ...figures.filter((f) => f.shelf === index).map(figureBody)];
      for (const a of group) {
        a.pullable = !inFront.some(
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
    shelf = slots.length ? slots.at(-1).shelf : 0;
  } else {
    let x = 0;
    let spans = figureSpans(0);
    for (const s of list) {
      const look = lookOf(s);
      for (let vol = 1; vol <= s.count; vol++) {
        let behind = false; // standing behind a figure
        for (;;) {
          if (x + look.thickness > SHELF_W || look.height > clearOf(shelf)) {
            shelf++; // full, or too short for this book
            x = 0;
            spans = figureSpans(shelf);
            continue;
          }
          const figure = inSpan(spans, x, x + look.thickness);
          behind = Boolean(figure) && TWO_DEEP && !figure.deep;
          if (!figure || behind) break;
          x = figure.x1; // no room behind this figure, so carry on past it
        }
        slots.push({
          key: `${s.id}:${vol}`, series: s, vol, look, shelf,
          x: x + look.thickness / 2, y: look.height / 2, z: behind ? BACK_Z : BOOK_Z, o: 0, pullable: !behind,
        });
        x += look.thickness;
      }
      x += SERIES_GAP;
    }
  }
  for (const f of figures) shelf = Math.max(shelf, f.shelf);
  const cases = Math.max(minCases, surface(shelf).case + 1);
  // Where a surface is: its bookcase's centre, the left end of its x range, and the height of its floor.
  const origin = (index) => {
    const surf = surface(index);
    const x = caseX(surf.case, cases);
    return { x, left: x - surf.width / 2, y: surf.floorY };
  };
  for (const slot of slots) {
    const o = origin(slot.shelf);
    slot.position = new THREE.Vector3(o.left + slot.x, o.y + slot.y, slot.z);
  }
  return {
    slots,
    cases,
    figures: figures.map((f) => {
      const o = origin(f.shelf);
      return { fig: f, position: new THREE.Vector3(o.left + f.x, o.y, figureZ(f)) };
    }),
    risers: risers.map((riser) => {
      const o = origin(riser.shelf);
      return { height: riser.height, position: new THREE.Vector3(o.x, o.y + riser.height / 2, BACK_Z) };
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
  return board;
}

let caseStamp = '';
let movableBoards = []; // the boards between the top and bottom ones, tagged with userData.board
function buildCases(cases) {
  const stamp = JSON.stringify([cases, dims]);
  if (stamp === caseStamp) return;
  caseStamp = stamp;
  caseGroup.clear();
  movableBoards = [];
  wall.position.z = -CASE_D / 2 - 0.05;
  for (let i = 0; i < cases; i++) {
    const x = caseX(i, cases);
    addBoard(CASE_W, CASE_H, 0.04, x, CASE_H / 2, -CASE_D / 2 + 0.02); // thin back panel
    addBoard(SIDE, CASE_H, CASE_D, x - CASE_W / 2 + SIDE / 2, CASE_H / 2, 0);
    addBoard(SIDE, CASE_H, CASE_D, x + CASE_W / 2 - SIDE / 2, CASE_H / 2, 0);
    addBoard(SHELF_W, BASE, 0.16, x, BASE / 2, CASE_D / 2 - 0.2); // kick plate
    for (let k = 0; k <= SHELVES; k++) {
      const board = addBoard(SHELF_W, BOARD, CASE_D, x, BOARD_Y[k] + BOARD / 2, 0);
      if (k > 0 && k < SHELVES) {
        board.userData.board = k;
        movableBoards.push(board);
      }
    }
  }
  // Keep the whole row of bookcases inside the shadow map.
  const half = (cases * CASE_W) / 2 + 2;
  sun.position.set(half * 0.3, CASE_H + 14, 16);
  sun.target.position.set(0, CASE_H / 2, 0);
  const reach = CASE_H / 2 + 7;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: reach, bottom: -reach, near: 1, far: CASE_H + 72 });
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

// Figures are drawn as simple stand-ins: a round base, a body in the figure's colours and a head.
const figureGroup = new THREE.Group();
scene.add(figureGroup);
const figureMeshes = new Map(); // figure id -> group, with its origin at the foot of the base
const skinMaterial = new THREE.MeshStandardMaterial({ color: 0xf3d2b8, roughness: 0.7 });
const baseMaterial = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.4 });
const figureColors = (f) => {
  const h = hash(`${f.name}|${f.id}`);
  return { hair: `hsl(${h % 360}, 60%, 52%)`, outfit: `hsl(${(h >>> 9) % 360}, 50%, 42%)` };
};

function buildFigure(f) {
  const { w, h, chibi } = FIGURE_SIZES[f.size];
  const group = new THREE.Group();
  const colors = figureColors(f);
  const hair = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.hair), roughness: 0.6 });
  const outfit = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.outfit), roughness: 0.7 });
  const part = (geometry, material, y, x = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  const stand = 0.06;
  part(new THREE.CylinderGeometry(w / 2, w / 2, stand, 40), baseMaterial, stand / 2);
  const tall = h - stand;
  // A chibi is nearly half head; a scale figure is about seven heads tall.
  const head = chibi ? tall * 0.26 : tall * 0.075;
  const legs = chibi ? tall * 0.18 : tall * 0.44;
  const body = tall - 2 * head - legs;
  const hip = chibi ? head * 0.55 : tall * 0.085;
  for (const side of [-1, 1]) {
    part(new THREE.CylinderGeometry(hip * 0.4, hip * 0.3, legs, 12), skinMaterial, stand + legs / 2, side * hip * 0.45);
  }
  part(new THREE.CylinderGeometry(hip * 0.55, hip * 1.25, body, 20), outfit, stand + legs + body / 2);
  part(new THREE.SphereGeometry(head, 24, 16), skinMaterial, h - head);
  // Hair: a cap over the top and back of the head.
  const cap = new THREE.SphereGeometry(head * 1.08, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
  part(cap, hair, h - head);
  const back = new THREE.Mesh(new THREE.SphereGeometry(head * 1.06, 24, 16, Math.PI, Math.PI), hair);
  back.position.set(0, h - head, 0);
  back.castShadow = true;
  group.add(back);
  group.userData.figure = f;
  group.userData.look = `${f.size}|${f.name}`;
  return group;
}

function syncFigures() {
  const live = new Set();
  for (const { fig, position } of layout.figures) {
    live.add(fig.id);
    let group = figureMeshes.get(fig.id);
    if (group && group.userData.look !== `${fig.size}|${fig.name}`) {
      figureGroup.remove(group);
      group = null;
    }
    if (!group) {
      group = buildFigure(fig);
      group.position.copy(position);
      if (!firstSync) group.position.z += 2.5; // new figures slide in from the front
      figureMeshes.set(fig.id, group);
      figureGroup.add(group);
    }
    group.userData.figure = fig;
    group.userData.position = position;
  }
  for (const [id, group] of figureMeshes) {
    if (live.has(id)) continue;
    figureGroup.remove(group);
    figureMeshes.delete(id);
  }
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
function layBadge(mesh, look, o) {
  const { thickness, height } = look;
  const badge = mesh.children[0];
  const across = 0.92;
  const along = (thickness * 0.92) / height;
  // The badge turns with the book, so turn it back to keep the number upright on a rolled spine.
  const { roll } = ORIENT[o];
  const sideways = Math.abs(Math.sin(roll)) > 0.5;
  badge.rotation.z = -roll;
  badge.scale.set(sideways ? along : across, sideways ? across : along, 1);
  badge.position.set(0, -0.5 + (0.13 + thickness / 2) / height, 0.5 + 0.004 / BOOK_D);
}

function syncScene() {
  lookById = new Map(series.map((s) => [s.id, lookOf(s)]));
  figuresAtFront = layoutMode !== 'free';
  if (layoutMode === 'free') {
    const next = reconcileFree(seedFrom);
    if (next !== free) {
      free = next;
      save();
    }
  }
  figuresAtFront = layoutMode !== 'free';
  layout = computeLayout(series, layoutMode);
  buildCases(layout.cases);
  riserGroup.clear();
  for (const { position, height } of layout.risers) {
    const riser = new THREE.Mesh(unitBox, riserMaterial);
    riser.scale.set(SHELF_W, height, BOOK_D + 0.06);
    riser.position.copy(position);
    riserGroup.add(riser);
  }
  renderLayoutNote();
  syncFigures();

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
    layBadge(mesh, slot.look, slot.o);
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
  const crowned = layout.slots.some((slot) => slot.shelf < 0); // books standing on top of a case
  const height = CASE_H + (crowned ? 2.2 : 0);
  flyTo(new THREE.Vector3(0, height / 2, 0), layout.cases * CASE_W, height);
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
  flyTo(box.getCenter(new THREE.Vector3()), size.x + 3, size.y + CASE_H / SHELVES);
}

function focusFigure(id) {
  const placed = layout.figures.find((item) => item.fig.id === id);
  if (!placed) return;
  const { h } = FIGURE_SIZES[placed.fig.size];
  flyTo(placed.position.clone().add(new THREE.Vector3(0, h / 2, 0)), 4, h + CASE_H / SHELVES);
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

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
let hovered = null;
let downAt = null;

// The book under the pointer, unless a figure or a shelf board is in front of it.
function pick(event) {
  const object = pickAny(event);
  return object && object.userData.slot ? object : null;
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
// the wheel moves it front to back, and R, T and F turn it a quarter turn at a time.
let drag = null; // { mesh, slot, offsetX, z, o, event, moved, spot }
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function planeHit(event, z) {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  dragPlane.constant = -z;
  return raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3());
}

// Shelf boards: drag one up or down, in any layout. Every bookcase shares the same spacing.
let shelfDrag = null; // { k, grabY, base, y, moved }

// The book, figure or movable board under the pointer, whichever is in front.
function pickAny(event) {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const first = raycaster.intersectObjects([...bookGroup.children, ...movableBoards], false)[0];
  const part = raycaster.intersectObjects(figureGroup.children, true)[0];
  if (part && (!first || part.distance < first.distance)) {
    let group = part.object;
    while (group.parent !== figureGroup) group = group.parent;
    return group;
  }
  return first?.object ?? null;
}

// Which shelf a point on the drag plane is over, and where that shelf's board starts.
function shelfAt(hit) {
  const { cases } = layout;
  const column = clamp(Math.round((hit.x - caseX(0, cases)) / CASE_W), 0, cases - 1);
  let level = 0; // the highest board the pointer is above
  for (let k = 1; k < SHELVES; k++) if (hit.y >= BOARD_Y[k]) level = k;
  const shelf = shelfOf(column, hit.y >= CASE_H ? -1 : SHELVES - 1 - level); // above the case is its top
  const surf = surface(shelf);
  return { shelf, floorY: surf.floorY, left: caseX(column, cases) - surf.width / 2 };
}

// Figures: drag one to another spot or shelf, in any layout. In free float the wheel moves it
// front to back; in the packed layouts it stands at the front edge.
let figDrag = null; // { group, fig, event, offsetX, z, moved, spot }

function updateFigDrag() {
  const hit = planeHit(figDrag.event, figDrag.group.userData.position.z);
  if (!hit) return false;
  const { shelf, floorY, left } = shelfAt(hit);
  const { fig } = figDrag;
  const fit = figureFits(figures, fig.id, fig.size, shelf, hit.x - figDrag.offsetX - left, layoutMode === 'free' ? figDrag.z : Infinity);
  if (!fit) return false;
  if (layoutMode === 'free') figDrag.z = fit.z;
  figDrag.spot = { shelf, x: fit.x, z: fit.z, position: new THREE.Vector3(left + fit.x, floorY, fit.z) };
  return true;
}

function endFigDrag() {
  figDrag = null;
  controls.enabled = true;
  canvas.style.cursor = '';
}

function setFigures(next) {
  snapshot();
  apply(series, free, dims, next);
}

function setBoardHeight(k, y) {
  for (const board of movableBoards) if (board.userData.board === k) board.position.y = y + BOARD / 2;
}

function updateShelfDrag(event) {
  const hit = planeHit(event, CASE_D / 2);
  if (!hit) return;
  const { k, base, grabY } = shelfDrag;
  const room = BOARD + LIP + MIN_ROW + 0.02;
  const y = clamp(base + hit.y - grabY, BOARD_Y[k - 1] + room, BOARD_Y[k + 1] - room);
  const ys = BOARD_Y.map((value, index) => (index === k ? y : value));
  const clears = rowClears(ys);
  // Stop where the last shelf able to take any book would become too short.
  if (clears.some((clear) => clear >= MAX_BOOK_H + 0.01)) shelfDrag.y = y;
  if (Math.abs(shelfDrag.y - base) > 0.005) shelfDrag.moved = true;
  setBoardHeight(k, shelfDrag.y);
  const shown = BOARD_Y.map((value, index) => (index === k ? shelfDrag.y : value));
  const [below, above] = [rowClears(shown)[k - 1], rowClears(shown)[k]].map((clear) => (clear / INCH).toFixed(1));
  tooltip.replaceChildren(`${above} in clear above · ${below} in below`);
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 330)}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
  canvas.style.cursor = 'ns-resize';
}

function endShelfDrag(keep) {
  const { k, y, base, moved } = shelfDrag;
  shelfDrag = null;
  controls.enabled = true;
  tooltip.hidden = true;
  canvas.style.cursor = '';
  if (!keep || !moved) {
    setBoardHeight(k, base);
    return;
  }
  const boards = BOARD_Y.slice(1, SHELVES).map((value, index) => (index + 1 === k ? y : value) / INCH);
  changeDims({ boards }, false);
}

// Runs before OrbitControls sees the press, so grabbing a book or a board does not also orbit
// the camera.
window.addEventListener(
  'pointerdown',
  (event) => {
    if (event.button !== 0 || event.target !== canvas || drag || shelfDrag || figDrag) return;
    const mesh = pickAny(event);
    if (!mesh) return;
    if (mesh.userData.figure) {
      const fig = mesh.userData.figure;
      const hit = planeHit(event, mesh.userData.position.z);
      figDrag = {
        group: mesh, fig, event,
        offsetX: hit ? hit.x - mesh.userData.position.x : 0,
        z: figureZ(fig), moved: false, spot: null,
      };
      hovered = null;
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (mesh.userData.board) {
      const hit = planeHit(event, CASE_D / 2);
      if (!hit) return;
      const k = mesh.userData.board;
      shelfDrag = { k, grabY: hit.y, base: BOARD_Y[k], y: BOARD_Y[k], moved: false };
      hovered = null;
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (layoutMode !== 'free') return;
    const { slot } = mesh.userData;
    const hit = planeHit(event, slot.z + BOOK_D / 2);
    drag = {
      mesh, slot, event,
      offsetX: hit ? hit.x - slot.position.x : 0,
      z: slot.z, o: slot.o, moved: false, spot: null,
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
  const { shelf, floorY, left } = shelfAt(hit);
  const spot = dropSpot(
    shelf, bodiesIn(free.books, shelf, drag.slot.key), drag.slot.look, hit.x - drag.offsetX - left, drag.z, drag.o, true,
  );
  if (!spot) return false;
  drag.z = spot.z;
  drag.spot = { ...spot, shelf, position: new THREE.Vector3(left + spot.x, floorY + spot.y, spot.z) };
  return true;
}

function endDrag() {
  layBadge(drag.mesh, drag.slot.look, drag.slot.o); // a move that goes through re-lays it
  drag = null;
  controls.enabled = true;
  canvas.style.cursor = '';
}

function moveBook(slot, spot) {
  const same = spot.shelf === slot.shelf && spot.o === slot.o &&
    Math.hypot(spot.x - slot.x, spot.y - slot.y, spot.z - slot.z) < 1e-4;
  if (same) return;
  snapshot();
  const books = { ...free.books, [slot.key]: { shelf: spot.shelf, x: spot.x, y: spot.y, z: spot.z, o: spot.o } };
  stabilize(books, slot.shelf); // whatever stood on it or leaned on it falls
  if (spot.shelf !== slot.shelf) stabilize(books, spot.shelf);
  apply(series, { ...free, books });
}

// Move a whole series: stand its volumes in order in a row that starts where the book was
// dropped. Volumes that do not fit there go into the next gaps, on that shelf and then the ones
// after it.
function moveSeries(slot, spot) {
  const { series: moving, look } = slot;
  const { w, h } = extent(look, 0);
  snapshot();
  const books = { ...free.books };
  const touched = new Set();
  const keys = [];
  for (let vol = 1; vol <= moving.count; vol++) {
    const key = `${moving.id}:${vol}`;
    keys.push(key);
    if (!books[key]) continue;
    touched.add(books[key].shelf);
    delete books[key];
  }
  let shelf = spot.shelf;
  let z = spot.z;
  let x = clamp(spot.x, w / 2, surface(shelf).width - w / 2);
  for (const key of keys) {
    let place = null;
    if (x + w / 2 <= surface(shelf).width + 1e-9) {
      const next = dropSpot(shelf, bodiesIn(books, shelf), look, x, z, 0);
      if (next && Math.abs(next.x - x) < 1e-6 && Math.abs(next.z - z) < 1e-6) place = { shelf, ...next };
    }
    if (!place) {
      const gap = firstGap(books, w, h, surface(shelf).top ? 0 : shelf); // firstGap only walks interior shelves
      place = { shelf: gap.shelf, x: gap.x, y: h / 2, z: BOOK_Z, o: 0 };
    }
    books[key] = place;
    touched.add(place.shelf);
    ({ shelf, z } = place);
    x = place.x + w;
  }
  for (const index of touched) stabilize(books, index);
  apply(series, { ...free, books });
}

// Which series to move as one when a book is dropped: the one picked with a right-click, or any
// series that the keep-together option says must follow the book to its new shelf or bookcase.
const TOGETHER_KEY = 'manga-shelf-together-v1';
const TOGETHER_MODES = ['off', 'shelf', 'bookcase'];
let keepTogether = TOGETHER_MODES.includes(localStorage.getItem(TOGETHER_KEY)) ? localStorage.getItem(TOGETHER_KEY) : 'off';
let groupId = null; // series picked with a right-click

function dropBook(slot, spot) {
  const follows =
    groupId === slot.series.id ||
    (keepTogether === 'shelf' && spot.shelf !== slot.shelf) ||
    (keepTogether === 'bookcase' && surface(spot.shelf).case !== surface(slot.shelf).case);
  if (follows && slot.series.count > 1) moveSeries(slot, spot);
  else moveBook(slot, spot);
}

// Stand a fallen or turned book back up, spine out. It goes where it is if it can stand there,
// and otherwise against the nearest wall or neighbour on its shelf that will hold it up.
function standUp(slot) {
  if (slot.o === 0) return;
  const others = bodiesIn(free.books, slot.shelf, slot.key);
  const upright = extent(slot.look, 0);
  const surf = surface(slot.shelf);
  const stands = (spot) =>
    !unstable([...others, { key: slot.key, shelf: slot.shelf, ...spot, ...upright }], surf).some((f) => f.body.key === slot.key);
  const here = { ...upright, x: slot.x, y: upright.h / 2, z: clamp(slot.z, ...zRange(upright.d)) };
  for (const place of [here, ...leanSpots(here, others, surf, Infinity)]) {
    const spot = dropSpot(slot.shelf, others, slot.look, place.x, place.z, 0, true);
    if (spot && stands(spot)) {
      moveBook(slot, { ...spot, shelf: slot.shelf });
      return;
    }
  }
}

canvas.addEventListener(
  'wheel',
  (event) => {
    if (figDrag) {
      event.preventDefault();
      if (layoutMode !== 'free') return; // figures stand at the front edge in the packed layouts
      figDrag.moved = true;
      const z = figDrag.z;
      figDrag.z = z + event.deltaY * 0.002;
      if (!updateFigDrag()) figDrag.z = z;
      return;
    }
    if (!drag) return;
    event.preventDefault();
    if (!drag.moved) startMoving();
    const z = drag.z;
    drag.z = z + event.deltaY * 0.002; // scroll up pushes the book back; dropSpot keeps it on the shelf
    if (!updateDrag()) drag.z = z;
  },
  { passive: false },
);
canvas.addEventListener('pointercancel', () => {
  if (drag) endDrag();
  if (shelfDrag) endShelfDrag(false);
  if (figDrag) endFigDrag();
});

canvas.addEventListener('pointermove', (event) => {
  if (shelfDrag) {
    updateShelfDrag(event);
    return;
  }
  if (figDrag) {
    figDrag.event = event;
    if (!figDrag.moved && downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 5) {
      figDrag.moved = true;
      tooltip.hidden = true;
      canvas.style.cursor = 'grabbing';
    }
    if (figDrag.moved) updateFigDrag();
    return;
  }
  if (drag) {
    drag.event = event;
    if (!drag.moved && downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 5) startMoving();
    if (drag.moved) updateDrag();
    return;
  }
  const under = event.buttons ? null : pickAny(event);
  hovered = under && under.userData.slot ? under : null;
  showTooltip(event);
  if (under?.userData.board) canvas.style.cursor = 'ns-resize';
  if (under?.userData.figure) {
    const { name, size } = under.userData.figure;
    const { label, h } = FIGURE_SIZES[size];
    const small = document.createElement('small');
    small.textContent = `${label} · ${Math.round(h * 10)} cm tall`;
    tooltip.replaceChildren(name || 'Figure', small);
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 330)}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    canvas.style.cursor = 'grab';
  }
});
canvas.addEventListener('pointerleave', () => {
  hovered = null;
  tooltip.hidden = true;
});
canvas.addEventListener('pointerdown', (event) => (downAt = [event.clientX, event.clientY]));
canvas.addEventListener('pointerup', (event) => {
  if (shelfDrag) {
    const { moved } = shelfDrag;
    endShelfDrag(true);
    if (moved) return;
  }
  if (figDrag) {
    const { moved, fig, spot } = figDrag;
    endFigDrag();
    if (moved) {
      if (spot) setFigures(figures.map((f) => (f.id === fig.id ? { ...f, shelf: spot.shelf, x: spot.x, z: spot.z } : f)));
      return;
    }
  }
  if (drag) {
    const { moved, slot, spot } = drag;
    endDrag();
    if (moved) {
      if (spot) dropBook(slot, spot);
      return;
    }
  }
  if (!downAt || Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 5) return; // it was a drag
  const mesh = pick(event);
  clearTimeout(clickTimer);
  if (event.button === 2) {
    // Right-click: pick the whole series, so that dragging one of its books moves all of them.
    if (!mesh) return;
    const { id } = mesh.userData.slot.series;
    groupId = groupId === id ? null : id;
    inspectedKey = null;
    select(groupId, { reveal: true });
    renderLayoutNote();
    return;
  }
  if (event.button !== 0) return;
  if (!mesh) {
    inspectedKey = null;
    groupId = null;
    select(null);
    renderLayoutNote();
    return;
  }
  const { slot } = mesh.userData;
  const open = () => {
    inspectedKey = inspectedKey === slot.key ? null : slot.key;
    if (inspectedKey) {
      useLargeCover(slot.series.id);
      flyTo(new THREE.Vector3(slot.position.x, slot.position.y, INSPECT_Z), 3, 2.6, 5.5);
    }
    if (groupId !== slot.series.id) groupId = null;
    select(slot.series.id, { reveal: true });
    renderLayoutNote();
  };
  // In free float a double-click stands the book up, so wait a moment to see if one is coming.
  if (layoutMode === 'free') clickTimer = setTimeout(open, 230);
  else open();
});

let clickTimer = 0;
canvas.addEventListener('dblclick', (event) => {
  if (layoutMode !== 'free') return;
  clearTimeout(clickTimer);
  const mesh = pick(event);
  if (!mesh) return;
  inspectedKey = null;
  standUp(mesh.userData.slot);
});
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

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
  totalsEl.textContent = `${series.length} series · ${volumes} volumes` +
    (figures.length ? ` · ${figures.length} figure${figures.length === 1 ? '' : 's'}` : '');
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
  free: 'Drag a book to any spot on any shelf or onto the top of a bookcase, and scroll while dragging to push it back or pull it forward. R, T and F turn the book you are dragging or pointing at, and a double-click stands it back up. Right-click a book to pick its whole series. An upright book with nothing to lean on falls over.',
};
const freeTools = document.getElementById('free-tools');
const removeCaseEl = document.getElementById('remove-case');
const togetherEl = document.getElementById('together');
const togetherSelect = document.getElementById('together-mode');
togetherSelect.value = keepTogether;
togetherSelect.addEventListener('change', () => {
  keepTogether = TOGETHER_MODES.includes(togetherSelect.value) ? togetherSelect.value : 'off';
  localStorage.setItem(TOGETHER_KEY, keepTogether);
});

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
  const picked = layoutMode === 'free' && series.find((s) => s.id === groupId);
  layoutNoteEl.textContent = picked
    ? `Whole series picked: ${picked.title}. Drag any of its books to move all ${picked.count} together. Right-click it again or press Esc to let go.`
    : LAYOUT_NOTES[layoutMode];
  freeTools.hidden = layoutMode !== 'free';
  togetherEl.hidden = layoutMode !== 'free';
  removeCaseEl.disabled = layout.cases < 2 || !emptyCases().length;
}

// Bookcases holding no books and no figures, wherever they are in the row.
function emptyCases() {
  const used = new Set();
  for (const slot of layout.slots) used.add(surface(slot.shelf).case);
  for (const f of figures) used.add(surface(f.shelf).case);
  const empty = [];
  for (let index = 0; index < layout.cases; index++) if (!used.has(index)) empty.push(index);
  return empty;
}

// Take out every empty bookcase and close the gaps, keeping at least one.
function removeEmptyCases() {
  const empty = new Set(emptyCases());
  const moved = new Map(); // old bookcase index -> new one
  for (let index = 0; index < layout.cases; index++) if (!empty.has(index)) moved.set(index, moved.size);
  const shift = (shelf) => shelfOf(moved.get(surface(shelf).case), surface(shelf).row);
  const books = {};
  for (const [key, p] of Object.entries(free.books)) books[key] = { ...p, shelf: shift(p.shelf) };
  apply(series, { cases: Math.max(1, moved.size), books }, dims, figures.map((f) => ({ ...f, shelf: shift(f.shelf) })));
}

freeTools.addEventListener('click', (event) => {
  const act = event.target.closest('button')?.id;
  if (!act || layoutMode !== 'free') return;
  snapshot();
  if (act === 'add-case') apply(series, { ...free, cases: layout.cases + 1 });
  else if (act === 'remove-case') removeEmptyCases();
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

// Bookcase size
const caseForm = document.getElementById('case-form');
const caseInputs = Object.fromEntries(
  Object.keys(DEFAULT_DIMS).map((name) => [name, document.getElementById(`case-${name}`)]),
);
const caseSummaryEl = document.getElementById('case-summary');
const caseNoteEl = document.getElementById('case-note');
const caseResetEl = document.getElementById('case-reset');
const caseEvenEl = document.getElementById('case-even');

function renderDims() {
  for (const [name, input] of Object.entries(caseInputs)) {
    input.value = dims[name];
    [input.min, input.max] = DIM_LIMITS[name];
  }
  const most = Math.min(DIM_LIMITS.shelves[1], maxShelves(dims.height));
  caseInputs.shelves.max = most;
  caseSummaryEl.textContent =
    `${dims.height} × ${dims.width} × ${dims.depth} in · ${dims.shelves} ${dims.shelves === 1 ? 'shelf' : 'shelves'}`;
  caseNoteEl.textContent =
    `Inches. Up to ${most} ${most === 1 ? 'shelf fits' : 'shelves fit'} at this height.` +
    ' Drag a shelf board in the scene to move it.' +
    (TWO_DEEP ? '' : ' Too shallow for a second row of books.');
  caseEvenEl.disabled = !dims.boards;
  caseResetEl.disabled = !dims.boards && Object.keys(DEFAULT_DIMS).every((name) => dims[name] === DEFAULT_DIMS[name]);
}

function changeDims(raw, fly = true) {
  let next = cleanDims({ ...dims, ...raw });
  // A new height or shelf count puts the boards back to even spacing.
  if (next.height !== dims.height || next.shelves !== dims.shelves) next = { ...next, boards: null };
  if (JSON.stringify(next) === JSON.stringify(dims)) {
    renderDims(); // put back anything that was typed out of range
    return;
  }
  snapshot();
  const oldShelves = SHELVES;
  dims = next;
  deriveCase();
  inspectedKey = null;
  const cases = layout.cases;
  const refit = refitFigures(oldShelves);
  figures = refit.figures;
  figureNotice = refit.lost
    ? refit.lost === 1
      ? '1 figure no longer fits anywhere and was removed. Undo brings it back.'
      : `${refit.lost} figures no longer fit anywhere and were removed. Undo brings them back.`
    : '';
  apply(series, refitFree(oldShelves));
  if (fly || layout.cases !== cases) overview(false); // keep every bookcase in view
}

caseForm.addEventListener('change', () => {
  const raw = {};
  for (const [name, input] of Object.entries(caseInputs)) {
    if (Number.isFinite(input.valueAsNumber)) raw[name] = input.valueAsNumber;
  }
  changeDims(raw);
});
caseForm.addEventListener('submit', (event) => event.preventDefault());
caseResetEl.addEventListener('click', () => changeDims({ ...DEFAULT_DIMS, boards: null }));
caseEvenEl.addEventListener('click', () => changeDims({ boards: null }, false));

// Figures
const figureForm = document.getElementById('figure-form');
const figureNameEl = document.getElementById('figure-name');
const figureSizeEl = document.getElementById('figure-size');
const figureListEl = document.getElementById('figure-list');
const figureCountEl = document.getElementById('figure-count');
const figureNoteEl = document.getElementById('figure-note');
let figureNotice = ''; // one-off message, such as a figure that found no shelf
for (const [key, size] of Object.entries(FIGURE_SIZES)) {
  const option = el('option', '', `${size.label} · ${Math.round(size.h * 10)} cm`);
  option.value = key;
  figureSizeEl.append(option);
}
figureSizeEl.value = '1/7';

function renderFigures() {
  figureCountEl.textContent = figures.length ? String(figures.length) : '';
  figureNoteEl.textContent = figureNotice || 'Drag a figure to move it. Books stay behind figures.';
  const rows = figures.map((f) => {
    const li = el('li');
    li.dataset.id = f.id;
    const dot = el('span', 'dot');
    dot.style.background = figureColors(f).hair;
    const remove = el('button', 'remove', '✕');
    remove.setAttribute('aria-label', `Remove ${f.name || 'figure'}`);
    li.append(dot, el('span', 'name', f.name || 'Figure'), el('span', 'size', FIGURE_SIZES[f.size].label), remove);
    return li;
  });
  figureListEl.replaceChildren(...rows);
}

figureForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const size = figureSizeEl.value;
  const spot = findFigureSpot(figures, size);
  if (!spot) {
    const inches = (FIGURE_SIZES[size].h / INCH).toFixed(1);
    figureNotice = `No shelf has room for a ${FIGURE_SIZES[size].label} figure. It needs ${inches} in of height: move a shelf board or resize the bookcase.`;
    renderFigures();
    return;
  }
  figureNotice = '';
  const id = newId();
  setFigures([...figures, { id, name: figureNameEl.value.trim().replace(/\s+/g, ' ').slice(0, 80), size, ...spot }]);
  figureNameEl.value = '';
  focusFigure(id);
});

figureListEl.addEventListener('click', (event) => {
  const id = event.target.closest('li')?.dataset.id;
  if (!id) return;
  if (event.target.closest('button')) {
    figureNotice = '';
    setFigures(figures.filter((f) => f.id !== id));
  } else focusFigure(id);
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
  figureNotice = '';
  apply(previous.series, previous.free, previous.dims, previous.figures);
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
  // Quarter turns in free float: R rolls the book, T turns it to face another way, F tips it over.
  const axis = { f: 0, t: 1, r: 2 }[event.key.toLowerCase()];
  if (shelfDrag) {
    if (event.key === 'Escape') endShelfDrag(false); // put the board back where it was
    return;
  }
  if (figDrag) {
    if (event.key === 'Escape') endFigDrag(); // put the figure back where it was
    return;
  }
  if (drag) {
    if (event.key === 'Escape') endDrag(); // put the book back where it was
    if (axis !== undefined) {
      if (!drag.moved) startMoving();
      const before = drag.o;
      drag.o = TURNS[before][axis];
      if (updateDrag()) layBadge(drag.mesh, drag.slot.look, drag.o);
      else drag.o = before; // no room to turn it here
    }
    return;
  }
  if (axis !== undefined && layoutMode === 'free' && hovered) {
    // Turn the book under the pointer where it stands.
    const { slot } = hovered.userData;
    const spot = dropSpot(slot.shelf, bodiesIn(free.books, slot.shelf, slot.key), slot.look, slot.x, slot.z, TURNS[slot.o][axis]);
    if (spot) moveBook(slot, { ...spot, shelf: slot.shelf });
    return;
  }
  if (event.key === 'Escape') {
    inspectedKey = null;
    groupId = null;
    select(null);
    renderLayoutNote();
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
// A pulled-out book is turned so its front cover (+x face) faces the room.
const COVER_OUT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const ease = 1 - Math.exp(-dt * 10);

  for (const mesh of bookGroup.children) {
    const { slot } = mesh.userData;
    const held = drag && drag.mesh === mesh && drag.moved && drag.spot ? drag.spot : null;
    goal.copy(held ? held.position : slot.position);
    const inspected = slot.key === inspectedKey;
    if (held) goal.z += 0.1; // lifted a little towards you while it is in your hand
    else if (inspected) goal.z = INSPECT_Z;
    else if (!slot.pullable) {
      // Back-row books stay put: the front row is in the way.
    } else if (mesh === hovered) goal.z += 0.45;
    else if (slot.series.id === selectedId) goal.z += 0.2;
    mesh.position.lerp(goal, held ? 1 - Math.exp(-dt * 30) : ease);
    // Turn the pulled-out book so its front cover (+x face) faces the room.
    mesh.quaternion.slerp(inspected && !held ? COVER_OUT : ORIENT[held ? held.o : slot.o].quat, ease);
  }

  for (const group of figureGroup.children) {
    const held = figDrag && figDrag.group === group && figDrag.moved && figDrag.spot;
    group.position.lerp(held ? figDrag.spot.position : group.userData.position, held ? 1 - Math.exp(-dt * 30) : ease);
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
renderDims();
renderFigures();
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
  dropSpot: (key, shelf, x, z, o = 0) =>
    dropSpot(shelf, bodiesIn(free.books, shelf, key), lookById.get(seriesIdOf(key)), x, z, o),
  moveBook: (key, shelf, x, z, o = 0) => {
    const slot = layout.slots.find((item) => item.key === key);
    const spot = slot && window.__shelf.dropSpot(key, shelf, x, z, o);
    if (spot) moveBook(slot, { ...spot, shelf });
    return spot;
  },
  camera,
  // Drop book `key` at x, z on a shelf the way a drag would, moving its series along when the
  // keep-together option or a right-click pick says so.
  dropBook: (key, shelf, x, z, o = 0) => {
    const slot = layout.slots.find((item) => item.key === key);
    const spot = slot && dropSpot(shelf, bodiesIn(free.books, shelf, key), slot.look, x, z, o, true);
    if (spot) dropBook(slot, { ...spot, shelf });
    return spot;
  },
  standUp: (key) => standUp(layout.slots.find((item) => item.key === key)),
  pickSeries: (id) => { groupId = id; },
  setTogether: (mode) => { keepTogether = mode; },
  get dims() { return dims; },
  get figures() { return figures; },
  sizes: FIGURE_SIZES,
  addFigure: (name, size) => {
    const spot = findFigureSpot(figures, size);
    if (spot) setFigures([...figures, { id: newId(), name, size, ...spot }]);
    return spot;
  },
  moveFigure: (id, shelf, x, z = Infinity) => {
    const f = figures.find((item) => item.id === id);
    const fit = f && figureFits(figures, id, f.size, shelf, x, layoutMode === 'free' ? z : Infinity);
    if (fit) setFigures(figures.map((item) => (item.id === id ? { ...item, shelf, ...fit } : item)));
    return fit;
  },
  setDims: (raw) => changeDims(raw),
  turns: TURNS,
  get limits() { return { SHELF_W, CASE_W, CASE_H, TOP_CLEAR, BOOK_D, CASE_D, BOOK_Z, SHELVES, TWO_DEEP, clears: ROW_CLEAR, floors: ROW_FLOOR }; },
  // Books in free float that nothing holds up, per shelf.
  unstable: () => {
    const shelves = new Set(Object.values(free.books).map((p) => p.shelf));
    return [...shelves].flatMap((shelf) => unstable(bodiesIn(free.books, shelf), surface(shelf)).map((f) => f.body.key));
  },
};
