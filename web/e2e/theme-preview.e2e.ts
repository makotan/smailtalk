/**
 * 実物プレビュー選択が**実際のブラウザで働くこと**の chromium 実測(V3-M4-T01 / D-G7)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m4.md` §2 の「V3-M4-T01」節、判定の正は
 * `docs/plan/v3/records/v3-m4-gate-a-intake.md` §3 と台帳 §8 の 2026-07-26 の D-G7 の行
 * (**門 = 外(Δ7)/ 判定 = 将来送り / 送り先 = 本タスク**)。
 *
 * ## ファイル名について(計画との差)
 *
 * 計画 §2 の主対象欄は `web/e2e/theme-preview.spec.ts` と書いているが、**本ファイルは
 * `.e2e.ts` である。** `web/e2e/playwright.config.ts` の冒頭が
 * 「`bun test` と混ざらないよう、テストファイルの拡張子は `.e2e.ts` にしてある
 *  (bun のテスト検出は `*.test.*` / `*.spec.*` を拾うため、`.spec.ts` は使わない)」
 * と明記しており、`testMatch` も `.e2e.ts` で終わるファイルだけを拾う形になっている。
 * **`.spec.ts` で置くと `bun test` が拾って playwright の import で落ちる。**
 * 既存の命名規則に合わせた(この差は実施記録の「計画への申し送り」に書いた)。
 *
 * ## なぜ要るか
 *
 * `web/test/theme-preview.test.tsx` は happy-dom 上の検査で、**CSS のカスケードも継承も
 * 解かない。** 「並べて見比べられる」と言うためには、**枠ごとに違う計算値が出ること**を
 * 本物のブラウザで1度確かめる必要がある(`web/e2e/theme.e2e.ts` と同じ理由)。
 *
 * ## 何を測るか
 *
 * 1. **候補が同時に並び、枠ごとに計算値が違う**(完了条件1 / D-M4-3)。切替式ではないので、
 *    どれか1枚を選ぶ操作をせずに全部が見える。
 * 2. **枠の中身は当該アプリの実データである**(完了条件1 の「実物」の条件)——
 *    先に作ったレコードの値が、枠の数だけ見える。
 * 3. **選ぶと既存の `apply_diff` 経路で適用され、リロードだけで反映される**(完了条件4)。
 * 4. **`_changelog` に web が自動生成した `intent` がそのまま載る**(完了条件12)。
 * 5. **`POST /undo` で元に戻る**(完了条件4)。
 * 6. **入口は owner 限定である**(完了条件11)。
 *
 * ## 何を測らないか(誇張しない)
 *
 * - **`redo` と `dry_run` はここでは測らない。** HTTP に該当のエンドポイントが無いためで
 *   (`src/server/app.ts` の変更系は diffs / undo / undo-preview / changelog の4本だけ)、
 *   カーネル経路での実測は `web/test/theme-candidates.test.ts` にある。
 * - **時間を1秒も測らない**(計画 §0-4 の2)。API 呼び出しの回数を数えるのは
 *   `web/test/theme-preview.test.tsx` である。
 * - **見やすさ・好み・「選べた」という感覚は測らない**(同 §0-4 の3)。読んでいるのは
 *   計算値と文字列だけで、スクリーンショット比較もしていない。
 * - **owner 限定は遮断ではない。** `POST /api/apps/:app_id/diffs` は今日も認証を要求しない
 *   (v0 からの状態)。**本タスクは `src/server/` を1バイトも変えていない。**
 *   **【V4-FIX1 項目(5) による改訂。上の2行は制定時の記述であり1バイトも書き換えていない】**
 *   **今日は認証を要求する**(未認証 401 / owner 以外 403)。**(iv) の実測を差し替えた** ——
 *   **viewer 自身のセッションでは 403 になり、owner なら今日も 201 で通る。**
 */
import { expect, type Page, test } from "@playwright/test";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import {
  buildRecord,
  ensureReferenceTargets,
  type FixtureApp,
  provisionApp,
  seedRoleSession,
} from "./fixture-app.ts";

/**
 * UI を通さずに投げる差分のテーマ(25スロット全部)。**コントラスト検査を通る値である。**
 *
 * **`web/src/theme-candidates.ts` を import しない** —— `.e2e.ts` は playwright の
 * プロセスで動き、候補の表そのものを検証するのは `web/test/theme-candidates.test.ts` の
 * 担当である。ここで要るのは「25スロット揃った、検査を通る実値」だけで、
 * 候補である必要が無い(`theme-export.e2e.ts` と同じ組み立て方)。
 */
