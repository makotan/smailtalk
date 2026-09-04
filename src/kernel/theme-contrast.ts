/**
 * テーマのコントラスト検査(V3-M1-T02 / ADR-0046 §1b / §1c / §3 限定3・限定4)。
 *
 * ## これは何であって、何でないか
 *
 * **これは「適用時検査」であってトークン表ではない。** ADR-0046 §1b の Δ10 の論証3点が
 * 依存しているのはこの区別である —— スロット集合(トークン表)の帰属先は表示層であり、
 * 正は `web/src/styles.css` の `:root` と `web/test/__fixtures__/styles-token-slots.txt`
 * (と V3-M1-T03 が新設する `schemas/manifest.schema.json` の `$defs/theme`)である。
 * **本ファイルが持つのは「与えられた2色の比が閾値以上か」を返す純関数と、
 * どの対を測るかを決めるための役割の属性だけである。**
 *
 * したがって本ファイルは次を1つも持たない(持てば ADR-0046 限定3 に触れ、Δ10 が発火する):
 *
 * - スロットの**値**(既定色・値域・単位)—— 1つも持たない。
 * - スロット名 → CSS カスタムプロパティ名の**変換規則** —— 持たない(スロット名は
 *   CSS カスタムプロパティ名そのものであり、変換は恒等である。理由は下記)。
 * - スロットの**並び・分類・表示名** —— 持たない。
 *
 * **{@link THEME_SLOT_ROLES} が独立のスロット表になっていないことの担保は機械的である** ——
 * ADR-0046 §3 限定1 が「`styles-token-slots.txt` のテーマ対象スロット集合 ==
 * `$defs/theme` の properties キー集合 == **本役割表のスロット集合**」を要求し、
 * V3-M1-T03 がその照合検査を置く。**他の2箇所と食い違えない表は、集合の独立な正ではない。**
 *
 * ## スロット名をそのまま使う理由
 *
 * 限定1 が3箇所の**完全一致**(added / removed とも0)を要求しているので、
 * 3箇所の名前は同一でなければならない。`styles-token-slots.txt` の正は
 * `--color-text` のような CSS カスタムプロパティ名である。**したがって役割表のキーも
 * `$defs/theme` のキーも同じ字面になり、変換規則は恒等になる**(T03-12 が定義する
 * 「スロット名 → CSS カスタムプロパティ名の変換規則1本」は恒等写像である)。
 *
 * ## 閾値の出所(ADR-0046 §1c)
 *
 * **本文テキスト 4.5:1 / 非テキスト(枠線など)3:1。数値は WCAG から借りているが、
 * 「WCAG 準拠」を名乗らない。借りた数値の正当性をこの製品は独立に持たない。**
 * 検査が担保するのは「**閾値未満の配色を適用できないこと**」だけであって、
 * 「読みやすいこと」でも「良い配色であること」でもない。
 *
 * ## 本ファイルは結線しない
 *
 * 適用経路への結線(`validateManifestFull` の `purpose === "incoming"`)・拒否の
 * 「全か無か」・`dry_run` の一致は **V3-M1-T03 の完了条件**である。
 */
import type { ValidationError } from "./errors.ts";

/**
 * スロットが検査の中で持つ役割。**役割の属性だけを持つ**(ADR-0046 §3 限定3)。
 *
 * - `foreground` … 何かの上に載る色。`target` は載る対象の種別で、閾値がこれで決まる。
 * - `background` … 下地になる色。
 * - `not-a-color` … 色ではないスロット(余白・寸法・書体・行間・影・枠線の太さなど)。
 *   **属性の追加ではなく「前景でも背景でもない」ことの明示である。** 限定1 が
 *   スロット集合の完全一致を求めるので、色でないスロットも表に載る必要がある。
 */
export type ThemeSlotRole =
  | { readonly kind: "foreground"; readonly target: "text" | "non-text" }
  | { readonly kind: "background" }
  | { readonly kind: "not-a-color" };

/**
 * 閾値。**2つだけである**(ADR-0046 §3 限定4)。
 *
 * 段階を増やさない・要素別の例外を作らない・「WCAG 準拠」と名乗らない。
 * 増やしたくなったら ADR-0046 §3a 2 により門A の再通過が要る。
 */
