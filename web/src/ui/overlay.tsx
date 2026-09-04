/**
 * **重ねて出す器3つ**(`V4-M18-T01`。`ADR-0094` 限定1〜限定10)。
 *
 * ## これは何で、何ではないか(**最初に固定する**)
 *
 * - **器を作るだけである。** **AI が書く語彙は1つも増えない**(`ADR-0094` 限定1)——
 *   `RESOURCE_KINDS` 7 / `FIELD_TYPES` 8 / `DIFF_OPS` 16 / `$defs` 28 / `$defs/theme` 25・25 /
 *   `$defs/field` 11 に1バイトも触っていない。**本ファイルは `schemas/` を1バイトも参照しない。**
 * - **どの画面を重ねて出すかを宣言するのは [`ADR-0095`](../../../docs/adr/0095-modal-view-declaration.md)
 *   であり、当てるのは `V4-M18-T04` である。** **本ファイル単体では、画面は1枚も重ならない。**
 * - **【禁止】「AI が部品を選べるようになった」と書かない。** **`P-G26` は 2026-08-03 に
 *   4回目の却下である**(`ADR-0096`)。**器の選択はマニフェストに1バイトも現れない。**
 * - **【禁止】「9プロパティの禁止を守ったまま重ねて出す器を作った」と書かない**
 *   (`ADR-0087` §3 の総括の禁止7 / `ADR-0094` §Decision 3 の 1)。
 *   **禁止が及ぶのは手で書く CSS(`web/src/styles.css`)だけであり、**
 *   **本ファイルの器は `fixed` / `inset-0` / `z-…` / `-translate-…` を使う。**
 *   **書けるのは「手で書く CSS の中では9プロパティを1つも使わない」までである。**
 *
 * ## 器は3つだけである(`ADR-0094` 限定2)
 *
 * | 器 | 何のためか | 出どころ |
 * |---|---|---|
 * | `OverlayDialog` | **今の画面を離れずに別の判断を求める**(`P-G14` の (B) 側) | `@base-ui-components/react/dialog` |
 * | `OverlayMenu` | **選べる操作が多いときに畳んで出す**(`P-G18`) | `@base-ui-components/react/menu` |
 * | `OverlayNotice` | **操作の結果を今の画面のまま知らせる**(`P-G16`) | `@base-ui-components/react/toast` |
 *
 * **4つ目(タブ / ポップオーバー / ツールチップ / サイドシート / コマンドパレット など)を
 * 1つも作らない。** 足す提案は改めて `ADR-0007` の門A を通し、`ADR-0094` と同格の個別 ADR を
 * 新規に書くこと。**`ADR-0094` に追記しない。**
 *
 * ## 依存を1本も足していない(`ADR-0094` 限定5)
 *
 * **`@base-ui-components/react`(`1.0.0-rc.0`)は着手前から `dependencies` に在る。**
 * `package.json` にも `bun.lock` にも1本も足していない(検査は `web/test/dependency-freeze.test.ts`)。
 * **`ADR-0087` 限定5(chart / recharts / d3 / victory / nivo)を1バイトも動かしていない。**
 *
 * ## **アクセシビリティ —— 既定で備わっていたもの / 自分で書いたもの**(`ADR-0094` 限定8)
 *
 * **`ADR-0094` §6 の 3 は「`dialog` を1度も import していない。備えていなければ本判定は
 * 差し戻しである」と自認していた。** **`V4-M18-T01` が実際に import して測った。**
 * **全件は `docs/plan/v4/records/v4-m18-impl.md` §A に在る。要点は次のとおりで、隠さない。**
 *
 * | 限定8 が求めるもの | Base UI の既定 | 本ファイル |
 * |---|---|---|
 * | 小窓に `role="dialog"` | **備える** | そのまま |
 * | 小窓に `aria-modal="true"` | **備えない** —— 外側を `data-base-ui-inert` + `aria-hidden="true"` で隠す作りで、`aria-modal` 属性は出ない | **本ファイルが明示的に書いている** |
 * | 小窓のフォーカストラップ | **備える**(`data-base-ui-focus-guard` の番人2つ + 外側の `aria-hidden`) | そのまま |
 * | 小窓が `Escape` で閉じる | **備える** | そのまま |
 * | 閉じたら開いた元へフォーカスを戻す | **備える** | そのまま |
 * | メニューに `role="menu"` / `role="menuitem"` | **備える** | そのまま |
 * | メニューの矢印キーの移動 | **備える**(ローミング `tabindex` + `data-highlighted`) | そのまま |
 * | 知らせに `role="status"` | **備えない** —— 素の `Toast.Root` は `role="dialog" aria-modal="false"` を出す(囲みの `Toast.Viewport` が `role="region" aria-live="polite"` を持つ) | **本ファイルが明示的に上書きしている** |
 *
 * > **【禁止】「Base UI がアクセシブルだった」と書かない。** **8点のうち2点は本製品の側で書いた。**
 * > **【禁止】「アクセシブルな器が入った」と総括しない**(`ADR-0094` §Decision 3 の 5)——
 * > **読み上げソフトを1度も動かしていない。** 測ったのは属性と、フォーカスがどこに在るかだけである。
 *
 * ## 配色は25スロットからの導出だけで決める(`ADR-0094` 限定7)
 *
 * **色のリテラル(`#…` / `rgb(` / `oklch(`)を1バイトも書かない。** 使うのは
 * `bg-popover` / `text-popover-foreground` / `bg-background` / `text-foreground` / `border-border`
 * などの**導出済みの名前**だけである(`web/src/tailwind.css` の `@theme inline`)。
 * **`$defs/theme` の25スロットを1つも増やしていない。**
 *
 * ## 重ね順は段の名前だけで書く(`ADR-0094` 限定4)
 *
 * **`z-index` の生の数値を1つも書かない。** 書けるのは `z-(--layer-overlay)` と
 * `z-(--layer-notice)` の2つだけである(定義は `web/src/tailwind.css`)。
 *
 * ## ダークモードを実装していない(`ADR-0094` 限定10 / `D-V4-43`)
 *
 * `prefers-color-scheme` / `[data-theme]` / `light-dark()` / `color-scheme:` / `dark:` を
 * 1バイトも書いていない。
 *
 * ## `undo` の射程外である(`ADR-0094` §6 の 5)
 *
 * **本ファイルの変更は changelog にも undo にも1バイトも残らない。**
 */
