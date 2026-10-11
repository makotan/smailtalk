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
 * - スロット名 → CSS カスタムプロパティ名の**変換規則** —— 持たない(**写像は
 *   `web/src/theme-role-map.ts` の1本だけが持つ**。理由は下記)。
 * - スロットの**並び・分類・表示名** —— 持たない。
 *
 * **{@link THEME_SLOT_ROLES} が独立のスロット表になっていないことの担保は機械的である** ——
 * ADR-0046 §3 限定1 が「`styles-token-slots.txt` のテーマ対象スロット集合 ==
 * `$defs/theme` の properties キー集合 == **本役割表のスロット集合**」を要求し、
 * V3-M1-T03 がその照合検査を置く。**他の2箇所と食い違えない表は、集合の独立な正ではない。**
 *
 * ## キーは役割名である(**【V20-M8 / ADR-0473】ここは書き直した**)
 *
 * **旧(要旨)**: 「限定1 が3箇所の完全一致を要求するので、役割表のキーも `$defs/theme` のキーも
 * `styles-token-slots.txt` と同じ CSS カスタムプロパティ名の字面になり、変換規則は恒等になる」。
 * **V20-M8 で偽になった。** 役割表のキーと `$defs/theme` のキーは**役割名**(`body_text` のような
 * 平たい `snake_case`)であり、`styles-token-slots.txt` の正は今日も CSS カスタムプロパティ名
 * (`--color-text` など)である。**2つは `web/src/theme-role-map.ts` の写像1本で結ばれる。**
 * 限定1 の完全一致(added / removed とも0)は「写像を通した一致」として引き直された
 * (ADR-0473。一致の中身は緩めていない —— 測り方だけが変わった)。
 * **名前を CSS カスタムプロパティ名のまま残したのは `--detail-label-width` / `--login-max-width` の
 * 2件だけである**(D-V20-12。V20-M9 が語彙から外す。この2件だけ写像は恒等)。
 * **【V20-M9 / ADR-0474】上の2件は語彙から外した。今日、名前を CSS の名前のまま残した枠は0件である。**
 * **このファイルは写像を1つも持たない** —— 役割名だけを知り、CSS の名前を知らない。
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
 *
 * **【V20-M9 / ADR-0474 §Decision 1-8。`ADR-0046` 限定3 の第2列を引き直した】** 属性を1つ足した ——
 * 背景は `surface`(その背景がどの面か)、前景は `surfaces`(その前景が載る面)。 面は
 * `page`(ページと、その上の強調の面)/ `overlay`(重ねて出す小窓)/ `primary`(主ボタン)の閉じた3値である。
 * **組は「前景 × その前景が載る面の背景」だけで作る。** 実値は今日どおり1つも持たない(式P12)。
 * 旧(逐語): `| { readonly kind: "foreground"; readonly target: "text" | "non-text" }` /
 * `| { readonly kind: "background" }`。
 * **面の型は export しない**(このファイルの export は7つのまま。`ADR-0463` 限定5 / `ADR-0472` 式11b)。
 */
type ThemeSurface = "page" | "overlay" | "primary";

