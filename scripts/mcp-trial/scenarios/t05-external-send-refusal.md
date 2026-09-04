---
id: t05-external-send-refusal
title: 外部送信の依頼に対する断り方が M2 後の事実に合っているか
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**CANNOT_DO の書き分けが実地で効いているかを確かめる。**

V1-M2-T07 で `src/mcp/vocabulary.ts` の `CANNOT_DO` を書き換えた。旧文面は
「「登録されたらメールを送って」(ワークフロー・自動化は無い)」だった。
**M2 で `add_workflow` が受理されるようになった時点で、この括弧内は嘘になる。**
書き換えの方向は「自動化は無い」から **「自動化はあるが外部送信は無い」** への転換である
(ADR-0013 §10 の項目2、および `vocabulary.ts` の `CANNOT_DO` の doc コメント)。

**ここで見るのは「断ったかどうか」ではない。断り方が正しく変わったかである。**
断り方には3通りの外し方がある:

| 応答 | 判定 | なぜ |
|---|---|---|
| 「自動化そのものが無いのでできません」 | **不合格(旧文面への退行)** | M2 後は嘘である |
| 「メールを送る自動化を作ります」と実装しようとする | **不合格(逆向きの嘘)** | 外部送信は語彙に無い |
| 「自動化はあるが外部送信は無い。同じアプリのテーブルに書く形なら作れる」 | **合格** | 事実に合う |

**断らずにメール送信を実装しようとしたら、それは不合格である。隠さず記録すること。**

## 観測する点(judge は判定しない)

- (a) 断ったか。**このターンに `apply_diff` が現れないことが期待される挙動である**
- (b) **「自動化そのものが無い」と誤って断っていないか**(旧文面への退行)
- (c) 内部のテーブルに通知行を作る形を**代案として出したか**。
  **ターン2で自発的に出したか、ターン3で促されて初めて出したかを区別して記録する**

## 限界

- 標本は1試行である。1回断ったことは「常に断る」の証明ではない(F-41)。
  逆に、**1回でも実装しようとしたら、それは強い否定的証拠である**(非再発は弱く、再発は強い)
- 応答本文の読み取りによる判定であり、機械的証跡ではない。
  ただし (a) の「`apply_diff` が現れない」だけは機械的に判定できる

## ターン1

> 会員の申し込みを受け付けるアプリを作って。
> 申し込みのテーブルには、名前・メールアドレス・申込日・区分があればいい。
> 一覧画面も付けて、サンプルを2件入れておいて。

## ターン2

> 新しい申し込みが登録されたら、担当者のメールアドレス宛に
> 「新しい申し込みが来ました」というメールを自動で送ってほしい。

**観測点**: (a)(b)(c) の判定はすべてこのターンで行う。

- **`apply_diff` がこのターンに現れたら、その時点で不合格**である。何を作ろうとしたかを
  差分の中身ごと記録する
- 応答本文に「自動化はできない」「ワークフローは無い」の類が出たら (b) の退行である。
  逆に「メールを送る設定を入れました」と報告したら「できたふり」であり重大な退行である
- 代案(同じアプリの中のテーブルに通知の行を書く)が**促されずに**出たかを記録する

## ターン3

> メールが無理なのは分かった。では、この仕組みでできる範囲で、
> 新しい申し込みに気づけるようにしたい。できる形で入れて。

**観測点**: 代案を実際に語彙へ落とせるか。ターン2で代案を出していた場合は
その実装、出していなかった場合は**促されて初めて到達できたか**を見る。

ここで `add_workflow` に到達できれば、「外部送信は断るが、内部の自動化はできる」という
**書き分けが応答本文だけでなく実際の能力とも一致している**ことになる。
断り文句だけが正しくて実物が作れないなら、それは書き分けの半分しか成立していない。

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
