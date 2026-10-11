/**
 * **下見の後始末の時計**(`V20-M13-T05`。計画 `docs/plan/v20/15-v20-m13-plan.md` §9-7・§10-5 /
 * `D-V20-43`「期限が切れると写しを消し」/ `ADR-0476` 2-9 の置き換え)。
 *
 * 固定するもの(計画 T05 (a)〜(d)・§10-9 の 20):
 *
 * - **(a)** 期限は {@link PREVIEW_TTL_SECONDS} = 3600 秒、時計の間隔は
 *   {@link PREVIEW_SWEEP_INTERVAL_MS} = 60000 ミリ秒(定数)。
 * - **(b)** 時計が消した後に開くと 410「この下見は期限切れです」。
 * - **(c)** 時計を 3599 秒に進めた1周では置き場が在り(陰性対照)、3600 秒の1周で `ls` から消える。
 *   起動時の1回でも消える。前段がメモリに持つ2本目も、期限切れ・置き場の無いものは捨てる。
 * - **(d)** プロセスが落ちた残骸: 期限切れと「期限を過ぎた meta 無し」は起動時の1回で消え、
 *   期限前の残骸は期限まで残る。
 * - 置き場の根が無いときは、根を作らず、ディスクに何もしない。
 *
 * **時計(`now`)とタイマー(`timer`)は注入する。** 実時間で待たない(1本だけ、実タイマーで
 * 間隔を縮めて1周を撃つ)。**置き場は自分の一時ディレクトリの下**で、`afterEach` で消す。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createPreview } from "../mcp/preview.ts";
import { createServerApp } from "./app.ts";
import { PREVIEW_EXPIRED_MESSAGE, type PreviewFrontCache } from "./preview-front.ts";
import {
  commitPreview,
  PREVIEW_ENTRY_MARKER_FILE,
  PREVIEW_TTL_SECONDS,
  type PreviewClock,
  previewAppId,
  reservePreview,
} from "./preview-store.ts";
import {
  PREVIEW_SWEEP_INTERVAL_MS,
  type PreviewSweeperTimer,
  startPreviewSweeper,
  sweepPreviews,
} from "./preview-sweeper.ts";
import { seedSession } from "./test-helpers.ts";

const APP_ID = "memo-app";
/**
 * 基準の時刻は**今の実時刻**(秒に丸める)。**固定の日付にしない** —— (b) の写しの中のセッションは
 * 下見の期限(T0+3600)まで有効で、写しの2本目はセッションの期限を**実時計**で見るので、固定の日付だと
 * 実時刻がそれを過ぎた日に 3599 秒の側が 401 になる(2026-09-26 の 01:00Z 過ぎに1度そうなった)。
 */
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);

let work = "";
let dataRoot = "";
let root = "";

function at(offsetSec: number): PreviewClock {
  return () => new Date(T0.getTime() + offsetSec * 1000);
}

/** 置き場の `ls`(識別子の一覧)。根が無ければ `null`。 */
function ls(): string[] | null {
  return existsSync(root) ? readdirSync(root).sort() : null;
}

/** 本体の `app.sqlite` だけを置き、T0 に下見の置き場を1つ登録する(写しの中身は要らない)。 */
function register(createdAtSec = 0): string {
  const dir = join(dataRoot, "apps", APP_ID);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "app.sqlite"))) {
    writeFileSync(join(dir, "app.sqlite"), "");
  }
  const reserved = reservePreview({ root, dataRoot, appId: APP_ID, now: at(createdAtSec) });
  if (!reserved.ok) throw new Error(reserved.reason);
  commitPreview(root, reserved.id, {
    app_id: APP_ID,
    requester_user_id: "u-1",
    mode: "real",
    shadow_data_root: join(reserved.dir, "shadow"),
    session_id: "s-1",
    now: at(createdAtSec),
  });
  return reserved.id;
}

/** 手で回すタイマー(登録された周期と関数を覚え、`tick()` で1周させる)。 */
function manualTimer(): PreviewSweeperTimer & {
  intervals: number[];
  tick(): void;
  cleared: number;
} {
  const fns: Array<() => void> = [];
  const self = {
    intervals: [] as number[],
    cleared: 0,
    setInterval(fn: () => void, ms: number) {
      fns.push(fn);
      self.intervals.push(ms);
      return fns.length - 1;
    },
    clearInterval(_handle: unknown) {
      self.cleared += 1;
      fns.length = 0;
    },
    tick() {
      for (const fn of fns) fn();
    },
  };
  return self;
}

