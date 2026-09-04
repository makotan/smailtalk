---
id: unconvertible-value-sortable
title: 変換不能値による拒否のあと、AI が _id を使って自己修正できるか(V1-M1-T07-b (A) 2本目)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**`unconvertible-value-rejection`(011)の2本目。1本目を書き換えずに、別シナリオとして立てる。**

011 は**変換不能値の拒否を実地で発火させることには成功した**が、
**AI が `_id` を使って `update_record` で自己修正する経路には到達しなかった。**
原因は**シナリオを書いた側の設計欠陥**である —— 型変換の動機を
「**月ごとの合計を出したいから**」と書いてしまい、**集計は語彙外**なので、
AI が「型を変えても目的は達成できない。変更しないことを推す」と正しく判断して止まった。

**動機を語彙内のものに差し替える。**010(`destructive-consent-granted`)が
同じ `change_field` を成立させたときの動機は「**並べ替え**の順番が気持ち悪いから」であり、
**並べ替えはビューの `sort` として語彙内にある。**それに揃える。

**011 を破棄しないこと。**「動機が語彙外だと破壊的変更そのものが回避される」という
011 の観測は、それ自体が独立した知見である。

## 何を観測するか

1. **拒否が発火するか**(011 で確認済み。再現性の確認)。
2. **★ 本命: `_id` を使った自己修正が起きるか。** エラーは該当行を `_id` 付きで最大5件挙げ、
   hint は「先に `update_record` / `delete_record` で該当レコードの値を直してから、
   改めて同じ差分を送ってください。**どの行がそれかは上の _id で分かります**」と案内する。
   **AI がこの `_id` をそのまま `update_record` に渡すか。**
   それとも `list_records` で全件を取り直すか。**どちらかを記録する。**
3. **打ち切られた6件目をどう扱うか。** `UNCONVERTIBLE_SAMPLE_LIMIT = 5` なので
   エラーに出るのは5件で、6件目は「ほか 1 件」としか書かれない。
   **`_id` が分からない1件を AI がどう見つけるか**が観測点である
   (`list_records` で補うのが正しい)。**これは 011 では観測できなかった。**
4. **失われるニュアンスについて同意を取るか。**「だいたい」「ちょっと」「くらい」は
   数値化すると消える。**これは `remove_field` とは別種の損失(値の書き換え)である。**
5. **修正後に改めて同じ差分を送り、apply まで到達するか。**

## 到達を妨げうる経路(先に書いておく)

1. **AI が「並べ替えのためだけに6件を書き換えるのは割に合わない」と判断して止まる。**
   011 と同じ形の停止である。**その場合も未到達として記録する。**
   ただし並べ替えは語彙内なので、011 と違って**目的は達成可能**である。
2. **AI が変換不能を先回りして予見し、拒否を踏む前に `update_record` を済ませる。**
   **望ましい挙動である。**ただしその場合「拒否メッセージを読んで自己修正した」は観測できない。
3. **AI が金額フィールドを新設する案(011 の A 案)を採る。** それも正しい判断でありうる。

## ターン1

> 支出のメモを付けたい。日付と、何に使ったかと、金額を記録できるようにして。金額は「1200円」とか「だいたい3000円」とか、あとで自分が思い出せるように書いたまま残したいから、文字でいい。一覧の画面もほしい。それっぽいのを6件くらい入れといて。

## ターン2

> 一覧を金額の大きい順に並べたいんだけど、いまの持ち方だと順番がめちゃくちゃになる。金額を数値にして、ちゃんと並ぶようにして。

## ターン3

> うん、それでいい。進めて。

## ターン4

> いま金額のところ、どうなってる?

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
