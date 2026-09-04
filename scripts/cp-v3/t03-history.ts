/**
 * V3-M7-T03 の実証スクリプト③(履歴の非対称・コントラスト検査・孤児資産)。**テストではない。**
 *
 * ## なぜ `web/e2e/` の外に、`*.test.ts` / `*.spec.ts` 以外の名前で置くのか
 *
 * `docs/plan/v3/records/v3-m7.md` §2 の `V3-M7-T03` 完了条件7(= `V3-M7-T02` 完了条件7 と
 * 同じ制約)。理由は t03-escape.ts / t03-probe.ts と同じである(複製データルートと
 * 起動済みサーバを前提にするので、`bun test` と playwright のどちらの射程にも入れない)。
 *
 * ## 何を測るか(`v3-m7.md` §0-4 (9) の3つの塊。**1文に丸めない**)
 *
 * - **(a)** 01 §8 の書き直された完了条件4 の3文 —— (i) 参照は undo で戻る /
 *   (ii) 過去の版は content-addressed なので壊れない(版A → 版B → undo で版A のバイト列が返る)/
 *   (iii) 失効させた資産だけは戻らず、配信が fail-closed かつ loud になる。
 * - **(b)** 前進の側の非対称 —— 逃げ道の参照もプリセット7キーも前進では外せない。
 *   あわせて「件数表示とページャの位置」「項目の段組数」は前進では既定に戻せない。
 * - **(c)** 残る限界2点 —— `_changelog` に載るのは参照であって CSS の中身ではない /
 *   孤児資産は蓄積する(検出のみ・自動刈り取りなし)。
 *
 * **孤児の数え方は `src/kernel/snapshot-orphans.ts` の `auditAppEscapeHatch` と同じ定義**
 * (現行 manifest + 全 snapshot の manifest が参照する digest の補集合)**を、
 * ファイルを直接読んで数え直したものである** —— カーネルから import すると
 * `scripts/kernel-import-snapshot.txt` に識別子が増え、`v3-m7.md` §2a-2 の手当て1 が
 * 許した7識別子の外に出る。**同じ定義を書き写した以上、定義がずれたら本スクリプトは古くなる。**
 *
 * 使い方:
 *   bun run scripts/cp-v3/t03-history.ts <dataRoot> <baseUrl> <ownerCookieValue> <outDir>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.ts";

const [, , dataRoot, baseUrl, ownerCookie, outDir] = process.argv;
if (
  dataRoot === undefined ||
  baseUrl === undefined ||
  ownerCookie === undefined ||
  outDir === undefined
) {
  throw new Error("usage: t03-history.ts <dataRoot> <baseUrl> <ownerCookieValue> <outDir>");
}
/** 引数を狭めた別名(関数の中から使うため。宣言の巻き上げで絞り込みが効かない)。 */
const DATA_ROOT: string = dataRoot;
const BASE_URL: string = baseUrl;
const OWNER_COOKIE: string = ownerCookie;
const OUT_DIR: string = outDir;

const APP_ID = "ref-ec";