export type ThemeSlotRole =
  | {
      readonly kind: "foreground";
      readonly target: "text" | "non-text";
      readonly surfaces: readonly ThemeSurface[];
    }
  | { readonly kind: "background"; readonly surface: ThemeSurface }
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
 * 役割表。**キーは `schemas/manifest.schema.json` の `$defs/theme` の properties(役割名。25件)と
 * 同一である。** `web/src/theme-role-map.ts` の写像を通すと、`web/test/__fixtures__/styles-token-slots.txt`
 * の「テーマ対象」スロット(25件。CSS カスタムプロパティ名)と一致する(【V20-M8 / ADR-0473】旧(逐語): 【V20-M9 で偽になった】今日は27件(ADR-0474。T01 が役割表を27件にした)。
 * 「キーは `web/test/__fixtures__/styles-token-slots.txt` の「テーマ対象」スロット(25件)と同一である。」)。
 *
 * 並びはスキーマの並び(= 同ファイルの並びを写像で引き戻したもの)に合わせてある(**並びに意味はない** ——
 * ペアの生成は下記の {@link generatePairs} が名前順に並べ替えてから行うので、この並びに依存しない。
 * **ただし名前順は役割名の名前順なので、V20-M8 で組の並びと誤りの順序が旧名のときと変わった**)。
 *
 * **【V20-M9 / ADR-0474】件数は 25 − 2 + 4 = 27 である**(上と下の「25件」は引き直しの前の逐語)。
 * 対象外は 3 → 5(語彙から外した `--detail-label-width` / `--login-max-width` を足した)。
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
  // 【V20-M9 / ADR-0474 §1-8】前景に `surfaces`、背景に `surface` を足した。今日の前景7つは
  // `page` と `overlay` の面に載る(小窓の中にも同じ文字が出るため)。旧(逐語)は属性 `kind` / `target` だけ。
  danger: { kind: "foreground", target: "text", surfaces: ["page", "overlay"] },
  body_text: { kind: "foreground", target: "text", surfaces: ["page", "overlay"] },
  label_text: { kind: "foreground", target: "text", surfaces: ["page", "overlay"] },
  placeholder_text: { kind: "foreground", target: "text", surfaces: ["page", "overlay"] },
  secondary_text: { kind: "foreground", target: "text", surfaces: ["page", "overlay"] },

  // 配色 —— 面と枠線
  // **枠線とフォーカスの輪は主ボタンの面(`primary`)に載せない**(D-V20-30。ADR-0474 §Decision 2 の行 11〜13 の
  // 「要素別の例外」。主ボタンの枠線と輪はページ地色に接して見え、その組は今日すでに測っている)。
  border_color: { kind: "foreground", target: "non-text", surfaces: ["page", "overlay"] },
  page_background: { kind: "background", surface: "page" },
  highlight_surface: { kind: "background", surface: "page" },
  // 【V20-M9 / ADR-0474 §1-2(D-V20-28)】足した4枠。主ボタンの地色と文字色、重ねて出す小窓の地色と文字色。
  primary_fill: { kind: "background", surface: "primary" },
  on_primary: { kind: "foreground", target: "text", surfaces: ["primary"] },
  overlay_background: { kind: "background", surface: "overlay" },
  overlay_text: { kind: "foreground", target: "text", surfaces: ["overlay"] },

  // 書体・行間(色ではない)
  body_font: { kind: "not-a-color" },
  note_font_size: { kind: "not-a-color" },
  secondary_font_size: { kind: "not-a-color" },
  body_line_height: { kind: "not-a-color" },

  // 密度(色ではない)
  space_1: { kind: "not-a-color" },
  space_2: { kind: "not-a-color" },
  space_3: { kind: "not-a-color" },
  space_4: { kind: "not-a-color" },
  space_5: { kind: "not-a-color" },
  space_6: { kind: "not-a-color" },

  // 枠線の強さ(色ではない。色は `border_color` が持つ)。
  // **`--border-style` はテーマ対象外である**(完了条件21。枠線の「種別」は7軸に無い)。
  border_width: { kind: "not-a-color" },

  // 角丸(色ではない)
  control_radius: { kind: "not-a-color" },

  // 影(**色を含みうる複合値だが、色として取り出さない**。記録 §11-3 に穴として書いた)
  surface_shadow: { kind: "not-a-color" },

  // アウトライン(フォーカスリング)。色だけが前景・非テキストである。
  // **`--focus-outline-style` はテーマ対象外である**(完了条件21。種別は7軸に無い)。
  focus_ring: { kind: "foreground", target: "non-text", surfaces: ["page", "overlay"] },
  focus_ring_width: { kind: "not-a-color" },

  // 寸法(色ではない)。**`--shell-max-width` はテーマ対象外である**(完了条件21。
  // `.shell` はアプリ単位スコープ要素の外側で、値を埋めても画面が1ピクセルも変わらない)。
  // 【V20-M9 / ADR-0474 §Decision 1-3(D-V20-12)】次の2行を外した(語彙から外したため。
  // `styles.css` の `:root` の2行は残り、固定値の一覧ではテーマ対象外へ移った)。旧(逐語):
  // "--detail-label-width": { kind: "not-a-color" },
  // "--login-max-width": { kind: "not-a-color" },
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
 *
 * **【V20-M9 / ADR-0474 §1-8】上の「前景 × 背景を全部測る」は、面(`surface` / `surfaces`)ごとの直積に
 * 引き直した。** 今日の14組は1組も減らず、小窓の8組と主ボタンの1組を足して23組になる(式P13)。
 * 前景は自分が載る面の背景とだけ組になる —— 主ボタンの面には `on_primary` だけが載る(D-V20-30)。
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
        // 【V20-M9 / ADR-0474 §1-8】前景が載る面の背景とだけ組にする(直積を面ごとに分ける)。
        const back = THEME_SLOT_ROLES[background];
        if (back?.kind !== "background" || !role.surfaces.includes(back.surface)) {
          continue;
        }
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
 * 自動的に入る —— `highlight_surface` が背景として役割表に載っているためで、
 * 状態を役割表に持たせる必要が無い(T02 完了条件3)。
 */
