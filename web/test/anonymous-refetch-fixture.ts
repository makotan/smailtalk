/**
 * `web/test/anonymous-refetch.test.tsx` と `web/test/runner-anonymous-refetch.test.tsx` の共通の台
 * (`V21-M4-T07`)。 **検査ではない**(`.test.` を名乗らない)。
 *
 * 未ログインの公開画面(一覧 / 詳細)を、`GET /public` が渡す定義だけで描かせ、行の取得を
 * 401 か 403 で断る。 取得した URL を順に記録して返す。
 */

export const APP_ID = "refetch-shop";

/** 描画の後、再描画を何度も待つ間(`V21-M1` の実測では 2.5秒で約1000〜2000本撃った)。 */
export const SETTLE_MS = 400;

const CATEGORY_TABLE = {
  id: "category",
  name: "カテゴリ",
  fields: [{ id: "label", name: "名前", type: "text", required: true }],
};

const PRODUCT_TABLE = {
  id: "product",
  name: "商品",
  fields: [
    { id: "name", name: "商品名", type: "text", required: true },
    { id: "category", name: "カテゴリ", type: "reference", reference_table: "category" },
  ],
};

const VIEWS = [
  {
    id: "product-list",
    name: "商品一覧",
    type: "list_view",
    table: "product",
    columns: ["name", "category"],
    tables: [PRODUCT_TABLE, CATEGORY_TABLE],
  },
  {
    id: "product-detail",
    name: "商品の詳細",
    type: "detail_view",
    table: "product",
    tables: [PRODUCT_TABLE, CATEGORY_TABLE],
  },
];

export type RefetchCase = { label: string; path: string };

export const REFETCH_CASES: RefetchCase[] = [
  { label: "公開の一覧画面", path: "/views/product-list" },
  { label: "公開の詳細画面", path: "/views/product-detail/records/p1" },
  { label: "入口(画面を名乗らない URL)", path: "" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `fetch` を差し替え、取得した URL の配列(呼ぶたびに伸びる)を返す。 */
export function stubAnonymousDenied(status: 401 | 403): string[] {
  const requested: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const full = String(input);
    requested.push(full);
    const url = full.split("?")[0] ?? "";
    if (url === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401),
      );
    }
    if (url === `/api/apps/${APP_ID}/manifest`) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: "認証が必要です。" }] }, 401),
      );
    }
    if (url === `/api/apps/${APP_ID}/public`) {
      return Promise.resolve(jsonResponse({ app: { id: APP_ID, name: "断る店" }, views: VIEWS }));
    }
    if (url.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return Promise.resolve(
        jsonResponse(
          {
            errors: [
              {
                path: "",
                message:
                  status === 401
                    ? "認証が必要です。ログインしてください。"
                    : "この操作を行う権限がありません。",
              },
            ],
          },
          status,
        ),
      );
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: "no stub" }] }, 404));
  }) as typeof fetch;
  return requested;
}

/** URL(クエリ込み)ごとの取得の回数。 */
export function countByUrl(urls: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const url of urls) {
    counts[url] = (counts[url] ?? 0) + 1;
  }
  return counts;
}
