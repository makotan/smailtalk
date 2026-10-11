/**
 * **明暗のモードの決め方**(`V20-M10-T03`。計画 `docs/plan/v20/12-v20-m10-plan.md` §9-3 の 2 / §10 の 5、
 * ユーザ決定 `D-V20-16` / `D-V20-31` / `D-V20-32`、`ADR-0458` 限定9)。
 *
 * ## 決め方(このファイルに閉じる)
 *
 * - **覚える場所**: ブラウザのサイト単位の保存領域(`localStorage`)のキー1つ。値は `light` / `dark` の2値
 *   (他の値は無いのと同じ。3つ目のモードを作らない)。**読み書きの例外は握りつぶす** —— 使えない
 *   ブラウザでは「覚えない」になる(切り替えはそのページの中では効く)。**マニフェストにもサーバにも
 *   1バイトも送らない**(語彙に置き場を作らない。`ADR-0458` 限定9)。**全アプリで共通の1つの記憶である。**
 * - **効いているモード** = 覚えた値があればそれ、無ければ OS の設定(変化を購読する)。
 * - **スイッチ** = 効いているモードの反対へ。**反対が OS の設定と同じなら記憶を消し、`<html>` の属性を外す**
 *   (`D-V20-32`)。違えば覚えて、属性を付ける。
 * - **`<html>` の属性の書き手はこのファイルだけである**(`web/test/color-scheme.test.ts` が走査で固定)。
 *   属性の値は2値。付いていなければ OS への追随は `web/src/styles.css` の配色設定の `@media` が受け持つ。
 * - **明るさの強制**(`D-V20-31`): 暗い側の組(`slots_dark`)を持たないテーマのアプリを開いている間、
 *   属性を `light` にする。**記憶は書き換えない。** OS の変化の購読も強制を上書きしない。数えて重ねる
 *   (同じアプリの中で器が張り替わっても外れない)。呼ぶのは製品の器(`AppWorkspace.tsx` の
 *   `AppThemeScope`)だけ —— 取り込みの事前表示と候補の見本からは呼ばない(計画 §10 の 5)。
 * - **別タブの変化は購読しない**(計画 §10 の 12(iii))。別タブで切り替えた結果は、開き直したときに効く。
 * - **【V20-M10 点検 中1 の処置。上の1行を消していない】覚えた値は制御の中に1つ持つ。** 保存領域を読むのは
 *   制御を作るときと、入口で当てるとき(`applyInitialColorScheme()` → `load()`)だけである。描画のたびに
 *   呼ばれる `preferred()` も、強制の掛け外しで走る `apply()` も保存領域を読み直さない(以前は読み直して
 *   いたため、別タブで切り替えた後の無関係な再描画でスイッチの表示と器だけが動き、`<html>` の属性は
 *   動かない、食い違った画面になった)。スイッチは**このタブで見えている側**の反対へ動き、保存領域へ書く。
 *
 * ## 入口
 *
 * `web/src/main.tsx` と `web/src/runner-main.tsx` が最初の描画の前に `applyInitialColorScheme()` を1度呼ぶ
 * (覚えた値がアプリ一覧にも効く)。
 */
import { useSyncExternalStore } from "react";

export type ColorScheme = "light" | "dark";

/** 覚える場所のキー(サイト単位の保存領域)。 */
export const COLOR_SCHEME_STORAGE_KEY = "smailtalk.color-scheme";

/** OS の明暗設定を問い合わせる条件(暗い側)。 */
const OS_DARK_QUERY = "(prefers-color-scheme: dark)";

/** `<html>` に付ける属性の名前(値は `light` / `dark` の2値)。 */
const ATTRIBUTE = "data-theme";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type MediaQueryLike = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
};

/** 外界との接点(検査で差し替えられるように切り出した)。 */
export type ColorSchemeEnvironment = {
  root: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };
  /** 保存領域を返す。取り出しそのものが例外を投げてもよい。 */
  storage: () => StorageLike | null | undefined;
  /** 無い環境では `undefined`(OS を明るいと読む)。 */
  matchMedia: ((query: string) => MediaQueryLike) | undefined;
};

