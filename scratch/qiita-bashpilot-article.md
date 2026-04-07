## はじめに

AI にコマンドを実行してもらうとき、こんな不安を感じたことはありませんか？

**「AI が裏で何を実行しているのか見えない」**

Claude Code や他の AI ツールは、バックグラウンドでコマンドを実行して結果だけを返します。便利ですが、本番サーバーを触るときや、重要なファイルを操作するときは不安です。

本稿で紹介する **bashpilot** は、この問題を解決します。AI が実行するすべてのコマンドが、あなたのターミナルにリアルタイムで表示されます。しかも、あなたも同じターミナルでコマンドを打てます。

## bashpilot とは

bashpilot は、AI とユーザーが**同じ bash ターミナル**で作業できる MCP サーバーです。

- AI が送ったコマンドは、あなたのターミナルに表示される
- コマンドの出力もリアルタイムで見える
- あなたも同じターミナルに入力できる（パスワード入力、Ctrl+C での中断など）
- セッション状態（カレントディレクトリ、環境変数、venv など）が保持される

VS Code の[ターミナルシェル統合](https://code.visualstudio.com/docs/terminal/shell-integration)（OSC 633）の技術にインスパイアされ、スタンドアロンの MCP サーバーとして独自に実装しました。

### PowerShell.MCP をお使いの方へ

PowerShell 7 がインストール可能な環境であれば、[PowerShell.MCP](https://github.com/yotsuda/PowerShell.MCP) を強くお勧めします。エンジンレベルの統合により、より安定した動作と豊富な機能を提供します。

bashpilot は、PowerShell 7 をインストールできない環境や、既存の bash スクリプトを AI で実行したい場合に最適です。

## セットアップ

### Claude Code の場合

```bash
claude mcp add bash -- npx bashpilot
```

これだけです。`bash` という名前で MCP サーバーが登録されます。

### Claude Desktop の場合

設定ファイル（Windows: `%APPDATA%\Claude\claude_desktop_config.json`、macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`）に追加します:

```json
{
  "mcpServers": {
    "bash": {
      "command": "npx",
      "args": ["bashpilot"]
    }
  }
}
```

Claude Desktop を再起動してください。

## 実際に使ってみる

### 1. コンソールの起動

AI に何かコマンドの実行を依頼すると、自動的に bash ターミナルが開きます。ウィンドウタイトルには、コンソールの名前が表示されます。

<!-- 📷 写真1: bashpilot のターミナルウィンドウが開いた画面 -->

### 2. コマンドの実行

AI が実行するコマンドは、あなたのターミナルにそのまま表示されます。出力もリアルタイムで流れます。

<!-- 📷 写真2: AI がコマンドを実行し、出力がターミナルに表示されている画面 -->

MCP のレスポンスには、ステータス行が含まれます:

```
✓ #9876 Falcon | Status: Completed | Pipeline: npm install | Duration: 12.34s | Location: /home/user/project
```

### 3. ユーザーがターミナルに介入

これが bashpilot の最大の特徴です。AI がコマンドを実行している最中に、あなたがターミナルで操作できます。

例えば:
- SSH 接続でパスワードを求められたら、あなたが入力する
- AI が間違ったコマンドを実行しそうなら、Ctrl+C で止める
- AI のセットアップが終わった後、手動でコマンドを試す

<!-- 📷 写真3: ユーザーがターミナルでパスワードを入力している画面 -->

### 4. 長時間コマンドのハンドリング

`npm install` や `docker build` のような長時間コマンドも、進捗がリアルタイムで見えます。

タイムアウトしても、コンソール側で実行は継続されます。結果は `wait_for_completion` で取得できます:

```
⧗ #9876 Falcon | Status: Busy | Pipeline: npm install

Use wait_for_completion tool to wait and retrieve the result.
```

### 5. 複数コンソールの自動管理

あるコンソールでコマンド実行中に新しいコマンドを送ると、bashpilot は自動的に別のコンソールに切り替えます。コンソールが閉じられたら検出して、新しいコンソールを起動します。

すべて自動で行われるので、ユーザーは意識する必要がありません。

## ファイル操作ツール

bashpilot には、Claude Code 互換のファイル操作ツールも内蔵されています:

| ツール | 説明 |
|--------|------|
| `read_file` | 行番号付き読み取り（offset/limit/tail 対応） |
| `write_file` | ファイル作成・上書き |
| `edit_file` | 文字列置換（一意性チェック付き、一括置換対応） |
| `search_files` | 正規表現によるファイル内検索 |
| `find_files` | glob パターンによるファイル探索 |

これらは Node.js で直接実装されており、ターミナルを経由しないため安定して動作します。Claude Desktop のようにファイル編集ツールを持たない MCP クライアントでも、コードの閲覧・編集が可能になります。

## 他のツールとの比較

### vs Claude Code の組み込み Bash ツール

| | Claude Code Bash | bashpilot |
|---|---|---|
| コマンドがユーザーに見える | No | **Yes** |
| ユーザーが介入できる | No | **Yes** |
| 進捗がリアルタイムで見える | No | **Yes** |
| セッション永続性 | Yes | Yes |

### vs iterm-mcp（macOS 限定）

| | iterm-mcp | bashpilot |
|---|---|---|
| 共有コンソール | Yes | **Yes** |
| プラットフォーム | macOS + iTerm2 のみ | **Windows / Linux / macOS** |
| 出力キャプチャ | 画面バッファの差分（不正確） | **OSC 633 マーカー（正確）** |
| コンソール管理 | なし | **auto-switch, 出力キャッシュ, claim/revert** |
| ファイル操作ツール | なし | **5 ツール内蔵** |

## 技術的な仕組み

bashpilot は、VS Code の[OSC 633 シェル統合](https://code.visualstudio.com/docs/terminal/shell-integration)にインスパイアされています。bash の `PROMPT_COMMAND` と `DEBUG` trap にフックを仕掛け、コマンドの開始・終了・終了コード・カレントディレクトリをエスケープシーケンスで通知します。

この仕組みに加え、以下の独自機能を実装しています:

- **マルチコンソール管理**: busy/standby 検出、自動切り替え、dead コンソール検出
- **出力キャッシュ**: タイムアウトしたコマンドの結果を保持し、後から取得可能
- **所有権ライフサイクル**: proxy 切断時に unowned 状態に移行し、再接続時に自動 reclaim
- **ソケットベースの discovery**: ファイルシステム上のソケット/ポートファイルを走査してコンソールを発見

## こんな場面で便利

- **本番サーバーの操作**: AI のコマンドをリアルタイムで監視、危なければ即座に Ctrl+C
- **SSH セッション**: AI がコマンドを送り、パスワードはユーザーが入力
- **Docker / Kubernetes**: コンテナ内での操作を AI に任せつつ、進捗を確認
- **Python venv**: `source activate` した環境を AI と共有
- **CI/CD デバッグ**: bash スクリプトの問題を AI と一緒に調査
- **学習**: AI のコマンド実行を見ながら、自分でも試す

## まとめ

bashpilot は、AI とユーザーが同じ bash ターミナルで協調作業できる MCP サーバーです。AI の操作が完全に可視化され、ユーザーはいつでも介入できます。

「AI に任せきり」ではなく「AI と一緒に作業する」— そんな体験を提供します。

- **GitHub**: https://github.com/yotsuda/bashpilot
- **npm**: https://www.npmjs.com/package/bashpilot
- **PowerShell 版**: [PowerShell.MCP](https://github.com/yotsuda/PowerShell.MCP)
