/**
 * 一覧の画面プリセットが**実際に画面へ当たること**の chromium 実測(V3-M2-T02)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m2.md` §2 の「V3-M2-T02」節、限定の正は
 * `docs/adr/0050-view-display-presets.md` §3(とくに限定5 / 限定6 / 限定9 / 限定11)と
 * `docs/adr/0051-layout-ledger-f5.md` §3(限定3 / 限定4)。
 *
 * ## なぜ要るか
 *
 * `V3-M2-T01` が終わった時点では、**マニフェストにプリセットを書いても画面は1ピクセルも
 * 変わらなかった**(語彙とカーネルだけが通っている状態)。**「プリセットが効く」と言える
 * 根拠は本ファイルにしか無い** —— `web/test/list-view.test.tsx` が見ているのは DOM に
 * 何が出るかだけで、happy-dom は CSS を解決しないからである。
 *
 * ## 4本が何を証明するか
 *
 * | # | テスト | 証明するもの |
 * |---|---|---|
 * | (i) | プリセット無し | **今日の描画のままである**(`table-layout: auto` / `<colgroup>` 0個 / 属性0個)。**number 列の「見出しだけ左寄せ」も直していない** |
 * | (ii) | 軸1 列の寄せ | `<th>` と `<td>` の**両方**の計算値が enum どおりになる。**number 列の既定(右寄せ)を書いた値が上書きする** |
 * | (iii) | 軸2 列の幅 | 段階値が**実際の px 幅**になり、`table-layout` が `fixed` に変わる |
 * | (iv) | 軸3 ページャ位置 | 件数表示とページャの **DOM 上の位置**が enum どおりに変わる(`both` は2箇所に出る) |
 *
 * ## このファイルが証明しないこと(誇張しないための境界)
 *
 * - **視覚的な良し悪しは見ていない。** 読んでいるのは計算値と矩形だけで、
 *   スクリーンショット比較はしていない(`theme.e2e.ts` と同じ限界)。
 * - **【V3-M2-T03 追記】`preset_image_size`(軸6)は下の (vii) が射程に入れた。**
 *   **【V3-M2-T04 追記】`preset_text_preview`(軸7)は下の (viii) が射程に入れた** ——
 *   ただし軸7 で読んでいるのは **CSS の計算値ではなく実際に描かれた文字数**である
 *   (軸7 は CSS では実装できず、表示関数の引数で当てる。ADR-0050 限定10)。
 * - **狭い画面での見え方は見ていない。** `@media` を1つも足していないので、
 *   固定レイアウトの列幅も項目の段組数も画面幅に追随しない(ADR-0050 限界6)。
 * - **【V4-M53 が 2026-08-04 に追記。門A / 限定採用。ADR-0157】直前の理由
 *   (「`@media` を1つも足していない」)は今日から偽である** —— **2026-08-04 実測:
 *   `web/src/styles.css:913` / `:919` に幅の条件の `@media` が2本ある**
 *   (`(min-width: 40rem)` / `(min-width: 64rem)`。どちらも `.shell` の `padding` だけを
 *   変える)。**足したのは `ADR-0089`**(`V4-M15-T07` / `D-V4-44`。2026-08-03)。
 *   **それでも帰結(列幅も段組数も画面幅に追随しない)は今日も真である。**
 *   **本ファイルが狭い画面を1度も見ていないことも今日どおりである** —— **段組・列幅の規則は
 *   2本の `@media` の内側に1つも入っていない**(`web/test/preset-boundary.test.ts` の
 *   `(vi-5)` が実測で固定している)。**旧文を1バイトも消していない。**
 *   **【禁止】「狭い画面での見え方を見た」と書かない** —— **本ファイルは今日も
 *   既定のビューポートでしか描いておらず、幅を変えた実測は1件も持たない。**
 */
import { deflateSync } from "node:zlib";
import { type APIRequestContext, expect, test } from "@playwright/test";
import type { DetailView, Diff, ListView, Manifest, Table } from "../../src/kernel/types.ts";
import {
  buildRecord,
  ensureReferenceTargets,
  type FixtureApp,
  provisionApp,
  type ReferenceIds,
} from "./fixture-app.ts";

/** ページャが出る境界(`web/src/views/ListViewRenderer.tsx` の `PAGE_SIZE`)を超える件数。 */
const RECORDS_OVER_ONE_PAGE = 51;

function listViewOf(manifest: Manifest): ListView {
  const view = manifest.app.views.find((candidate): candidate is ListView => {
    return candidate.type === "list_view";
  });
  if (view === undefined) throw new Error("フィクスチャに list_view が無い");
  return view;
}

/** 製品の HTTP API で差分を適用する(テスト専用経路ではない)。 */
async function applyDiff(request: APIRequestContext, app: FixtureApp, diff: Diff): Promise<void> {
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    data: diff,
    headers: app.authHeaders,
  });
  expect(applied.status(), await applied.text()).toBe(201);
}

/** `update_view` でプリセットだけを差し替える差分(`DIFF_OPS` を1つも増やしていない)。 */
function updateViewDiff(viewId: string, changes: Record<string, unknown>, diffId: string): Diff {
  return {
    diff_id: diffId,
    intent: "この画面の見せ方を、用意された選択肢の中から選びたいという要望に応えた",
    operations: [{ op: "update_view", view: viewId, changes }],
  } as Diff;
}