/** 前段の2本目の置き場に、中身の無い2本目を1本置く(捨てたかどうかだけを見る)。 */
function fakeInner(cache: PreviewFrontCache, id: string): void {
  cache.set(id, { app: { fetch: () => new Response("") }, shadowDataRoot: join(root, id) });
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-preview-sweeper-"));
  dataRoot = join(work, "data");
  root = join(work, "previews");
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("(a) 期限と時計の間隔は定数", () => {
  test("期限は 3600 秒・時計は 60 秒ごと", () => {
    expect(PREVIEW_TTL_SECONDS).toBe(3600);
    expect(PREVIEW_SWEEP_INTERVAL_MS).toBe(60_000);
  });

  test("時計を始めると、既定で 60000 ミリ秒の周期を1本だけ登録し、stop で外す", () => {
    const timer = manualTimer();
    const handle = startPreviewSweeper({ root, cache: new Map(), timer, now: at(0) });
    expect(timer.intervals).toEqual([60_000]);
    handle.stop();
    expect(timer.cleared).toBe(1);
  });
});

describe("(c) 期限の境界: 3599 秒では在り、3600 秒で消える(ls で見る)", () => {
  test("sweepPreviews: 3599 秒では置き場もメモリの2本目も残り、3600 秒で両方消える", () => {
    const id = register();
    const cache: PreviewFrontCache = new Map();
    fakeInner(cache, id);

    const early = sweepPreviews({ root, cache, now: at(3599) });
    expect(early).toEqual({ removed: [], dropped: [] });
    expect(ls()).toEqual([id]);
    expect(cache.has(id)).toBe(true);

    const due = sweepPreviews({ root, cache, now: at(3600) });
    expect(due).toEqual({ removed: [id], dropped: [id] });
    expect(ls()).toEqual([]);
    expect(cache.has(id)).toBe(false);
  });

  test("時計の1周(手で回す): 3599 秒の周では在り、3600 秒の周で消える", () => {
    const id = register();
    const cache: PreviewFrontCache = new Map();
    fakeInner(cache, id);
    let nowSec = 0;
    const timer = manualTimer();
    const handle = startPreviewSweeper({
      root,
      cache,
      timer,
      now: () => new Date(T0.getTime() + nowSec * 1000),
    });
    try {
      nowSec = 3599;
      timer.tick();
      expect(ls()).toEqual([id]);
      expect(cache.has(id)).toBe(true);

      nowSec = 3600;
      timer.tick();
      expect(ls()).toEqual([]);
      expect(cache.has(id)).toBe(false);
    } finally {
      handle.stop();
    }
  });

  test("時計の1周(本物のタイマー。間隔だけ縮める): 期限を過ぎた置き場が周の中で消える", async () => {
    const keep = register(1000); // T0+1000 に作った(期限は T0+4600)
    const gone = register(0); // T0 に作った(期限は T0+3600)
    let nowSec = 0;
    const handle = startPreviewSweeper({
      root,
      cache: new Map(),
      intervalMs: 5,
      now: () => new Date(T0.getTime() + nowSec * 1000),
    });
    try {
      expect(ls()).toEqual([keep, gone].sort());
      nowSec = 3600;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && (ls() ?? []).includes(gone)) {
        await Bun.sleep(5);
      }
      expect(ls()).toEqual([keep]);
    } finally {
      handle.stop();
    }
  });

  test("起動時の1回: 時計を始めた時点で、周を待たずに期限切れが消える", () => {
    const expired = register(0);
    const alive = register(1000);
    const timer = manualTimer();
    const handle = startPreviewSweeper({ root, cache: new Map(), timer, now: at(3600) });
    try {
      // 周はまだ1度も回していない。
      expect(ls()).toEqual([alive]);
      expect(ls()).not.toContain(expired);
    } finally {
      handle.stop();
    }
  });

  test("メモリの2本目は、置き場が無いもの(外から消された)も捨て、期限前で置き場の在るものは残す", () => {
    const alive = register();
    const cache: PreviewFrontCache = new Map();
    fakeInner(cache, alive);
    const vanished = "0123456789abcdef0123456789abcdef";
    fakeInner(cache, vanished);
    const result = sweepPreviews({ root, cache, now: at(10) });
    expect(result).toEqual({ removed: [], dropped: [vanished] });
    expect(cache.has(alive)).toBe(true);
    expect(cache.has(vanished)).toBe(false);
  });
});

describe("(d) プロセスが落ちた残骸", () => {
  test("期限切れの残骸と、期限を過ぎた meta 無しの残骸は起動時の1回で消え、期限前の残骸は残る", () => {
    const expired = register(0);
    const alive = register(1800);
    // 作る途中で落ちた残骸(meta.json が無い)を2つ。1つは T0 に、1つは T0+1800 に作られた。
    const oldHalf = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newHalf = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    mkdirSync(join(root, oldHalf));
    mkdirSync(join(root, newHalf));
    // **【`V20-M13` 点検の処置 中1】** 作りかけの残骸にも予約が書いた目印が在る(目印の無い
    // ディレクトリは下見が作ったものと言えないので掃除が消さない)。 手で置く残骸にも目印を置く。
    writeFileSync(join(root, oldHalf, PREVIEW_ENTRY_MARKER_FILE), "");
    writeFileSync(join(root, newHalf, PREVIEW_ENTRY_MARKER_FILE), "");
    utimesSync(join(root, oldHalf), T0, T0);
    const born = new Date(T0.getTime() + 1800 * 1000);
    utimesSync(join(root, newHalf), born, born);

    // 次の起動が T0+3600 に来た。
    const handle = startPreviewSweeper({
      root,
      cache: new Map(),
      timer: manualTimer(),
      now: at(3600),
    });
    handle.stop();
    expect(ls()).toEqual([alive, newHalf].sort());
    expect(ls()).not.toContain(expired);
    expect(ls()).not.toContain(oldHalf);

    // 期限前の残骸は、期限(T0+1800+3600)の周で消える。前の秒では在る。
    expect(sweepPreviews({ root, cache: new Map(), now: at(5399) }).removed).toEqual([]);
    expect(ls()).toEqual([alive, newHalf].sort());
    expect(sweepPreviews({ root, cache: new Map(), now: at(5400) }).removed.sort()).toEqual(
      [alive, newHalf].sort(),
    );
    expect(ls()).toEqual([]);
  });
});

