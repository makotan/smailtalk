/**
 * テーマの参照(`$palette_<名前>`)を実値まで解く(`V20-M9-T02`。条文 = `ADR-0474` §Decision 1-4 / 1-5)。
 *
 * ## 規則は5本ちょうど(`ADR-0474` §1-4 の表。式・計算・条件・関数呼び出し・文字列連結は1つも足さない)
 *
 * - **R1** 値が参照の綴りなら、**同じ組(`slots` のオブジェクト1つ)**の `palette_<名前>` の値を引く。
 *   マニフェストの外(別のアプリ・テンプレート・URL)は1つも指さない。組をまたがない。
 * - **R2** 引いた値がまた参照なら R1 を繰り返す。実値に着いたら、それが解決値である。
 * - **R3** 引く先の名前が無ければ「解決できない参照」として拒否する(どの枠の、どの参照かを名指しする)。
 * - **R4** たどる途中で同じ名前に2度来たら「循環参照」として拒否する(道筋を名指しする)。
 * - **R5** 参照を {@link THEME_REFERENCE_MAX_DEPTH} 回たどっても実値に着かなければ「参照が深すぎる」として拒否する。
 *
 * **判定の順は「未解決 → 循環 → 深さ」**(1歩ごとに、行き先が無ければ未解決、既に通った名前なら循環、
 * たどった回数が上限を超えたら深すぎる)。**生の色も全部解く**(どの役割からも指されていない生の色でも拒否する)。
 * 枠ごとの誤りは高々1件。誤りの `path` は `<pathPrefix>/<枠の名前>`。
 *
 * ## 呼ぶのは `validate.ts` の `checkTheme` だけ(`incoming` のときだけ。`ADR-0047` 限定8)
 *
 * 表示層はこの解決器を呼ばない(ブラウザが CSS の変数参照として解く。`ADR-0474` §1-6 / 式P8)。
 * **このファイルの import は `import type` だけ**(色を数値に読む読み口を2本目として作らない。`ADR-0463` 限定4)。
 */
import type { ValidationError } from "./errors.ts";

/** 1つの枠から参照をたどってよい回数(役割 → 生 → 生 → 生の実値 が3回)。`ADR-0474` §1-1 / `ADR-0456` 限定3。 */
export const THEME_REFERENCE_MAX_DEPTH = 3;

/** 参照の綴りの頭(`$defs/theme` の参照の枝 `^\$palette_[a-z0-9_]{1,40}$` と同じ頭)。 */
const REFERENCE_HEAD = "$palette_";

/**
 * `slots` の参照を実値まで解く純関数。入力は書き換えない。
 *
 * 返す `slots` は、拒否されなかった枠を実値にした写しである(拒否された枠は入らない)。
 * `errors` が空でなければ、呼び手はテーマを含む差分全体を拒否する(`ADR-0047` 限定9。全か無か)。
 */
export function resolveThemeSlots(
  slots: Readonly<Record<string, string>>,
  pathPrefix: string,
): { readonly slots: Record<string, string>; readonly errors: ValidationError[] } {
  const resolved: Record<string, string> = {};
  const errors: ValidationError[] = [];
  for (const [name, first] of Object.entries(slots)) {
    const path = `${pathPrefix}/${name}`;
    const trail = [name];
    let value = first;
    let hops = 0;
    let rejected = false;
    while (typeof value === "string" && value.startsWith(REFERENCE_HEAD)) {
      const target = `palette_${value.slice(REFERENCE_HEAD.length)}`;
      hops += 1;
      if (!Object.hasOwn(slots, target)) {
        errors.push({
          path,
          message: `テーマの ${name} が指す ${value} は、同じテーマに ${target} が無いので解決できない参照です。この差分は適用できません。`,
          hint: `${target} を生の色として同じテーマに書き足すか、${name} を実値(#rrggbb / oklch(L C H))か、在る生の色への参照に直してください。`,
        });
        rejected = true;
        break;
      }
      if (trail.includes(target)) {
        errors.push({
          path,
          message: `テーマの ${name} の参照がたどる途中で同じ名前に戻る循環参照です(${[...trail, target].join(" → ")})。この差分は適用できません。`,
          hint: "輪の中のどれか1つの生の色を実値(#rrggbb / oklch(L C H))にしてください。",
        });
        rejected = true;
        break;
      }
      if (hops > THEME_REFERENCE_MAX_DEPTH) {
        errors.push({
          path,
          message: `テーマの ${name} は参照が深すぎます。参照をたどれるのは ${THEME_REFERENCE_MAX_DEPTH} 回までです(${trail.join(" → ")} → …)。この差分は適用できません。`,
          hint: `途中の生の色を実値にして、${THEME_REFERENCE_MAX_DEPTH} 回以内に実値に着くようにしてください。`,
        });
        rejected = true;
        break;
      }
      trail.push(target);
      value = slots[target] as string;
    }
    if (!rejected) {
      resolved[name] = value;
    }
  }
  return { slots: resolved, errors };
}
