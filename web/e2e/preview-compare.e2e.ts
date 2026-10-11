/**
 * **見比べの画面を chromium で開く**(`V20-M14-T04E`。計画 `docs/plan/v20/16-v20-m14-plan.md` §9-3 / §9-7 / §10-3 /
 * §10-5、ユーザ決定 `D-V20-47`〜`D-V20-54`、変更 ADR `ADR-0478`)。
 *
 * 案は E2E の中で **MCP の `dry_run_diff`(`preview` と `compare` の引数つき)** を呼んで作る(`preview-fixture.ts`。
 * 2・3案目は1案目と同じ頼んだ人を名乗る。 置き場の根は fixture-server の一時ディレクトリの隣で、終わるときに消える)。
 *
 * | # | 何を測るか |
 * |---|---|
 * | (1) | 3案の束と2案の束を未ログインで開く → 案が並ぶ(名前・3つとも別のトレードオフ・iframe)。上端に見比べの帯(期限 HH:MM)。 枠の中は1案の下見(下見の帯) |
 * | (2) | モバイル(既定)とデスクトップで、**iframe の中の計算値**(`documentElement.clientWidth` と、Tailwind の `sm:` で向きが変わるシェルの見出しの `flex-direction`)が実際に変わる。 変えたのは iframe の幅だけ(中の URL・`<style>` の数は同じ。中の `body` の書体と文字の色の計算値も同じ = 軽8) |
 * | (3) | 持ち主でログインして「この案にする」→ 確認(意図が出る)→ OK → 本物のマニフェストが変わる。 POST は1回だけで本物の `/diffs` へ。 残りの案は押せない |
 * | (4) | 本物へ別の差分を先に当てた束は、開いた時点で古い(押せない・理由が出る)。 開いた後に当てたら OK の直後に止まる。 どちらも POST 0回・本物は変わらない |
 * | (5) | 未ログインで押す → 「適用するにはログインが要ります」と本物のアプリを別のタブで開くリンク。 本物は変わらない |
 * | (6) | 束の期限切れ(置き場を消す)→ 開き直すと「この下見は期限切れです」 |
 * | (7) | 負荷の回数(`V20-M14-T05`。回数だけ。時間は測らない): 1案の下見を開く要求 N(道筋ごと)と、k 案(1〜3)の見比べの総量 = 親 2 + k·N・行の取得・OK の直後の2本 |
 * | (8) | 確認の小窓に案の変更の一覧が op の数だけ出る(`D-V20-55`。`V20-M14` 点検の処置 中3): 種類の言い方と対象の名前。 画面と項目の変更には「要確認」の印が付かない。 やめると POST 0回 |
 * | (9) | **【`V20-M15-T04E`】** 理由ありで選ぶ: 小窓に固定文・「理由(任意)」の欄・注意書き(`D-V20-63` の逐語)。 適用で本物の画面が変わり、定義に `choices` が1件(名前・トレードオフ・理由)。 `GET /changelog` が1行だけ増え、その行の op は案の op と `remember_design`。 元に戻す(`POST /undo`)1回で案の変更と選んだ記録が両方消え、本物のアプリの画面の描画も戻る |
 * | (10) | 理由なしでも選べる(空白だけの理由は送らない): `choices` の要素に `reason` のキーが無い。 変更履歴は1行 |
 * | (11) | `off_pattern` の案にだけ「このアプリの型と違う」の印(無い案には無い)。 印の付いた案もそのまま選べる |
 * | (12) | 型(`patterns`)を含む案: 小窓の一覧に「型を変える」の行と「要確認」の印。 選ぶと本物の型が置き換わり、`choices` が1件。 変更履歴は1行で op は案の2本と画面が足す1本 |
 * | (13) | 小窓で取り消すと POST 0回・変更履歴 0行・定義は1バイトも変わらない。 開き直すと理由の欄は空 |
 *
 * **撮った画面**は環境変数 `ST_E2E_SHOT_DIR` があるときだけそこへ書く(検査の合否には使わない)。
 */
import { join } from "node:path";
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Frame,
  type Page,
  test,
} from "@playwright/test";
import type { Diff } from "../../src/kernel/types.ts";
import { type FixtureApp, provisionApp } from "./fixture-app.ts";

const EXPIRED = "この下見は期限切れです";
const STALE = "案が古くなりました。AI に作り直してもらってください";

type Requester = { user_id: string; username: string };
type CompareInfo = { url: string; group: string; count: number };
type Created = { previewUrl: string; compare: CompareInfo; requester: Requester };

/** 案の差分(どれもデータを失わない op だけ。`D-V20-52`)。 */
function candidateDiffs(tag: string): { diff: Diff; name: string; tradeoff: string }[] {
  return [
    {
      name: "名前だけ変える案",
      tradeoff: "一覧の名前が短くなるが、列は今のまま",
      diff: {
        diff_id: `d-v20-m14-t04e-${tag}-a`,
        intent: "一覧の名前を短くしたい(案A)",
        operations: [{ op: "update_view", view: "item-list", changes: { name: "備品(案A)" } }],
      },
    },
    {
      name: "列を絞る案",
      tradeoff: "一覧が名前と数量だけになり見やすいが、他の列は詳細でしか見えない",
      diff: {
        diff_id: `d-v20-m14-t04e-${tag}-b`,
        intent: "一覧の列を名前と数量に絞りたい(案B)",
        operations: [
          {
            op: "update_view",
            view: "item-list",
            changes: { name: "備品(案B)", columns: ["name", "quantity"] },
          },
        ],
      },
    },
    {
      name: "置き場所を足す案",
      tradeoff: "置き場所が一覧で分かるが、入力する項目が1つ増える",
      diff: {
        diff_id: `d-v20-m14-t04e-${tag}-c`,
        intent: "備品に置き場所を持たせ、一覧で見たい(案C)",
        operations: [
          {
            op: "add_field",
            table: "items",
            field: { id: "location", name: "置き場所", type: "text" },
          },
          {
            op: "update_view",
            view: "item-list",
            changes: { name: "備品(案C)", columns: ["name", "location", "quantity"] },
          },
        ],
      },
    },
  ];
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.ST_E2E_SHOT_DIR;
  if (dir !== undefined && dir !== "") {
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  }
}