const SLOTS_FROM_OUTSIDE_UI: Record<string, string> = {
  "--color-text": "#101010",
  "--color-text-secondary": "#595959",
  "--color-text-label": "#595959",
  "--color-text-placeholder": "#595959",
  "--color-danger": "#a00000",
  "--color-page-background": "#ffffff",
  "--color-surface-highlight": "#f2f2f2",
  "--color-border": "#767676",
  "--focus-outline-color": "#005fcc",
  "--focus-outline-width": "2px",
  "--font-family-base": "Georgia, serif",
  "--font-size-secondary": "0.85em",
  "--font-size-note": "0.875rem",
  "--line-height-base": "1.6",
  "--space-1": "0.25rem",
  "--space-2": "0.5rem",
  "--space-3": "0.75rem",
  "--space-4": "1rem",
  "--space-5": "1.25rem",
  "--space-6": "2rem",
  "--border-width": "1px",
  "--control-border-radius": "4px",
  "--surface-shadow": "none",
  "--detail-label-width": "8rem",
  "--login-max-width": "24rem",
};

/** 候補の枚数と、それぞれの地色。**`web/src/theme-candidates.ts` の写しである。** */
const CANDIDATES = [
  { id: "plain-light", name: "明るい", background: "rgb(255, 255, 255)" },
  { id: "deep-dark", name: "暗い", background: "rgb(16, 32, 48)" },
  { id: "warm-roomy", name: "暖色でゆったり", background: "rgb(255, 248, 225)" },
] as const;

function listViewOf(manifest: Manifest): ListView {
  const view = manifest.app.views.find((candidate): candidate is ListView => {
    return candidate.type === "list_view";
  });
  if (view === undefined) {
    throw new Error("フィクスチャに list_view が無い");
  }
  return view;
}

/** 一覧に出る実データを1件作り、そこに出るはずの値を返す。 */
async function seedRow(app: FixtureApp, view: ListView): Promise<string> {
  const table = app.tableOf(view.table);
  const referenceIds = await ensureReferenceTargets(app, table);
  const row = buildRecord(table, 0, referenceIds);
  await app.createRecord(view.table, row);
  const first = view.columns[0];
  if (first === undefined) {
    throw new Error("一覧に列が1つも無い");
  }
  return String(row[first]);
}

/** 枠の計算値(地色)を読む。 */
async function frameBackground(page: Page, candidateId: string): Promise<string> {
  return await page.evaluate((id) => {
    const frame = document.querySelector(`[data-candidate-id="${id}"]`);
    if (frame === null) throw new Error(`枠が無い: ${id}`);
    return getComputedStyle(frame).backgroundColor;
  }, candidateId);
}

async function openPreview(page: Page, app: FixtureApp): Promise<void> {
  await page.goto(`/apps/${app.appId}`);
  await expect(page.getByTestId("view-list")).toBeVisible();
  await page.getByTestId("open-theme-preview").click();
  await expect(page.getByTestId("theme-preview")).toBeVisible();
}

