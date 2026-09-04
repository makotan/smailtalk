/**
 * 決定的な擬似乱数(V1-M1-T05)。
 *
 * ベンチマークの検証方法は「再実行可能で、レポートの数値が再現する」である。
 * データの中身が実行ごとに変わると、DB のファイルサイズも変換の当たり外れも
 * 変わってしまい、数値の再現を主張できない。よって **`Math.random()` を使わず、
 * 固定シードの線形合同法**でデータを作る。
 *
 * 実装は mulberry32(32bit 状態、周期 2^32)。暗号用途ではない。
 * ここで要るのは「同じシードなら同じ列が出ること」だけである。
 */

/** 32bit 状態の決定的な擬似乱数生成器。 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 0 は縮退するので必ず非ゼロにする。
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** [0, 1) の実数。 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [0, max) の整数。 */
  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  /** 配列から1つ選ぶ。空配列は呼び出し側の誤りなので例外にする。 */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("pick: 空の配列からは選べません");
    }
    return items[this.int(items.length)] as T;
  }
}