async function createCandidate(
  request: APIRequestContext,
  app: FixtureApp,
  entry: { diff: Diff; name: string; tradeoff: string; off_pattern?: boolean },
  group?: { group: string; requester: Requester },
): Promise<Created> {
  const response = await request.post(`/__e2e__/apps/${app.appId}/preview`, {
    data: {
      mode: "real",
      diff: entry.diff,
      compare: {
        name: entry.name,
        tradeoff: entry.tradeoff,
        ...(entry.off_pattern === undefined ? {} : { off_pattern: entry.off_pattern }),
        ...(group === undefined ? {} : { group: group.group }),
      },
      ...(group === undefined ? {} : { requester: group.requester }),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as {
    is_error: boolean;
    result: { preview?: { url: string }; compare?: CompareInfo; preview_refused?: unknown } | null;
    content: unknown;
    requester: Requester;
  };
  expect(body.is_error, JSON.stringify(body.content)).toBe(false);
  const preview = body.result?.preview;
  const compare = body.result?.compare;
  if (preview === undefined || compare === undefined) {
    throw new Error(`見比べの案が作られなかった: ${JSON.stringify(body.result)}`);
  }
  createdIds.push(idOf(preview.url));
  if (group === undefined) {
    createdIds.push(compare.group);
  }
  return { previewUrl: preview.url, compare, requester: body.requester };
}

type Group = {
  url: string;
  groupId: string;
  candidates: { id: string; name: string; tradeoff: string; diff: Diff }[];
};

/** `count` 案の束を作る(1案目で束ができ、2・3案目はその束へ同じ頼んだ人で足す)。 */
async function createGroup(
  request: APIRequestContext,
  app: FixtureApp,
  count: number,
  tag: string,
): Promise<Group> {
  return await createGroupOf(request, app, candidateDiffs(tag).slice(0, count));
}

/** 案の並びを渡して束を作る(`V20-M15-T04E`。`off_pattern` や型の変更を含む案を並べるため)。 */
async function createGroupOf(
  request: APIRequestContext,
  app: FixtureApp,
  entries: { diff: Diff; name: string; tradeoff: string; off_pattern?: boolean }[],
): Promise<Group> {
  const count = entries.length;
  const first = await createCandidate(request, app, entries[0] as (typeof entries)[number]);
  const created = [first];
  for (const entry of entries.slice(1)) {
    created.push(
      await createCandidate(request, app, entry, {
        group: first.compare.group,
        requester: first.requester,
      }),
    );
  }
  const last = created[created.length - 1] as Created;
  expect(last.compare.count).toBe(count);
  expect(new Set(created.map((c) => c.compare.url)).size).toBe(1);
  return {
    url: first.compare.url,
    groupId: first.compare.group,
    candidates: created.map((c, index) => {
      const entry = entries[index] as (typeof entries)[number];
      return {
        id: idOf(c.previewUrl),
        name: entry.name,
        tradeoff: entry.tradeoff,
        diff: entry.diff,
      };
    }),
  };
}

/**
 * **この検査が作った下見と束の識別子**(終わるたびに置き場を消す)。 置き場の上限20は fixture-server の
 * 全体で数えるので(`src/server/preview-store.ts` の `PREVIEW_MAX_ENTRIES`)、消さずに残すと後の検査の下見が
 * 断られる。
 */
const createdIds: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of createdIds.splice(0)) {
    const response = await request.post(`/__e2e__/previews/${id}/expire`);
    expect(response.status(), await response.text()).toBe(200);
  }
});

function idOf(url: string): string {
  const matched = /\/apps\/(pv-[0-9a-f]{32})\/$/.exec(url);
  if (matched === null) throw new Error(`下見の URL の形が違う: ${url}`);
  return matched[1] as string;
}

/** 本物のアプリの一覧の画面の名前(持ち主のセッションで読む)。 */
async function realListName(request: APIRequestContext, app: FixtureApp): Promise<unknown> {
  const response = await request.get(`/api/apps/${app.appId}/manifest`, {
    headers: app.authHeaders,
  });
  expect(response.status()).toBe(200);
  const manifest = (await response.json()) as { app: { views: { id: string; name?: string }[] } };
  return manifest.app.views.find((view) => view.id === "item-list")?.name ?? null;
}

