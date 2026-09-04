# ワークフローのアクション5種 —— 必須キーと、書けるキーの全量

**この表の出所は `schemas/manifest.schema.json` の `$defs/workflow_action` である。**
食い違いを見つけたら、スキーマのほうを信じること。

## アクションに書けるキーの全量(17)

`action` / `table` / `values` / `target` / `connection` / `destination` / `payload` /
`capability` / `prompt` / `input` / `output_field` / `fallback` / `function` /
`output_table` / `write_back` / `write_ops` / `when`

**`action` はどのアクションでも必須。** 18個目の名前を書くと差分全体が拒否される。

## 種別ごとの必須キーと、書けないキー

| `action` | 必須(`action` のほか) | **書けない**キー |
|---|---|---|
| `create_record` | `table`, `values` | `target`, `connection`, `destination`, `payload`, `capability`, `prompt`, `input`, `output_field`, `fallback`, `function`, `output_table`, `write_back`, `write_ops` |
| `update_record` | `table`, `values`, `target` | `connection`, `destination`, `payload`, `capability`, `prompt`, `input`, `output_field`, `fallback`, `function`, `output_table`, `write_back`, `write_ops` |
| `call_external` | `connection`, `destination`, `payload` | `table`, `values`, `target`, `capability`, `prompt`, `input`, `output_field`, `fallback`, `function`, `output_table`, `write_back`, `write_ops` |
| `ai_transform` | `capability`, `prompt`, `input`, `output_field`, `fallback` | `table`, `values`, `target`, `connection`, `destination`, `payload`, `function`, `output_table`, `write_back`, `write_ops` |
| `run_function` | `function` | `table`, `values`, `target`, `connection`, `destination`, `payload`, `capability`, `prompt`, `input`, `output_field`, `fallback` |

**`when` は5種すべてに任意で書ける。**

## `when` の形(これ以外は無い)

```json
"when": { "field": "state", "equals": "open" }
```

- `field` と `equals` の**両方が必須**で、**それ以外のキーは書けない**。
- `field` は**トリガー元レコードのフィールドID**。
- `equals` は文字列 / 数値 / 真偽値のリテラル。
- **一致しないときはそのアクションを飛ばす。飛ばしたことは実行履歴に残る。**
- **【2026-08-25 追記】自動処理を足す差分を「当てずに試す」のにも、
  役割の規則の `target: "app"` / `can: ["write"]` が要るようになった** ——
  **`dry_run_diff` に `apply_diff` とまったく同じ判定が、`intent` の検査より前に掛かる。**
  **役割の規則を1本も書いていないアプリでは、持ち主でも断られる**
  (直し方は `set_roles` で `owner` にその1行を書き戻すこと)。
- **役割の規則(`app.roles[].rules`)の `when` は別のキーである** —— あちらは `and` / `or` / `not` を
  8段まで組め、葉も2形ある。**ここに書けるのは今日も等値1形だけである。**
  - **【2026-08-12 訂正(`V8-M32`。`V8-M26` / ユーザ決定 `D-V8-70`)。直前の1行を1バイトも消していない】**
    **「葉も2形ある」は今日は偽で、あちらの葉は3形ある** —— **3つ目は「その項目が空か」(`is_empty`)である。**
    **こちら(ワークフローの `when`)が等値1形だけであることは今日も変わらない。**

## `values` と `target` の形

```json
"values": { "task": "$record._id", "state": "open", "note": "$record.title" }
```

- **オブジェクト**である(配列ではない)。キーはフィールドID。
- 値はリテラルか `$record.<フィールドID>` の文字列。

`target` が受ける形は**3つだけ**:

1. `$record._id` —— トリガー元のレコード自身を更新する
2. `$record.<reference 型フィールドID>` —— その参照フィールドが指す行を更新する(**1ホップだけ**)
3. UUID のリテラル —— 特定の1行

**`$record.a.b` のような多段は書けない。**

## `trigger` の形

| `type` | 必須 | 書けないキー |
|---|---|---|
| `on_create` | `table` | `at`, `older_than` |
| `on_update` | `table` | `at`, `older_than` |
| `manual` | `table` | `at`, `older_than` |
| `schedule` | `at` = `{ "hour": …, "minute": … }`(**両方必須**) | `table` を書かない場合は `older_than` も書けない |

## 関数(コードの島)の形

| キー | 必須か | 形 |
|---|---|---|
| `id` | 必須 | ID |
| `name` | 必須 | 文字列 |
| `code` | 必須 | JavaScript のソース(1文字以上) |
| `input` | 必須 | `source` が必須。`table` / `view` / `record` の3つだけ |
| `output` | 必須 | `fields` か `ops` の**どちらか一方**(排他) |
| `capabilities` | 任意 | 文字列の配列 |

- `input.source` が `table` → `table` が必須 / `view` → `view` が必須
- `output.fields` の各要素は `id` と `type` が必須。`type` はフィールド型9種のどれか
- **`output.ops` は `run_function` の書込操作モードだけが使う。** 中身の形はスキーマに書かれておらず、
  実行時に検証される

## この参照ファイルが持っていないもの

- **`connection` / `capability` の作り方**。**発行できるのは人間(owner)だけである。**
- **`payload` / `prompt` の中身の書き方**。
- **島のコードの書き方**(サンドボックスで何が使えるか)。