/** 要素の計算値をまとめて読む(`theme.e2e.ts` と同じ形)。 */
async function computed(
  page: import("@playwright/test").Page,
  selector: string,
  properties: string[],
): Promise<Record<string, string>> {
  return await page.evaluate(
    ({ selector, properties }) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`要素が見つからない: ${selector}`);
      const style = getComputedStyle(element);
      const out: Record<string, string> = {};
      for (const property of properties) out[property] = style.getPropertyValue(property);
      return out;
    },
    { selector, properties },
  );
}

/** 1列ぶんの計算値(見出しと最初のセルの両方)。 */
async function columnAlign(
  page: import("@playwright/test").Page,
  fieldId: string,
  columnIndex: number,
): Promise<{ th: string; td: string }> {
  return await page.evaluate(
    ({ fieldId, columnIndex }) => {
      const table = document.querySelector(".list-table");
      if (table === null) throw new Error("一覧の表が無い");
      const th = table.querySelectorAll("thead th")[columnIndex];
      const td = table.querySelector(`tbody td[data-field="${fieldId}"]`);
      if (th === undefined || td === null) throw new Error(`列が見つからない: ${fieldId}`);
      return {
        th: getComputedStyle(th).textAlign,
        td: getComputedStyle(td).textAlign,
      };
    },
    { fieldId, columnIndex },
  );
}

/*
 * **【V4-M20-T03 で `list-bulk` が1つ増えた】**
 *
 * **単位C(画面で選んでまとめて操作する)の判定は「将来送り」であり、その送り先が
 * `V4-M20-T03`(**表示層だけで作り、カーネル語彙を1つも増やさない**)である。**
 * **入口のボタン(「まとめて操作」)は `.list-view` の直下に立つので、この並びの先頭に
 * 1つ増える。****出るのは editor / owner のときだけである**(e2e は認証済みで開いている)。
 * **並びの前後関係(件数表示とページャの位置)は1つも変わっていない。**
 */
/** `.list-view` の直下の並び(`data-testid` の列)。 */
async function sectionOrder(page: import("@playwright/test").Page): Promise<string[]> {
  return await page.evaluate(() => {
    const section = document.querySelector(".list-view");
    if (section === null) throw new Error("一覧の器が無い");
    return [...section.children].map(
      (child) => child.getAttribute("data-testid") ?? child.tagName.toLowerCase(),
    );
  });
}

/** 対象テーブルに `count` 件のレコードを入れる(フィルタに合致する値で埋める)。 */
async function seed(app: FixtureApp, table: Table, count: number): Promise<ReferenceIds> {
  const referenceIds = await ensureReferenceTargets(app, table);
  for (let index = 0; index < count; index += 1) {
    await app.createRecord(table.id, buildRecord(table, index, referenceIds));
  }
  return referenceIds;
}

