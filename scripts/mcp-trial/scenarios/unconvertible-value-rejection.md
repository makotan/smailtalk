---
id: unconvertible-value-rejection
title: 変換不能値による拒否を実際に踏ませ、AI が _id 一覧を読んで自己修正できるかを見る(V1-M1-T07-b (A))
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**V1-M1-T06 が観測できなかった経路その1 —— 変換不能値による拒否。**

T06 の3試行(008/009/010)で走った型変換は**どちらも `select("1".."5") → number`** であり、
**全ての値が変換できた。**したがって `convert.ts` が実装した
「**全行を事前走査し、変換できない値が1件でもあれば拒否する**」(ADR-0010 §6b / 限定7)
という中核の規則は、**実地では一度も踏まれていない。**自動テストでしか動いていない。

**このシナリオは、その規則を実際に踏ませる。**

## 何を観測するか

1. **拒否が実際に起きるか。** ターン2 の要求は「単位付きの文字列が入った text を number にする」であり、
   `"1200円"` は `Number.parseFloat` を通らない。**拒否されなければ、それ自体が退行である。**
2. **エラー本文の情報が実際に読まれているか。** `collectUnconvertible` のエラーは
   **どの行が該当するかを `_id` 付きで最大5件挙げ**、hint が
   「先に `update_record` / `delete_record` で値を直してから、改めて同じ差分を送れ」と案内する。
   **`allowed_values` に相当する「次に何をすればよいかを機械可読に示す情報」がこの位置に置かれている。**
   AI がこれを読み、**`_id` を使って該当行を直しに行くか。**それとも自分で全件を再走査し直すか。
3. **6件中に変換できる値も混ぜてある。** `"980"` は変換できる。
   **AI が「全件書き換える」ではなく「該当した行だけ直す」を選べるか。**
4. **ターン3 は同意の付与である。**手順の指示ではない。
   **自己修正した差分が実際に apply まで到達するか**を見る。
5. **拒否の説明の質。** 「変換できませんでした」で終わらず、
   **どの行のどの値がなぜ駄目なのかをユーザの言葉で伝えるか。**

## 到達を妨げうる経路(先に書いておく)

1. **AI がターン1 で金額を `number` 型で作ってしまう。** 人間ターンは
   「『1200円』とか『だいたい3000円』とか書いたまま残したい」と明示しているので
   text を選ぶのが自然だが、**AI が勝手に number にしたらシナリオの前提が壊れる。**
   その場合は**到達不能として記録し、シナリオを直すのではなく、そう記録する。**
2. **AI が変換不能を dry-run で予見し、拒否を踏む前に自分で先回りして直す。**
   **それは望ましい挙動であって未到達ではない。**ただしその場合
   「カーネルの拒否メッセージを読んで自己修正した」ことは観測できない。**そう記録する。**
3. **AI が `update_record` ではなく「金額(数値)」フィールドを新設して並行させる。**
   `OUT_OF_SCOPE_BEHAVIOR` の「元に戻せる代替案を先に示せ」に沿った判断でありうる。
   **どちらを選んだか、理由を述べたかを記録する。**

## ターン1

> 支出のメモを付けたい。日付と、何に使ったかと、金額を記録できるようにして。金額は「1200円」とか「だいたい3000円」とか、あとで自分が思い出せるように書いたまま残したいから、文字でいい。一覧の画面もほしい。それっぽいのを6件くらい入れといて。

## ターン2

> やっぱり月ごとの合計を出したいから、金額を数値に変えて。

## ターン3

> うん、それでいい。直して進めて。

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