export const CONTRAST_THRESHOLDS: Readonly<Record<"text" | "non-text", number>> = Object.freeze({
  text: 4.5,
  "non-text": 3,
});

/**
 * 役割表。**キーは `web/test/__fixtures__/styles-token-slots.txt` の
 * 「テーマ対象」スロット(25件)と同一である。**
 *
 * 並びは同ファイルの並びに合わせてある(**並びに意味はない** —— ペアの生成は下記の
 * {@link generatePairs} が名前順に並べ替えてから行うので、この並びに依存しない)。
 *
 * 役割の判定根拠は `docs/plan/v3/03-token-slot-inventory.md` §7(隣接ペアの実測)と
 * §9-1(スロットの意味)であり、内訳は `docs/plan/v3/records/v3-m1-t02.md` §5 にある。
 *
 * ## 28件 → 25件(V3-M1-T03 の完了条件21)
 *
 * **`:root` のスロットは28件のままだが、テーマ対象は25件である**(ADR-0046 限定1 の
 * 文言は「`styles-token-slots.txt` の**テーマ対象スロット集合** == `$defs/theme` の
 * properties キー集合 == 役割表のスロット集合」であり、`:root` の全件を要求していない)。
 * 対象外の3件と理由は `web/test/__fixtures__/styles-token-slots.txt` の
 * 「テーマ対象外」節が持つ(`--shell-max-width` はスコープ要素の外 /
 * `--border-style` と `--focus-outline-style` は7軸に「枠線・アウトラインの種別」が
 * 含まれない)。**3件はいずれも `not-a-color` だったので、検査対象の対は1組も減っていない**
 * (`src/kernel/theme-contrast.test.ts` の14組のテストがそれを固定する)。
 */
export const THEME_SLOT_ROLES: Readonly<Record<string, ThemeSlotRole>> = Object.freeze({
  // 配色 —— テキスト(前景・本文テキストの閾値)
  "--color-danger": { kind: "foreground", target: "text" },
  "--color-text": { kind: "foreground", target: "text" },
  "--color-text-label": { kind: "foreground", target: "text" },
  "--color-text-placeholder": { kind: "foreground", target: "text" },
  "--color-text-secondary": { kind: "foreground", target: "text" },

  // 配色 —— 面と枠線
  "--color-border": { kind: "foreground", target: "non-text" },
  "--color-page-background": { kind: "background" },
  "--color-surface-highlight": { kind: "background" },

  // 書体・行間(色ではない)
  "--font-family-base": { kind: "not-a-color" },
  "--font-size-note": { kind: "not-a-color" },
  "--font-size-secondary": { kind: "not-a-color" },
  "--line-height-base": { kind: "not-a-color" },

  // 密度(色ではない)
  "--space-1": { kind: "not-a-color" },
  "--space-2": { kind: "not-a-color" },
  "--space-3": { kind: "not-a-color" },
  "--space-4": { kind: "not-a-color" },
  "--space-5": { kind: "not-a-color" },
  "--space-6": { kind: "not-a-color" },

  // 枠線の強さ(色ではない。色は `--color-border` が持つ)。
  // **`--border-style` はテーマ対象外である**(完了条件21。枠線の「種別」は7軸に無い)。
  "--border-width": { kind: "not-a-color" },

  // 角丸(色ではない)
  "--control-border-radius": { kind: "not-a-color" },

  // 影(**色を含みうる複合値だが、色として取り出さない**。記録 §11-3 に穴として書いた)
  "--surface-shadow": { kind: "not-a-color" },

  // アウトライン(フォーカスリング)。色だけが前景・非テキストである。
  // **`--focus-outline-style` はテーマ対象外である**(完了条件21。種別は7軸に無い)。
  "--focus-outline-color": { kind: "foreground", target: "non-text" },
  "--focus-outline-width": { kind: "not-a-color" },

  // 寸法(色ではない)。**`--shell-max-width` はテーマ対象外である**(完了条件21。
  // `.shell` はアプリ単位スコープ要素の外側で、値を埋めても画面が1ピクセルも変わらない)。
  "--detail-label-width": { kind: "not-a-color" },
  "--login-max-width": { kind: "not-a-color" },
});

