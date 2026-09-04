/**
 * **`V8-M26` / `D-V8-68` —— 自動付与に付けた「自分の行だけ」の条件が、実 HTTP で効くことの検査。**
 *
 * **ユーザ決定 `D-V8-68`(2026-08-10)。選ばれた説明文の逐語**:
 * 「「作った人だけの表」には、自動の1行に「自分の行だけ」の条件を付けて入れます。
 * 作った直後から使えて、他人の行は見えません。ただし運営が全件を見たいときは、
 * 別に1行書くことになります。」
 *
 * ## **なぜ `src/kernel/` に在るのか(置き場所の理由を隠さない)**
 *
 * **測っているのはサーバ層のふるまいであり、本来なら `src/server/` に置くのが素直である。**
 * **本タスクの担当範囲が `src/kernel/` の下だけに限られていた**(同じ worktree で
 * `src/server/` を別の担当が編集中だった)ため、ここに置いた。
 * **`src/kernel/` の他の検査にも `src/server/` を import しているものが既に複数在る**
 * (`role-rules.test.ts` / `role-conditions.test.ts` / `red-team.test.ts` など)ので、
 * 新しい向きの依存を作ってはいない。**製品コードは1バイトも増えていない。**
 *
 * ## **この検査が測らないもの(誇張しない)**
 *
 * - **`st_owner` の後追い絞り込み(`V1-M3-T04` のサーバ層 post-filter)と、面の条件の
 *   どちらが効いて他人の行が消えているのかを、この検査は切り分けていない。**
 *   **どちらも「他人の行は見えない」側に効くので、結果だけでは区別が付かない。**
 *   **切り分けているのは (C) である** —— **`st_owner` が空の行(= 共有行)は、
 *   post-filter では見えるが面の条件では見えない。**
 * - **付与表(行ごとのアクセス権)の経路は1件も通っていない。**
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerApp } from "../server/app.ts";
import { seedSession, TEST_ORIGIN } from "../server/test-helpers.ts";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Diff, Manifest } from "./types.ts";

const APP_ID = "owner-scoped-grant";

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

/** **役割は3つとも宣言するが、規則は1本も書かない**(自動付与だけを測る土台)。 */
function baseManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "自分の行だけの店",
      tables: [],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

/** **`st_owner`(作った人だけの表)を持つ表を、差分で作る**(自動付与はここで走る)。 */
const ADD_TABLE: Diff = {
  diff_id: "d-notes",
  intent: "作った人だけの覚え書きを作る",
  operations: [
    {
      op: "add_table",
      table: {
        id: "notes",
        name: "覚え書き",
        fields: [
          { id: "title", name: "件名", type: "text", required: true },
          { id: "st_owner", name: "持ち主", type: "text" },
        ],
      },
    },
  ],
} as unknown as Diff;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-owner-scoped-grant-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "自分の行だけの店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
  const applied = applyDiff(dataRoot, APP_ID, ADD_TABLE as unknown);
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(cookie: string | undefined, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(new Request(`http://localhost${path}`, init));
}

const records = `/api/apps/${APP_ID}/tables/notes/records`;

function session(role: "owner" | "editor" | "viewer") {
  return seedSession(dataRoot, APP_ID, {
    role,
    username: `${role}-${Math.random().toString(36).slice(2, 10)}`,
  });
}

async function titlesFor(cookie: string): Promise<string[]> {
  const res = await req(cookie, "GET", records);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { title: string }[] };
  return body.records.map((row) => row.title);
}

// ---------------------------------------------------------------------------

test("(A) 作った直後、その人は自分の行を作って読める(自動付与は生きている)", async () => {
  const a = session("owner");
  const created = await req(a.cookie, "POST", records, { title: "Aの覚え書き" });
  expect(created.status, await created.clone().text()).toBe(201);
  expect(await titlesFor(a.cookie)).toEqual(["Aの覚え書き"]);
});

test("(B) 他人の行は1件も見えない(閲覧者にも、もう1人の持ち主にも)", async () => {
  const a = session("owner");
  const b = session("owner");
  const viewer = session("viewer");
  expect((await req(a.cookie, "POST", records, { title: "Aの覚え書き" })).status).toBe(201);
  expect((await req(b.cookie, "POST", records, { title: "Bの覚え書き" })).status).toBe(201);

  expect(await titlesFor(a.cookie)).toEqual(["Aの覚え書き"]);
  expect(await titlesFor(b.cookie)).toEqual(["Bの覚え書き"]);
  // **閲覧者は自分の行を1件も持たないので、1件も見えない。**
  expect(await titlesFor(viewer.cookie)).toEqual([]);
});

