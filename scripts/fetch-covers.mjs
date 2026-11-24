#!/usr/bin/env node
// Look up cover art on AniList for every series in src/collection.json and write src/covers.json.
// Only image URLs are stored; the app loads the images from AniList when it runs.
//
// Usage: node scripts/fetch-covers.mjs
//
// The spreadsheet uses nicknames ("komi", "umaru"), so SEARCH maps a title to a better search
// phrase, and IDS pins a title to an exact AniList manga id. Set a title to null to skip it.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const collection = JSON.parse(readFileSync(new URL('src/collection.json', root)));
const overrides = JSON.parse(readFileSync(new URL('scripts/cover-overrides.json', root)));

const key = (title) => title.trim().toLowerCase().replace(/\s+/g, ' ');
const clean = (title) =>
  title
    .replace(/\(\s*manga\s*\)/i, '')
    .replace(/\s+manga$/i, '')
    .replace(/^(.*?)\s*,\s*the$/i, 'The $1')
    .replace(/\s+/g, ' ')
    .trim();

const FIELDS = 'id format volumes title{romaji english} coverImage{extraLarge large color}';

async function gql(query) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 30);
      console.error(`rate limited, waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const body = await res.json();
    if (body.data) return body.data; // a missing id returns partial data plus errors
    throw new Error(JSON.stringify(body.errors));
  }
  throw new Error('AniList kept rate limiting');
}

const jobs = [];
const covers = {};
for (const { title } of collection) {
  const k = key(title);
  if (overrides.ids[k] === null) continue;
  jobs.push({ k, title, id: overrides.ids[k], search: overrides.search[k] ?? clean(title) });
}

for (let i = 0; i < jobs.length; i += 10) {
  const batch = jobs.slice(i, i + 10);
  const parts = batch.map((job, n) =>
    job.id
      ? `q${n}: Page(perPage:1){media(id:${job.id}){${FIELDS}}}`
      : `q${n}: Page(perPage:5){media(search:${JSON.stringify(job.search)},type:MANGA,format_in:[MANGA,ONE_SHOT],sort:SEARCH_MATCH){${FIELDS}}}`,
  );
  const data = await gql(`{${parts.join('\n')}}`);
  batch.forEach((job, n) => {
    const [best, ...others] = data[`q${n}`]?.media ?? [];
    if (!best) {
      console.log(`--  ${job.title}: no match`);
      return;
    }
    covers[job.k] = {
      id: best.id,
      match: best.title.english || best.title.romaji,
      cover: best.coverImage.large,
      coverLarge: best.coverImage.extraLarge,
      color: best.coverImage.color,
    };
    const alt = others.map((m) => `${m.id}:${m.title.english || m.title.romaji}`).join(' | ');
    console.log(`${job.id ? 'id' : 'ok'}  ${job.title}  =>  [${best.id}] ${covers[job.k].match} (${best.format}, ${best.volumes ?? '?'} vols)${alt ? `\n      alt: ${alt}` : ''}`);
  });
  await new Promise((r) => setTimeout(r, 2500));
}

writeFileSync(new URL('src/covers.json', root), JSON.stringify(covers, null, 2) + '\n');
console.log(`\n${Object.keys(covers).length} of ${collection.length} series have a cover -> src/covers.json`);