/** 検査する1対。**スロット名の対と、どちらの閾値で測るかだけを持つ**(値は持たない)。 */
export type ThemeContrastPair = {
  readonly foreground: string;
  readonly background: string;
  readonly target: "text" | "non-text";
};

/**
 * 役割の直積としてペアを生成する。
 *
 * **隣接ペアの一覧を実体として持たない** —— 持つと「どの対が画面で隣り合うか」という
 * 表示層の知識がカーネルに来る(限定3 の緊張)。代わりに
 * **「前景 × 背景」を全部測る**。これは 03 §7 が静的な読みで見つけた対の**上位集合**で
 * あり、実在しない対まで測る代わりに、**見落としが原理的に起きない側へ倒してある**
 * (fail-closed。過剰に測ることの代償は記録 §11-1 に書いた)。
 */
function generatePairs(): ThemeContrastPair[] {
  const names = Object.keys(THEME_SLOT_ROLES).sort();
  const backgrounds = names.filter((name) => THEME_SLOT_ROLES[name]?.kind === "background");
  const pairs: ThemeContrastPair[] = [];
  // 本文テキストの対を先に、非テキストの対を後に置く(読む人のための並びで、意味はない)。
  for (const target of ["text", "non-text"] as const) {
    for (const name of names) {
      const role = THEME_SLOT_ROLES[name];
      if (role === undefined || role.kind !== "foreground" || role.target !== target) {
        continue;
      }
      for (const background of backgrounds) {
        pairs.push(Object.freeze({ foreground: name, background, target }));
      }
    }
  }
  return pairs;
}

/**
 * 検査対象のペア。**役割から機械的に生成される**(T02 完了条件2)。
 *
 * `:hover` / `:focus-visible` でしか現れないペア(03 §7 の #5 / #12 / #16)も
 * 自動的に入る —— `--color-surface-highlight` が背景として役割表に載っているためで、
 * 状態を役割表に持たせる必要が無い(T02 完了条件3)。
 */
export const THEME_CONTRAST_PAIRS: readonly ThemeContrastPair[] = Object.freeze(generatePairs());

/** `#rgb` / `#rrggbb`(大文字小文字を問わない)。これ以外の色表記は受けない。 */
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/** 色を 0..255 の3チャンネルに分ける。読めなければ null(例外を投げない)。 */
function channels(color: string): readonly [number, number, number] | null {
  const text = color.trim();
  const six = HEX6.exec(text);
  if (six !== null) {
    const [, r, g, b] = six;
    if (r === undefined || g === undefined || b === undefined) {
      return null;
    }
    return [Number.parseInt(r, 16), Number.parseInt(g, 16), Number.parseInt(b, 16)];
  }
  const three = HEX3.exec(text);
  if (three !== null) {
    const [, r, g, b] = three;
    if (r === undefined || g === undefined || b === undefined) {
      return null;
    }
    return [
      Number.parseInt(`${r}${r}`, 16),
      Number.parseInt(`${g}${g}`, 16),
      Number.parseInt(`${b}${b}`, 16),
    ];
  }
  return null;
}

/**
 * sRGB の1チャンネルを線形値へ戻す(ガンマ展開)。
 *
 * 分岐点 `0.03928` と係数は WCAG 2.x の relative luminance の定義から借りた値である
 * (ADR-0046 §1c。**借りた数値の正当性をこの製品は独立に持たない**)。
 */