test.describe("V3-M2-T02 一覧のプリセットの表示層への適用(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の期待値は chromium の値である(`theme.e2e.ts` と同じ理由)",
  );

  test("(i) プリセットを1つも書いていない一覧は今日の描画のままである", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seed(app, app.tableOf(view.table), 2);
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.getByTestId("list-table")).toBeVisible();

    // `table-layout` は `auto` のまま = 既存アプリの列幅配分が1ピクセルも変わらない
    // (ADR-0050 限定6 / ADR-0051 限定4)。
    const table = await computed(page, ".list-table", ["table-layout"]);
    expect(table["table-layout"]).toBe("auto");

    // プリセット由来の DOM は1つも増えていない。
    expect(await page.locator(".list-table colgroup").count()).toBe(0);
    expect(await page.locator("[data-preset-align]").count()).toBe(0);
    expect(await page.locator("[data-preset-width]").count()).toBe(0);
    expect(await page.locator("[data-preset-pager]").count()).toBe(0);

    // 既定の並び: 件数表示が表の前、ページャは(51件未満なので)出ない。
    //
    // **【`V10-M3-T01` で `list-create` が先頭に1つ増えた】** 一覧の既定挙動として
    // 新規作成の口が `.list-view` の直下の先頭に立つようになった。**この検査が
    // 表しているものが1段変わっている** —— 「プリセットを1つも書いていない一覧の並び」は、
    // 今日から**新規作成の口を含む**(題材のアプリには対象テーブルの `form` が在り、
    // 面が読取を許し、既定セッションが owner なので5条件すべてが揃う)。
    // **件数表示とページャの前後関係は1つも変わっていない。**
    expect(await sectionOrder(page)).toEqual([
      "list-create",
      "list-bulk",
      "list-total",
      "list-table",
    ]);

    // **number 列の「見出しだけ左寄せ」は直していない**(T02 の明示的な決定)。
    // 直すと既存の全アプリの見た目が変わるので、プリセットを書いた画面だけが変わる形に閉じた。
    const quantity = await columnAlign(page, "quantity", 1);
    expect(quantity.th).toBe("left");
    expect(quantity.td).toBe("right");
    const name = await columnAlign(page, "name", 0);
    expect(name.th).toBe("left");
    expect(name.td).toBe("left");
  });

  test("(ii) 軸1: 書いた寄せが見出しとセルの両方に効き、number 列の既定も上書きする", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seed(app, app.tableOf(view.table), 2);

    await applyDiff(
      request,
      app,
      updateViewDiff(
        view.id,
        // columns は [name, quantity, condition, in_use]。**in_use には書かない**
        // (書かなかった列が今日のままであることを同じ画面で見るため)。
        { preset_column_align: { name: "right", quantity: "left", condition: "center" } },
        "preset-align",
      ),
    );
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.getByTestId("list-table")).toBeVisible();

    const name = await columnAlign(page, "name", 0);
    expect(name).toEqual({ th: "right", td: "right" });
    const condition = await columnAlign(page, "condition", 2);
    expect(condition).toEqual({ th: "center", td: "center" });
    // **number の既定は右寄せだが、書いた `left` が勝つ**(規則の並び順で後勝ちにしてある)。
    const quantity = await columnAlign(page, "quantity", 1);
    expect(quantity).toEqual({ th: "left", td: "left" });
    // 書かなかった列は今日のまま。
    const inUse = await columnAlign(page, "in_use", 3);
    expect(inUse).toEqual({ th: "left", td: "left" });

    // **属性値は enum の要素だけである**(限定11)。自由な文字列は1つも出ていない。
    const values = await page.evaluate(() =>
      [...document.querySelectorAll("[data-preset-align]")].map((element) =>
        element.getAttribute("data-preset-align"),
      ),
    );
    expect(new Set(values)).toEqual(new Set(["right", "left", "center"]));

    // **アプリ・画面を指す属性は1つも新設していない**(限定5)。
    expect(await page.locator("[data-app-id], [data-view-id]").count()).toBe(0);

    // **プリセットはアプリのスコープ要素の内側にしか出ない**(ADR-0051 限定3)——
    // シェル(プラットフォームの外枠)には1つも漏れていない。
    const leaked = await page.evaluate(() => {
      const scope = document.querySelector('[data-testid="app-theme"]');
      const marked = [...document.querySelectorAll("[data-preset-align], [data-preset-pager]")];
      return {
        outside: marked.filter((element) => scope === null || !scope.contains(element)).length,
        onShell: document
          .querySelector(".shell")
          ?.getAttributeNames()
          .filter((name) => name.startsWith("data-preset")).length,
      };
    });
    expect(leaked).toEqual({ outside: 0, onShell: 0 });
  });

  test("(iii) 軸2: 段階値が実際の列幅になり、書いた画面だけ table-layout が fixed になる", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seed(app, app.tableOf(view.table), 2);

    await applyDiff(
      request,
      app,
      updateViewDiff(
        view.id,
        // **3段階すべてを1画面で測る**(当たり先の無い enum 値を残さないため)。
        { preset_column_width: { name: "narrow", quantity: "standard", condition: "wide" } },
        "preset-width",
      ),
    );
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.getByTestId("list-table")).toBeVisible();

    const table = await computed(page, ".list-table", ["table-layout"]);
    expect(table["table-layout"]).toBe("fixed");

    const widths = await page.evaluate(() => {
      const row = document.querySelector(".list-table tbody tr");
      if (row === null) throw new Error("行が無い");
      const out: Record<string, number> = {};
      for (const cell of row.querySelectorAll("td")) {
        const field = cell.getAttribute("data-field");
        if (field !== null) out[field] = Math.round(cell.getBoundingClientRect().width);
      }
      return out;
    });
    // 段階値は `web/src/styles.css` の 6rem / 12rem / 24rem(= 96px / 192px / 384px)。
    expect(widths.name).toBe(96);
    expect(widths.quantity).toBe(192);
    expect(widths.condition).toBe(384);
    // **幅を書かなかった列も固定レイアウトの配分になる**(限定6 の代償)——
    // 「一部の列だけ幅を指定して残りは今までどおり」はできない。
    expect(widths.in_use).toBeGreaterThan(0);
  });

  test("(iv) 軸3: 件数表示とページャの位置が enum どおりに変わる", async ({ page, request }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    await seed(app, app.tableOf(view.table), RECORDS_OVER_ONE_PAGE);
    const url = `/apps/${app.appId}/views/${view.id}`;

    // --- 書く前は今日の並び(件数表示が上・ページャが下)---
    await page.goto(url);
    await expect(page.getByTestId("list-pager")).toBeVisible();
    expect(await sectionOrder(page)).toEqual([
      "list-create",
      "list-bulk",
      "list-total",
      "list-table",
      "list-pager",
    ]);

    // --- top: どちらも表の前へ ---
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_pager_position: "top" }, "preset-pager-top"),
    );
    await page.reload();
    await expect(page.getByTestId("list-pager")).toBeVisible();
    expect(await sectionOrder(page)).toEqual([
      "list-create",
      "list-bulk",
      "list-total",
      "list-pager",
      "list-table",
    ]);
    expect(await page.locator('.list-view[data-preset-pager="top"]').count()).toBe(1);

    // --- bottom: どちらも表の後へ ---
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_pager_position: "bottom" }, "preset-pager-bottom"),
    );
    await page.reload();
    await expect(page.getByTestId("list-table")).toBeVisible();
    expect(await sectionOrder(page)).toEqual([
      "list-create",
      "list-bulk",
      "list-table",
      "list-total",
      "list-pager",
    ]);

    // --- both: **ページャ**が表の前と後の2箇所に出る(件数表示は1回だけ)---
    //
    // **【E-G44 ではなく E-G19 / V4-M6 で期待を書き直した】** 着手前はここが
    // 「件数表示も2回出る」を固定していた。**それが `E-G19` の症状そのものである** ——
    // 実地の `product-all` に同じ「1–32 件 / 全 32 件」が表の上と下に出ており、書き手は
    // 「ページャを上下に置いた」つもりで `both` を書いていた(02 §5-3 `E-G19`)。
    // **宣言値は3値のまま1つも増やしていない。**
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_pager_position: "both" }, "preset-pager-both"),
    );
    await page.reload();
    await expect(page.getByTestId("list-table")).toBeVisible();
    expect(await sectionOrder(page)).toEqual([
      "list-create",
      "list-bulk",
      "list-total",
      "list-pager",
      "list-table",
      "list-pager",
    ]);
    expect(await page.getByTestId("list-pager").count()).toBe(2);
    expect(await page.getByTestId("list-total").count()).toBe(1);

    // --- undo で1つ前(bottom)へ戻る(既存機構のまま効く)---
    const undone = await request.post(`/api/apps/${app.appId}/undo`, { headers: app.authHeaders });
    expect(undone.status(), await undone.text()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("list-table")).toBeVisible();
    expect(await sectionOrder(page)).toEqual([
      "list-create",
      "list-bulk",
      "list-table",
      "list-total",
      "list-pager",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 詳細のプリセット(V3-M2-T03。軸4 / 軸5 / 軸6)
// ---------------------------------------------------------------------------

/**
 * ここから下が確かめるのは3つである(上の (i)〜(iv) と同じ形で、対象が詳細画面になる):
 *
 * | # | テスト | 証明するもの |
 * |---|---|---|
 * | (v) | 軸4 項目名と値の向き | `flex-direction` が enum どおりに変わり、**縦積みのとき
 *         `--detail-label-width` が高さとして効いていない**(ADR-0050 限定8) |
 * | (vi) | 軸5 項目の段組数 | 項目の**実際の矩形**が enum どおりの段数に並ぶ |
 * | (vii) | 軸6 image の表示サイズ | **一覧と詳細に別サイズを持てる**こと、**`related` の
 *          子一覧の画像にも当たる**こと、**軸4・軸5 は子一覧に当たらない**こと(ADR-0050 §4) |
 *
 * **(vii) だけは実体のある画像が要る。** 配信された画像を chromium が自然寸法で描けないと
 * 「原寸」と「段階値」の区別が測れないので、`node:zlib` で本物の PNG を組み立ててアップロードする。
 */

/** PNG のチャンク CRC(多項式 0xedb88320。表を持たずに都度計算する)。 */
function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 8bit グレースケールの本物の PNG(自然寸法 `width` × `height`)。 */
function pngBytes(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 0; // color type = grayscale
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) raw[y * (width + 1) + 1 + x] = (x + y) & 0xff;
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 製品の画像アップロード API(`POST /files`)で1枚上げ、`file_id` を返す。 */
async function uploadImage(
  request: APIRequestContext,
  app: FixtureApp,
  width: number,
  height: number,
): Promise<string> {
  const uploaded = await request.post(`/api/apps/${app.appId}/files`, {
    headers: app.authHeaders,
    multipart: {
      file: {
        name: "photo.png",
        mimeType: "image/png",
        buffer: Buffer.from(pngBytes(width, height)),
      },
    },
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  return ((await uploaded.json()) as { file_id: string }).file_id;
}

function detailViewOf(manifest: Manifest): DetailView {
  const view = manifest.app.views.find((candidate): candidate is DetailView => {
    return candidate.type === "detail_view";
  });
  if (view === undefined) throw new Error("フィクスチャに detail_view が無い");
  return view;
}

/** 詳細の1項目ぶんの矩形と計算値(ラベルと値の位置関係を見る)。 */
async function fieldGeometry(page: import("@playwright/test").Page, index: number) {
  return await page.evaluate((index) => {
    const item = document.querySelectorAll(".detail-fields .detail-field")[index];
    if (item === undefined) throw new Error(`項目が無い: ${index}`);
    const label = item.querySelector("dt");
    const value = item.querySelector("dd");
    if (label === null || value === null) throw new Error("dt/dd が無い");
    const round = (rect: DOMRect) => ({
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    return {
      direction: getComputedStyle(item).flexDirection,
      labelBasis: getComputedStyle(label).flexBasis,
      item: round(item.getBoundingClientRect()),
      label: round(label.getBoundingClientRect()),
      value: round(value.getBoundingClientRect()),
    };
  }, index);
}

/** 画像の計算値と実寸(`.field-image` は一覧・詳細・子一覧で同じクラスである)。 */
async function imageBox(page: import("@playwright/test").Page, selector: string) {
  return await page.evaluate((selector) => {
    const image = document.querySelector(selector);
    if (image === null) throw new Error(`画像が見つからない: ${selector}`);
    const style = getComputedStyle(image);
    const rect = image.getBoundingClientRect();
    return {
      maxWidth: style.maxWidth,
      maxHeight: style.maxHeight,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, selector);
}

test.describe("V3-M2-T03 詳細のプリセットの表示層への適用(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の期待値は chromium の値である(`theme.e2e.ts` と同じ理由)",
  );

  /** 詳細画面を1件開ける状態にする(レコード1件 + URL)。 */
  async function openableDetail(request: APIRequestContext) {
    const app = await provisionApp(request);
    const view = detailViewOf(app.manifest);
    const table = app.tableOf(view.table);
    const referenceIds = await ensureReferenceTargets(app, table);
    const recordId = await app.createRecord(table.id, buildRecord(table, 0, referenceIds));
    return { app, view, recordId, referenceIds };
  }

  test("(v) 軸4: 項目名と値の向きが enum どおりに変わり、縦積みでもラベルは高さを持たない", async ({
    page,
    request,
  }) => {
    const { app, view, recordId } = await openableDetail(request);
    await app.authenticate(page.context());
    const url = `/apps/${app.appId}/views/${view.id}/records/${recordId}`;

    // --- 書く前(未指定)は今日の描画のまま ---
    await page.goto(url);
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    expect(await page.locator("[data-preset-label]").count()).toBe(0);
    const before = await fieldGeometry(page, 0);
    // 横並び。ラベル幅はテーマスロット `--detail-label-width`(8rem = 128px)。
    expect(before.direction).toBe("row");
    expect(before.labelBasis).toBe("128px");
    expect(before.label.top).toBe(before.value.top);

    // --- inline: 今日と同じ向き(書いた値が既定と一致することを実測で示す)---
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_label_placement: "inline" }, "preset-label-inline"),
    );
    await page.reload();
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    const inline = await fieldGeometry(page, 0);
    expect(inline.direction).toBe("row");
    expect(inline.labelBasis).toBe("128px");
    expect(inline.label.top).toBe(inline.value.top);

    // --- stacked: 縦積みになる ---
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_label_placement: "stacked" }, "preset-label-stacked"),
    );
    await page.reload();
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    const stacked = await fieldGeometry(page, 0);
    expect(stacked.direction).toBe("column");
    // **【ADR-0050 限定8】`flex-basis` を `auto` へ落としてある** —— 落とさないと
    // 128px が「高さ」として解釈され、ラベル1行のために 128px の空白ができる。
    expect(stacked.labelBasis).toBe("auto");
    expect(stacked.label.height).toBeLessThan(60);
    // 値はラベルの下に来る(横並びではない)。
    expect(stacked.value.top).toBeGreaterThanOrEqual(stacked.label.top + stacked.label.height);
    // **テーマスロットの値そのものは1バイトも変えていない**(横並びへ戻せば再び効く)。
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_label_placement: "inline" }, "preset-label-back"),
    );
    await page.reload();
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    expect((await fieldGeometry(page, 0)).labelBasis).toBe("128px");
  });

  test("(vi) 軸5: 項目が enum どおりの段数で並ぶ", async ({ page, request }) => {
    const { app, view, recordId } = await openableDetail(request);
    await app.authenticate(page.context());
    const url = `/apps/${app.appId}/views/${view.id}/records/${recordId}`;

    // --- 書く前(未指定)は器がブロックのまま ---
    await page.goto(url);
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    expect((await computed(page, ".detail-fields", ["display"])).display).toBe("block");

    // --- 1段組: 項目は縦に並ぶ ---
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_field_columns: 1 }, "preset-columns-1"),
    );
    await page.reload();
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    const single = await computed(page, ".detail-fields", ["display", "grid-template-columns"]);
    expect(single.display).toBe("grid");
    // 1トラックだけ(段が1つ)。
    expect((single["grid-template-columns"] ?? "").split(" ")).toHaveLength(1);
    const first = await fieldGeometry(page, 0);
    const second = await fieldGeometry(page, 1);
    expect(second.item.top).toBeGreaterThan(first.item.top);
    expect(second.item.left).toBe(first.item.left);

    // --- 2段組: 隣り合う2項目が同じ段に並ぶ ---
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_field_columns: 2 }, "preset-columns-2"),
    );
    await page.reload();
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    const two = await computed(page, ".detail-fields", ["display", "grid-template-columns"]);
    expect(two.display).toBe("grid");
    expect((two["grid-template-columns"] ?? "").split(" ")).toHaveLength(2);
    const left = await fieldGeometry(page, 0);
    const right = await fieldGeometry(page, 1);
    const nextRow = await fieldGeometry(page, 2);
    // 1件目と2件目は**同じ高さ**に、左右に並ぶ。
    expect(right.item.top).toBe(left.item.top);
    expect(right.item.left).toBeGreaterThan(left.item.left);
    // 3件目は次の段へ折り返す。
    expect(nextRow.item.top).toBeGreaterThan(left.item.top);
    expect(nextRow.item.left).toBe(left.item.left);
  });

  test("(vii) 軸6: 一覧と詳細に別サイズを持てて、related の子一覧にも当たる", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const list = listViewOf(app.manifest);
    const detail = detailViewOf(app.manifest);
    const table = app.tableOf(list.table);

    // **自然寸法 600×400 の本物の PNG**(段階値より大きいので「縮んだこと」が測れる)。
    const fileId = await uploadImage(request, app, 600, 400);
    const referenceIds = await ensureReferenceTargets(app, table);
    const recordId = await app.createRecord(table.id, {
      ...buildRecord(table, 0, referenceIds),
      photo: fileId,
    });

    // 一覧に画像列を出しつつ **thumbnail**、詳細は **medium** —— 別々の段階値を同時に書く。
    await applyDiff(
      request,
      app,
      updateViewDiff(
        list.id,
        { columns: ["name", "photo"], preset_image_size: "thumbnail" },
        "preset-image-list",
      ),
    );
    await applyDiff(
      request,
      app,
      updateViewDiff(detail.id, { preset_image_size: "medium" }, "preset-image-detail"),
    );

    // --- 一覧: thumbnail(4rem = 64px)---
    await page.goto(`/apps/${app.appId}/views/${list.id}`);
    await expect(page.getByTestId("list-table")).toBeVisible();
    const inList = await imageBox(page, ".list-view .field-image");
    expect(inList.maxWidth).toBe("64px");
    // 600×400 が幅 64px に収まり、縦横比は保たれる(64 / 600 * 400 ≒ 43)。
    expect(inList.width).toBe(64);
    expect(inList.height).toBe(43);

    // --- 詳細: medium(12rem = 192px)。**同じ画像が別の大きさで出る** ---
    await page.goto(`/apps/${app.appId}/views/${detail.id}/records/${recordId}`);
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    const inDetail = await imageBox(page, ".detail-view .field-image");
    expect(inDetail.maxWidth).toBe("192px");
    expect(inDetail.width).toBe(192);
    expect(inDetail.width).not.toBe(inList.width);

    // --- original: 枠を掛けない(自然寸法のまま)---
    await applyDiff(
      request,
      app,
      updateViewDiff(detail.id, { preset_image_size: "original" }, "preset-image-original"),
    );
    await page.reload();
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    const original = await imageBox(page, ".detail-view .field-image");
    expect(original.maxWidth).toBe("none");
    expect(original.width).toBe(600);

    // --- related の子一覧(ADR-0050 §4 の表を実測で確かめる)---
    // categories の詳細に「このカテゴリの items」を出し、その列に画像を含める。
    const categoryId = referenceIds.get("categories");
    expect(categoryId, "参照先のカテゴリが作られている").toBeDefined();
    await applyDiff(request, app, {
      diff_id: "preset-related-view",
      intent: "カテゴリの詳細に、そのカテゴリの備品一覧を出したい",
      operations: [
        {
          op: "add_view",
          view: {
            id: "category-detail",
            type: "detail_view",
            table: "categories",
            related: [{ table: "items", via: "category", columns: ["name", "photo"] }],
            // **軸6 は子一覧に当たり、軸4・軸5 は当たらない**ことを同じ画面で見るため、
            // 3軸を同時に書く。
            preset_image_size: "thumbnail",
            preset_label_placement: "stacked",
            preset_field_columns: 2,
          },
        },
      ],
    } as Diff);
    await page.goto(`/apps/${app.appId}/views/category-detail/records/${categoryId}`);
    await expect(page.getByTestId("related-table")).toBeVisible();

    // **軸6 は当たる** —— 子一覧の画像も thumbnail(64px)になる。
    const inRelated = await imageBox(page, ".related-table .field-image");
    expect(inRelated.maxWidth).toBe("64px");
    expect(inRelated.width).toBe(64);

    // **軸4・軸5 は当たらない** —— 子一覧の表は素の表のままである。
    const relatedShape = await page.evaluate(() => {
      const table = document.querySelector(".related-table");
      const fields = document.querySelector(".detail-fields");
      if (table === null || fields === null) throw new Error("子一覧または項目の器が無い");
      const row = table.querySelector("tbody tr");
      const cell = table.querySelector("tbody td");
      return {
        insideFieldList: fields.contains(table),
        fieldsDisplay: getComputedStyle(fields).display,
        tableDisplay: getComputedStyle(table).display,
        rowDisplay: row === null ? null : getComputedStyle(row).display,
        cellDirection: cell === null ? null : getComputedStyle(cell).flexDirection,
      };
    });
    expect(relatedShape.insideFieldList).toBe(false);
    // 項目の器には段組が当たっている(= 書いた値は確かに効いている)。
    expect(relatedShape.fieldsDisplay).toBe("grid");
    // それでも子一覧は表のまま(段組にも縦積みにもなっていない)。
    expect(relatedShape.tableDisplay).toBe("table");
    expect(relatedShape.rowDisplay).toBe("table-row");
    expect(relatedShape.cellDirection).toBe("row");
  });
});

