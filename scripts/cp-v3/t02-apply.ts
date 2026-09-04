/**
 * V3-M7-T02 の実証スクリプト②(適用)。**テストではない。**
 *
 * ## なぜ `web/e2e/` の外に、`*.test.ts` / `*.spec.ts` 以外の名前で置くのか
 *
 * `docs/plan/v3/records/v3-m7.md` §2 の `V3-M7-T02` 完了条件7 が要求している。理由は2つ:
 *
 * - **`bun test` はリポジトリ全体の `*.test.ts` を拾う**(同 §0-1c (11))。本スクリプトは
 *   `.gitignore:4` の無視規則に載る複製データルート(`data-m7-t02-live`)を前提にする。
 *   リポジトリに複製は1バイトも入っていないので、`*.test.ts` の名前で置けば実 CI の
 *   `checks` が必ず赤になる。
 * - **playwright は `web/e2e/` 配下の `.e2e.ts` を拾う**(同 §0-1c (12))。同じ理由で
 *   `web/e2e/` にも置けない。
 *
 * ## 何をするか(3段。`docs/plan/v3/records/v3-m7.md` §2 の T02 完了条件3)
 *
 * 1. **組織テンプレートの確定** —— **専用の機構は実装されていない**(同 §0-1c (7))。
 *    実体は **owner が作った1つのアプリのテーマ**である(`web/test/theme-template.test.ts`
 *    の docblock の逐語「**ここで「組織のテンプレート」と呼んでいるのは owner が作った
 *    1つのアプリであり、テナント・組織の概念は1バイトも作っていない**」)。したがって
 *    ここでやるのは `create_app` + `set_theme` の2手である。
 * 2. **アプリへの適用** —— テンプレートアプリの `/app/theme/slots` をそのまま `ref-ec` に
 *    `set_theme` で写し、`origin`(`template_app_id` / `template_diff_id`)を添える。
 *    **カーネルは origin の真偽を検証しない**(`schemas/manifest.schema.json:70` の `$comment`)。
 * 3. **画面ごとの調整** —— `update_view` の `preset_*` だけを書く。**`name` / `columns` /
 *    `sort` / `filter` / `fields` を1つも書かない**(完了条件10)。
 *
 * ## 使わないもの
 *
 * - **`custom_css` を1件も使わない**(完了条件4)。本ファイルに `custom_css` という
 *   文字列はこの説明文以外に1つも現れない。
 *
 * 使い方: bun run scripts/cp-v3/t02-apply.ts <dataRoot> <outDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.ts";

const [, , dataRoot, outDir] = process.argv;
if (dataRoot === undefined || outDir === undefined) {
  throw new Error("usage: t02-apply.ts <dataRoot> <outDir>");
}

/** 組織テンプレートの実体 = owner が作った1つのアプリ。 */
const TEMPLATE_APP_ID = "org-shop-theme";
const TARGET_APP_ID = "ref-ec";

/**
 * 組織テンプレートのスロット25件。**`$defs/theme` の properties は全部 required なので、
 * 25件すべてに実値を書く**(1件でも欠けると適用が拒否される)。
 *
 * 値は「落ち着いた温かみのある店」という意図で選んだ。**この製品の既定配色は
 * そのままではテンプレートにできない** —— `--color-border` の既定 `#ddd` が非テキスト
 * 閾値 3:1 を通らない(`docs/adr/0046-design-token-slots.md` 限界7 /
 * `web/test/theme-template.test.ts` の `TEMPLATE_SLOTS` の注)。
 */