import { Dialog } from "@base-ui-components/react/dialog";
import { Menu } from "@base-ui-components/react/menu";
import { Toast } from "@base-ui-components/react/toast";
import type * as React from "react";
import { cn } from "./utils.ts";

/**
 * **器の名前の全量**(`ADR-0094` 限定2 の機械的固定の当たり先)。
 *
 * **4つ目をここに足したら、それは限定2 を破ることである。**
 * 数える検査は `web/test/overlay.test.tsx` の (T01-1) が持つ。
 */
export const OVERLAY_CONTAINERS = Object.freeze([
  "OverlayDialog",
  "OverlayMenu",
  "OverlayNotice",
] as const);

/**
 * 背面。**器の外側を暗くするのではなく、器の外側の操作を受け止めるだけである** ——
 * **不透明度を持たない**(`ADR-0046` 限定2 の第3列が「8つ目の軸(… 不透明度 …)を足さない」と
 * 定めており、背面の濃さはテーマの語彙のどこにも置き場が無い)。
 */
const BACKDROP_CLASS = cn("fixed inset-0", "z-(--layer-overlay)");

/** 器の面。**配色は導出済みの名前だけで書く。** */
const SURFACE_CLASS = cn(
  "rounded-ui border-[length:var(--border-width)] border-solid border-border",
  "bg-popover text-popover-foreground font-sans shadow-surface",
  "group-data-[ui-family=compact]/ui:rounded-none",
);