/** 本物へ別の差分を当てる(持ち主のセッション。束の案を古くする)。 */
async function changeRealApp(request: APIRequestContext, app: FixtureApp, tag: string) {
  const response = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-v20-m14-t04e-other-${tag}`,
      intent: "入力画面の名前を変える(見比べとは別の変更)",
      operations: [
        { op: "update_view", view: "item-form", changes: { name: `備品の登録(${tag})` } },
      ],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
}

async function anonymousPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  expect(await context.cookies()).toEqual([]);
  return await context.newPage();
}

async function deadlineInBrowser(page: Page, expiresAt: string): Promise<string> {
  return await page.evaluate((iso) => {
    const at = new Date(iso);
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  }, expiresAt);
}

/** 案の iframe の中の文書(読み込み済み)。 */
async function frameOf(page: Page, candidateId: string): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes(`/apps/${candidateId}/`)))
    .toBe(true);
  const frame = page.frames().find((entry) => entry.url().includes(`/apps/${candidateId}/`));
  if (frame === undefined) throw new Error(`iframe が無い: ${candidateId}`);
  await frame.waitForSelector('[data-testid="preview-banner"]');
  return frame;
}

/** iframe の中の計算値(幅と、`sm:` で向きが変わるシェルの見出しの向き)。 */
async function innerMetrics(frame: Frame): Promise<{ width: number; header: string }> {
  return await frame.evaluate(() => {
    const header = document.querySelector("main.shell > header");
    return {
      width: document.documentElement.clientWidth,
      header: header === null ? "" : getComputedStyle(header).flexDirection,
    };
  });
}

/**
 * iframe の中の「幅で変わってはいけない」計算値(`body` の書体と文字の色)。 `V20-M14` 点検の処置 軽8 —— 幅の
 * 切り替えが枠の中の見た目を変えないことを、中の計算値で直に比べる。
 */
async function innerInvariants(frame: Frame): Promise<{ fontFamily: string; color: string }> {
  return await frame.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { fontFamily: style.fontFamily, color: style.color };
  });
}

/** 見比べの画面の `/api/` 要求を数える。 */
function countRequests(page: Page): { method: string; url: string; status?: number }[] {
  const seen: { method: string; url: string; status?: number }[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/")) seen.push({ method: req.method(), url: url.pathname });
  });
  return seen;
}

// ---------------------------------------------------------------------------

test("(1) 3案と2案の束が並ぶ(名前・別々のトレードオフ・iframe)。上端に見比べの帯", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  for (const count of [3, 2]) {
    const group = await createGroup(request, app, count, `one-${count}`);
    const page = await anonymousPage(browser);
    await page.goto(group.url);
    const cards = page.getByTestId("compare-candidate");
    await expect(cards).toHaveCount(count);
    const names = await page.getByTestId("compare-candidate-name").allTextContents();
    expect(names).toEqual(group.candidates.map((c) => c.name));
    const tradeoffs = await page.getByTestId("compare-candidate-tradeoff").allTextContents();
    expect(tradeoffs).toEqual(group.candidates.map((c) => c.tradeoff));
    expect(new Set(tradeoffs).size).toBe(count);
    const srcs = await page
      .locator('[data-testid="compare-candidate"] iframe')
      .evaluateAll((frames) => frames.map((frame) => frame.getAttribute("src")));
    expect(srcs).toEqual(group.candidates.map((c) => `/apps/${c.id}/`));

    // 上端の帯(下見の帯ではない)。
    const banner = page.getByTestId("compare-banner");
    const expiresAt = await page.evaluate(async (url) => {
      const id = /\/apps\/(pv-[0-9a-f]{32})\//.exec(url)?.[1];
      const res = await fetch(`/api/apps/${id}/compare`);
      return ((await res.json()) as { compare: { expires_at: string } }).compare.expires_at;
    }, group.url);
    const hhmm = await deadlineInBrowser(page, expiresAt);
    await expect(banner).toHaveText(
      `見比べ(適用前)。選んで確認するとアプリに反映されます。期限 ${hhmm}`,
    );
    expect(
      await page.evaluate(() =>
        document.querySelector("main.shell")?.firstElementChild?.getAttribute("data-testid"),
      ),
    ).toBe("compare-banner");
    await expect(page.getByTestId("preview-banner")).toHaveCount(0);

    // 枠の中は1案の下見そのまま(下見の帯と、その案の画面)。
    for (const candidate of group.candidates) {
      const frame = await frameOf(page, candidate.id);
      await expect(frame.getByTestId("preview-banner")).toContainText("下見(適用前)");
    }
    await shot(page, `compare-${count}`);
    await page.context().close();
  }
});

test("(2) モバイルとデスクトップで iframe の中の計算値が変わる(変えたのは iframe の幅だけ)", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const group = await createGroup(request, app, 2, "width");
  const page = await anonymousPage(browser);
  await page.goto(group.url);
  await expect(page.getByTestId("compare-candidate")).toHaveCount(2);
  const mobile = page.getByRole("button", { name: "モバイル(390px)" });
  const desktop = page.getByRole("button", { name: "デスクトップ(1280px)" });
  await expect(mobile).toHaveAttribute("aria-pressed", "true");

  const ids = group.candidates.map((c) => c.id);
  const before = [];
  const invariantsBefore = [];
  for (const id of ids) {
    const frame = await frameOf(page, id);
    before.push(await innerMetrics(frame));
    invariantsBefore.push(await innerInvariants(frame));
  }
  expect(invariantsBefore.every((value) => value.fontFamily !== "" && value.color !== "")).toBe(
    true,
  );
  // モバイル: 幅 390 で、`sm`(40rem)未満なのでシェルの見出しは縦積み。
  expect(before).toEqual([
    { width: 390, header: "column" },
    { width: 390, header: "column" },
  ]);
  const stylesBefore = await page.evaluate(() => document.querySelectorAll("style").length);
  const srcBefore = await page
    .locator('[data-testid="compare-candidate"] iframe')
    .evaluateAll((frames) => frames.map((frame) => frame.getAttribute("src")));
  await shot(page, "compare-width-mobile");

  await desktop.click();
  await expect(desktop).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => {
      const values = [];
      for (const id of ids) values.push(await innerMetrics(await frameOf(page, id)));
      return values;
    })
    .toEqual([
      { width: 1280, header: "row" },
      { width: 1280, header: "row" },
    ]);
  // 変えたのは iframe の幅だけ(中の URL と、見比べの画面の <style> の数は同じ)。
  expect(
    await page
      .locator('[data-testid="compare-candidate"] iframe')
      .evaluateAll((frames) => frames.map((frame) => frame.getAttribute("src"))),
  ).toEqual(srcBefore);
  expect(await page.evaluate(() => document.querySelectorAll("style").length)).toBe(stylesBefore);
  // 中の「幅で変わってはいけない」計算値(書体と文字の色)は 390 と 1280 で同じ(軽8)。
  const invariantsAfter = [];
  for (const id of ids) invariantsAfter.push(await innerInvariants(await frameOf(page, id)));
  expect(invariantsAfter).toEqual(invariantsBefore);
  // 収まらないので縮めている(外側の箱の高さも同じ比)。
  const box = await page.getByTestId("compare-frame-box").first().boundingBox();
  const shown = await page
    .locator('[data-testid="compare-candidate"] iframe')
    .first()
    .boundingBox();
  expect(box).not.toBeNull();
  expect(shown).not.toBeNull();
  expect((shown?.width ?? 0) < 1280).toBe(true);
  expect(Math.abs((box?.height ?? 0) - (shown?.height ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((box?.width ?? 0) - (shown?.width ?? 0))).toBeLessThanOrEqual(2);
  await shot(page, "compare-width-desktop");

  // 戻すと中も戻る。
  await mobile.click();
  await expect
    .poll(async () => (await innerMetrics(await frameOf(page, ids[0] as string))).width)
    .toBe(390);
  await page.context().close();
});

test("(3) 持ち主でログインして選ぶ → 確認 → 適用で本物が変わる。POST は1回で、残りの案は押せない", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const group = await createGroup(request, app, 3, "apply");
  const chosen = group.candidates[1] as Group["candidates"][number];
  const before = await realListName(request, app);
  expect(before).not.toBe("備品(案B)");

  const context = await browser.newContext();
  await app.authenticate(context);
  const page = await context.newPage();
  const seen = countRequests(page);
  await page.goto(group.url);
  await expect(page.getByTestId("compare-candidate")).toHaveCount(3);

  await page.getByTestId("compare-choose").nth(1).click();
  const dialog = page.getByTestId("compare-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(chosen.name);
  await expect(dialog).toContainText(chosen.tradeoff);
  await expect(dialog).toContainText("一覧の列を名前と数量に絞りたい(案B)");
  // 確認の段では送っていない。
  expect(seen.filter((r) => r.method === "POST")).toEqual([]);
  await shot(page, "compare-confirm");
  await dialog.getByTestId("compare-confirm-ok").click();

  const result = page.getByTestId("compare-result");
  await expect(result).toContainText("適用しました");
  await expect(result.getByRole("link")).toHaveAttribute("href", `/apps/${app.appId}/`);
  expect(await realListName(request, app)).toBe("備品(案B)");
  const posts = seen.filter((r) => r.method === "POST");
  expect(posts).toEqual([{ method: "POST", url: `/api/apps/${app.appId}/diffs` }]);
  // OK の直後にも /compare を引いている(開いた時点と合わせて2回)。
  expect(
    seen.filter((r) => r.method === "GET" && r.url === `/api/apps/${group.groupId}/compare`).length,
  ).toBe(2);
  // 残りの案は押せない。
  for (let index = 0; index < 3; index += 1) {
    await expect(page.getByTestId("compare-choose").nth(index)).toBeDisabled();
  }
  await shot(page, "compare-applied");
  await context.close();
});

test("(4) 本物へ別の差分を当てた案は古い: 開いた時点なら押せない / OK の直後なら止まる。POST 0回", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const context = await browser.newContext();
  await app.authenticate(context);

  // 開いた時点で古い。
  const stale = await createGroup(request, app, 2, "stale-open");
  await changeRealApp(request, app, "open");
  const nameAfterOther = await realListName(request, app);
  const page = await context.newPage();
  const seen = countRequests(page);
  await page.goto(stale.url);
  await expect(page.getByTestId("compare-candidate")).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await expect(page.getByTestId("compare-choose").nth(index)).toBeDisabled();
  }
  await expect(page.getByTestId("compare-candidate-stale")).toHaveText([STALE, STALE]);
  await page.getByTestId("compare-choose").first().click({ force: true });
  await expect(page.getByTestId("compare-confirm")).toHaveCount(0);
  expect(seen.filter((r) => r.method === "POST")).toEqual([]);
  expect(await realListName(request, app)).toBe(nameAfterOther);
  await shot(page, "compare-stale-open");
  await page.close();

  // 開いた後で古くなる(OK の直後の /compare で止まる)。
  const later = await createGroup(request, app, 2, "stale-later");
  const page2 = await context.newPage();
  const seen2 = countRequests(page2);
  await page2.goto(later.url);
  await expect(page2.getByTestId("compare-choose").first()).toBeEnabled();
  await changeRealApp(request, app, "later");
  await page2.getByTestId("compare-choose").first().click();
  await page2.getByTestId("compare-confirm-ok").click();
  await expect(page2.getByTestId("compare-result")).toContainText(STALE);
  await expect(page2.getByTestId("compare-choose").first()).toBeDisabled();
  expect(seen2.filter((r) => r.method === "POST")).toEqual([]);
  expect(await realListName(request, app)).toBe(nameAfterOther);
  await shot(page2, "compare-stale-after-ok");
  await context.close();
});

test("(5) 未ログインで押すと「適用するにはログインが要ります」と、本物を別のタブで開くリンク", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const group = await createGroup(request, app, 2, "anon");
  const before = await realListName(request, app);
  const page = await anonymousPage(browser);
  const statuses: { url: string; status: number }[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith("/diffs"))
      statuses.push({ url: url.pathname, status: response.status() });
  });
  await page.goto(group.url);
  await page.getByTestId("compare-choose").first().click();
  await page.getByTestId("compare-confirm-ok").click();
  const result = page.getByTestId("compare-result");
  await expect(result).toContainText("適用するにはログインが要ります");
  const link = result.getByRole("link");
  await expect(link).toHaveAttribute("href", `/apps/${app.appId}/`);
  await expect(link).toHaveAttribute("target", "_blank");
  expect(statuses).toEqual([{ url: `/api/apps/${app.appId}/diffs`, status: 401 }]);
  // ログイン画面に落ちない・本物は変わらない・押し直せる。
  await expect(page.getByTestId("login-page")).toHaveCount(0);
  expect(await realListName(request, app)).toBe(before);
  await expect(page.getByTestId("compare-choose").first()).toBeEnabled();
  await shot(page, "compare-login-required");
  await page.context().close();
});

test("(6) 束の期限切れ(置き場を消す)の後は「この下見は期限切れです」", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const group = await createGroup(request, app, 2, "expire");
  const page = await anonymousPage(browser);
  await page.goto(group.url);
  await expect(page.getByTestId("compare-candidate")).toHaveCount(2);
  const expire = await request.post(`/__e2e__/previews/${group.groupId}/expire`);
  expect(expire.status(), await expire.text()).toBe(200);
  await page.goto(group.url);
  await expect(page.getByTestId("preview-expired")).toContainText(EXPIRED);
  await expect(page.getByTestId("compare-candidate")).toHaveCount(0);
  await expect(page.getByTestId("compare-banner")).toHaveCount(0);
  await expect(page.getByTestId("login-page")).toHaveCount(0);
  await page.context().close();
});

test("(8) 確認の小窓に案の変更の一覧が op の数だけ出る(種類の言い方と対象の名前・画面と項目には印なし)", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const group = await createGroup(request, app, 3, "ops");
  const page = await anonymousPage(browser);
  const seen = countRequests(page);
  await page.goto(group.url);
  await expect(page.getByTestId("compare-candidate")).toHaveCount(3);
  // 案C = add_field + update_view の2 op。
  await page.getByTestId("compare-choose").nth(2).click();
  const dialog = page.getByTestId("compare-confirm");
  await expect(dialog).toBeVisible();
  const rows = dialog.getByTestId("compare-confirm-operation");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-op", "add_field");
  await expect(rows.nth(0)).toContainText("項目を足す: items の 置き場所(location)");
  await expect(rows.nth(1)).toHaveAttribute("data-op", "update_view");
  await expect(rows.nth(1)).toContainText("画面を変える: item-list");
  await expect(dialog.getByTestId("compare-confirm-operations")).toContainText(
    "この案が行う変更 2件",
  );
  await expect(dialog.getByTestId("compare-confirm-operation-flag")).toHaveCount(0);
  await shot(page, "compare-confirm-operations");
  await dialog.getByTestId("compare-confirm-cancel").click();
  await expect(page.getByTestId("compare-confirm")).toHaveCount(0);
  expect(seen.filter((r) => r.method === "POST")).toEqual([]);
  await page.context().close();
});

// ---------------------------------------------------------------------------
// (7) 負荷の回数(`V20-M14-T05`。計画 §3 T05 / §10-5。**回数だけを数える。時間は測らない**)
// ---------------------------------------------------------------------------

/**
 * 見比べの画面と、その中の iframe(1案の下見)が出す `/api/` 要求を、**出した枠ごとに**集める。
 * 識別子は道筋の中で `<束>` / `<案>` / `<本物>` に置き換える(道筋ごとの内訳を案の数に依らず比べるため)。
 * **数える要求は2種**(計画 §10-5): 「API 要求の全部(道筋ごと)」と「行の取得だけ」(`rowFetches`)。
 * 応答の状態は数えるためではなく記録のために添える。
 */
type LoadRequest = { frame: string; method: string; route: string; status?: number };

function loadRecorder(
  page: Page,
  names: { group?: string; candidates: string[]; real: string },
): LoadRequest[] {
  const seen: LoadRequest[] = [];
  const entries = new Map<object, LoadRequest>();
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return;
    let route = url.pathname;
    if (names.group !== undefined) route = route.split(names.group).join("<束>");
    for (const id of names.candidates) route = route.split(id).join("<案>");
    route = route.split(names.real).join("<本物>");
    const frame = req.frame();
    const frameName =
      frame === page.mainFrame()
        ? "parent"
        : (names.candidates.find((id) => frame.url().includes(`/apps/${id}/`)) ?? frame.url());
    const entry: LoadRequest = { frame: frameName, method: req.method(), route };
    entries.set(req, entry);
    seen.push(entry);
  });
  page.on("response", (response) => {
    const entry = entries.get(response.request());
    if (entry !== undefined) entry.status = response.status();
  });
  return seen;
}

/** 道筋ごとの内訳(`"GET /api/apps/<案>/manifest" → 1` の形。キーの順は辞書順)。 */
function breakdown(requests: LoadRequest[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const request of requests) {
    const key = `${request.method} ${request.route}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** 応答の状態つきの内訳(記録用)。 */
function statuses(requests: LoadRequest[]): string[] {
  return requests.map((r) => `${r.method} ${r.route} ${r.status ?? "-"}`).sort();
}

/** 行の取得(`GET .../tables/<表>/records`)だけ。 */
function rowFetches(requests: LoadRequest[]): LoadRequest[] {
  return requests.filter(
    (request) => request.method === "GET" && /\/tables\/[^/]+\/records$/.test(request.route),
  );
}

/** 要求の数が落ち着くまで待つ(1秒おきに数えて、同じ数が3回続いたら落ち着いたとみなす)。 */
async function settle(seen: LoadRequest[]): Promise<void> {
  let last = -1;
  let same = 0;
  for (let round = 0; round < 30 && same < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (seen.length === last) same += 1;
    else {
      same = 0;
      last = seen.length;
    }
  }
  expect(same, "要求の数が30秒のうちに落ち着かなかった").toBe(3);
}

/**
 * **実測で決まった値**(記録 `docs/plan/v20/records/v20-m14-t05.md` に書く数はこの検査の出力である)。
 * - 1案の下見(アプリの入口 `/apps/pv-<案>/`。iframe の `src` と同じ)を開く要求 N = 4 = アプリの一覧 1 +
 *   `/compare`(404)1 + `/auth/me` 1 + `/manifest` 1。 **行の取得は 0**(入口は一覧の画面を開かない)。
 * - 見比べの親の頁は2本 = `/compare`(200)1 + アプリの一覧 1(殻のアプリの切り替え)。
 * - k 案の見比べの総量 = 親 2 + k·N。 **計画の式「親の `/compare` 1 + k·N」より、親のアプリの一覧の1本だけ多い。**
 */
const N_SINGLE = 4;
const PARENT = { "GET /api/apps": 1, "GET /api/apps/<束>/compare": 1 };

test("(7) 負荷の回数: 1案の下見を開く回数 N と、k 案の見比べ(k=1,2,3)の総量 = 親 2 + k·N(回数だけ。時間は測らない)", async ({
  browser,
  request,
}) => {
  // --- 束を何度も作って枠を全部読み込む重い検査。遅い CI 台では既定30秒を超えることがある(実 CI run 36227291804)。
  test.setTimeout(120_000);
  const app = await provisionApp(request);
  const log = (text: string) => console.log(`T05 ${text}`);

  // --- N: 1案の下見を、見比べの外で(トップの頁として)開く。 入口(iframe と同じ URL)と、一覧の画面(参考)。
  const single = await createGroup(request, app, 1, "load-n");
  const singleId = (single.candidates[0] as Group["candidates"][number]).id;
  const nBreakdowns: Record<string, Record<string, number>> = {};
  for (const path of [`/apps/${singleId}/`, `/apps/${singleId}/views/item-list`]) {
    const singlePage = await anonymousPage(browser);
    const singleSeen = loadRecorder(singlePage, { candidates: [singleId], real: app.appId });
    await singlePage.goto(path);
    await singlePage.waitForSelector('[data-testid="preview-banner"]');
    await settle(singleSeen);
    nBreakdowns[path] = breakdown(singleSeen);
    log(
      `single path=${path.split(singleId).join("<案>")} N=${singleSeen.length} rows=${rowFetches(singleSeen).length} ${JSON.stringify(statuses(singleSeen))}`,
    );
    await singlePage.context().close();
  }
  const nBreakdown = nBreakdowns[`/apps/${singleId}/`] as Record<string, number>;
  expect(nBreakdown).toEqual({
    "GET /api/apps": 1,
    "GET /api/apps/<案>/auth/me": 1,
    "GET /api/apps/<案>/compare": 1,
    "GET /api/apps/<案>/manifest": 1,
  });
  const n = Object.values(nBreakdown).reduce((a, b) => a + b, 0);
  expect(n).toBe(N_SINGLE);
  // 参考: 一覧の画面を開いた1案の下見は、入口の N に行の取得が1本足される。
  expect(nBreakdowns[`/apps/${singleId}/views/item-list`]).toEqual({
    ...nBreakdown,
    "GET /api/apps/<案>/tables/items/records": 1,
  });

  // --- k 案の見比べ。
  for (const k of [1, 2, 3]) {
    const group = await createGroup(request, app, k, `load-${k}`);
    const ids = group.candidates.map((c) => c.id);
    const page = await anonymousPage(browser);
    const seen = loadRecorder(page, { group: group.groupId, candidates: ids, real: app.appId });
    await page.goto(group.url);
    await expect(page.getByTestId("compare-candidate")).toHaveCount(k);
    for (const id of ids) await frameOf(page, id);
    await settle(seen);
    const parent = seen.filter((r) => r.frame === "parent");
    const perFrame = ids.map((id) => seen.filter((r) => r.frame === id));
    const stray = seen.filter((r) => r.frame !== "parent" && !ids.includes(r.frame));
    log(
      `k=${k} total=${seen.length} increment_over_N=${seen.length - n} rows=${rowFetches(seen).length} parent=${JSON.stringify(statuses(parent))} frames=${JSON.stringify(perFrame.map((f) => f.length))} frame0=${JSON.stringify(statuses(perFrame[0] ?? []))}`,
    );
    expect(stray).toEqual([]);
    expect(breakdown(parent)).toEqual(PARENT);
    for (const frame of perFrame) expect(breakdown(frame)).toEqual(nBreakdown);
    expect(seen.length).toBe(2 + k * n);
    expect(seen.length).toBe(2 + k * N_SINGLE);
    expect(rowFetches(seen).length).toBe(0);
    await page.context().close();
  }

  // --- OK の直後の /compare(別に数える)。持ち主でログインして2案の束から1案を適用する。
  const group = await createGroup(request, app, 2, "load-ok");
  const ids = group.candidates.map((c) => c.id);
  const context = await browser.newContext();
  await app.authenticate(context);
  const page = await context.newPage();
  const seen = loadRecorder(page, { group: group.groupId, candidates: ids, real: app.appId });
  await page.goto(group.url);
  await expect(page.getByTestId("compare-candidate")).toHaveCount(2);
  for (const id of ids) await frameOf(page, id);
  await settle(seen);
  const opened = seen.length;
  await page.getByTestId("compare-choose").first().click();
  await page.getByTestId("compare-confirm-ok").click();
  await expect(page.getByTestId("compare-result")).toContainText("適用しました");
  await settle(seen);
  const afterOk = seen.slice(opened);
  log(`logged-in k=2 opened=${opened} afterOk=${JSON.stringify(statuses(afterOk))}`);
  expect(opened).toBe(2 + 2 * N_SINGLE);
  expect(breakdown(afterOk)).toEqual({
    "GET /api/apps/<束>/compare": 1,
    "POST /api/apps/<本物>/diffs": 1,
  });
  expect(afterOk.every((r) => r.frame === "parent")).toBe(true);
  await context.close();
});

// ---------------------------------------------------------------------------
// (9)〜(13) 選んだ記録と型(`V20-M15-T04E`。計画 `docs/plan/v20/17-v20-m15-plan.md` §9-4 の 8・§10-5 の軽20・
// §10-6 の `T04E` の行。設計の正 `ADR-0479`。決定 `D-V20-56` / `D-V20-57` / `D-V20-59` / `D-V20-63` / `D-V20-64`)
// ---------------------------------------------------------------------------

/** 固定文(`ADR-0479` §Decision 4-6)と注意書き(`D-V20-63`)の逐語。 **画面の定数を読まずに綴りで固定する。** */
const CHOICE_NOTE =
  "この案の名前とトレードオフを、このアプリの選んだ記録に残します(最新20件まで)。";
const REASON_NOTICE = "ここに書いた文は、このアプリにログインできる人なら誰でも読めます";
const OFF_PATTERN = "このアプリの型と違う";

type DesignMemory = {
  choices?: { name: string; tradeoff: string; reason?: string }[];
  patterns?: string[];
};
type RealApp = {
  views: { id: string; name?: string; columns?: string[] }[];
  design_memory?: DesignMemory;
};
type ChangelogRow = {
  kind: string;
  diff_id: string;
  operations: { op: string; [key: string]: unknown }[];
};

/** 本物のアプリの定義(持ち主のセッションで `GET /manifest`)。 */
async function realApp(request: APIRequestContext, app: FixtureApp): Promise<RealApp> {
  const response = await request.get(`/api/apps/${app.appId}/manifest`, {
    headers: app.authHeaders,
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { app: RealApp }).app;
}

/** 本物の変更履歴(`GET /changelog`。ログインが要る)。 */
async function changelogOf(request: APIRequestContext, app: FixtureApp): Promise<ChangelogRow[]> {
  const response = await request.get(`/api/apps/${app.appId}/changelog`, {
    headers: app.authHeaders,
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { changelog: ChangelogRow[] }).changelog;
}

/** 本物に型を書く(通常の差分 `remember_design` の `patterns`。`D-V20-58`)。 */
async function writePatterns(
  request: APIRequestContext,
  app: FixtureApp,
  patterns: string[],
  tag: string,
): Promise<void> {
  const response = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `d-v20-m15-t04e-patterns-${tag}`,
      intent: "このアプリの型を書く",
      operations: [{ op: "remember_design", design_memory: { patterns } }],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
}

/** 持ち主でログインした見比べの画面を開く。 */
async function openAsOwner(browser: Browser, app: FixtureApp, url: string, count: number) {
  const context = await browser.newContext();
  await app.authenticate(context);
  const page = await context.newPage();
  const seen = countRequests(page);
  await page.goto(url);
  await expect(page.getByTestId("compare-candidate")).toHaveCount(count);
  return { context, page, seen };
}

/** 本物のアプリの画面の一覧に出る画面の名前(ブラウザで描いたもの)。 */
async function renderedViewNames(page: Page, app: FixtureApp): Promise<string> {
  await page.goto(`/apps/${app.appId}/`);
  const nav = page.getByTestId("view-list");
  await expect(nav).toBeVisible();
  return (await nav.textContent()) ?? "";
}

test("(9) 理由ありで選ぶ → 定義に choices が1件・変更履歴が1行(案の op と remember_design)・元に戻すで両方消え、画面も戻る", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const app = await provisionApp(request);
  const group = await createGroup(request, app, 2, "reason");
  const chosen = group.candidates[1] as Group["candidates"][number];
  const before = await realApp(request, app);
  expect(before.design_memory).toBeUndefined();
  const rowsBefore = await changelogOf(request, app);

  const { context, page, seen } = await openAsOwner(browser, app, group.url, 2);
  await page.getByTestId("compare-choose").nth(1).click();
  const dialog = page.getByTestId("compare-confirm");
  await expect(dialog).toBeVisible();
  // 固定文 → 理由の欄 → 注意書き(逐語)。
  await expect(dialog.getByTestId("compare-confirm-choice-note")).toHaveText(CHOICE_NOTE);
  const reasonBox = dialog.getByLabel("理由(任意)");
  await expect(reasonBox).toHaveAttribute("data-testid", "compare-confirm-reason");
  await expect(reasonBox).toHaveValue("");
  await expect(dialog.getByTestId("compare-confirm-reason-notice")).toHaveText(REASON_NOTICE);
  const order = await dialog.evaluate((root) =>
    ["compare-confirm-choice-note", "compare-confirm-reason", "compare-confirm-reason-notice"].map(
      (id) =>
        Array.from(root.querySelectorAll("[data-testid]")).findIndex(
          (element) => element.getAttribute("data-testid") === id,
        ),
    ),
  );
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // 画面が足す選んだ記録は変更の一覧に混ぜない(案の op は1本)。
  await expect(dialog.getByTestId("compare-confirm-operation")).toHaveCount(1);
  await reasonBox.fill("  一覧は名前と数量だけで足りるから  ");
  await shot(page, "compare-choose-reason");
  await dialog.getByTestId("compare-confirm-ok").click();
  await expect(page.getByTestId("compare-result")).toContainText("適用しました");
  await expect(page.getByTestId("compare-confirm")).toHaveCount(0);
  expect(seen.filter((r) => r.method === "POST")).toEqual([
    { method: "POST", url: `/api/apps/${app.appId}/diffs` },
  ]);

  // 本物: 案の変更と、選んだ記録1件(名前・トレードオフ・理由。理由は前後の空白を落とす)。
  const after = await realApp(request, app);
  expect(after.views.find((view) => view.id === "item-list")?.name).toBe("備品(案B)");
  expect(after.design_memory).toEqual({
    choices: [
      { name: chosen.name, tradeoff: chosen.tradeoff, reason: "一覧は名前と数量だけで足りるから" },
    ],
  });
  // 変更履歴は1行だけ増え、その行の op は案の op と remember_design(軽20)。
  const rowsAfter = await changelogOf(request, app);
  expect(rowsAfter.length).toBe(rowsBefore.length + 1);
  const row = rowsAfter[rowsAfter.length - 1] as ChangelogRow;
  expect(row.kind).toBe("apply");
  expect(row.diff_id).toBe(chosen.diff.diff_id);
  expect(row.operations.map((operation) => operation.op)).toEqual([
    "update_view",
    "remember_design",
  ]);
  expect(row.operations[1]).toEqual({
    op: "remember_design",
    design_memory: {
      choice: {
        name: chosen.name,
        tradeoff: chosen.tradeoff,
        reason: "一覧は名前と数量だけで足りるから",
      },
    },
  });
  // 本物のアプリの画面にも案の変更が描かれる。
  expect(await renderedViewNames(page, app)).toContain("備品(案B)");

  // 元に戻す(`POST /undo`。**`AppWorkspace.tsx` に元に戻すの画面操作は無い** —— 記録 §2 の注)。
  const undone = await request.post(`/api/apps/${app.appId}/undo`, { headers: app.authHeaders });
  expect(undone.status(), await undone.text()).toBe(200);
  const reverted = await realApp(request, app);
  expect(reverted.design_memory).toBeUndefined();
  expect(reverted.views).toEqual(before.views);
  const rowsUndone = await changelogOf(request, app);
  expect(rowsUndone.map((entry) => entry.kind).slice(-2)).toEqual(["apply", "undo"]);
  // 本物のアプリの画面の描画も戻る(リロードで案の名前が消える)。
  const names = await renderedViewNames(page, app);
  expect(names).not.toContain("備品(案B)");
  expect(names).toContain("item-list");
  await shot(page, "compare-choose-undone");
  await context.close();
});

test("(10) 理由なしでも選べる(空白だけの理由は送らない): choices の要素に reason が無い・変更履歴は1行", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const group = await createGroup(request, app, 2, "no-reason");
  const chosen = group.candidates[0] as Group["candidates"][number];
  const rowsBefore = await changelogOf(request, app);
  const { context, page, seen } = await openAsOwner(browser, app, group.url, 2);
  await page.getByTestId("compare-choose").first().click();
  const dialog = page.getByTestId("compare-confirm");
  await dialog.getByTestId("compare-confirm-reason").fill(" 　 ");
  await dialog.getByTestId("compare-confirm-ok").click();
  await expect(page.getByTestId("compare-result")).toContainText("適用しました");
  expect(seen.filter((r) => r.method === "POST").length).toBe(1);

  const after = await realApp(request, app);
  expect(after.design_memory).toEqual({
    choices: [{ name: chosen.name, tradeoff: chosen.tradeoff }],
  });
  expect(Object.keys(after.design_memory?.choices?.[0] ?? {})).toEqual(["name", "tradeoff"]);
  const rowsAfter = await changelogOf(request, app);
  expect(rowsAfter.length).toBe(rowsBefore.length + 1);
  const row = rowsAfter[rowsAfter.length - 1] as ChangelogRow;
  expect(row.operations.map((operation) => operation.op)).toEqual([
    "update_view",
    "remember_design",
  ]);
  expect(row.operations[1]).toEqual({
    op: "remember_design",
    design_memory: { choice: { name: chosen.name, tradeoff: chosen.tradeoff } },
  });
  await context.close();
});

test("(11) off_pattern の案にだけ「このアプリの型と違う」の印。印の付いた案もそのまま選べる", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  await writePatterns(request, app, ["一覧の列は4つまで"], "off");
  const [a, b] = candidateDiffs("off") as [
    ReturnType<typeof candidateDiffs>[number],
    ReturnType<typeof candidateDiffs>[number],
  ];
  const group = await createGroupOf(request, app, [{ ...a, off_pattern: true }, b]);
  const { context, page, seen } = await openAsOwner(browser, app, group.url, 2);
  const cards = page.getByTestId("compare-candidate");
  await expect(page.getByTestId("compare-candidate-off-pattern")).toHaveCount(1);
  await expect(cards.nth(0).getByTestId("compare-candidate-off-pattern")).toHaveText(OFF_PATTERN);
  await expect(cards.nth(1).getByTestId("compare-candidate-off-pattern")).toHaveCount(0);
  await expect(cards.nth(1)).not.toContainText(OFF_PATTERN);
  await shot(page, "compare-off-pattern");

  // 印の付いた案を選ぶ。
  await expect(page.getByTestId("compare-choose").first()).toBeEnabled();
  await page.getByTestId("compare-choose").first().click();
  await page.getByTestId("compare-confirm-ok").click();
  await expect(page.getByTestId("compare-result")).toContainText("適用しました");
  expect(seen.filter((r) => r.method === "POST").length).toBe(1);
  const after = await realApp(request, app);
  expect(after.views.find((view) => view.id === "item-list")?.name).toBe("備品(案A)");
  // 型は選んだだけでは変わらない。 選んだ記録は印の付いた案。
  expect(after.design_memory).toEqual({
    choices: [{ name: a.name, tradeoff: a.tradeoff }],
    patterns: ["一覧の列は4つまで"],
  });
  await context.close();
});

