// Reading manga lists from AniList and MyAnimeList, and merging them into the collection.
// Everything here is pure or talks to the network. main.js wires it to the page.

const ANILIST = 'https://graphql.anilist.co';
const PAGE_SIZE = 50;

// Every source's status words, reduced to one vocabulary.
const ANILIST_STATUS = {
  CURRENT: 'reading',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  DROPPED: 'dropped',
  PLANNING: 'planning',
  REPEATING: 'repeating',
};

const MAL_STATUS = {
  reading: 'reading',
  completed: 'completed',
  'on-hold': 'paused',
  dropped: 'dropped',
  'plan to read': 'planning',
  1: 'reading',
  2: 'completed',
  3: 'paused',
  4: 'dropped',
  6: 'planning',
};

// How many volumes of a listed series to put on the shelf. 0 means leave it off.
export function ownedVolumes(status, read, total) {
  if (status === 'planning') return 0;
  const volumes = Number(read) || 0;
  if (volumes > 0) return volumes;
  return status === 'completed' && total > 0 ? total : 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_RETRIES = 3;
const ENRICH_GAP_MS = 2000;

function retryDelay(headers) {
  const after = Number(headers.get('retry-after'));
  if (after > 0) return after * 1000;
  const reset = Number(headers.get('x-ratelimit-reset'));
  const wait = reset > 0 ? reset * 1000 - Date.now() : 60000;
  return Math.max(1000, wait);
}

async function anilist(query, variables) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ANILIST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(retryDelay(res.headers));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.errors?.[0]?.message || res.statusText || `AniList request failed (HTTP ${res.status})`);
    }
    return body.data;
  }
}

const MEDIA = `id idMal format title{romaji english} coverImage{extraLarge large color}
  staff(perPage:10, sort:RELEVANCE){ edges { role node { name { full } } } }`;

const AUTHOR_ROLE = /^(story & art|story|art|original creator|original story)\s*(\(.*\))?$/i;

function authorOf(media) {
  const names = (media.staff?.edges ?? [])
    .filter((e) => AUTHOR_ROLE.test(e.role))
    .map((e) => e.node.name.full);
  return [...new Set(names)].join(', ');
}

const titleOf = (media) => media.title.english || media.title.romaji;

const coverOfMedia = (media) => ({
  id: media.id,
  match: titleOf(media),
  cover: media.coverImage.large,
  coverLarge: media.coverImage.extraLarge,
  color: media.coverImage.color,
});

export async function fetchAniList(userName) {
  const query = `query($u:String,$c:Int){ MediaListCollection(userName:$u, type:MANGA, chunk:$c, perChunk:500) {
    hasNextChunk lists { entries { status progressVolumes media { volumes ${MEDIA} } } } } }`;
  const seen = new Set();
  const entries = [];
  for (let chunk = 1, more = true; more; chunk++) {
    const collection = (await anilist(query, { u: userName, c: chunk })).MediaListCollection;
    more = collection.hasNextChunk;
    for (const list of collection.lists) {
      for (const { status, progressVolumes, media } of list.entries) {
        if (!media || media.format === 'NOVEL' || seen.has(media.id)) continue;
        seen.add(media.id);
        const count = ownedVolumes(ANILIST_STATUS[status] ?? 'reading', progressVolumes, media.volumes);
        if (count) entries.push({ title: titleOf(media), author: authorOf(media), count, cover: coverOfMedia(media) });
      }
    }
  }
  return entries;
}

async function malText(file) {
  const [a, b] = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (a !== 0x1f || b !== 0x8b) return file.text();
  try {
    return await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } catch {
    throw new Error('This .gz file is damaged or incomplete. Download the MyAnimeList export again.');
  }
}

// AniList knows the author and cover that MAL's export leaves out. A partial lookup would store
// MAL titles on one run and AniList titles on the next, so any failure fails the import.
async function enrich(rows) {
  const query = `query($ids:[Int]){ Page(perPage:${PAGE_SIZE}){ media(idMal_in:$ids, type:MANGA){ ${MEDIA} } } }`;
  const found = new Map();
  try {
    for (let i = 0; i < rows.length; i += PAGE_SIZE) {
      if (i) await sleep(ENRICH_GAP_MS);
      const ids = rows.slice(i, i + PAGE_SIZE).map((r) => r.id);
      for (const media of (await anilist(query, { ids })).Page.media) found.set(media.idMal, media);
    }
  } catch (err) {
    console.warn('Could not look up MyAnimeList titles on AniList', err);
    throw new Error('Could not reach AniList to look up your MyAnimeList titles. Try again in a minute.');
  }
  return found;
}

export async function parseMalExport(file) {
  const doc = new DOMParser().parseFromString(await malText(file), 'text/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.nodeName !== 'myanimelist') {
    throw new Error('This is not a MyAnimeList export');
  }
  if (doc.querySelector('anime') || doc.querySelector('myinfo > user_export_type')?.textContent.trim() === '1') {
    throw new Error('This is a MyAnimeList anime list. Export the manga list instead.');
  }
  const rows = [];
  for (const el of doc.querySelectorAll('manga')) {
    const text = (tag) => el.querySelector(tag)?.textContent.trim() ?? '';
    const status = MAL_STATUS[text('my_status').toLowerCase()] ?? 'reading';
    const count = ownedVolumes(status, text('my_read_volumes'), Number(text('manga_volumes')) || 0);
    if (count) rows.push({ id: Number(text('manga_mangadb_id')), title: text('manga_title'), count });
  }
  const found = await enrich(rows);
  return rows.filter(({ id }) => found.get(id)?.format !== 'NOVEL').map(({ id, title, count }) => {
    const media = found.get(id);
    return media
      ? { title: titleOf(media), author: authorOf(media), count, cover: coverOfMedia(media) }
      : { title, author: '', count, cover: null };
  });
}

// Folds entries into the collection without removing or shrinking anything, so running it
// twice with the same list changes nothing the second time. `covers` pairs each stored title
// with the cover that came for it.
export function mergeImport(series, entries, { titleKey, coverId, newId, maxCount }) {
  const next = series.map((s) => ({ ...s }));
  const byTitle = new Map();
  const byCover = new Map();
  const keep = (map, key, s) => key != null && !map.has(key) && map.set(key, s);
  for (const s of next) {
    keep(byTitle, titleKey(s.title), s);
    keep(byCover, coverId(s), s);
  }

  const matched = new Set();
  const covers = [];
  for (const entry of entries) {
    const title = entry.title.trim().replace(/\s+/g, ' ');
    if (!title) continue;
    const count = Math.min(maxCount, entry.count);
    let target = byTitle.get(titleKey(title)) ?? byCover.get(entry.cover?.id);
    if (target) {
      matched.add(target.id);
      target.count = Math.max(target.count, count);
      if (!target.author && entry.author) target.author = entry.author;
    } else {
      target = { id: newId(), title, author: entry.author, count };
      next.push(target);
      keep(byTitle, titleKey(title), target);
      keep(byCover, entry.cover?.id, target);
    }
    if (entry.cover) covers.push({ title: target.title, cover: entry.cover });
  }

  const before = new Map(series.map((s) => [s.id, s]));
  const existing = [...matched].filter((id) => before.has(id));
  const updated = existing.filter((id) => {
    const was = before.get(id);
    const now = next.find((s) => s.id === id);
    return was.count !== now.count || was.author !== now.author;
  }).length;
  return { next, covers, added: next.length - series.length, updated, unchanged: existing.length - updated };
}
