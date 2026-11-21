import test from "node:test";
import assert from "node:assert/strict";
import { PLAYLIST_MAX, normPlaylist, playlistLink, positionLabel, stepPlaylist, watchUrl } from "../lib/playlist.js";
import { emptyTrail, pushTrail, stepTrail } from "../lib/trail.js";
import { rig, slot } from "./rig.mjs";

const vid = (n) => `video${String(n).padStart(6, "0")}`;  // 11 characters, like a YouTube id
const LIST = { list_id: "PLabc123", title: "My Playlist", entries: [1, 2, 3].map((n) => ({ id: vid(n), title: `Video ${n}` })) };
const PL_URL = "https://www.youtube.com/playlist?list=PLabc123";
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((x) => setTimeout(x, 0)); };

test("playlist links: /playlist pages and watch links inside a playlist; channels and plain videos are not", () => {
  assert.deepEqual(playlistLink(PL_URL), { listId: "PLabc123", videoId: null });
  assert.deepEqual(playlistLink(`https://www.youtube.com/watch?v=${vid(2)}&list=PLabc123&index=2`), { listId: "PLabc123", videoId: vid(2) });
  assert.equal(playlistLink("https://www.youtube.com/@someone/videos"), null);
  assert.equal(playlistLink("https://www.youtube.com/channel/UC123?list=PLabc123"), null);
  assert.equal(playlistLink(`https://www.youtube.com/watch?v=${vid(1)}`), null);
  assert.equal(playlistLink("https://example.com/playlist?list=PLabc123"), null);
  assert.equal(watchUrl(vid(1)), `https://www.youtube.com/watch?v=${vid(1)}`);
});

test("stepping stops at both ends; the label counts from one", () => {
  const p = normPlaylist({ listId: "PLabc123", title: "t", entries: LIST.entries, index: 0 });
  assert.equal(stepPlaylist(p, -1), null);
  assert.equal(stepPlaylist(p, 1).index, 1);
  assert.equal(stepPlaylist({ ...p, index: 2 }, 1), null);
  assert.equal(positionLabel({ ...p, index: 1 }), "2 of 3");
  const long = { ...p, entries: Array.from({ length: PLAYLIST_MAX }, (_, i) => ({ id: vid(i), title: "" })) };
  assert.equal(positionLabel(long), `1 of ${PLAYLIST_MAX}+`);
  assert.equal(normPlaylist({ listId: "x", entries: [] }), null);
});

test("trail: a playlist is one stop; paging through it replaces that stop and keeps what lies forward", () => {
  const pl = (i) => ({ url: watchUrl(vid(i + 1)), jobId: `p${i}`, entryId: `p${i}`, mode: "claude-dip", result: `R${i}`,
                       playlist: { listId: "PLabc123", title: "t", entries: LIST.entries, index: i } });
  let t = pushTrail(emptyTrail(), { url: "https://a.test", jobId: "a", mode: "claude-dip", result: "A" });
  t = pushTrail(t, pl(0));
  t = pushTrail(t, pl(1));
  t = pushTrail(t, pl(2));
  assert.deepEqual(t.items.map((x) => x.jobId), ["a", "p2"]);
  t = pushTrail(t, { url: "https://b.test", jobId: "b", mode: "claude-dip", result: "B" });
  t = stepTrail(t, -1).trail;                    // back to the playlist stop
  t = pushTrail(t, pl(1));                        // paging there replaces the stop and keeps "b" forward
  assert.deepEqual([t.items.map((x) => x.jobId), t.pos], [["a", "p1", "b"], 1]);
});

test("a right-clicked playlist summarizes its first video, the arrows page through it, and it is one back/forward stop", async () => {
  const r = rig({ slot: slot(), mode: "claude-dip" });
  r.server.playlist = LIST;
  await r.c.init(1);
  await r.tick();                                                    // a plain summary first
  await r.c.submitUrl(PL_URL);
  const posts = () => r.log.fetches.filter((f) => f.method === "POST" && f.path === "/jobs");
  assert.equal(posts().at(-1).body.url, watchUrl(vid(1)), "the first video is summarized, not the playlist link");
  assert.equal(r.state.last.playlist.index, 0);
  await r.tick();
  assert.equal(r.state.last.result, "Summary for claude-dip");
  assert.equal(await r.c.stepPlaylist(-1), false, "nothing before the first video");
  assert.equal(await r.c.stepPlaylist(1), true);
  assert.equal(posts().at(-1).body.url, watchUrl(vid(2)));
  assert.equal(r.state.last.playlist.index, 1);
  await r.tick();
  assert.equal(r.server.playlistReads, 1, "the list is read once, not on every page");
  assert.equal(r.state.last.trailBack, true);
  assert.equal(r.state.last.trailForward, false);
  assert.equal(await r.c.goTrail(-1), true);                         // one step back leaves the whole playlist
  await settle();
  assert.equal(r.state.last.playlist, null);
  assert.equal(r.state.last.source.url, "https://v.test/watch");
  assert.equal(await r.c.goTrail(1), true);                          // and forward lands on the video last shown there
  await settle();
  assert.deepEqual([r.state.last.playlist.index, r.state.last.source.url], [1, watchUrl(vid(2))]);
  assert.equal(await r.c.goTrail(1), false);
});

test("a video opened inside a playlist is summarized at once and the arrows start at its place", async () => {
  const r = rig({ slot: slot({ url: `https://www.youtube.com/watch?v=${vid(2)}&list=PLabc123` }), mode: "claude-dip" });
  r.server.playlist = LIST;
  await r.c.init(1);
  await settle();
  assert.equal(r.log.fetches.find((f) => f.method === "POST").body.url, `https://www.youtube.com/watch?v=${vid(2)}&list=PLabc123`);
  assert.equal(r.state.last.playlist.index, 1);
  await r.tick();
  await settle();
  const st = r.store.trail;
  assert.equal(st.items.at(-1).playlist.listId, "PLabc123", "the trail stop carries the playlist");
});

test("a playlist that cannot be read shows a plain error and submits nothing", async () => {
  const r = rig({ slot: slot({ url: PL_URL }), mode: "claude-dip" });
  await r.c.init(1);
  assert.match(r.state.last.error, /no videos that can be summarized/);
  assert.equal(r.log.fetches.filter((f) => f.method === "POST").length, 0);
});

test("channel links are not playlists: no playlist lookup", async () => {
  const r = rig({ slot: slot({ url: "https://www.youtube.com/@someone/videos" }), mode: "claude-dip" });
  r.server.playlist = LIST;
  await r.c.init(1);
  assert.equal(r.server.playlistReads, undefined);
  assert.equal(r.state.last.playlist, null);
});