test("(12) 型を含む案: 小窓に「型を変える」と「要確認」。選ぶと本物の型が置き換わり、変更履歴は1行", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  await writePatterns(request, app, ["一覧の列は4つまで"], "change");
  const [, b] = candidateDiffs("pattern") as [
    ReturnType<typeof candidateDiffs>[number],
    ReturnType<typeof candidateDiffs>[number],
  ];
  const newPatterns = ["一覧の列は名前と数量だけ", "入力フォームは1カラム"];
  const withPatterns = {
    name: "型ごと変える案",
    tradeoff: "一覧が名前と数量だけになり、この先の案もその型に揃う",
    diff: {
      diff_id: "d-v20-m15-t04e-pattern-p",
      intent: "一覧の列を絞り、このアプリの型も変えたい(案P)",
      operations: [
        {
          op: "update_view",
          view: "item-list",
          changes: { name: "備品(案P)", columns: ["name", "quantity"] },
        },
        { op: "remember_design", design_memory: { patterns: newPatterns } },
      ],
    } as Diff,
  };
  const group = await createGroupOf(request, app, [b, withPatterns]);
  const rowsBefore = await changelogOf(request, app);
  const { context, page, seen } = await openAsOwner(browser, app, group.url, 2);

  // 型を含まない案には「型を変える」も印も無い(陰性)。
  await page.getByTestId("compare-choose").nth(0).click();
  let dialog = page.getByTestId("compare-confirm");
  await expect(dialog.getByTestId("compare-confirm-operation")).toHaveCount(1);
  await expect(dialog).not.toContainText("型を変える");
  await expect(dialog.getByTestId("compare-confirm-operation-flag")).toHaveCount(0);
  await dialog.getByTestId("compare-confirm-cancel").click();

  await page.getByTestId("compare-choose").nth(1).click();
  dialog = page.getByTestId("compare-confirm");
  const rows = dialog.getByTestId("compare-confirm-operation");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-op", "update_view");
  await expect(rows.nth(1)).toHaveAttribute("data-op", "remember_design");
  await expect(rows.nth(1)).toContainText("型を変える: 型 2 件");
  await expect(rows.nth(1).getByTestId("compare-confirm-operation-flag")).toHaveText("要確認");
  await expect(dialog.getByTestId("compare-confirm-operation-flag")).toHaveCount(1);
  // 型の文そのものは小窓に出さない(件数だけ)。
  for (const pattern of newPatterns) await expect(dialog).not.toContainText(pattern);
  await shot(page, "compare-confirm-patterns");
  await dialog.getByTestId("compare-confirm-reason").fill("型ごと揃えたい");
  await dialog.getByTestId("compare-confirm-ok").click();
  await expect(page.getByTestId("compare-result")).toContainText("適用しました");
  expect(seen.filter((r) => r.method === "POST").length).toBe(1);

  const after = await realApp(request, app);
  expect(after.design_memory).toEqual({
    choices: [
      { name: withPatterns.name, tradeoff: withPatterns.tradeoff, reason: "型ごと揃えたい" },
    ],
    patterns: newPatterns,
  });
  const rowsAfter = await changelogOf(request, app);
  expect(rowsAfter.length).toBe(rowsBefore.length + 1);
  const row = rowsAfter[rowsAfter.length - 1] as ChangelogRow;
  expect(row.operations.map((operation) => operation.op)).toEqual([
    "update_view",
    "remember_design",
    "remember_design",
  ]);
  await context.close();
});