test.describe("V3-M4-T01 実物プレビュー選択(chromium 実測)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "計算値の期待値は chromium の値である(`theme.e2e.ts` と同じ理由)",
  );

  test("(i) 候補が同時に並び、枠ごとに地色が違う(切替操作をしていない)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    await openPreview(page, app);

    const frames = page.getByTestId("theme-preview-frame");
    await expect(frames).toHaveCount(CANDIDATES.length);
    for (const candidate of CANDIDATES) {
      await expect(frames.filter({ hasText: candidate.name }).first()).toBeVisible();
    }

    // **どれも押していない状態で**、枠の地色が候補ごとに違う。
    const backgrounds: string[] = [];
    for (const candidate of CANDIDATES) {
      const background = await frameBackground(page, candidate.id);
      expect(background).toBe(candidate.background);
      backgrounds.push(background);
    }
    expect(new Set(backgrounds).size).toBe(CANDIDATES.length);

    // 製品のスコープ要素は1つのままである(`theme.e2e.ts` (iii) の前提を壊していない)。
    await expect(page.getByTestId("app-theme")).toHaveCount(1);
  });

  test("(ii) 枠の中身は当該アプリの実データである(枠の数だけ同じ行が出る)", async ({
    page,
    request,
  }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    const view = listViewOf(app.manifest);
    const value = await seedRow(app, view);

    await openPreview(page, app);
    await expect(page.getByTestId("theme-preview-frame")).toHaveCount(CANDIDATES.length);
    // 実データのセルが枠の数だけ描かれている(サンプルデータではない)。
    await expect(page.getByText(value, { exact: true })).toHaveCount(CANDIDATES.length);
  });

  test("(iii) 選ぶと適用され、リロードで反映され、undo で戻る", async ({ page, request }) => {
    const app = await provisionApp(request);
    await app.authenticate(page.context());
    await openPreview(page, app);

    const target = CANDIDATES[1];
    if (target === undefined) {
      throw new Error("候補が2件未満");
    }
    const frame = page.locator(`[data-candidate-id="${target.id}"]`);
    await frame.getByTestId("apply-theme-candidate").click();

    // 何が起きたかを画面が言う(黙って成功にしない)。
    const result = page.getByTestId("theme-preview-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(target.name);

    // **リロードだけで反映される**(マニフェストをフロントに焼き込んでいない。ADR-0003 §2)。
    await page.reload();
    await expect(page.getByTestId("view-list")).toBeVisible();
    const applied = await page.evaluate(() => {
      const scope = document.querySelector('[data-testid="app-theme"]');
      if (scope === null) throw new Error("スコープ要素が無い");
      return getComputedStyle(scope).backgroundColor;
    });
    expect(applied).toBe(target.background);

    // `_changelog` に、web が自動生成した intent がそのまま載っている(完了条件12)。
    // **【`V17-M4-T02`】`GET /changelog` にログインが要るようになったので cookie を渡す。**
    const changelog = await request.get(`/api/apps/${app.appId}/changelog`, {
      headers: app.authHeaders,
    });
    expect(changelog.status(), await changelog.text()).toBe(200);
    const entries = (await changelog.json()) as {
      changelog: { diff_id: string; intent: string }[];
    };
    const entry = entries.changelog.find((candidate) => candidate.diff_id.includes(target.id));
    expect(entry?.intent).toContain(target.name);
    expect(entry?.intent).toContain("人間が書いた意図ではない");

    // **既存の undo がそのまま効く**(専用の取り消し経路を作っていない)。
    const undone = await request.post(`/api/apps/${app.appId}/undo`, { headers: app.authHeaders });
    expect(undone.status(), await undone.text()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("view-list")).toBeVisible();
    const scopeStyle = await page.getByTestId("app-theme").getAttribute("style");
    expect(scopeStyle).toBeNull();
  });

  test("(iv) 入口は owner 限定である(viewer には導線が出ない)", async ({ page, request }) => {
    const app = await provisionApp(request);
    const viewer = await seedRoleSession(request, app.appId, "viewer");
    await viewer.authenticate(page.context());

    await page.goto(`/apps/${app.appId}`);
    await expect(page.getByTestId("view-list")).toBeVisible();
    await expect(page.getByTestId("current-role")).toHaveAttribute("data-role", "viewer");
    await expect(page.getByTestId("open-theme-preview")).toHaveCount(0);

    // **【V3-M1 制定時の記述。1バイトも書き換えない】**
    //   > **しかしこれは遮断ではない。** UI の外から同じ差分を投げれば、今日も 201 が返る
    //   > (`POST /api/apps/:app_id/diffs` は認証を要求しない。v0 からの状態で、本タスクは
    //   >  `src/server/` を1バイトも変えていない)。**それを実測して、隠さずに残す。**
    //
    // **【V4-FIX1 項目(5) による改訂。今日の正はこちらである】**
    // **`POST /api/apps/:app_id/diffs` は今日、認証を要求する**(未認証 401 / owner 以外 403)。
    // **ユーザ決定「書き換えの口は塞ぐ …(必須)」の履行である。**
    // **したがって上の「これは遮断ではない」は、viewer については今日から偽になった。**
    //
    // **【誇張しない】** **owner なら今日も UI の外から同じ差分を通せる**(第2の実測)。
    // **入口が owner 限定であることが、owner に対する遮断になったわけではない。**
    const postedByViewer = await request.post(`/api/apps/${app.appId}/diffs`, {
      headers: viewer.authHeaders,
      data: {
        diff_id: "theme-from-outside-ui-viewer",
        intent: "UI を通さずに viewer が投げた差分(サーバが 403 で止めることの実測)",
        operations: [{ op: "set_theme", theme: { slots: SLOTS_FROM_OUTSIDE_UI } }],
      },
    });
    expect(postedByViewer.status(), await postedByViewer.text()).toBe(403);

    const postedByOwner = await request.post(`/api/apps/${app.appId}/diffs`, {
      headers: app.authHeaders,
      data: {
        diff_id: "theme-from-outside-ui",
        intent: "UI を通さずに owner が投げた差分(owner には今日も通ることの実測)",
        operations: [{ op: "set_theme", theme: { slots: SLOTS_FROM_OUTSIDE_UI } }],
      },
    });
    expect(postedByOwner.status(), await postedByOwner.text()).toBe(201);
  });
});
