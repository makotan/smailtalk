/**
 * `web/e2e/anonymous-entry.e2e.ts` と `web/e2e/runner-anonymous-entry.e2e.ts` の共通の台(`V21-M4`)。
 * **検査ではない**(`.e2e.ts` を名乗らない)。
 *
 * 払い出したアプリ(フィクスチャ `inventory-all-field-types.json` の表 `categories` / `items`)に、
 * 未ログインに開いた画面を3枚足す。 **表・項目は1つも足さない**(稼働中の差し替えは表について
 * 追加しか許さないため、画面と規則だけを動かす)。
 */
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import type { Manifest } from "../../src/kernel/types.ts";

export const DETAIL_VIEW = "entry-cat-detail";
export const LIST_VIEW = "entry-cat-list";
/** 未ログインに開いた画面だが、その表(`items`)には未ログインの読取規則を書かない(401 になる)。 */
export const DENIED_VIEW = "entry-item-list";

/**
 * 払い出したアプリに公開画面を3枚足す(並び順: 詳細 → 一覧 → 読めない表の一覧)。
 *
 * **`anonymous: false` は後始末の形である** —— 稼働中の差し替えは画面の削除を受け付けない
 * (「マニフェストを直接渡す経路では、ビューの削除を表現できません」。実測)ので、画面は残し、
 * **未ログインの規則だけを外す**(運営の役割 `owner` の規則は残す。名指しが無くなると
 * `web/e2e/fixture-server.ts` の `grantFixtureRoleRules` が運営3役割へ配り直すため)。
 */
export async function installEntryViews(
  request: APIRequestContext,
  appId: string,
  current: Manifest,
  options: { anonymous: boolean; unlisted?: readonly string[] } = { anonymous: true },
): Promise<void> {
  const next = structuredClone(current);
  const loose = next.app as unknown as {
    roles?: { id: string; name?: string; rules?: Record<string, unknown>[] }[];
  };
  next.app.views = [
    ...next.app.views,
    { id: DETAIL_VIEW, name: "カテゴリの詳細", type: "detail_view", table: "categories" },
    {
      id: LIST_VIEW,
      name: "カテゴリ一覧(公開)",
      type: "list_view",
      table: "categories",
      columns: ["name"],
    },
    {
      id: DENIED_VIEW,
      name: "品目一覧(公開・読めない)",
      type: "list_view",
      table: "items",
      columns: ["name"],
    },
  ] as Manifest["app"]["views"];
  // **【`V22-M4-T08`】名指しした画面に `menu_listed: false` を書く**(メニューに載せない公開画面。
  // `ADR-0494` §Decision 1)。 **名指しが無ければ1バイトも変えない**(既存の呼び手は今日どおり)。
  for (const view of next.app.views) {
    if (options.unlisted?.includes(view.id) === true) {
      (view as { menu_listed?: boolean }).menu_listed = false;
    }
  }
  const roles = loose.roles ?? [];
  const push = (roleId: string, rules: Record<string, unknown>[]): void => {
    const found = roles.find((role) => role.id === roleId);
    if (found === undefined) {
      roles.push({ id: roleId, name: roleId, rules });
      return;
    }
    found.rules = [...(found.rules ?? []), ...rules];
  };
  const views = [DETAIL_VIEW, LIST_VIEW, DENIED_VIEW];
  push(
    "owner",
    views.map((view) => ({ target: "view", view, can: ["read"] })),
  );
  if (options.anonymous) {
    push("anonymous", [
      ...views.map((view) => ({ target: "view", view, can: ["read"] })),
      { target: "table", table: "categories", can: ["read"] },
    ]);
  }
  loose.roles = roles;
  const replaced = await request.post(`/__e2e__/apps/${appId}/manifest`, { data: next });
  expect(replaced.status(), await replaced.text()).toBe(200);
}

/** 開いてから `ms` のあいだに出た要求の URL(パス + クエリ)を数える。 */
export async function countRequests(page: Page, open: () => Promise<void>, ms: number) {
  const seen: string[] = [];
  const listener = (request: { url: () => string }) => {
    const url = new URL(request.url());
    seen.push(`${url.pathname}${url.search}`);
  };
  page.on("request", listener);
  await open();
  await page.waitForTimeout(ms);
  page.off("request", listener);
  const counts: Record<string, number> = {};
  for (const url of seen) {
    counts[url] = (counts[url] ?? 0) + 1;
  }
  return counts;
}