// ---------------------------------------------------------------------------
// long_text の切り詰め長(V3-M2-T04。軸7)
// ---------------------------------------------------------------------------

/**
 * (viii) が確かめるのは3つである:
 *
 * - **一覧と詳細で別の切り詰め長になる**(画面ごとに違う値が別々に効く)。
 * - **全文は `title` に残る**(切り詰めても値を捨てない。既存の挙動を壊していない)。
 * - **`standard` を書くと未指定と1文字も変わらない**(既定の明示的な宣言になる)。
 *
 * **軸1〜6 と読むものが違う。** 軸7 は CSS では実装できない(切り詰め後の文字列しか
 * DOM に出ないので CSS からは全文を復元できない)ため、当てるのは表示関数の引数であり、
 * ここで読むのは `getComputedStyle` ではなく**描かれた文字列そのもの**である。
 * したがって `data-preset-*` 属性も増えない —— そのことも下で実測する。
 */

/** 画面の中の long_text の表示(描かれた文字列と、全文が残る `title`)。 */
async function longTextPreview(
  page: import("@playwright/test").Page,
  scopeSelector: string,
): Promise<{ text: string; length: number; title: string | null }> {
  return await page.evaluate((scopeSelector) => {
    const scope = document.querySelector(scopeSelector);
    if (scope === null) throw new Error(`器が見つからない: ${scopeSelector}`);
    const node = scope.querySelector('[data-testid="field-value-long_text"]');
    if (node === null) throw new Error(`long_text の表示が無い: ${scopeSelector}`);
    const text = node.textContent ?? "";
    return { text, length: text.length, title: node.getAttribute("title") };
  }, scopeSelector);
}

