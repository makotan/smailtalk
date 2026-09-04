---
id: ec-catalog-cart
title: EC 代表スライスを対話だけで組む(カタログ / カート / 注文)— D-M7a ハイブリッドのライブ側
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**V2-M7-T04(D-M7a ハイブリッドのライブ側)のシナリオである。** 記録は
`docs/plan/v2/records/v2-m7.md` §1 V2-M7-T04。

人間(ネットショップを始めたい店主)が**自然な会話だけ**で、AI に MCP ツールだけを使わせて
リファレンス EC アプリの**代表スライス**を組ませる。代表スライスは3つの部分からなる。

- **ターン1 = カタログ**: 商品テーブル + カテゴリテーブル + 誰でも見られる公開一覧ビュー
  (EC-G1 公開閲覧。商品が category を参照する)。
- **ターン2 = カート**: カートテーブル + カート明細テーブル + 商品画面からの「カートに入れる」
  操作起点(EC-G14 actions プリフィル。明細が商品を参照し個数を持つ)。
- **ターン3 = 注文**: 注文テーブル + 注文明細テーブル + 注文が作られたときに自動で状態を
  付ける on_create ワークフロー(EC-G5/自動化。手作業なしで状態が入る)。

**このライブ試行が担うのは「AI が対話で EC を組めること」の確認だけである。** 全機能セット・
4決済経路・チェックアウトの原子性・受信の署名検証・timeout 欠落の非補償は**決定論 E2E
(V2-M7-T03)が担う**。ライブでは誘発できないそれらの範囲は T03 が持つことを、CP-V2
エビデンスに正直に分離記録する(cp-v1-9 §10 と同型)。

**プロンプトには JSON もマニフェストの断片も型名も一切書かない**(prompt-lint.ts が弾く)。
完成形を貼れば AI は転記するだけになり「対話だけで組めた」という主張が崩れる。人間が渡すのは
「何が欲しいか」という業務の言葉だけで、テーブル・フィールド型・ビューの形・ワークフローの
語彙は**すべて AI が選ぶ**。M7 はカーネル語彙をひとつも足さない実証ゲートなので、AI が
既存語彙(リソース7 / 型8 / diff 15)だけで組み切れることを見る。

**データルート**: 既定の `data-ec-catalog-cart` で完結する(3ターンとも同じアプリを育てるので、
他シナリオとの共有は不要。`--data-root` を明示しなくても衝突しない)。

## ターン1

> ネットショップを始めたいので、まずはお客さんに見せる商品カタログを作ってほしい。
> 売る商品には、名前・値段・在庫数・簡単な紹介文を持たせたい。
> 商品はカテゴリで分類したいので、カテゴリも一緒に用意して、どの商品がどのカテゴリかを結びつけて。
> そして、まだログインしていない訪問者でも、商品の一覧をそのまま見て回れるようにして。
> 動作確認できるよう、カテゴリがばらける商品サンプルを何点か入れておいて。

## ターン2

> 気に入った商品を、お客さんがカゴにためていけるようにしたい。
> お客さんごとに自分のカゴがあって、そこに商品をいくつか入れられて、商品ごとに個数も持てるようにして。
> それと、商品の画面から「カートに入れる」ですぐそのカゴに追加できると、お客さんが迷わなくて助かる。

## ターン3

> 買うと決めたら注文として残したい。
> 注文には、注文したお客さん・状態・いつの注文かを持たせて、
> どの商品を何個買ったのかを注文の明細としても残るようにして。
> あと、注文が入ったら状態を自動で「受付済み」にしてほしい。毎回わたしが手で直すのは面倒なので。

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