const TEMPLATE_SLOTS: Record<string, string> = {
  "--color-text": "#1a1a1a",
  "--color-text-secondary": "#5b5b5b",
  "--color-text-label": "#4a4a4a",
  "--color-text-placeholder": "#636363",
  "--color-danger": "#8f2320",
  "--color-page-background": "#fdfaf5",
  "--color-surface-highlight": "#f3e7d3",
  "--color-border": "#7a6a52",
  "--focus-outline-color": "#0b4fa8",
  "--focus-outline-width": "3px",
  "--font-family-base": "Georgia, Hiragino Mincho ProN, serif",
  "--font-size-secondary": "0.8em",
  "--font-size-note": "0.813rem",
  "--line-height-base": "1.9",
  "--space-1": "0.5rem",
  "--space-2": "0.75rem",
  "--space-3": "1rem",
  "--space-4": "1.5rem",
  "--space-5": "1.75rem",
  "--space-6": "2.5rem",
  "--border-width": "2px",
  "--control-border-radius": "6px",
  "--surface-shadow": "0 2px 6px #00000026",
  "--detail-label-width": "6rem",
  "--login-max-width": "24rem",
};

/**
 * 画面ごとの調整。**書くのは `preset_` で始まるキーだけである。**
 * 各項目のコメントは「どの要求に向けて当てたか」(`docs/plan/v3/records/v3-m7-t01-requirements.json`)。
 */
const VIEW_PRESETS: { view: string; changes: Record<string, unknown>; aim: string }[] = [
  {
    view: "catalog-list",
    aim: "M7-R25(欄の幅を中身の量に合わせたい)/ M7-R21(写真の枠)",
    changes: {
      preset_column_width: {
        image: "narrow",
        name: "wide",
        product_code: "standard",
        category: "narrow",
        status: "narrow",
      },
      preset_column_align: { status: "center" },
      preset_image_size: "medium",
    },
  },
  {
    view: "variant-list",
    aim: "M7-R26 / M7-R28 に向けた列の調整(金額と在庫を右へ、状態を中央へ)",
    changes: {
      preset_column_width: {
        product: "standard",
        variant_name: "standard",
        size: "narrow",
        color: "narrow",
        sku: "standard",
        price: "narrow",
        stock: "narrow",
        status: "narrow",
      },
      preset_column_align: { price: "right", stock: "right", status: "center" },
    },
  },
  {
    view: "admin-order-list",
    aim: "M7-R36(件数の案内の位置)/ M7-R35(合計の欄の強調)",
    changes: {
      preset_pager_position: "both",
      preset_column_width: {
        order_number: "standard",
        customer_name: "standard",
        status: "narrow",
        payment_status: "narrow",
        total: "narrow",
        placed_at: "standard",
      },
      preset_column_align: { total: "right", status: "center", payment_status: "center" },
    },
  },
  {
    view: "admin-order-line-list",
    aim: "M7-R37(内部の識別子の欄を狭めたい)",
    changes: {
      preset_column_width: {
        order_number: "standard",
        order_id: "narrow",
        item_name: "wide",
        quantity: "narrow",
        unit_price: "narrow",
        line_total: "narrow",
      },
      preset_column_align: { quantity: "right", unit_price: "right", line_total: "right" },
    },
  },
  {
    view: "wf-run-list",
    aim: "M7-R40(エラーの内容が途中で切れる)",
    changes: {
      preset_text_preview: "long",
      preset_column_width: {
        ran_at: "narrow",
        workflow: "standard",
        trigger_type: "narrow",
        status: "narrow",
        error: "wide",
      },
    },
  },
  {
    view: "product-detail",
    aim: "M7-R54(2つずつ横に並べたい)/ M7-R55(商品説明の全文)/ M7-R56(写真を大きく)",
    changes: {
      preset_field_columns: 2,
      preset_label_placement: "inline",
      preset_text_preview: "long",
      preset_image_size: "medium",
    },
  },
  {
    view: "admin-order-detail",
    aim: "M7-R63(伝票のようにまとめたい)に向けた段組と項目名の向き",
    changes: {
      preset_field_columns: 2,
      preset_label_placement: "stacked",
      preset_text_preview: "long",
    },
  },
  {
    view: "variant-detail",
    aim: "M7-R68(在庫の数の見せ方)に向けた段組",
    changes: {
      preset_field_columns: 2,
      preset_label_placement: "inline",
      preset_image_size: "medium",
    },
  },
  {
    view: "category-detail",
    aim: "M7-R66(子一覧に写真を添えたい)に向けた画像の大きさ",
    changes: { preset_field_columns: 2, preset_image_size: "medium" },
  },
  {
    view: "cart-detail",
    aim: "M7-R84 / M7-R85(案内の見せ方)に向けた段組",
    changes: { preset_field_columns: 1, preset_label_placement: "inline" },
  },
];