export const THEME_CONTRAST_PAIRS: readonly ThemeContrastPair[] = Object.freeze(generatePairs());

/** `#rgb` / `#rrggbb`(大文字小文字を問わない)。16進の記述子が照合する形はこの2つだけ(8桁は受けない)。 */
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/**
 * 色の表記1種の読み手(記述子)。**非 export である**(公開の識別子を増やさない)。
 *
 * - `notation` … 表記の名前(読む人のためのラベル。判定には使わない)。
 * - `patterns` … この表記に当たるかを照合する正規表現。**照合を実行するのは
 *   {@link channels} だけである**(読む口は1本。記述子は照合を実行しない)。
 * - `toChannels` … 一致した組(捕獲群)を 0..255 の3ch に直す。直せなければ null。
 *
 * **読み手の出口の型 = sRGB ガンマ付き 0..255 の3ch。** どの表記の読み手も、この型に
 * 直してから返す。輝度の計算({@link linearize} / {@link relativeLuminance})はこの型
 * だけを前提にしており、表記の違いはすべて読み手の中で吸収する。
 *
 * **【V20-M7B / ADR-0472】上の2段落の「0..255」は尺度であって値の範囲ではなくなった。** oklch の読み手は
 * 色域の外の色を切り詰めずに返すので、出口の値は 0..255 の外にもなり得る。 {@link linearize} /
 * {@link relativeLuminance} に渡す前に {@link srgbViewLuminance} が [0, 255] に切り詰める
 * (広色域の画面の見え方は {@link wideGamutLuminance} が別に計算する)。 16進の読み手は今日どおり 0..255 だけを返す。
 *
 * **記述子はスロット名を1つも持たない。** 「どのスロットに何が書けるか」は
 * スキーマの値域が決めることで、ここは「この文字列が色としてどう読めるか」だけを持つ。
 */
type ColorNotationReader = {
  readonly notation: string;
  readonly patterns: readonly RegExp[];
  readonly toChannels: (
    groups: readonly (string | undefined)[],
  ) => readonly [number, number, number] | null;
};

/** 16進の捕獲群(2桁ずつ、または1桁ずつ)を 0..255 の3ch に直す。1桁は同じ桁を重ねる。 */
function hexGroupsToChannels(
  groups: readonly (string | undefined)[],
): readonly [number, number, number] | null {
  const [r, g, b] = groups;
  if (groups.length !== 3 || r === undefined || g === undefined || b === undefined) {
    return null;
  }
  const widen = (digits: string): number =>
    Number.parseInt(digits.length === 1 ? `${digits}${digits}` : digits, 16);
  return [widen(r), widen(g), widen(b)];
}