test("(13) 小窓で取り消すと POST 0回・変更履歴 0行・定義は変わらない。開き直すと理由は空", async ({
  browser,
  request,
}) => {
  const app = await provisionApp(request);
  const group = await createGroup(request, app, 2, "cancel");
  const before = await realApp(request, app);
  const rowsBefore = await changelogOf(request, app);
  const { context, page, seen } = await openAsOwner(browser, app, group.url, 2);
  await page.getByTestId("compare-choose").nth(1).click();
  const dialog = page.getByTestId("compare-confirm");
  await dialog.getByTestId("compare-confirm-reason").fill("やっぱりやめる理由");
  await dialog.getByTestId("compare-confirm-cancel").click();
  await expect(page.getByTestId("compare-confirm")).toHaveCount(0);
  await page.getByTestId("compare-choose").nth(1).click();
  await expect(page.getByTestId("compare-confirm-reason")).toHaveValue("");
  await page.getByTestId("compare-confirm-cancel").click();
  await expect(page.getByTestId("compare-confirm")).toHaveCount(0);

  expect(seen.filter((r) => r.method === "POST")).toEqual([]);
  expect(await changelogOf(request, app)).toEqual(rowsBefore);
  expect(await realApp(request, app)).toEqual(before);
  await expect(page.getByTestId("compare-choose").first()).toBeEnabled();
  await context.close();
});
