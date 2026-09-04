/**
 * V3-M7-T03 の実証スクリプト④(1画面に当てられる逃げ道は1つだけ、の実測)。**テストではない。**
 *
 * ## なぜ `web/e2e/` の外に、`*.test.ts` / `*.spec.ts` 以外の名前で置くのか
 *
 * t03-escape.ts / t03-probe.ts / t03-history.ts と同じ理由(`v3-m7.md` §2 の T03 完了条件7)。
 *
 * ## 何を測るか
 *
 * `M7-R22`(表ではなく札を並べる見せ方にしたい)は、同じ画面の `M7-R18`(見出しの行に地色)
 * `M7-R19`(1行おきの地色)`M7-R25`(欄ごとの幅)と**同時には成り立たない** —— 表を
 * 札の並びに変えると、表の見出しの行も行の縞も列の幅も消えるからである。
 * **`$defs/view.custom_css` は1キーなので、1つの画面に2つの資産を当てて選ぶことはできない。**
 *
 * したがって本スクリプトは **`catalog-list` の参照を札の版へ差し替えて測り、測り終えたら
 * 元の版へ差し戻す。** 「両方を同時に満たせなかった」ことを、切り替えの実測として残す。
 *
 * 使い方:
 *   bun run scripts/cp-v3/t03-cards.ts <dataRoot> <baseUrl> <ownerCookieValue> <outDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "@playwright/test";
import { createMcpServer } from "../../src/mcp/server.ts";

const [, , dataRoot, baseUrl, ownerCookie, outDir] = process.argv;
if (
  dataRoot === undefined ||
  baseUrl === undefined ||
  ownerCookie === undefined ||
  outDir === undefined
) {
  throw new Error("usage: t03-cards.ts <dataRoot> <baseUrl> <ownerCookieValue> <outDir>");
}
/** 引数を狭めた別名(関数の中から使うため。宣言の巻き上げで絞り込みが効かない)。 */
const DATA_ROOT: string = dataRoot;
const BASE_URL: string = baseUrl;
const OWNER_COOKIE: string = ownerCookie;
const OUT_DIR: string = outDir;

const APP_ID = "ref-ec";
const VIEW_ID = "catalog-list";

/** 札の並びの版。**表の器そのものを組み替える。** */
const CARDS_CSS = `
/* M7-R22 表ではなく、写真を大きく出して名前を下に添えた札を並べる */
.list-table, .list-table tbody, .list-table tr, .list-table td { display: block; }
.list-table thead, .list-table colgroup { display: none; }
.list-table tbody {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 20px;
}
.list-table tbody tr {
  border: 2px solid #b9ab93; border-radius: 8px; padding: 14px; background-color: #fffdf8;
}
.list-table td { border: none; padding: 2px 0; }
.list-table td[data-field="image"] .field-empty {
  display: block; width: 100%; height: 160px;
  border: 2px dashed #b9ab93; border-radius: 6px; background-color: #f7f1e6;
}
.list-table td[data-field="name"] { font-size: 1.15rem; font-weight: 700; }
`;

const server = createMcpServer({ dataRoot: DATA_ROOT, previewBaseUrl: BASE_URL });
const client = new Client({ name: "v3-m7-t03-cards", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const data = (result.structuredContent ?? {}) as Record<string, unknown>;
  if (result.isError === true) {
    throw new Error(`${name} が失敗した: ${JSON.stringify(data)}`);
  }
  return data;
}

const before = (await call("get_manifest", { app_id: APP_ID })) as {
  manifest?: { app?: { views?: { id: string; custom_css?: { asset: string; digest: string } }[] } };
};
const previousRef = before.manifest?.app?.views?.find((v) => v.id === VIEW_ID)?.custom_css;
if (previousRef === undefined) {
  throw new Error(`${VIEW_ID} に逃げ道の参照が無い(先に t03-escape.ts を走らせること)`);
}

/** 計算後スタイルを測る(判定に使うのはこの値だけ)。 */
async function measure(label: string): Promise<Record<string, unknown>> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([
    { name: "st_session", value: OWNER_COOKIE, domain: new URL(BASE_URL).hostname, path: "/" },
  ]);
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/apps/${APP_ID}/views/${VIEW_ID}`, { waitUntil: "networkidle" });
  await page
    .locator(".list-table")
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  const measured = await page.evaluate(() => {
    const read = (selector: string, props: string[], index = 0) => {
      const node = document.querySelectorAll(selector)[index];
      if (!(node instanceof Element)) return { found: false };
      const computed = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const css: Record<string, string> = {};
      for (const p of props) css[p] = computed.getPropertyValue(p);
      return { found: true, css, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
    };
    return {
      "list-table": read(".list-table", ["display"]),
      thead: read(".list-table thead", ["display"]),
      tbody: read(".list-table tbody", ["display", "grid-template-columns", "gap"]),
      "tr-0": read(".list-table tbody tr", ["display", "border-top-width", "border-radius"], 0),
      "tr-1": read(".list-table tbody tr", ["display", "background-color"], 1),
      "td-name": read('.list-table td[data-field="name"]', ["display", "font-size", "font-weight"]),
      "td-image-empty": read('.list-table td[data-field="image"] .field-empty', [
        "display",
        "width",
        "height",
      ]),
      "col-0": read(".list-table col", ["display"]),
    };
  });
  await browser.close();
  return { label, measured };
}

const beforeCards = await measure("表の版(M7-R18 / R19 / R25 が効いている版)");

// owner が札の版を発行する(AI は申請だけ)。
await call("request_custom_css", {
  app_id: APP_ID,
  name: "screen-catalog-cards",
  purpose: "商品カタログを表ではなく札の並びで見せたい",
  views: [VIEW_ID],
});
const response = await fetch(`${BASE_URL}/api/apps/${APP_ID}/escape-hatch-assets`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: `st_session=${OWNER_COOKIE}`,
    Origin: BASE_URL,
  },
  body: JSON.stringify({
    name: "screen-catalog-cards",
    css: CARDS_CSS.trim(),
    scopeViews: [VIEW_ID],
  }),
});
const issued = (await response.json()) as { asset?: { name: string; digest: string } };
if (issued.asset === undefined) {
  throw new Error(`発行に失敗: ${response.status} ${JSON.stringify(issued)}`);
}

await call("apply_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: "m7-t03-cards-on",
    intent: "商品カタログを札の並びで見せたい、という要望に応えて逃げ道を札の版へ差し替えた",
    operations: [
      {
        op: "update_view",
        view: VIEW_ID,
        changes: { custom_css: { asset: issued.asset.name, digest: issued.asset.digest } },
      },
    ],
  },
});

const afterCards = await measure("札の版(M7-R22 が効いている版)");

// 元の版へ差し戻す(前進で書き戻せるのは「別の参照に置き換える」ことだけである)。
await call("apply_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: "m7-t03-cards-off",
    intent: "表の見せ方に戻したい、という要望に応えて逃げ道を元の版へ差し替えた",
    operations: [{ op: "update_view", view: VIEW_ID, changes: { custom_css: previousRef } }],
  },
});
const restored = await measure("差し戻した後");

await client.close();
await server.close();

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "t03-cards.json"),
  `${JSON.stringify(
    {
      dataRoot: DATA_ROOT,
      baseUrl: BASE_URL,
      previousRef,
      cardsAsset: issued.asset,
      beforeCards,
      afterCards,
      restored,
    },
    null,
    2,
  )}\n`,
);
console.error(JSON.stringify({ beforeCards, afterCards, restored }, null, 2));