/**
 * **【`V8-M26` / ユーザ決定 `D-V8-70`(2026-08-11)。この test は答えが反転した】**
 *
 * **旧の test 名(逐語)**: 「**(C) 【正直に書く】持ち主が空の行(共有行)も見えない ——
 * 面の条件が効いている証拠**」。
 * **旧の期待値(逐語)**: `expect(await titlesFor(a.cookie)).toEqual([]);`
 *
 * **旧は `V8-M26` の自動付与が「自分の行だけ」だったことの帰結を、正直に固定していた。**
 * **`D-V8-70` はそれを「共有行も見えるようにする」側へ倒し、自動の1行を
 * 「自分の行、または持ち主が空の行」に変えた。** **したがって今日は見える。**
 *
 * **【この test が反転しても弱くなっていない理由】** **面の条件が効いていること自体は、
 * すぐ上の `(B)`(他人の行は1件も見えない)が測っている** —— **「条件が効いている証拠」が
 * 0件になるわけではない。** **下の `(C-3)` も同じ向きを別の角度から固定する。**
 */
test("(C) 持ち主が空の行(共有行)は見える(旧: 見えない。`D-V8-70` で反転した)", async () => {
  const a = session("owner");
  // **`st_owner` を空文字で送っても、サーバ層が要求者の識別子で上書きする**ので、
  // 共有行は HTTP からは作れない。**カーネルの口(差分適用後の DB)から直に入れる。**
  const created = await req(a.cookie, "POST", records, { title: "Aの覚え書き" });
  expect(created.status).toBe(201);
  const row = ((await created.json()) as { record: { _id: string } }).record;

  const { Database } = await import("bun:sqlite");
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true });
  try {
    db.run(`UPDATE "notes" SET "st_owner" = '' WHERE "_id" = ?`, [row._id]);
  } finally {
    db.close();
  }

  // **持ち主が空 = 共有行である。** **面の条件の2枝目(「その項目が空」)が成り立つので、
  // 今日は見える。**
  expect(await titlesFor(a.cookie)).toEqual(["Aの覚え書き"]);

  // **持ち主でない相手にも見える** —— **「みんなのもの」の意味そのものである。**
  const b = session("owner");
  expect(await titlesFor(b.cookie)).toEqual(["Aの覚え書き"]);
});

/**
 * **【`V8-M26` / `D-V8-70`】「空」の実測に基づく2形(`NULL` と 長さ0の文字列)の
 * **両方**が見えること。**
 *
 * **2026-08-11 の実測**: **共有化は `PATCH {st_owner: null}` でも
 * `PATCH {st_owner: 長さ0の文字列}` でも 200 で通り、SQLite にはそれぞれ `NULL` と
 * 長さ0の `TEXT` が入る。** **片方だけを空とみなすと、共有化した行の半分が見えない。**
 */
test("(C-2) `NULL` の共有行も、長さ0の文字列の共有行も、どちらも見える", async () => {
  const a = session("owner");
  const first = await req(a.cookie, "POST", records, { title: "NULLで共有" });
  const second = await req(a.cookie, "POST", records, { title: "空文字で共有" });
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const firstId = ((await first.json()) as { record: { _id: string } }).record._id;
  const secondId = ((await second.json()) as { record: { _id: string } }).record._id;

  const { Database } = await import("bun:sqlite");
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true });
  try {
    db.run(`UPDATE "notes" SET "st_owner" = NULL WHERE "_id" = ?`, [firstId]);
    db.run(`UPDATE "notes" SET "st_owner" = '' WHERE "_id" = ?`, [secondId]);
  } finally {
    db.close();
  }

  // **`viewer` は自分の行を1件も持たない** —— **見えるのは共有行の2件だけである。**
  const b = session("viewer");
  expect((await titlesFor(b.cookie)).sort()).toEqual(["NULLで共有", "空文字で共有"]);
});

/**
 * **【`V8-M26` / `D-V8-70`】戻したのは共有行だけである。**
 *
 * **他人の個人行は今日も1件も見えない** —— **`or` の左は「自分」のままだからである。**
 * **【禁止の履行】「共有できるようになった」を「他人の行が見えるようになった」と読ませない。**
 */
test("(C-3) 共有行が見えるようになっても、他人の個人行は1件も見えない", async () => {
  const a = session("owner");
  const b = session("owner");
  const shared = await req(a.cookie, "POST", records, { title: "みんなのもの" });
  expect(shared.status).toBe(201);
  expect((await req(a.cookie, "POST", records, { title: "Aだけのもの" })).status).toBe(201);
  const sharedId = ((await shared.json()) as { record: { _id: string } }).record._id;

  const { Database } = await import("bun:sqlite");
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true });
  try {
    db.run(`UPDATE "notes" SET "st_owner" = NULL WHERE "_id" = ?`, [sharedId]);
  } finally {
    db.close();
  }

  // **B に見えるのは共有行だけである**(`Aだけのもの` は1件も出ない)。
  expect(await titlesFor(b.cookie)).toEqual(["みんなのもの"]);
});
