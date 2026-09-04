/**
 * **題材のマニフェストに「面の規則」(`app.roles[].rules`)を最小限だけ足すための、
 * `web/test/` ローカルの下ごしらえ**(`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`)。
 *
 * ## なぜ要るのか(**着手前の実測**)
 *
 * **`V8-M26` が既定を「閉じる」側へ倒した** —— **`src/server/owner-scope.ts` の
 * `judgeRoleAccess` は、規則を1本も名指ししていない `table` / `view` / `action` を
 * 今日から拒否する**(`field` だけは今日どおり開いたまま。台帳 `T-G1b` = 却下)。
 * **`web/src/auth/authz.tsx` の `canUseView` / `canUseAction` は同じ関数を呼ぶので、
 * 規則を1本も書いていない題材では画面が1つも描かれなくなった。**
 *
 * **着手時点の `web/test` の赤は 112 本 / 23 ファイルであり、その原因はほぼ全部
 * 「題材のマニフェストが `app.roles[].rules` を1本も持たない」ことだった。**
 *
 * ## この下ごしらえがしないこと(**先に書く。誇張しない**)
 *
 * 1. **判定を1バイトも緩めていない。** **足すのは題材の側の宣言だけである** ——
 *    **`web/src/auth/authz.tsx` にも `src/server/owner-scope.ts` にも触っていない。**
 * 2. **「全部に全許可を配る」ための道具ではない。** **`grantRules` は呼び出し側が
 *    名指しした役割に、名指しした規則だけを足す。** **その検査の主題に要らない対象を
 *    足さないのは呼び出し側の責任である。**
 * 3. **`field`(項目)の規則を作る補助を置いていない** —— **項目の既定は今日も開いており
 *    (`T-G1b` = 却下)、赤の原因に1件も含まれていなかったからである。**
 *    項目の規則が要る検査は、規則の値を直に書くこと(そちらは「主題が権限そのもの」である)。
 * 4. **UI が描くことは「通る」ことではない。** **遮断はサーバの 403 / 404 であり、
 *    ここで足した宣言は表示層の先回りを通すだけである。**
 *
 * ## `import type` だけを使っている理由
 *
 * **`scripts/kernel-import-drift.test.ts` が `src/kernel/` からの**値**の import を
 * スナップショットで固定しているためである**(`import type` は数えない)。
 * **本ファイルは型しか import しないので、そのスナップショットを1行も動かさない。**
 */
import type { Manifest, RoleDeclaration, RoleRule, RoleRuleVerb } from "../../src/kernel/types.ts";

/** 運営3ロール。**題材が `owner` / `editor` / `viewer` を跨ぐときの定型。** */
export const ADMIN_ROLES = ["owner", "editor", "viewer"] as const;

/** **その画面を開ける**規則1本(`target: "view"` × `read`)。 */
export function viewRead(viewId: string): RoleRule {
  return { target: "view", view: viewId, can: ["read"] };
}

/** **その画面のそのボタンを出す**規則1本(`target: "action"` × `read`)。 */
export function actionRead(viewId: string, actionId: string): RoleRule {
  return { target: "action", view: viewId, action: actionId, can: ["read"] };
}

/** **その表について、名指しした動詞だけ**を許す規則1本(`target: "table"`)。 */
export function tableCan(tableId: string, ...can: RoleRuleVerb[]): RoleRule {
  return { target: "table", table: tableId, can: can.length === 0 ? ["read"] : can };
}

/**
 * **名指しした役割に、名指しした規則を足す**(既存の `app.roles` があれば併合する)。
 *
 * **同じ規則を2度足さない**(`uniqueItems` に触れないため。ただしこの併合は
 * JSON の同値でしか重複を見ない —— **スキーマの `uniqueItems` と同じ穴を持つ**)。
 *
 * **マニフェストをその場で書き換えて、同じ参照を返す**(題材の組み立ての途中で
 * 呼ぶ使い方に合わせている)。
 */
export function grantRules(
  manifest: Manifest,
  roleIds: readonly string[],
  rules: readonly RoleRule[],
): Manifest {
  const app = manifest.app as { roles?: RoleDeclaration[] };
  const roles: RoleDeclaration[] = app.roles ?? [];
  for (const roleId of roleIds) {
    let declaration = roles.find((candidate) => candidate.id === roleId);
    if (declaration === undefined) {
      declaration = { id: roleId, rules: [] };
      roles.push(declaration);
    }
    const existing = declaration.rules ?? [];
    const merged = [...existing];
    for (const rule of rules) {
      const encoded = JSON.stringify(rule);
      if (!merged.some((candidate) => JSON.stringify(candidate) === encoded)) {
        merged.push(rule);
      }
    }
    declaration.rules = merged;
  }
  // **【`V8-M28` / 台帳 `T-G16a`(2026-08-11)】持ち主(`owner`)には
  // `{"target":"app","can":["write"]}` と `{"target":"role","can":["write"]}` の2行が要る** ——
  // **適用時検査(`src/kernel/referential-integrity.ts` の類型17 の拡張)が両方の実在を
  // 要求するので、足さないと題材のマニフェストが丸ごと拒否される**
  // (`applyManifest` が `valid: false` を返し、表そのものが作られない)。
  // **この2行は名指しする対象を持たないので、表・画面・ボタン・項目の測定を1ミリも動かさない。**
  // **判定は1バイトも緩めていない** —— **変えたのは題材の側だけである。**
  {
    const owner = roles.find((declaration) => declaration.id === "owner");
    if (owner !== undefined) {
      const rules = (owner.rules ?? []) as RoleRule[];
      for (const target of ["app", "role"] as const) {
        if (rules.some((rule) => rule.target === target)) {
          continue;
        }
        rules.push({ target, can: ["write"] } as RoleRule);
      }
      owner.rules = rules;
    }
  }
  app.roles = roles;
  return manifest;
}

/**
 * **題材に載っている画面すべてに「開ける」規則を足す**(名指しした役割にだけ)。
 *
 * **【誇張しない】これは「全許可」ではない** —— **足すのは画面 × 読取だけであり、
 * 表・項目・ボタンの規則を1本も足さない。** **それでも「その検査の主題に必要な最小限」を
 * 超えることがあるので、画面が1〜2本の題材では {@link viewRead} を直に使うこと。**
 */
export function grantAllViews(manifest: Manifest, roleIds: readonly string[]): Manifest {
  return grantRules(
    manifest,
    roleIds,
    manifest.app.views.map((view) => viewRead(view.id)),
  );
}