const server = createMcpServer({ dataRoot, previewBaseUrl: "http://localhost:3100" });
const client = new Client({ name: "v3-m7-t02-apply", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const callLog: { tool: string; summary: string }[] = [];

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const data = (result.structuredContent ?? {}) as Record<string, unknown>;
  if (result.isError === true) {
    throw new Error(`${name} が失敗した: ${JSON.stringify(data)}`);
  }
  callLog.push({ tool: name, summary: JSON.stringify(args).slice(0, 160) });
  return data;
}

// ---- 段1: 組織テンプレートの確定(owner が作った1つのアプリ + そのテーマ) ----
const apps = (await call("list_apps", {})) as { apps?: { app_id: string }[] };
const alreadyThere = (apps.apps ?? []).some((a) => a.app_id === TEMPLATE_APP_ID);
if (!alreadyThere) {
  await call("create_app", { app_id: TEMPLATE_APP_ID, name: "組織の見た目テンプレート" });
}
const TEMPLATE_DIFF_ID = "m7-t02-template-01";
await call("apply_diff", {
  app_id: TEMPLATE_APP_ID,
  diff: {
    diff_id: TEMPLATE_DIFF_ID,
    intent: "組織として使い回す見た目を1つに決めたい、という要望に応えてテーマを置いた",
    operations: [{ op: "set_theme", theme: { slots: TEMPLATE_SLOTS } }],
  },
});

const templateManifest = (await call("get_manifest", { app_id: TEMPLATE_APP_ID })) as {
  manifest?: { app?: { theme?: { slots?: Record<string, string> } } };
};
const templateSlots = templateManifest.manifest?.app?.theme?.slots;
if (templateSlots === undefined) {
  throw new Error("テンプレートアプリにテーマが入っていない");
}

// ---- 段2: アプリへの適用(origin つき) ----
await call("apply_diff", {
  app_id: TARGET_APP_ID,
  diff: {
    diff_id: "m7-t02-apply-01",
    intent: "組織で決めた見た目をこの店にも当てたい、という要望に応えてテーマを写した",
    operations: [
      {
        op: "set_theme",
        theme: {
          slots: templateSlots,
          origin: { template_app_id: TEMPLATE_APP_ID, template_diff_id: TEMPLATE_DIFF_ID },
        },
      },
    ],
  },
});

// ---- 段3: 画面ごとの調整(preset_ で始まるキーだけ) ----
await call("apply_diff", {
  app_id: TARGET_APP_ID,
  diff: {
    diff_id: "m7-t02-presets-01",
    intent: "画面ごとに見せ方を整えたい、という要望に応えて画面の見せ方だけを差し替えた",
    operations: VIEW_PRESETS.map((entry) => ({
      op: "update_view",
      view: entry.view,
      changes: entry.changes,
    })),
  },
});

const finalManifest = await call("get_manifest", { app_id: TARGET_APP_ID });

await client.close();
await server.close();

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "t02-manifest-after.json"),
  `${JSON.stringify(finalManifest.manifest, null, 2)}\n`,
);
writeFileSync(
  join(outDir, "t02-apply-log.json"),
  `${JSON.stringify({ dataRoot, templateAppId: TEMPLATE_APP_ID, templateDiffId: TEMPLATE_DIFF_ID, viewPresets: VIEW_PRESETS, callLog }, null, 2)}\n`,
);
console.error(`[t02-apply] ${callLog.length} 回の MCP ツール呼び出しで3段を終えた`);
for (const entry of callLog) {
  console.error(`  - ${entry.tool} ${entry.summary}`);
}
