# BigQuery導入 ステップ手順（PoC：Dinii明細を分析する）

目的：Diniiの生データ（出数・取引明細）をBigQueryに置き、**時間帯別・商品別・滞在時間**を分析できる土台を作る。
今回は **1店舗1営業日ぶんのCSVを1枚入れて、SQLで分析するところまで**（無料枠内・請求ゼロ）。

- プロジェクト名: `tori-analytics`
- リージョン: 東京（`asia-northeast1`）
- 使うファイル: `Downloads/dinii_orders_bq.csv`（整形済み。Shift-JIS→UTF-8・日時ISO化・LINE ID列は除外済み）

---

## ステップ1: Google Cloud プロジェクトを作る

1. https://console.cloud.google.com/ を開く（Workspaceのアカウントでログイン）
2. 上部のプロジェクト選択（左上「Google Cloud」の右）→ **「新しいプロジェクト」**
3. プロジェクト名: **`tori-analytics`** → 作成 → 作成したプロジェクトに切り替え
4. 初回は請求先アカウントの作成を求められることがあります。
   - クレカ登録は必要ですが、**BigQueryは無料枠（毎月ストレージ10GB・クエリ1TB）内なら請求ゼロ**
   - 「無料トライアル」を有効化してもOK

> 会社のWorkspace管理でCloudが制限されている場合は、社長アカウント（管理者）で許可が必要なことがあります。詰まったら画面を見せてください。

---

## ステップ2: BigQuery を開いてデータセットを作る

1. 左上メニュー（≡）→ **BigQuery** を開く（または https://console.cloud.google.com/bigquery ）
2. 左の「エクスプローラ」で **プロジェクト `tori-analytics`** の右の「⋮」→ **「データセットを作成」**
3. 設定:
   - データセットID: **`dinii`**
   - ロケーションタイプ: リージョン → **`asia-northeast1（東京）`**
   - 「データセットを作成」

---

## ステップ3: CSVからテーブルを作る（アップロード）

1. 作った **`dinii`** データセットの「⋮」→ **「テーブルを作成」**
2. 設定:
   - **テーブルの作成元**: 「アップロード」
   - **ファイルを選択**: `Downloads/dinii_orders_bq.csv`
   - ファイル形式: **CSV**
   - テーブル名: **`orders`**
   - **スキーマ**: 「テキストとして編集」をONにして、下の内容を貼り付け:

```
store_id:STRING,business_date:DATE,checkout_at:DATETIME,order_at:DATETIME,check_id:STRING,category_id:STRING,category:STRING,menu_id:STRING,menu:STRING,main_sub:STRING,price_incl:NUMERIC,price_excl:NUMERIC,cost_incl:NUMERIC,cost_excl:NUMERIC,qty:NUMERIC,sales_incl:NUMERIC,discount:NUMERIC,parent_menu_id:STRING,parent_menu:STRING,tax_rate:STRING
```

   - 「詳細オプション」→ **スキップするヘッダー行の数: `1`**
   - 「テーブルを作成」

3. `dinii.orders` に 1,017行 入れば成功。左でテーブルをクリック→「プレビュー」で中身を確認。

---

## ステップ4: 分析SQLを実行してみる

BigQueryの「＋SQLクエリを作成」を押して、以下を貼って実行（▶実行）。

### ① 時間帯別 売上（会計日時ベース）
```sql
SELECT EXTRACT(HOUR FROM checkout_at) AS 時,
       SUM(sales_incl) AS 売上,
       COUNT(DISTINCT check_id) AS 会計数
FROM `tori-analytics.dinii.orders`
GROUP BY 時 ORDER BY 時;
```

### ② 商品別 売上ランキング
```sql
SELECT menu AS 商品,
       SUM(sales_incl) AS 売上,
       SUM(qty) AS 点数
FROM `tori-analytics.dinii.orders`
GROUP BY menu ORDER BY 売上 DESC LIMIT 20;
```

### ③ 分類別 売上
```sql
SELECT category AS 分類, SUM(sales_incl) AS 売上
FROM `tori-analytics.dinii.orders`
GROUP BY category ORDER BY 売上 DESC;
```

### ④ 滞在時間（会計ごと：会計日時 − 初回オーダー）
```sql
SELECT check_id,
       DATETIME_DIFF(MAX(checkout_at), MIN(order_at), MINUTE) AS 滞在分
FROM `tori-analytics.dinii.orders`
GROUP BY check_id
ORDER BY 滞在分 DESC;
```

### ⑤ 会計時間帯 × 平均滞在（時間帯ごとの滞在傾向）
```sql
WITH c AS (
  SELECT check_id,
         EXTRACT(HOUR FROM MAX(checkout_at)) AS 会計時,
         DATETIME_DIFF(MAX(checkout_at), MIN(order_at), MINUTE) AS 滞在分
  FROM `tori-analytics.dinii.orders` GROUP BY check_id )
SELECT 会計時, COUNT(*) AS 会計数, ROUND(AVG(滞在分)) AS 平均滞在分
FROM c GROUP BY 会計時 ORDER BY 会計時;
```

数字が出れば、**BigQueryの土台は完成**です。以降はこの`orders`テーブルに全店・全期間を貯めていくだけで、同じSQLが全店分析になります。

---

## 完了後にやること（私が担当）
- ダッシュボードのGASからBigQueryを叩く配線 → 画面に「時間帯別／商品別／滞在時間」パネルを追加
- Diniiの出数/取引を**定期エクスポート→BQ自動投入**（既存のns-daily-import流用）で日次自動化
- 集計テーブル（agg_日次店舗・agg_時間帯など）で高速化

---

## 困ったとき
- アップロードで文字化け → 使うのは整形済みの `dinii_orders_bq.csv`（UTF-8）。元のShift-JIS版は使わない
- 日時が入らない → スキーマの `checkout_at:DATETIME`・`order_at:DATETIME` と、日付が `2026-07-12 03:57:30` 形式か確認
- 請求が不安 → BigQueryは無料枠内ならゼロ。心配なら「予算アラート」を設定（請求 → 予算とアラート）