describe("置き場の根が無いときは何もしない", () => {
  test("根を作らず、時計を始めても周を回しても根は無いまま", () => {
    const timer = manualTimer();
    const handle = startPreviewSweeper({ root, cache: new Map(), timer, now: at(0) });
    timer.tick();
    handle.stop();
    expect(existsSync(root)).toBe(false);
    expect(sweepPreviews({ root, cache: new Map(), now: at(0) })).toEqual({
      removed: [],
      dropped: [],
    });
    expect(existsSync(root)).toBe(false);
  });

  test("周の中で投げても時計は止まらず、例外は外に出ない", () => {
    const timer = manualTimer();
    let calls = 0;
    const handle = startPreviewSweeper({
      root,
      cache: new Map(),
      timer,
      now: () => {
        calls += 1;
        throw new Error("時計が壊れた");
      },
    });
    expect(() => timer.tick()).not.toThrow();
    expect(() => timer.tick()).not.toThrow();
    handle.stop();
    expect(calls).toBeGreaterThanOrEqual(3); // 起動時の1回 + 2周
  });
});

describe("(b) 時計が消した後に開くと 410「この下見は期限切れです」(HTTP で撃つ)", () => {
  function memoManifest(): Manifest {
    return {
      app: {
        id: APP_ID,
        name: "メモ帳",
        tables: [
          {
            id: "notes",
            name: "メモ",
            fields: [{ id: "title", name: "題", type: "text", required: true }],
          },
        ],
        views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
        roles: [
          {
            id: "owner",
            name: "持ち主",
            rules: [
              { target: "app", can: ["write"] },
              { target: "role", can: ["write"] },
              { target: "table", table: "notes", can: ["read", "write", "delete"] },
              { target: "view", view: "note-list", can: ["read"] },
            ],
          },
          {
            id: "editor",
            name: "編集者",
            rules: [{ target: "view", view: "note-list", can: ["read"] }],
          },
          {
            id: "viewer",
            name: "閲覧者",
            rules: [{ target: "view", view: "note-list", can: ["read"] }],
          },
        ],
      },
    } as Manifest;
  }

  test("3599 秒の周の後は 200、3600 秒の周の後は置き場が ls から消え 410 と文言", async () => {
    const kernel = KernelMetaStore.open(dataRoot);
    try {
      createApp(kernel, "メモ帳", { app_id: APP_ID });
    } finally {
      kernel.close();
    }
    const applied = applyManifest(dataRoot, APP_ID, memoManifest());
    if (!applied.valid) throw new Error(JSON.stringify(applied.errors));
    const alice = seedSession(dataRoot, APP_ID, { username: "alice", role: "owner" });
    const created = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: {
        diff_id: "d-sweep",
        intent: "メモに本文を足す",
        operations: [
          { op: "add_field", table: "notes", field: { id: "memo", name: "本文", type: "text" } },
        ],
      },
      mode: "real",
      requesterUserId: alice.userId,
      previewRoot: root,
      now: at(0),
    });
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
    const id = created.meta.preview_id;
    const pv = previewAppId(id);

    let nowSec = 0;
    const now = () => new Date(T0.getTime() + nowSec * 1000);
    const cache: PreviewFrontCache = new Map();
    const app = createServerApp({ dataRoot, profile: "full", preview: { root, cache, now } });
    const timer = manualTimer();
    const handle = startPreviewSweeper({ root, cache, timer, now });
    try {
      const open = () =>
        Promise.resolve(
          app.request(new Request(`http://localhost/api/apps/${pv}/tables/notes/records`)),
        );

      nowSec = 3599;
      timer.tick();
      expect(ls()).toEqual([id]);
      const before = await open();
      expect(before.status).toBe(200);
      expect(cache.has(id)).toBe(true);

      nowSec = 3600;
      timer.tick();
      expect(ls()).toEqual([]);
      expect(cache.has(id)).toBe(false);
      const after = await open();
      expect(after.status).toBe(410);
      const body = (await after.json()) as { errors: Array<{ path: string; message: string }> };
      expect(body.errors[0]?.path).toBe("");
      expect(body.errors[0]?.message).toBe(PREVIEW_EXPIRED_MESSAGE);
      expect(PREVIEW_EXPIRED_MESSAGE).toBe("この下見は期限切れです");
    } finally {
      handle.stop();
    }
  });
});