/** 16進の記述子。6桁を先に、3桁を後に照合する(建て替える前の順序と同じ)。 */
const HEX_NOTATION_READER: ColorNotationReader = Object.freeze({
  notation: "hex",
  patterns: Object.freeze([HEX6, HEX3]),
  toChannels: hexGroupsToChannels,
});

/**
 * 明るさ基準の表記 `oklch(L C H)`(V20-M7。ADR-0463 §Decision 5 限定2 の「足す表記は1種ちょうど」)。
 *
 * **形を受ける範囲はスキーマ(`$defs/theme` の色スロット9件の `anyOf` の2枝目)より広い** ——
 * ここは「数と空白と括弧の並び」だけを見て、値の範囲は {@link oklchGroupsToChannels} が確かめる
 * (二重の守り。スキーマを通らない値を直接渡されても読まない)。`%` は L にだけ付けられる。
 *
 * **【V20-M7B / ADR-0472 限定2】H の位置にだけ `none` を書ける(0 として読む)。** L と C の位置の `none`、
 * 大文字の `NONE`、透明度、角度の単位は今日どおり読まない(フラグ `i` を付けない)。
 */
const OKLCH = /^oklch\(([0-9]+(?:\.[0-9]+)?%?) ([0-9]+(?:\.[0-9]+)?) ([0-9]+(?:\.[0-9]+)?|none)\)$/;

/**
 * 色域の外とみなす境目の幅(**許容差はこの1つだけ**。v20-m0-t02 §3-5 / ADR-0472 限定4)。
 *
 * **【V20-M7B / ADR-0472 で役目が変わった】** V20-M7 では「ガンマ符号化した後の各チャンネル(0..1 の尺度)が
 * `[-幅, 1 + 幅]` の外なら読まない(null)」の境目だった。**今日は「外なら広色域の画面の見え方も測る」の境目である**
 * ({@link wideGamutLuminance})。内側の色(16進はつねに内側)は、広色域の画面の見え方として通常の画面の見え方の
 * 値をそのまま使う —— したがって V20-M7 で受けていた色の比・判定・message は1ビットも変わらない(ADR-0472 限定11)。
 * 幅は 8ビットの1段の半分 `0.5/255` で、知覚についての主張を1つも含まない。 **2つ目の許容差を作らない。**
 */
const SRGB_GAMUT_MARGIN = 0.5 / 255;

/**
 * 線形 sRGB の1チャンネルをガンマ側へ戻す(sRGB の符号化)。
 *
 * 分岐点 `0.0031308` と係数 `12.92` / `1.055` / `1 / 2.4` / `0.055` は IEC 61966-2-1(sRGB)の値。
 * **【非対称を隠さない】逆向きの {@link linearize} の分岐点は WCAG 2.x が借りた旧値 `0.03928` で、
 * 符号化側の `0.0031308 × 12.92 = 0.04045` と一致しない。** 本段は {@link linearize} を1バイトも
 * 書き換えない(ADR-0463 限定3「振る舞いを1つも変えない」)。この非対称で比が動くのは、
 * 符号化した値が 0.03928〜0.04045 の間(0..255 で 10.0〜10.3)に入るチャンネルだけである。
 *
 * **【V20-M7B / ADR-0472 §Decision 2-2】負の値は符号を保って符号化する(`sign(x)·encode(|x|)`)。**
 * 色域の外の色は線形の値が負になるチャンネルを持つ。V20-M7 では直線部の式 `12.92 × x` をそのまま
 * 当てていた —— 許容差の内側の負の値(線形で -0.00016 より大きい)は直線部なので、どちらの式でも
 * 1ビットも同じ値になる。 逆向きは {@link decodeSrgbExact}(広色域の画面の見え方だけが使う)。
 */
function encodeSrgb(linear: number): number {
  const magnitude = Math.abs(linear);
  const encoded =
    magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055;
  return linear < 0 ? -encoded : encoded;
}