const server = createMcpServer({ dataRoot: DATA_ROOT, previewBaseUrl: BASE_URL });
const client = new Client({ name: "v3-m7-t03-history", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

type ToolResult = { data: Record<string, unknown>; isError: boolean };
async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  return {
    data: (result.structuredContent ?? {
      text: (result.content as { text?: string }[] | undefined)?.[0]?.text,
    }) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

async function manifest(): Promise<Record<string, unknown>> {
  const out = await call("get_manifest", { app_id: APP_ID });
  return (out.data.manifest ?? {}) as Record<string, unknown>;
}
function viewOf(m: Record<string, unknown>, viewId: string): Record<string, unknown> {
  const views = ((m.app ?? {}) as { views?: Record<string, unknown>[] }).views ?? [];
  return views.find((v) => v.id === viewId) ?? {};
}
async function fetchCss(viewId: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${BASE_URL}/api/apps/${APP_ID}/views/${viewId}/custom.css`);
  return { status: response.status, body: await response.text() };
}
async function issue(
  name: string,
  css: string,
  scopeViews: string[],
): Promise<{ id: string; digest: string }> {
  const response = await fetch(`${BASE_URL}/api/apps/${APP_ID}/escape-hatch-assets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `st_session=${OWNER_COOKIE}`,
      Origin: BASE_URL,
    },
    body: JSON.stringify({ name, css, scopeViews }),
  });
  const body = (await response.json()) as { asset?: { id: string; digest: string } };
  if (body.asset === undefined) {
    throw new Error(`発行に失敗: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.asset;
}

const report: Record<string, unknown> = { dataRoot: DATA_ROOT, baseUrl: BASE_URL };

/* =========================================================================================== *
 * (a)(i)(ii) 版A → 版B → undo。**参照が戻ることと、版A のバイト列が返ることを別々に測る。**
 * =========================================================================================== */
const beforeUndo = await manifest();
const refB = viewOf(beforeUndo, "catalog-list").custom_css as { asset: string; digest: string };
const cssB = await fetchCss("catalog-list");

const undone = await call("undo", { app_id: APP_ID });
const afterUndo = await manifest();
const refA = viewOf(afterUndo, "catalog-list").custom_css as
  | { asset: string; digest: string }
  | undefined;
const cssA = await fetchCss("catalog-list");

report.a_i_ii = {
  before_undo: refB,
  after_undo: refA,
  reference_changed: refB?.digest !== refA?.digest,
  undo_result: undone.data,
  css_b_status: cssB.status,
  css_b_bytes: new TextEncoder().encode(cssB.body).length,
  css_a_status: cssA.status,
  css_a_bytes: new TextEncoder().encode(cssA.body).length,
  // 版A の本文が「壊れていない」ことの判定は **バイト列が sha256 と一致すること**である。
  css_a_digest_matches: refA === undefined ? null : await sha256Hex(cssA.body),
  css_a_declared_digest: refA?.digest ?? null,
  css_b_digest_matches: await sha256Hex(cssB.body),
  css_b_declared_digest: refB?.digest ?? null,
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 版B へ戻す(以降の測定は版B の状態で行う)。
const redone = await call("redo", { app_id: APP_ID });
const afterRedo = await manifest();
report.a_i_ii_redo = {
  redo_result: redone.data,
  reference: viewOf(afterRedo, "catalog-list").custom_css,
};

/* =========================================================================================== *
 * (b) 前進の側の非対称。
 * =========================================================================================== */
// (b1) 逃げ道の参照は、`custom_css` を書かない `update_view` では外れない。
await call("apply_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: "m7-t03-forward-omit",
    intent: "逃げ道の参照を書かずに別のキーだけを差し替えたら参照が外れるかを確かめたい",
    operations: [
      { op: "update_view", view: "catalog-list", changes: { preset_image_size: "original" } },
    ],
  },
});
const afterOmit = await manifest();
// (b2) `custom_css: null` は受け付けられるか。
const nullAttempt = await call("apply_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: "m7-t03-forward-null",
    intent: "逃げ道の参照を明示的に消せるかを確かめたい",
    operations: [{ op: "update_view", view: "catalog-list", changes: { custom_css: null } }],
  },
});
// (b3) プリセットのキーも同じか(`preset_pager_position` を書かない update_view)。
const beforePreset = await manifest();
await call("apply_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: "m7-t03-forward-preset",
    intent: "画面の見せ方のキーを書かずに別のキーだけを差し替えたらキーが外れるかを確かめたい",
    operations: [
      { op: "update_view", view: "admin-order-list", changes: { preset_text_preview: "short" } },
    ],
  },
});
const afterPreset = await manifest();
// (b4) `preset_pager_position` の3値のどれかで「書く前の並び」に戻せるか。
const pagerAttempts: Record<string, unknown> = {};
for (const value of ["top", "bottom", "both"]) {
  const attempt = await call("apply_diff", {
    app_id: APP_ID,
    diff: {
      diff_id: `m7-t03-pager-${value}`,
      intent: "件数表示とページャの位置を既定の並びに戻せるかを確かめたい",
      operations: [
        { op: "update_view", view: "admin-order-list", changes: { preset_pager_position: value } },
      ],
    },
  });
  pagerAttempts[value] = { accepted: !attempt.isError };
}
// (b5) `preset_field_columns` に「既定」を表す値があるか。
const columnsAttempt = await call("dry_run_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: "m7-t03-columns-default",
    intent: "項目の段組数を既定へ戻せるかを確かめたい",
    operations: [
      { op: "update_view", view: "product-detail", changes: { preset_field_columns: 0 } },
    ],
  },
});

report.b_forward = {
  omit_custom_css_still_present: viewOf(afterOmit, "catalog-list").custom_css !== undefined,
  custom_css_null: { isError: nullAttempt.isError, result: nullAttempt.data },
  preset_before: viewOf(beforePreset, "admin-order-list").preset_pager_position,
  preset_after_omitting_it: viewOf(afterPreset, "admin-order-list").preset_pager_position,
  pager_position_values_accepted: pagerAttempts,
  field_columns_zero: { isError: columnsAttempt.isError, result: columnsAttempt.data },
};

/* =========================================================================================== *
 * (a)(iii) 失効させた資産は undo で戻らない。配信が fail-closed かつ loud。
 * =========================================================================================== */
const probeView = "my-order-list";
const p1 = await issue("revoke-probe", ".list-table td { outline: 1px solid #123456; }", [
  probeView,
]);
const p2 = await issue("revoke-probe", ".list-table td { outline: 2px solid #654321; }", [
  probeView,
]);
await call("apply_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: "m7-t03-revoke-a",
    intent: "失効の実験のために、この画面に版P1 の逃げ道を当てたい",
    operations: [
      {
        op: "update_view",
        view: probeView,
        changes: { custom_css: { asset: "revoke-probe", digest: p1.digest } },
      },
    ],
  },
});
const p1Delivered = await fetchCss(probeView);
await call("apply_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: "m7-t03-revoke-b",
    intent: "失効の実験のために、この画面の逃げ道を版P2 へ差し替えたい",
    operations: [
      {
        op: "update_view",
        view: probeView,
        changes: { custom_css: { asset: "revoke-probe", digest: p2.digest } },
      },
    ],
  },
});
const p2Delivered = await fetchCss(probeView);
// owner が版P1 を失効させる。
const revoked = await fetch(`${BASE_URL}/api/apps/${APP_ID}/escape-hatch-assets/${p1.id}`, {
  method: "DELETE",
  headers: { Cookie: `st_session=${OWNER_COOKIE}`, Origin: BASE_URL },
});
// undo で参照だけが版P1 に戻る。
await call("undo", { app_id: APP_ID });
const afterRevokeUndo = await manifest();
const p1AfterUndo = await fetchCss(probeView);
const bodyStillOnDisk = existsSync(join(DATA_ROOT, "apps", APP_ID, "escape-hatch", p1.digest));

report.a_iii = {
  p1_digest: p1.digest,
  p2_digest: p2.digest,
  p1_delivered_status: p1Delivered.status,
  p2_delivered_status: p2Delivered.status,
  revoke_status: revoked.status,
  reference_after_undo: viewOf(afterRevokeUndo, probeView).custom_css,
  delivery_after_undo_status: p1AfterUndo.status,
  delivery_after_undo_body: p1AfterUndo.body.slice(0, 400),
  body_still_on_disk: bodyStillOnDisk,
};

/* =========================================================================================== *
 * (c) 残る限界2点。
 * =========================================================================================== */
const changelog = await call("get_changelog", { app_id: APP_ID, limit: 5 });
const changelogText = JSON.stringify(changelog.data);
report.c_changelog = {
  contains_css_body:
    changelogText.includes("background-color") || changelogText.includes("::after"),
  contains_asset_name:
    changelogText.includes("screen-catalog-list") || changelogText.includes("revoke-probe"),
  sample: changelog.data,
};

// 孤児資産の数え直し(定義は `auditAppEscapeHatch` と同じ。import はしない)。
const hatchDir = join(DATA_ROOT, "apps", APP_ID, "escape-hatch");
const onDisk = existsSync(hatchDir)
  ? readdirSync(hatchDir)
      .filter((n) => /^[0-9a-f]{64}$/.test(n))
      .sort()
  : [];
function digestsOf(manifestPath: string): string[] {
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      app?: { views?: { custom_css?: { digest?: string } }[] };
    };
    return (parsed.app?.views ?? [])
      .map((v) => v.custom_css?.digest)
      .filter((d): d is string => typeof d === "string");
  } catch {
    return [];
  }
}
const referenced = new Set(digestsOf(join(DATA_ROOT, "apps", APP_ID, "manifest.json")));
const snapshotRoot = join(DATA_ROOT, "apps", APP_ID, "snapshots");
const snapshots = existsSync(snapshotRoot) ? readdirSync(snapshotRoot) : [];
for (const name of snapshots) {
  for (const digest of digestsOf(join(snapshotRoot, name, "manifest.json"))) {
    referenced.add(digest);
  }
}
report.c_orphans = {
  on_disk: onDisk.length,
  referenced: referenced.size,
  orphans: onDisk.filter((d) => !referenced.has(d)).length,
  snapshots: snapshots.length,
};

/* =========================================================================================== *
 * コントラスト検査(裁定14 の実例)—— 逃げ道で書けた色を、テーマのスロットに書けるか。
 * =========================================================================================== */
const themeSlots = ((afterRedo.app ?? {}) as { theme?: { slots?: Record<string, string> } }).theme
  ?.slots;
const contrast = await call("dry_run_diff", {
  app_id: APP_ID,
  diff: {
    diff_id: "m7-t03-contrast",
    intent: "空欄の文字を薄くしたい、という要望に応えて文字色のスロットを薄い色に差し替えたい",
    operations: [
      {
        op: "set_theme",
        theme: { slots: { ...(themeSlots ?? {}), "--color-text-placeholder": "#bdb5a8" } },
      },
    ],
  },
});
report.contrast_check = {
  attempted_value: "#bdb5a8",
  isError: contrast.isError,
  result: contrast.data,
};

await client.close();
await server.close();

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "t03-history.json"), `${JSON.stringify(report, null, 2)}\n`);
console.error(JSON.stringify(report, null, 2));
