/**
 * **`V10-M31-T01`(台帳 `CM-G38`。**門外**(`Δ7`)/ 判定値 = 限定採用)。**
 * **`GET /api/apps/:app_id/manifest` の応答に、アプリごとのコメント設定が載ることの実測。**
 *
 * ## この検査が主張すること
 *
 * > **定義の取得の口が、応答の**外側**に兄弟キー `comment_visibility` を1本だけ足して返す。**
 * > **中身は `{ write: boolean, read: boolean }` の2値ちょうどであり、2つは1つに畳まれていない。**
 * > **`undefined`(設定が1度も倒されていない)のときは `{ write:false, read:false }` に倒す。**
 *
 * ## この検査が主張**しない**こと(**先に書く。丸めない**)
 *
 * 1. **`src/kernel/types.ts` の `Manifest` 型に1バイトも足していない。** **足したのは
 *    サーバ層が応答を組み立てるときの兄弟キー1本だけであり、器の中の定義は1バイトも動かない。**
 *    **`src/kernel/` と `schemas/` を1バイトも触っていない**(これが門外(`Δ7`)の根拠である)。
 * 2. **`GET /api/apps/:app_id/public`(未ログインへ渡す最小限)には1バイトも足していない。**
 *    **書く欄はログイン済みにしか出ないので不要である** —— **未ログイン側のキー集合を固定した
 *    検査は今日どおり緑のままである**(`src/server/anonymous-public-view.test.ts`)。
 * 3. **画面(ブラウザ)がこの値を見て何かを出し分ける、とは1文字も主張しない。**
 *    **測っているのは HTTP の応答だけである。**
 * 4. **設定を HTTP から**書き換える**口は1本も無い**(`ADR-0377` 限定6。読み口だけを足した)。
 *
 * ## **書く側を OFF にしても、書込の口は今日どおり通る**(利用者決定 `D-V10-38`)
 *
 * **`comment_visibility.write` は「欄を出すか」の合図であって、`POST /api/apps/:app_id/comments`
 * を止める壁ではない。** **止めていないことを (f) が陽性対照つきで実測する** ——
 * **ここを「止まる」と読み替えると、`D-V10-38` を黙って覆すことになる。**
 *
 * 作りは `src/server/comment-visibility-backup-inclusion.test.ts`(`beforeEach` / `dataRoot` の
 * 払い出し / `applyManifest` / `createApp`)を先例として真似た。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "book-tracker";
const MANIFEST_PATH = `/api/apps/${APP_ID}/manifest`;
const COMMENTS_PATH = `/api/apps/${APP_ID}/comments`;

let dataRoot: string;
let store: KernelMetaStore;
let app: ReturnType<typeof createServerApp>;
let cookie: string;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
    },
  } as unknown as Manifest;
}

/** 適用した定義そのもの(既定3役割の規則を足した形)。**(e) の突き合わせ相手である。** */
function appliedManifest(): Manifest {
  return withDefaultRoleRules(manifest());
}

/** ログイン済みで定義の取得を叩く(この口は `V8-M21` からログインを要求する)。 */
function getManifest(): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${MANIFEST_PATH}`, {
        method: "GET",
        headers: new Headers({ origin: TEST_ORIGIN, cookie }),
      }),
    ),
  );
}

/** コメントを1件書く(`src/server/comment-api.test.ts` の `post` と同型)。 */
function postComment(body: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${COMMENTS_PATH}`, {
        method: "POST",
        headers: new Headers({
          origin: TEST_ORIGIN,
          cookie,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ anchorForm: "app", anchorParts: [], body }),
      }),
    ),
  );
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "gp-comment-visibility-http-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "蔵書管理", { app_id: APP_ID });
  const applied = applyManifest(dataRoot, APP_ID, appliedManifest());
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
  app = createServerApp({ dataRoot });
  cookie = seedSession(dataRoot, APP_ID).cookie;
});

afterEach(() => {
  store.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a)〜(c) 既定と、片側ずつ倒した値
// ---------------------------------------------------------------------------

test("(cvh-a) V10-M31-T01: 既定のアプリでは comment_visibility が { write:false, read:false } で載る", async () => {
  const res = await getManifest();
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.comment_visibility).toEqual({ write: false, read: false });
});

test("(cvh-b) V10-M31-T01: 書く側だけを倒すと、サーバを起こし直さずに { write:true, read:false } になる", async () => {
  // **陽性対照(先に置く)** —— 倒す前は両方 false である。
  const before = (await (await getManifest()).json()) as Record<string, unknown>;
  expect(before.comment_visibility).toEqual({ write: false, read: false });

  store.setCommentVisibility(APP_ID, { write: true });

  // **`createServerApp` を呼び直していない。** 口はリクエストごとに台帳を開き直すので、
  // 同じ `app` のまま倒した値が見える(`withStore` = `src/server/app.ts`)。
  const after = (await (await getManifest()).json()) as Record<string, unknown>;
  expect(after.comment_visibility).toEqual({ write: true, read: false });
});

test("(cvh-c) V10-M31-T01: 読む側だけを倒すと { write:false, read:true } になる(2つが1つに畳まれていない)", async () => {
  store.setCommentVisibility(APP_ID, { read: true });
  const body = (await (await getManifest()).json()) as Record<string, unknown>;
  expect(body.comment_visibility).toEqual({ write: false, read: true });
});

// ---------------------------------------------------------------------------
// (d)(e) 応答の形 —— 3つ目のキーが生えたら赤くなる / `app` が1バイトも動かない
// ---------------------------------------------------------------------------

test("(cvh-d) V10-M31-T01: 応答のトップレベルのキーは app / comment_visibility の2つちょうどである", async () => {
  const body = (await (await getManifest()).json()) as Record<string, unknown>;
  // **形は `src/server/anonymous-public-view.test.ts:218` に倣った完全一致である** ——
  // **3つ目が生えた瞬間に赤くなる。**
  expect(Object.keys(body).sort()).toEqual(["app", "comment_visibility"]);
});

test("(cvh-e) V10-M31-T01: comment_visibility を足しても body.app は今日と1バイトも変わっていない", async () => {
  const body = (await (await getManifest()).json()) as Record<string, unknown>;
  // **比べる相手は「適用した題材そのもの」である**(`src/server/app.test.ts` と同じ作法)。
  expect(body.app).toEqual((appliedManifest() as unknown as { app: unknown }).app);
});

// ---------------------------------------------------------------------------
// (f) 書く側が OFF でも、書込の口は今日どおり通る(利用者決定 `D-V10-38`)
// ---------------------------------------------------------------------------

test("(cvh-f) V10-M31-T01: 書く側が OFF のままでも POST /comments は 201 で通る(陽性対照 = ON でも通る)", async () => {
  // **既定は OFF である**(上の (a) が同じ台で実測している)。
  const off = await postComment("OFF のままでも書ける");
  expect(off.status).toBe(201);

  // **陽性対照** —— ON に倒しても同じく通る(合図であって壁ではない)。
  store.setCommentVisibility(APP_ID, { write: true });
  const on = await postComment("ON でも書ける");
  expect(on.status).toBe(201);
});