// ---------------------------------------------------------------------------
// 1. 重ねて出す小窓
// ---------------------------------------------------------------------------

export type OverlayDialogProps = {
  /** 小窓の題。**読み上げの役に名前を付けるため必須である**(`aria-labelledby` で結ぶ)。 */
  readonly title: React.ReactNode;
  /** 開く操作の中身。省略すると、開閉は `open` / `onOpenChange` の側だけで決まる。 */
  readonly trigger?: React.ReactNode;
  /** 制御する場合の開閉状態。省略すると器が自分で持つ。 */
  readonly open?: boolean | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * **器を差し込む先**(`V4-M18-T04` が chromium で実測して足した)。
   *
   * **省略すると `document.body` の直下に差さる** —— **そこはアプリ単位テーマのスコープ要素
   * (`.app-theme`)の外である。** `AppWorkspace` の `AppThemeScope` は25スロットを
   * **inline `style`** でその要素に立てるので、**外へ出した器にはアプリのテーマが1つも届かず、
   * `:root` の既定値で描かれる**(2026-08-03 に chromium で実測: `popupInsideScope: false`)。
   * **逃げ道(任意 CSS)も届かない** —— `ViewHost` はそれを `.app-theme { … }` の入れ子に
   * 包んで配るからである(`ADR-0055` 限定13)。
   *
   * **したがって、テーマを当てたい呼び出し側は `.app-theme` の要素をここに渡すこと。**
   * `position: fixed` は祖先が包含ブロックを作らない限りビューポート基準のままである ——
   * **`.app-theme` の `transform` / `filter` / `contain` はいずれも `none` である**(実測)。
   */
  readonly container?: HTMLElement | null | undefined;
  readonly children: React.ReactNode;
};

/**
 * **今の画面を離れずに別の判断を求める器**(`P-G14` の (B) 側)。
 *
 * **`aria-modal="true"` は明示的に書いている**(Base UI の既定では出ない。冒頭の表)。
 */