function linearize(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** 相対輝度。係数 0.2126 / 0.7152 / 0.0722 も WCAG から借りた値である。 */
function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * 2色のコントラスト比を返す。**どちらかが色として読めなければ null。**
 *
 * 比は `(明るい方 + 0.05) / (暗い方 + 0.05)` で、1..21 の範囲に入る。
 * 引数の順序に依らない(明るい側が分子になる)。
 */
export function contrastRatio(a: string, b: string): number | null {
  const ca = channels(a);
  const cb = channels(b);
  if (ca === null || cb === null) {
    return null;
  }
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 比の表示は小数第2位まで。**比較には丸めた値を使わない**(丸めると閾値直下が通る)。 */
function formatRatio(ratio: number): string {
  return ratio.toFixed(2);
}

/** 閾値の表示(`4.5:1` / `3:1`)。 */
function formatThreshold(threshold: number): string {
  return `${threshold}:1`;
}

/** 閾値の説明語。要素別の例外は作らない(限定4)ので、2語しかない。 */
const TARGET_LABEL: Readonly<Record<"text" | "non-text", string>> = Object.freeze({
  text: "本文テキスト",
  "non-text": "非テキスト(枠線・フォーカスリングなど)",
});

/**
 * テーマのスロット値を受け取り、コントラスト比が閾値未満の対を {@link ValidationError} で返す。
 *
 * **エラーが0件であることが「適用してよい」の意味である**(呼び出し側 = V3-M1-T03 が
 * `validateManifestFull` の `purpose === "incoming"` で結線し、1件でもあれば差分全体を
 * 拒否する。**部分適用はしない**)。**本関数は結線しない。**
 *
 * @param slots スロット名 → 値。**役割表に無いキーは無視する**(値域と未知キーの拒否は
 *   `$defs/theme` の `additionalProperties: false` が担う = T03)。値は `unknown` で受け、
 *   文字列でないものは「色として読めない」として拒否する(fail-closed)。
 * @param pathPrefix `ValidationError.path`(RFC 6901 JSON Pointer)の接頭辞。
 *   既定は `/app/theme` なので、path は `/app/theme/--color-text` の形になる。
 *   **スロット名に `/` と `~` が現れないので RFC 6901 のエスケープは不要である。**
 *   T03 が `app.theme` の中の格納形を決めるので、差し替えられるようにしてある。
 * @returns 落ちた対のエラー。**1件目で打ち切らず全件返す**(LLM が1往復で直せるように)。
 *
 * ## この関数が測らないもの(記録 §11 に全件)
 *
 * - **片側しか与えられていない対は測らない。** 既定値(`styles.css` の値)をカーネルは
 *   持たない(持てばトークン表になる)。**したがって前景だけを差し替えて既定の背景と
 *   読めない組み合わせを作る経路は、この検査では止まらない。**
 * - 影(`--surface-shadow`)の中の色は取り出さない。
 */
export function checkThemeContrast(
  slots: Readonly<Record<string, unknown>>,
  pathPrefix = "/app/theme",
): ValidationError[] {
  const errors: ValidationError[] = [];

  // (1) 色スロットに色として読めない値が入っていたら、比を計算できないので拒否する。
  //     順序を決定的にするため役割表の並びで回す(入力オブジェクトのキー順に依存させない)。
  const unreadable = new Set<string>();
  for (const [name, role] of Object.entries(THEME_SLOT_ROLES)) {
    if (role.kind === "not-a-color") {
      continue;
    }
    const value = slots[name];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string" || channels(value) === null) {
      unreadable.add(name);
      errors.push({
        path: `${pathPrefix}/${name}`,
        message: `テーマのスロット ${name} の値が色として読めません。コントラスト比を計算できないため、この差分は適用できません。`,
        hint: "色は #rgb または #rrggbb の16進表記で指定してください(例: #333333)。",
      });
    }
  }

  // (2) 対ごとに比を測る。**両側の値が与えられている対だけ**が測れる。
  for (const pair of THEME_CONTRAST_PAIRS) {
    if (unreadable.has(pair.foreground) || unreadable.has(pair.background)) {
      continue; // (1) で報告済み。同じ原因で二重に出さない。
    }
    const foreground = slots[pair.foreground];
    const background = slots[pair.background];
    if (typeof foreground !== "string" || typeof background !== "string") {
      continue;
    }
    const ratio = contrastRatio(foreground, background);
    if (ratio === null) {
      continue;
    }
    const threshold = CONTRAST_THRESHOLDS[pair.target];
    if (ratio >= threshold) {
      continue;
    }
    errors.push({
      path: `${pathPrefix}/${pair.foreground}`,
      message: `前景 ${pair.foreground}(${foreground})と背景 ${pair.background}(${background})のコントラスト比は ${formatRatio(ratio)}:1 で、${TARGET_LABEL[pair.target]}の閾値 ${formatThreshold(threshold)} を下回ります。`,
      hint: `どちらかの色を変えて比を ${formatThreshold(threshold)} 以上にしてください。閾値は本文テキスト ${formatThreshold(CONTRAST_THRESHOLDS.text)} と非テキスト ${formatThreshold(CONTRAST_THRESHOLDS["non-text"])} の2つだけです。`,
    });
  }

  return errors;
}