export type ColorSchemeController = {
  /** 効いているモード(制御の中に持つ覚えた値 ?? OS)。強制は含めない。保存領域は読まない。 */
  preferred(): ColorScheme;
  /** 保存領域を読み直して覚えた値を入れ替え、属性を当てて知らせる(入口で当てるとき)。 */
  load(): void;
  /** 明るさを強制しているか。 */
  forced(): boolean;
  /** `<html>` の属性を今の状態に合わせる。 */
  apply(): void;
  /** 反対へ。反対が OS と同じなら忘れる。 */
  toggle(): void;
  /** 明るさを強制する。戻り値を呼ぶと外れる(2度呼んでも1つだけ外れる)。 */
  forceLight(): () => void;
  subscribe(listener: () => void): () => void;
};

function isColorScheme(value: unknown): value is ColorScheme {
  return value === "light" || value === "dark";
}

export function createColorSchemeController(env: ColorSchemeEnvironment): ColorSchemeController {
  const listeners = new Set<() => void>();
  let forceCount = 0;
  /** 覚えた値(制御の中に1つ)。保存領域を読むのは作るときと `load()` のときだけ。 */
  let remembered: ColorScheme | null = null;
  let media: MediaQueryLike | undefined;
  try {
    media = env.matchMedia?.(OS_DARK_QUERY);
  } catch {
    media = undefined;
  }

  function storage(): StorageLike | null {
    try {
      return env.storage() ?? null;
    } catch {
      return null;
    }
  }

  /** 保存領域から読む。使えなければ `undefined`(今の覚えた値を保つ)。 */
  function readStored(): ColorScheme | null | undefined {
    const store = storage();
    if (store === null) return undefined;
    try {
      const value = store.getItem(COLOR_SCHEME_STORAGE_KEY);
      return isColorScheme(value) ? value : null;
    } catch {
      // 使えない保存領域 → そのページの中だけの記憶のまま。
      return undefined;
    }
  }

  function loadStored(): void {
    const value = readStored();
    if (value !== undefined) remembered = value;
  }

  function writeStored(value: ColorScheme | null): void {
    remembered = value;
    const store = storage();
    if (store === null) return;
    try {
      if (value === null) store.removeItem(COLOR_SCHEME_STORAGE_KEY);
      else store.setItem(COLOR_SCHEME_STORAGE_KEY, value);
    } catch {
      // 覚えない。
    }
  }

  function os(): ColorScheme {
    return media?.matches === true ? "dark" : "light";
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  const controller: ColorSchemeController = {
    preferred: () => remembered ?? os(),
    load() {
      loadStored();
      controller.apply();
      notify();
    },
    forced: () => forceCount > 0,
    apply() {
      if (forceCount > 0) {
        env.root.setAttribute(ATTRIBUTE, "light");
        return;
      }
      if (remembered === null) env.root.removeAttribute(ATTRIBUTE);
      else env.root.setAttribute(ATTRIBUTE, remembered);
    },
    toggle() {
      const next: ColorScheme = controller.preferred() === "dark" ? "light" : "dark";
      writeStored(next === os() ? null : next);
      controller.apply();
      notify();
    },
    forceLight() {
      forceCount += 1;
      controller.apply();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        forceCount -= 1;
        controller.apply();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  loadStored();

  media?.addEventListener("change", () => {
    controller.apply();
    notify();
  });

  return controller;
}

let shared: ColorSchemeController | undefined;

/** ブラウザの `window` / `document` に結んだ1つだけの制御(初めて呼ばれたときに作る)。 */
export function colorSchemeController(): ColorSchemeController {
  if (shared === undefined) {
    shared = createColorSchemeController({
      root: document.documentElement,
      storage: () => window.localStorage,
      matchMedia:
        typeof window.matchMedia === "function"
          ? (query: string) => window.matchMedia(query)
          : undefined,
    });
  }
  return shared;
}

/** 入口で最初の描画の前に1度呼ぶ(保存領域を読み直して当てる)。 */
export function applyInitialColorScheme(): void {
  colorSchemeController().load();
}

/** スイッチを押したとき。 */
export function toggleColorScheme(): void {
  colorSchemeController().toggle();
}

/** 明るさの強制(`D-V20-31`)。**製品の器(`AppThemeScope`)だけが呼ぶ。** */
export function forceLightColorScheme(): () => void {
  return colorSchemeController().forceLight();
}

/** 効いているモード(覚えた値 ?? OS)を読み、変わったら描き直す。描画のたびに保存領域を読まない。 */
export function useColorScheme(): ColorScheme {
  const controller = colorSchemeController();
  return useSyncExternalStore(controller.subscribe, controller.preferred, () => "light");
}