test.describe("V3-M2-T04 long_text の切り詰め長の表示層への適用(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "他の (i)〜(vii) と同じ器で動かすため揃える(読む値自体はブラウザに依存しない)",
  );

  test("(viii) 軸7: 一覧と詳細で別の切り詰め長になり、全文は title に残る", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const list = listViewOf(app.manifest);
    const detail = detailViewOf(app.manifest);
    const table = app.tableOf(list.table);

    // 200文字。どの段階値(20 / 40 / 80)でも必ず切り詰めが起きる長さ。
    const note = "あいうえおかきくけこ".repeat(20);
    const referenceIds = await ensureReferenceTargets(app, table);
    const recordId = await app.createRecord(table.id, {
      ...buildRecord(table, 0, referenceIds),
      note,
    });

    // --- 書く前(未指定)は今日の既定(40文字)---
    await applyDiff(
      request,
      app,
      updateViewDiff(list.id, { columns: ["name", "note"] }, "preset-text-columns"),
    );
    const listUrl = `/apps/${app.appId}/views/${list.id}`;
    await page.goto(listUrl);
    await expect(page.getByTestId("list-table")).toBeVisible();
    const before = await longTextPreview(page, ".list-table");
    // 切り詰めた40文字 + 省略記号。
    expect(before.length).toBe(41);
    expect(before.text).toBe(`${note.slice(0, 40)}…`);
    expect(before.title).toBe(note);

    // --- 一覧は short(20)、詳細は long(80)—— **別々の画面に別々の値を書く** ---
    await applyDiff(
      request,
      app,
      updateViewDiff(list.id, { preset_text_preview: "short" }, "preset-text-list"),
    );
    await applyDiff(
      request,
      app,
      updateViewDiff(detail.id, { preset_text_preview: "long" }, "preset-text-detail"),
    );

    await page.reload();
    await expect(page.getByTestId("list-table")).toBeVisible();
    const inList = await longTextPreview(page, ".list-table");
    expect(inList.length).toBe(21);
    expect(inList.text).toBe(`${note.slice(0, 20)}…`);
    // **切り詰めても全文は捨てない**(既存の挙動を1バイトも壊していない)。
    expect(inList.title).toBe(note);

    await page.goto(`/apps/${app.appId}/views/${detail.id}/records/${recordId}`);
    await expect(page.getByTestId("detail-fields")).toBeVisible();
    const inDetail = await longTextPreview(page, ".detail-fields");
    expect(inDetail.length).toBe(81);
    expect(inDetail.text).toBe(`${note.slice(0, 80)}…`);
    expect(inDetail.title).toBe(note);
    // **同じ値が同じアプリの中で別の長さで出ている**(画面ごとに効く)。
    expect(inDetail.text).not.toBe(inList.text);

    // --- standard は未指定と1文字も変わらない(既定の明示的な宣言)---
    await applyDiff(
      request,
      app,
      updateViewDiff(list.id, { preset_text_preview: "standard" }, "preset-text-standard"),
    );
    await page.goto(listUrl);
    await expect(page.getByTestId("list-table")).toBeVisible();
    const standard = await longTextPreview(page, ".list-table");
    expect(standard.text).toBe(before.text);
    expect(standard.title).toBe(note);

    // --- 軸7 は DOM 属性を1つも増やしていない(経路B ではない)---
    expect(await page.locator("[data-preset-text], [data-preset-preview]").count()).toBe(0);
    // **アプリ・画面を指す属性も1つも新設していない**(ADR-0050 限定5)。
    expect(await page.locator("[data-app-id], [data-view-id]").count()).toBe(0);

    // --- related の子一覧にも当たる(ADR-0050 §4)---
    const categoryId = referenceIds.get("categories");
    expect(categoryId, "参照先のカテゴリが作られている").toBeDefined();
    await applyDiff(request, app, {
      diff_id: "preset-text-related",
      intent: "カテゴリの詳細に備品の一覧を出し、長文の見せ方を画面ごとに揃えたい",
      operations: [
        {
          op: "add_view",
          view: {
            id: "category-detail-text",
            type: "detail_view",
            table: "categories",
            related: [{ table: "items", via: "category", columns: ["name", "note"] }],
            preset_text_preview: "short",
          },
        },
      ],
    } as Diff);
    await page.goto(`/apps/${app.appId}/views/category-detail-text/records/${categoryId}`);
    await expect(page.getByTestId("related-table")).toBeVisible();
    const inRelated = await longTextPreview(page, ".related-table");
    expect(inRelated.length).toBe(21);
    expect(inRelated.title).toBe(note);
  });
  test("(ix) 軸9: 画面ごとの詰まり具合が計算値に出て、書かなかった画面は1ピクセルも変わらない", async ({
    page,
    request,
  }) => {
    /**
     * **`V4-M19-T04` / `ADR-0118` 限定6 / 限定8 の chromium 実測。**
     *
     * **何を測るか**: **同じアプリの2つの一覧**(片方に `compact` を書き、片方には
     * 何も書かない)の**計算値の差**である。**片方だけを変えられることの実測がここにしかない**
     * —— `web/test/view-density.test.tsx` は happy-dom であって CSS を1バイトも計算しない。
     *
     * **【正直に書く】角丸の軸だけは差が0である**(`v4-m15-t19.md:967` と同じ実測)。
     * **「2つの系統は全部の軸で違う」とは書けない。**
     */
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    const table = app.tableOf(view.table);
    await seed(app, table, 2);

    // **同じテーブルを出す2枚目の一覧を足す** —— 片方にだけ書いて、もう片方が
    // 1ピクセルも変わらないことを同じアプリの中で見るためである。
    await applyDiff(request, app, {
      diff_id: "preset-density-plain",
      intent: "同じ一覧をもう1枚置いて、片方だけ詰まり具合を変えたときの差を見たい",
      operations: [
        {
          op: "add_view",
          view: {
            id: "items-list-plain",
            type: "list_view",
            table: table.id,
            columns: [...view.columns],
          },
        },
      ],
    } as Diff);

    /** ボタン・表のセル・器の計算値をまとめて読む。 */
    const read = async () =>
      await page.evaluate(() => {
        const button = document.querySelector<HTMLElement>(".list-view button");
        const cell = document.querySelector<HTMLElement>(".list-table tbody td");
        if (button === null || cell === null) throw new Error("測る要素が見つからない");
        const bs = getComputedStyle(button);
        const cs = getComputedStyle(cell);
        return {
          buttonHeight: bs.height,
          buttonPaddingLeft: bs.paddingLeft,
          buttonFontSize: bs.fontSize,
          buttonBorderRadius: bs.borderTopLeftRadius,
          cellFontSize: cs.fontSize,
          scopes: document.querySelectorAll('[data-testid="view-density-scope"]').length,
        };
      });

    // --- 書かなかった画面(2枚目)---
    await page.goto(`/apps/${app.appId}/views/items-list-plain`);
    await expect(page.getByTestId("list-table")).toBeVisible();
    const plain = await read();
    // **作用域の要素が1つも出ない**(限定8)。
    expect(plain.scopes).toBe(0);

    // --- compact を書いた画面(1枚目)---
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_density: "compact" }, "preset-density-compact"),
    );
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.getByTestId("list-table")).toBeVisible();
    const compact = await read();
    expect(compact.scopes).toBe(1);
    expect(await page.getAttribute('[data-testid="view-density-scope"]', "data-ui-family")).toBe(
      "compact",
    );

    // **実際に詰まっている**(差が0でない軸を1つずつ名指しで固定する)。
    expect(compact.buttonHeight).not.toBe(plain.buttonHeight);
    expect(compact.buttonPaddingLeft).not.toBe(plain.buttonPaddingLeft);
    expect(compact.buttonFontSize).not.toBe(plain.buttonFontSize);
    expect(compact.cellFontSize).not.toBe(plain.cellFontSize);
    // **【正直に書く】角丸だけは差が0である。**「全部の軸で違う」と書かない。
    expect(compact.buttonBorderRadius).toBe(plain.buttonBorderRadius);

    // --- 書かなかった画面が、隣の画面の宣言で1ピクセルも動いていない ---
    await page.goto(`/apps/${app.appId}/views/items-list-plain`);
    await expect(page.getByTestId("list-table")).toBeVisible();
    expect(await read()).toEqual(plain);

    // --- comfortable と明示した画面は、書かなかった画面と同じ計算値になる(既定を反転させていない)---
    await applyDiff(
      request,
      app,
      updateViewDiff(view.id, { preset_density: "comfortable" }, "preset-density-comfortable"),
    );
    await page.goto(`/apps/${app.appId}/views/${view.id}`);
    await expect(page.getByTestId("list-table")).toBeVisible();
    const comfortable = await read();
    expect({ ...comfortable, scopes: 0 }).toEqual(plain);

    // --- アプリ・画面を指す属性を1つも新設していない(ADR-0118 限定10)---
    expect(await page.locator("[data-app-id], [data-view-id]").count()).toBe(0);
  });
});
