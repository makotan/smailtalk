/**
 * AI 呼び出しコストの推定(V1-M5-T03 / ADR-0021 §3e)。
 *
 * **これは「推定」である。**モデル別の単価表(入力/出力 100万トークンあたり USD)×
 * トークン数で計算する。実際の請求は単価改定・値引き・最低課金で単価表とずれる
 * (ADR-0021 §8b(d) / §Consequences 限界3)—— 実請求との突合は T05(課金基盤要件)の
 * 担当であり、ここは「メータリングに載せる推定値」を出すだけである。
 *
 * **未知モデルはコスト 0 と推定する。**捏造しない(黙って適当な単価を当てない。憲法6)——
 * 0 と記録し、`isKnownModel` で「単価表に無かった」ことを呼び出し側が知れるようにする。
 * モデルが増えたら単価表に足す(人間の運用。環境変数 `ST_AI_PRICES` で上書き余地も残す)。
 */

/** 100万トークンあたりの単価(USD)。入力と出力で別。 */
export interface ModelPrice {
  /** 入力 100万トークンあたり USD。 */
  inputPerMTok: number;
  /** 出力 100万トークンあたり USD。 */
  outputPerMTok: number;
}

/**
 * 既定の単価表(2026-01 時点の概算。ADR-0021 §3e)。
 *
 * **正確さより「桁が合っていること」を優先する。**メータリングの目的は暴走の検知と
 * 課金軸の判断材料(T05)であり、そこに要るのは請求書の再現ではなく「どのアプリ/ユーザが
 * どれだけ使ったか」の相対比較である。単価は概算で、運用で足し引きできる。
 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "openai/gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "openai/gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
};

/**
 * 有効な単価表を組み立てる。環境変数 `ST_AI_PRICES`(JSON)があれば既定にマージする
 * (`{ "model": { "inputPerMTok": n, "outputPerMTok": n } }`)。
 * **不正な JSON は握りつぶさず既定だけを使う**(起動を止めない。ログは呼び出し側の責務)。
 */
function loadPrices(): Record<string, ModelPrice> {
  const raw = process.env.ST_AI_PRICES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PRICES;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelPrice>;
    return { ...DEFAULT_PRICES, ...parsed };
  } catch {
    return DEFAULT_PRICES;
  }
}

/** そのモデルが単価表にあるか(未知なら推定コストは 0 になる)。 */
export function isKnownModel(model: string): boolean {
  return model in loadPrices();
}

/**
 * トークン数から推定コスト(USD)を出す。
 * **未知モデルは 0 を返す**(`isKnownModel` で判別可能)。捏造しない。
 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = loadPrices()[model];
  if (price === undefined) {
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}
