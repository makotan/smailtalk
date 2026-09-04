/**
 * 要件定義書の E2E(V1-M8-T02 / ADR-0025 §10。CP-V1-8 確認方法2 / 確認方法4)。
 *
 * 見るのは3つ:
 *
 *   (a) 画面を開くと、そのアプリの要件定義書が**節ごとに**出る
 *   (b) **全記述に出典が表示されている**(出典欄が空の記述が0件。確認方法2 の画面側)
 *   (c) 画面に出ている記述が、**API 応答そのもの**である(件数・ID・本文の全一致)
 *
 * **期待値をこのファイルに1つも焼き込まない。** 記述の本文も件数も、払い出された
 * アプリの API 応答から導く —— フィクスチャ固有の名前を書いてしまうと、
 * 「画面がフィクスチャを解釈して描いている」ことの証明にならず、
 * 「テストが答えを知っていた」だけになる(既存 e2e と同じ流儀)。
 *
 * 認可の検査も1つ持つ: 要件定義書 API は changelog / manifest と同列の
 * **無認証(ローカル専用)**である(§10-1)。`request` にセッション cookie を
 * 1つも載せずに 200 が返ることで、UI の見え方(誰にでも出る導線)と API の
 * 実際の認可が一致していることを実物で踏む(§10-2)。
 */
import { expect, test } from "@playwright/test";
import type { RequirementStatement } from "../../src/kernel/requirements-doc.ts";
import { provisionApp } from "./fixture-app.ts";

/** `format=json` の応答(`src/server/app.ts` のルートが返す形)。 */
type RequirementsResponse = {
  requirements: {
    app_id: string;
    section: string | null;
    statements: RequirementStatement[];
    markdown: string;
  };
};

test("要件定義書が画面に出て、全記述に出典が付いている", async ({ page, request }) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  // --- 期待値は API から導く(**セッション cookie を1つも載せない**)---
  const response = await request.get(`/api/apps/${app.appId}/requirements?format=json`);
  expect(response.status(), await response.text()).toBe(200);
  const { requirements } = (await response.json()) as RequirementsResponse;
  expect(requirements.app_id).toBe(app.appId);
  expect(requirements.statements.length).toBeGreaterThan(0);

  // --- (a) 画面を開く ---
  await page.goto(`/apps/${app.appId}`);
  await page.getByTestId("open-requirements-doc").click();
  await expect(page.getByTestId("requirements-doc")).toBeVisible();

  // 節は ADR-0025 §7 の6つ。該当が無い節も枠として出る(黙って消さない)。
  await expect(page.getByTestId("requirement-section")).toHaveCount(6);

  // --- (c) 画面の記述が API 応答そのものである ---
  const statements = page.getByTestId("requirement-statement");
  await expect(statements).toHaveCount(requirements.statements.length);

  const rendered = await statements.evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-statement-id"),
      section: node.closest("[data-section]")?.getAttribute("data-section") ?? null,
      text: node.querySelector('[data-testid="requirement-text"]')?.textContent ?? "",
      sourceCount: node.querySelectorAll('[data-testid="requirement-source"]').length,
    })),
  );

  expect(rendered.map((item) => item.id)).toEqual(
    requirements.statements.map((statement) => statement.id),
  );
  expect(rendered.map((item) => item.text)).toEqual(
    requirements.statements.map((statement) => statement.text),
  );
  // 節の振り分けも応答どおり(画面が自分で分類し直していない)。
  expect(rendered.map((item) => item.section)).toEqual(
    requirements.statements.map((statement) => statement.section),
  );

  // --- (b) 出典欄が空の記述が0件 ---
  expect(rendered.filter((item) => item.sourceCount === 0)).toEqual([]);
  // 出典の総数も応答から導く(1件でも落ちれば合わない)。
  expect(rendered.reduce((total, item) => total + item.sourceCount, 0)).toBe(
    requirements.statements.reduce((total, statement) => total + statement.sources.length, 0),
  );

  // 閉じるとビュー一覧に戻る(通常導線であって、袋小路の画面ではない)。
  await page.getByTestId("close-requirements-doc").click();
  await expect(page.getByTestId("view-list")).toBeVisible();
});

test("要件定義書はマニフェストの変更に追随する(焼き込まれていない)", async ({ page, request }) => {
  const app = await provisionApp(request);
  await app.authenticate(page.context());

  await page.goto(`/apps/${app.appId}`);
  await page.getByTestId("open-requirements-doc").click();
  const statements = page.getByTestId("requirement-statement");
  // 取得は非同期なので、描画が済むまで待ってから数える。
  await expect(statements.first()).toBeVisible();
  const before = await statements.count();
  expect(before).toBeGreaterThan(0);

  // 既存 ID と衝突しないビューを1つ足す(名前はマニフェストから機械的に導く)。
  const table = app.manifest.app.tables[0];
  if (table === undefined) {
    throw new Error("フィクスチャにテーブルがありません。");
  }
  const taken = app.manifest.app.views.map((view) => view.id);
  let addedViewId = `${table.id}-added`;
  while (taken.includes(addedViewId)) {
    addedViewId = `${addedViewId}-x`;
  }
  const applied = await request.post(`/api/apps/${app.appId}/diffs`, {
    headers: app.authHeaders,
    data: {
      diff_id: `${addedViewId}-diff`,
      intent: "要件定義書が変更に追随することを確かめる",
      operations: [
        {
          op: "add_view",
          view: {
            id: addedViewId,
            type: "list_view",
            table: table.id,
            columns: table.fields.slice(0, 1).map((field) => field.id),
          },
        },
      ],
    },
  });
  expect(applied.status(), await applied.text()).toBe(201);

  // **リロードするだけ**で、足したビューについての記述が増えている。
  await page.reload();
  await page.getByTestId("open-requirements-doc").click();
  await expect(statements.first()).toBeVisible();

  const response = await request.get(`/api/apps/${app.appId}/requirements?format=json`);
  const { requirements } = (await response.json()) as RequirementsResponse;
  await expect(statements).toHaveCount(requirements.statements.length);
  expect(requirements.statements.length).toBeGreaterThan(before);

  // 足したビューの ID が、実際に画面へ出ている(実在集合を通った識別子である)。
  await expect(page.getByTestId("requirements-doc")).toContainText(addedViewId);
});
