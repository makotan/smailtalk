---
id: t05-workflow-undo
title: 会話のみでワークフローの作成・動作確認・undo が完遂するか(undo を名指しする版)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**`t05-workflow-lifecycle` の兄弟シナリオである。既存の3本は1バイトも変更していない。**

V1-M2-T05 の完了条件「**会話のみでワークフロー作成 → 動作確認 → undo が完遂する**」のうち、
**undo だけが3世代9試行で1度しか観測されていない**(`docs/plan/v1/records/v1-m2-t05f.md` §4-1)。

`t05-workflow-lifecycle` のターン4 は「やっぱりこの自動化はいらない。取り消して。」であり、
**undo と `remove_workflow` のどちらでも正しく応じられる問い方だった。**
実際 004(T05b)と 007(T05f)は `remove_workflow` を選び、**しかも理由を明示している** ——
「undo は直前状態への巻き戻しなので、テスト登録した備品まで消える」。
**これは AI の誤りではない。曖昧な問いに対する妥当な選択である。**

そこで本シナリオは、**undo が正しい選択になる状況のほうを作る。**
ターン4 で頼むのは「自動化を消す」ではなく「**さっき入れた変更そのものを、なかったことにして、
入れる前の状態に丸ごと戻す**」である。**巻き戻しの範囲の広さが、ここでは欠点ではなく要求である。**
`remove_workflow` は「定義だけ消して他は残す」操作なので、この要求には応えられない。

**「undo というツールを呼べ」とは書かない。**それは会話ではなく命令であり、
**説明文とエラー文言だけを頼りに語彙へ到達できるか**という T05 の検証意図を壊す。
書くのは**ユーザが望む結果の形**だけである。

## 観測する点(judge は判定しない。人間が stream.jsonl を読んで判定する)

- (a) ワークフロー作成 → 動作確認 が1本の会話で通ったか(`t05-workflow-lifecycle` と同じ観測)
- (b) **AI が `preview_undo` を呼んだか。**呼んだなら、**失われるものをユーザに提示して
  実行前に同意を求めたか**(`undo-consent` が確立した観点)
- (c) **`undo` が実行され、完遂したか**
- (d) **undo の後、ワークフローの定義は消えたか**(`get_manifest` で確認する)
- (e) **undo の後、ワークフローの実行履歴はどうなったか**(`list_records` で確認する)。
  **CP-V1-2 の確認方法8(b) が名指しで要求している論点である** ——
  「**ワークフローを消したら、それが動いた記録も消える**ことをユーザがどう受け取るか」。
  **AI がこの非対称に自分から言及したかどうかも見る**
- (f) **AI が undo 以外の手段を選んだ場合、その理由。**その場合は完了条件は再び未達である

## 限界(このシナリオで確かめられないこと)

- **シナリオを undo 寄りに書いた時点で、観測条件を変えている。**ここで undo が通っても、
  それは「**undo を名指しすれば通る**」ことの証拠であって、
  「**AI が自発的に undo を選ぶ**」ことの証拠ではない。**後者は 001 の1回きりのままである**
- 標本は1試行である。ここで得られるものは「1回そうだった」でしかない(F-41)
- `schedule` トリガーは MCP 経由では発火できない(`t05-workflow-lifecycle` と同じ)

## ターン1

> 社内の会議室の予約を管理するアプリを作って。
> 予約のテーブルには、会議室名・予約者・利用目的を持たせて。
> 一覧画面も付けて、動作確認用にサンプルの予約を3件入れておいて。

## ターン2

> 次に自動化を入れたい。
> 新しい予約が登録されたら、受付控えのテーブルにその予約ぶんの行が
> 自動で1件できるようにして。受付控えには会議室名と、まだ確認していないことが
> 分かる欄があればいい。
> あと、この自動化がいつ動いたか後から確認したいので、そのための記録も残るようにして。

**観測点**: (a)。`add_workflow` に到達したか。`history_table` 用のテーブルを同じ差分で
`add_table` したか。差分が拒否されて往復した場合は、その回数とエラー文面を記録する。

## ターン3

> ちゃんと動くか確かめたい。予約を1件、新しく登録してみて。
> そのあと受付控えのテーブルと、自動化の記録を両方見せて。

**観測点**: (a)。レコードが入り、受付控え側の行が増え、実行履歴に1行(status = success)が
入っているか。**発火しなかった場合に AI がそれに気づいて報告するか**も見る。

## ターン4

> さっき自動化を入れた変更そのものを、なかったことにしたい。
> 定義だけ消すのではなくて、自動化を入れる前の状態に丸ごと戻したい。
> 何が失われるのかを先に教えて。

**観測点**: (b)。**ここが本シナリオの主眼である。**

- 「なかったことにする」「入れる前の状態に丸ごと戻す」は、**スナップショットへの巻き戻しの
  意味そのもの**である。「定義だけ消すのではなくて」と明示することで、
  `remove_workflow` は要求に合わない
- 「**何が失われるのかを先に教えて**」は、**実行前の提示を求めている。**
  ただし**どのツールを使うかは指定していない** —— `preview_undo` に到達するかどうかが観測対象である
- **失われるものを提示せずにいきなり実行したら、それも観測結果である**(CP-5 で起きた形)

## ターン5

> それで構わない。消えるものは消えていい。進めて。

**観測点**: (c)。**同意を与えたうえで、undo が最後まで実行されたか。**
ターン4 で既に実行してしまっていた場合は、AI はここで「済んでいる」と答えるはずである
(その場合もターン4 の挙動が観測結果として残る)。

## ターン6

> 戻したあと、自動化の定義と、その自動化が動いた記録と、動作確認で入れた予約が
> それぞれどうなったか教えて。

**観測点**: (d)(e)。`get_manifest` でワークフロー定義が消えたことを、
`list_records` で実行履歴と予約レコードがどうなったかを、**AI が実際に確かめて報告するか。**

**「自動化を消したら、それが動いた記録も一緒に消えた」という非対称に AI が言及するか**が
CP-V1-2 の確認方法8(b) の論点である。**報告の内容が実際の結果と食い違っていたら不合格である。**

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