export function OverlayDialog({
  title,
  trigger,
  open,
  onOpenChange,
  container,
  children,
}: OverlayDialogProps) {
  return (
    // **`modal` は Base UI の既定(`true`)をそのまま使う** —— 焦点の閉じ込め・
    // 画面送りの固定・外側への操作の遮断が、この1つの既定で同時に効く。
    // **閉じ方を選ぶ口を作っていない**(`Escape` と背面クリックの両方が効く)——
    // **増分を有限に限るためであり、閉じ方を選べるようにする提案は改めて門A である。**
    <Dialog.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
      modal={true}
    >
      {trigger === undefined ? null : (
        <Dialog.Trigger data-slot="overlay-dialog-trigger">{trigger}</Dialog.Trigger>
      )}
      <Dialog.Portal container={container ?? undefined}>
        <Dialog.Backdrop data-slot="overlay-dialog-backdrop" className={BACKDROP_CLASS} />
        <Dialog.Popup
          data-slot="overlay-dialog"
          // **明示的に書く** —— Base UI の既定では出ない(実測。冒頭の表)。
          aria-modal="true"
          className={cn(
            // **座標系プロパティを使う。** 手で書く CSS には1バイトも書いていない。
            "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
            "z-(--layer-overlay)",
            "flex max-h-[90vh] w-[min(32rem,calc(100vw-2rem))] flex-col gap-s3 overflow-auto p-s4",
            "outline-none focus-visible:outline-[length:var(--focus-outline-width)] focus-visible:outline-solid focus-visible:outline-ring",
            SURFACE_CLASS,
            "group-data-[ui-family=compact]/ui:gap-s2 group-data-[ui-family=compact]/ui:p-s2",
          )}
        >
          <Dialog.Title data-slot="overlay-dialog-title" className="m-0 font-semibold leading-none">
            {title}
          </Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// 2. 開くメニュー
// ---------------------------------------------------------------------------

export type OverlayMenuItem = {
  readonly label: React.ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean | undefined;
};

export type OverlayMenuProps = {
  readonly trigger: React.ReactNode;
  /**
   * 項目。**「有限の一覧を畳んで出す」ための器であり、入れ子のメニューを1段も持たない** ——
   * 入れ子を足す提案は改めて門A である(`ADR-0094` §Decision 4 の 1 と同じ向き)。
   */
  readonly items: readonly OverlayMenuItem[];
};

/** **選べる操作が多いときに畳んで出す器**(`P-G18`)。 */
export function OverlayMenu({ trigger, items }: OverlayMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger data-slot="overlay-menu-trigger">{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          data-slot="overlay-menu-positioner"
          className="z-(--layer-overlay)"
          sideOffset={4}
        >
          <Menu.Popup
            data-slot="overlay-menu"
            className={cn(
              "flex min-w-[10rem] flex-col p-s1",
              "outline-none focus-visible:outline-[length:var(--focus-outline-width)] focus-visible:outline-solid focus-visible:outline-ring",
              SURFACE_CLASS,
            )}
          >
            {items.map((item, index) => (
              <Menu.Item
                // biome-ignore lint/suspicious/noArrayIndexKey: 項目は安定IDを持たず、定義位置が同一性である(detail-actions と同じ扱い)
                key={index}
                data-slot="overlay-menu-item"
                disabled={item.disabled ?? false}
                onClick={item.onSelect}
                className={cn(
                  "cursor-default rounded-ui px-s2 py-s1 text-sm",
                  "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
                  "group-data-[ui-family=compact]/ui:rounded-none group-data-[ui-family=compact]/ui:px-s1 group-data-[ui-family=compact]/ui:text-xs",
                )}
              >
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// ---------------------------------------------------------------------------
// 3. 一時的な知らせ
// ---------------------------------------------------------------------------

/**
 * 知らせを1本出す。**`OverlayNotice` の内側でだけ使える。**
 *
 * **文字列1つしか受けない** —— 見出しと本文に割る / 操作ボタンを添える / 出しっぱなしにする、を
 * 1つも作らない(**増分を有限に限る**。足す提案は改めて門A である)。
 */
export function useOverlayNotice(): (message: string) => void {
  const manager = Toast.useToastManager();
  return (message: string) => {
    manager.add({ title: message });
  };
}

/**
 * **操作の結果を今の画面のまま知らせる器**(`P-G16`)。
 *
 * **`role="status"` は明示的に上書きしている**(Base UI の既定は `role="dialog"`。冒頭の表)。
 * **囲みは `aria-live="polite"` の生きた領域であり、これは Base UI の既定である。**
 */
export function OverlayNotice({ children }: { readonly children: React.ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          data-slot="overlay-notice-viewport"
          className={cn(
            // **座標系プロパティを使う。** 手で書く CSS には1バイトも書いていない。
            "fixed right-s3 bottom-s3",
            "z-(--layer-notice)",
            "flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-s2",
          )}
        >
          <OverlayNoticeList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

/** 出ている知らせを並べる。**器の一部であって、4つ目の器ではない**(export していない)。 */
function OverlayNoticeList() {
  const { toasts } = Toast.useToastManager();
  return (
    <>
      {toasts.map((toast) => (
        <Toast.Root
          key={toast.id}
          toast={toast}
          data-slot="overlay-notice"
          // **明示的に上書きする** —— Base UI の既定は `role="dialog" aria-modal="false"`(実測)。
          role="status"
          className={cn("flex items-start gap-s2 p-s3 text-sm", SURFACE_CLASS)}
        >
          <Toast.Title className="m-0 font-medium" />
          <Toast.Close
            data-slot="overlay-notice-close"
            aria-label="閉じる"
            className={cn(
              "ml-auto shrink-0 cursor-default rounded-ui px-s1 text-sm",
              "outline-none focus-visible:outline-[length:var(--focus-outline-width)] focus-visible:outline-solid focus-visible:outline-ring",
            )}
          >
            ×
          </Toast.Close>
        </Toast.Root>
      ))}
    </>
  );
}