/**
 * oklch の捕獲群(L / C / H の文字列)を sRGB ガンマ付き 0..255 の尺度の3ch に直す。直せなければ null。
 *
 * **【V20-M7B / ADR-0472】色域の外でも null を返さない。** ガンマ符号化した**切り詰める前の**値を返す
 * (0..255 の外の値も返る)。切り詰めは見え方ごとに {@link srgbViewLuminance} / {@link wideGamutLuminance} が行う。
 * **L / H の範囲の外・NaN・無限大は今日どおり null。** H の `none` は 0 と読む。
 *
 * 経路: OKLCH → OKLab(a = C·cos h, b = C·sin h)→ LMS'(立方根の側)→ 立方 → 線形 sRGB →
 * ガンマ符号化 → ×255。**照合はしない**(捕獲群を受けるだけ。照合は {@link channels} の1本)。
 *
 * 係数の出典: Björn Ottosson「A perceptual color space for image processing」(2020)の公開値
 * (OKLab → LMS' の逆行列と、LMS → 線形 sRGB の逆行列。CSS Color Module Level 4 が同じ値を引いている)。
 * **係数を外部の実装とこの場で突き合わせていない**(穴として unfixed-holes.md §19 に書いた)。
 *
 * **8ビットへの整数丸めはしない**(小数を返す。2つ目の許容差を作らないため)。
 */
