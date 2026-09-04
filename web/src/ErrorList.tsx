/**
 * 統一形式のエラー表示(V0-P3-T03 / ADR-0003 §3)。
 *
 * `path` / `message` / `allowed_values` / `hint` をそのまま出す。カーネルが
 * 「自己修正できる形」で書いた情報(handover 3.8)を、フロントが要約して
 * 捨ててしまわないようにするため。
 *
 * ## 【V4-M15-T05 / T06】器を部品体系の `Alert` に載せ替えた(ADR-0087)
 *
 * **`variant="destructive"` の `Alert` で包む**(`V4-M15-T14` が定めた「エラーの見え方」)。
 * **中身は1バイトも変えていない** —— 出す4項目も、その並びも、`<ul>` / `<li>` の構造も、
 * `data-testid="errors"` も、`errors` / `allowed` / `hint` のクラス名も同じである
 * (`web/src/styles.css` の `.errors li` / `.errors .allowed` / `.errors .hint` が
 * これらに当たっており、消すと文字色と行の分かれ方が効かなくなる)。
 *
 * **`Alert` は `role="alert"` を持つ。** 着手前のこの器は素の `<ul>` で、支援技術に
 * 「これはエラーである」と伝える手掛かりを1つも持っていなかった —— **増えたのは
 * その1つだけである**(`aria-live` は足していない。読み上げの割り込み方を選ぶ語彙は
 * この製品に無い)。
 *
 * **色を新しく作っていない。** `destructive` の変種が使うのは `--color-danger` 由来の
 * `text-destructive` / `border-destructive` だけで、**地色は `bg-background` のままである**
 * (濃い地色のスロットが25の中に無い = `ADR-0087` 限定7)。
 */
import type { ValidationError } from "./api.ts";
import { Alert } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";

export function ErrorList({ errors }: { errors: ValidationError[] }) {
  return (
    <Alert variant="destructive">
      <ul className={cn("errors", "m-0 flex flex-col gap-s1")} data-testid="errors">
        {errors.map((error, index) => (
          // エラーには識別子が無く、並び順がそのまま意味(サーバが返した順)なので index を使う。
          // biome-ignore lint/suspicious/noArrayIndexKey: サーバが返した配列の並び順が同一性そのもの
          <li key={index} className="flex flex-col gap-s1">
            {error.path !== "" && <code>{error.path}</code>}
            <span>{error.message}</span>
            {error.allowed_values !== undefined && (
              <span className={"allowed"}>許可される値: {error.allowed_values.join(", ")}</span>
            )}
            {error.hint !== undefined && <span className={"hint"}>{error.hint}</span>}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