function oklchGroupsToChannels(
  groups: readonly (string | undefined)[],
): readonly [number, number, number] | null {
  const [lightnessText, chromaText, hueText] = groups;
  if (
    groups.length !== 3 ||
    lightnessText === undefined ||
    chromaText === undefined ||
    hueText === undefined
  ) {
    return null;
  }
  const percent = lightnessText.endsWith("%");
  const lightnessNumber = Number(percent ? lightnessText.slice(0, -1) : lightnessText);
  const lightness = percent ? lightnessNumber / 100 : lightnessNumber;
  const chroma = Number(chromaText);
  const hue = hueText === "none" ? 0 : Number(hueText);
  if (
    !Number.isFinite(lightness) ||
    !Number.isFinite(chroma) ||
    !Number.isFinite(hue) ||
    lightness < 0 ||
    lightness > 1 ||
    chroma < 0 ||
    hue < 0 ||
    hue > 360
  ) {
    return null;
  }
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const encoded = [
    encodeSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encodeSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encodeSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
  const toByteScale = (channel: number | undefined): number | null => {
    if (channel === undefined || !Number.isFinite(channel)) {
      return null;
    }
    return channel * 255;
  };
  const red = toByteScale(encoded[0]);
  const green = toByteScale(encoded[1]);
  const blue = toByteScale(encoded[2]);
  if (red === null || green === null || blue === null) {
    return null;
  }
  return [red, green, blue];
}

/** oklch の記述子(V20-M7)。**表記を足したのはこの1つだけである**(ADR-0463 限定2)。 */
const OKLCH_NOTATION_READER: ColorNotationReader = Object.freeze({
  notation: "oklch",
  patterns: Object.freeze([OKLCH]),
  toChannels: oklchGroupsToChannels,
});

/**
 * 読み手の一覧。**色の文字列を数値に直すときに回る唯一の一覧である。**
 * 表記を足すときはここに記述子を足す(読む口 {@link channels} は増やさない)。
 */
const COLOR_NOTATION_READERS: readonly ColorNotationReader[] = Object.freeze([
  HEX_NOTATION_READER,
  OKLCH_NOTATION_READER,
]);

/**
 * 色を 0..255 の尺度の3チャンネルに分ける。読めなければ null(例外を投げない)。
 *
 * **【V20-M7B / ADR-0472】戻り値は 0..255 の外にもなり得る**(oklch の読み手は色域の外の色を切り詰めずに返す)。
 * 16進の読み手は今日どおり 0..255 の整数だけを返す。 **輝度に直す前に、見え方ごとに切り詰めること**
 * ({@link srgbViewLuminance} / {@link wideGamutLuminance})。
 *
 * **色の文字列を照合する口はこの関数1本だけである。** 読み手の一覧を先頭から回り、
 * 最初に当たった記述子の変換で3ch に直す。どの記述子にも当たらなければ null。
 */
function channels(
  color: string,
  readers: readonly ColorNotationReader[] = COLOR_NOTATION_READERS,
): readonly [number, number, number] | null {
  const text = color.trim();
  for (const reader of readers) {
    for (const pattern of reader.patterns) {
      const match = pattern.exec(text);
      if (match !== null) {
        return reader.toChannels(match.slice(1));
      }
    }
  }
  return null;
}

/**
 * sRGB の1チャンネルを線形値へ戻す(ガンマ展開)。
 *
 * **入力は読み手の出口の型 = sRGB ガンマ付き 0..255 の3ch の1チャンネルである。**
 * この関数は sRGB のガンマ曲線そのものであり、入力が sRGB であることに依存している。
 * sRGB 以外の表記を受けるときは、読み手の側で先にこの型へ直してから渡すこと。
 *
 * 分岐点 `0.03928` と係数は WCAG 2.x の relative luminance の定義から借りた値である
 * (ADR-0046 §1c。**借りた数値の正当性をこの製品は独立に持たない**)。
 */
function linearize(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/**
 * 相対輝度。係数 0.2126 / 0.7152 / 0.0722 も WCAG から借りた値である。
 *
 * 入力は読み手の出口の型 = sRGB ガンマ付き 0..255 の3ch である。
 */
function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * 通常の画面(sRGB)の見え方の相対輝度(ADR-0472 §Decision 2-2)。
 *
 * **各チャンネルを [0, 255] に切り詰めてから {@link relativeLuminance} に通す**(切り詰めてから線形に戻す。
 * 負の値を {@link linearize} に渡すと NaN になる)。Chromium は sRGB の画面で、色域の外の色をガンマ符号化した
 * 後のチャンネルごとの切り捨てで描く(ADR-0472 §Context 3 の実測)ので、それと同じ切り詰めを使う。
 * 0..255 の内側の値(16進はつねに)では切り詰めは値を1ビットも動かさない。
 */
function srgbViewLuminance(color: readonly [number, number, number]): number {
  const [r, g, b] = color;
  const clip = (channel: number): number => Math.min(255, Math.max(0, channel));
  return relativeLuminance([clip(r), clip(g), clip(b)]);
}

/**
 * ガンマ符号化した sRGB の1チャンネル(0..1 の尺度)を線形の値へ戻す。**{@link encodeSrgb} の厳密な逆**
 * (符号を保ち、分岐点 `0.04045` = `0.0031308 × 12.92`。IEC 61966-2-1 / CSS Color Module Level 4 の
 * `lin_sRGB`)。**広色域の画面の見え方({@link wideGamutLuminance})だけが使う。** 通常の画面の見え方は
 * 今日どおり WCAG の {@link linearize}(分岐点 `0.03928`)を使う —— 2つの逆関数が同じファイルに並ぶのは
 * 意図であり、16進と V20-M7 で受けていた色の比を1ビットも動かさないためである(ADR-0472 限定7 / 限定11)。
 */
function decodeSrgbExact(encoded: number): number {
  const magnitude = Math.abs(encoded);
  const linear = magnitude <= 0.04045 ? magnitude / 12.92 : ((magnitude + 0.055) / 1.055) ** 2.4;
  return encoded < 0 ? -linear : linear;
}

/**
 * 線形 sRGB → XYZ(D65)。CSS Color Module Level 4 の `lin_sRGB_to_XYZ` の有理数の値をそのまま写した。
 * **この場で外部の実装と突き合わせていない**(穴として unfixed-holes.md §20 に書く)。
 */
const LINEAR_SRGB_TO_XYZ: readonly (readonly [number, number, number])[] = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];

/** XYZ(D65)→ 線形 display-p3。CSS Color Module Level 4 の `XYZ_to_lin_P3` の有理数の値。 */
const XYZ_TO_LINEAR_DISPLAY_P3: readonly (readonly [number, number, number])[] = [
  [446124 / 178915, -333277 / 357830, -72051 / 178915],
  [-14852 / 17905, 63121 / 35810, 423 / 17905],
  [11844 / 330415, -50337 / 660830, 316169 / 330415],
];

/**
 * 線形 display-p3 → XYZ(D65)の2行目(= 輝度 Y の係数)。CSS Color Module Level 4 の `lin_P3_to_XYZ` の2行目。
 * **WCAG から借りた値ではない**(ADR-0472 §Decision 2-3。準拠を名乗らない)。
 */
const LINEAR_DISPLAY_P3_LUMINANCE: readonly [number, number, number] = [
  35783 / 156275,
  247089 / 357200,
  198249 / 2500400,
];

/** 3×3 の行列と3成分の積。 */
function multiplyMatrix(
  matrix: readonly (readonly [number, number, number])[],
  [x, y, z]: readonly [number, number, number],
): [number, number, number] {
  const row = (index: number): number => {
    const [a, b, c] = matrix[index] ?? [0, 0, 0];
    return a * x + b * y + c * z;
  };
  return [row(0), row(1), row(2)];
}

/**
 * 広色域の画面(display-p3)の見え方の相対輝度(ADR-0472 §Decision 2-2。**非 export**)。
 *
 * - **切り詰める前のチャンネルがすべて許容差({@link SRGB_GAMUT_MARGIN})の内側なら、通常の画面の見え方の
 *   値をそのまま返す**(16進はつねにこちら)。したがって16進と V20-M7 で受けていた色では、2つの見え方の比は
 *   完全に等しい。
 * - 外側なら: {@link decodeSrgbExact} で線形 sRGB に戻す → 線形 display-p3(CSS Color 4 の行列)→
 *   [0, 1] に切り詰める(広色域の画面も外は切り詰める)→ display-p3 → XYZ の2行目で Y を出す。
 *
 * **正規表現を書かない**(ADR-0463 限定4。読む口は {@link channels} の1本)。{@link channels} が返した値から計算する。
 */
function wideGamutLuminance(color: readonly [number, number, number]): number {
  const [r, g, b] = color;
  const inside = (channel: number): boolean => {
    const unit = channel / 255;
    return unit >= -SRGB_GAMUT_MARGIN && unit <= 1 + SRGB_GAMUT_MARGIN;
  };
  if (inside(r) && inside(g) && inside(b)) {
    return srgbViewLuminance(color);
  }
  const linear: [number, number, number] = [
    decodeSrgbExact(r / 255),
    decodeSrgbExact(g / 255),
    decodeSrgbExact(b / 255),
  ];
  const displayP3 = multiplyMatrix(
    XYZ_TO_LINEAR_DISPLAY_P3,
    multiplyMatrix(LINEAR_SRGB_TO_XYZ, linear),
  );
  const clip = (channel: number): number => Math.min(1, Math.max(0, channel));
  const [kr, kg, kb] = LINEAR_DISPLAY_P3_LUMINANCE;
  return kr * clip(displayP3[0]) + kg * clip(displayP3[1]) + kb * clip(displayP3[2]);
}

/** 2つの相対輝度の比。`(明るい方 + 0.05) / (暗い方 + 0.05)`。 */
function ratioOfLuminances(la: number, lb: number): number {
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 2色のコントラスト比を返す。**どちらかが色として読めなければ null。**
 *
 * 比は `(明るい方 + 0.05) / (暗い方 + 0.05)` で、1..21 の範囲に入る。
 * 引数の順序に依らない(明るい側が分子になる)。
 *
 * **【V20-M7B / ADR-0472】返すのは通常の画面(sRGB)の見え方の比である**({@link srgbViewLuminance})。
 * 色域の外の oklch も null にせず、切り詰めた色の比を返す。広色域の画面の見え方は返さない
 * (適用時の検査 {@link checkThemeContrast} だけが使う)。署名と、読めない文字列で null を返すことは変えない。
 *
 * @param readers 色の文字列を読む読み手の一覧。**省略時はこのファイルの既定の一覧**
 *   (今日は16進と oklch の2つ)。色はこの一覧越しにだけ読む —— 読み手を1つも持たない一覧を
 *   渡すと、どんな値でも null を返す。適用時の検査({@link checkThemeContrast})は
 *   この引数を渡さない(常に既定の一覧で読む)。
 */
export function contrastRatio(
  a: string,
  b: string,
  readers: readonly ColorNotationReader[] = COLOR_NOTATION_READERS,
): number | null {
  const ca = channels(a, readers);
  const cb = channels(b, readers);
  if (ca === null || cb === null) {
    return null;
  }
  return ratioOfLuminances(srgbViewLuminance(ca), srgbViewLuminance(cb));
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
 *   既定は `/app/theme` なので、path は `/app/theme/body_text` の形になる。
 *   **スロット名に `/` と `~` が現れないので RFC 6901 のエスケープは不要である。**
 *   T03 が `app.theme` の中の格納形を決めるので、差し替えられるようにしてある。
 * @returns 落ちた対のエラー。**1件目で打ち切らず全件返す**(LLM が1往復で直せるように)。
 *
 * ## この関数が測らないもの(記録 §11 に全件)
 *
 * - **片側しか与えられていない対は測らない。** 既定値(`styles.css` の値)をカーネルは
 *   持たない(持てばトークン表になる)。**したがって前景だけを差し替えて既定の背景と
 *   読めない組み合わせを作る経路は、この検査では止まらない。**
 * - 影(`surface_shadow`)の中の色は取り出さない。
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
        // 【V20-M16-T01(2026-09-27)】旧(逐語): "色は #rgb / #rrggbb の16進表記か、明るさ基準の oklch(L C H) で指定してください(例: #333333 / oklch(0.55 0.15 250))。"
        // 生の色への参照を書けることが抜けていたので1文足した(例の括弧は単独で通る値だけにしておく)。
        hint:
          "色は #rgb / #rrggbb の16進表記か、明るさ基準の oklch(L C H) で指定してください(例: #333333 / oklch(0.55 0.15 250))。" +
          "同じテーマに生の色(palette_ で始まる名前)を定義していれば、$palette_<名前> の形でその色を指すこともできます。",
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
    const foregroundChannels = channels(foreground);
    const backgroundChannels = channels(background);
    if (foregroundChannels === null || backgroundChannels === null) {
      continue;
    }
    // 【V20-M7B / ADR-0472 限定10】2つの画面の見え方の比を出し、**小さいほう**で判定する。組ごとに高々1件。
    const srgbRatio = ratioOfLuminances(
      srgbViewLuminance(foregroundChannels),
      srgbViewLuminance(backgroundChannels),
    );
    const wideGamutRatio = ratioOfLuminances(
      wideGamutLuminance(foregroundChannels),
      wideGamutLuminance(backgroundChannels),
    );
    const ratio = Math.min(srgbRatio, wideGamutRatio);
    const threshold = CONTRAST_THRESHOLDS[pair.target];
    if (ratio >= threshold) {
      continue;
    }
    // 2つの比が完全に等しいとき(16進と許容差の内側の oklch はつねに)は今日の文面のまま。
    // 等しくなければ、表示が同じ字面でも両方を書く(ADR-0472 R-2 軽4 の裁定)。
    const ratioText =
      srgbRatio === wideGamutRatio
        ? `${formatRatio(ratio)}:1`
        : `通常の画面では ${formatRatio(srgbRatio)}:1、広色域の画面では ${formatRatio(wideGamutRatio)}:1`;
    errors.push({
      path: `${pathPrefix}/${pair.foreground}`,
      message: `前景 ${pair.foreground}(${foreground})と背景 ${pair.background}(${background})のコントラスト比は ${ratioText} で、${TARGET_LABEL[pair.target]}の閾値 ${formatThreshold(threshold)} を下回ります。`,
      hint: `どちらかの色を変えて比を ${formatThreshold(threshold)} 以上にしてください。閾値は本文テキスト ${formatThreshold(CONTRAST_THRESHOLDS.text)} と非テキスト ${formatThreshold(CONTRAST_THRESHOLDS["non-text"])} の2つだけです。`,
    });
  }

  return errors;
}
