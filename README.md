[English](README-en.md) | [日本語](README.md)

# LINEonLinux

公式Windows版LINEを、**Wine** を使用してLinux上で動かすためのツールです。

> 非公式プロジェクトです。LY Corporation / LINE とは無関係です。
> LINE本体は同梱せず、公式からダウンロードして検証してから実行します。


## 動作環境

- Linux(x86_64)。テストはFedora KDE plasmaで行っています。
- osslsigncode、openssl、curl、python3、xz、Noto Sans CJKフォント
  （`deps.sh` がディストリ別に確認・導入案内をします。その他ツールと
  フォントだけは確認のうえパッケージ導入します。）

## インストール

```bash
./installer.sh            # 通常
./installer.sh --dpi 144  # 高DPIディスプレイ向け（150%）
```

DPIは Wine の LogPixels で、既定は 120（125%）。96=100%、144=150%、
192=200% です。指定した値は `~/.linewine/dpi` に保存され、起動時にも
使われます。起動時だけ変えるなら環境変数が優先します:
`LINEWINE_DPI=120 line-wine`。DPIを変えると次回起動時にレジストリの
互換プロファイルが自動で再適用されます。

## アンインストール

```bash
./uninstall.sh          # ランチャー登録を削除（データは残ります）
./uninstall.sh --purge  # ~/.linewine ごと全部削除（チャット・ログイン情報含む）
```

## 日本語入力

Wine の X11 ドライバは XIM 経由で日本語を受け取るため、起動時に
`launch-line.sh` が次を自動で設定します:

- 実行中の IME を検出して `XMODIFIERS` を設定（fcitx系 → `@im=fcitx`、IBus → `@im=ibus`）
- ロケールが日本語でない場合、`LC_ALL=ja_JP.UTF-8` を設定します。

ホスト側には IBus か fcitx5 が Mozc/Anthy 等と一緒に動いている必要があります。
`./diagnose.sh` で IME の検出状態と ja ロケールの有無を確認できます。
既に自分で設定している `XMODIFIERS` は上書きしません。
自動設定を丸ごと止める場合は `LINEWINE_NO_IME_ENV=1`です。

## 使い方

```bash
line-wine            # 起動（Wine更新で署名が古ければ自動で再署名されます）
./update.sh          # キットの更新＋再署名（LINE本体は自動更新されます）
./diagnose.sh        # 状態確認（署名・フォント・バージョンなど）
```

## 修正したこと

| 問題 | 対策 |
|---|---|
| LINE 26.x の署名チェックで起動拒否 | ローカル証明書で prefix 内 DLL に署名（`compat.sh`） |
| ログイン後に絵文字でクラッシュ | カラー絵文字フォントを Wine から隠す専用 fontconfig ビュー＋ `Segoe UI Emoji` → Symbola 置換 |
| 最大化するとウィンドウが消える | `LINE.exe` の WM 装飾を無効化 |
| 画像ビューアが落ちる | `LineMediaPlayer.exe` の `msvcp140_2` を native 優先に |
| Waylandでウィンドウが透明になる | Wine の描画を X11 ドライバ＋EGL無効に固定（`LINEWINE_KEEP_WAYLAND=1` で解除） |
| ダウンロードが prefix の奥に埋もれる | Windowsのユーザーフォルダを実 XDG フォルダへリンク |
| 文字化け・豆腐 | Noto Sans CJK へのフォント置換、DPI（既定120、`--dpi`で変更可）、RGBスムージング |

## データの場所

```
~/.linewine/
  runners/   ポータブルWine（wine-11.22-amd64、展開後 約850MB）
  prefix/    Wine prefix（LINE本体とチャットデータ。バックアップ対象）
  signing/   ローカル署名証明書と鍵（鍵は 0600）
  cache/     ダウンロードした公式インストーラ
  state/     フォントビュー、署名失敗リスト、最終署名ログ
  app/       導入済みランチャー一式（キットのフォルダを消しても動く）
```

## 環境変数

- `LINEWINE_DIR`（既定 `~/.linewine`）、`LINEWINE_PREFIX`
- `LINEWINE_WINE` — ランナーの代わりに自分のWine（9以上）を使う場合に指定
- `LINEWINE_DPI` — DPIの一時上書き（保存値より優先）
- `LINE_INSTALLER` — 手元の LineInst.exe を使う場合に指定
- `LINEWINE_KEEP_WAYLAND=1` — X11固定をやめる
- `LINEWINE_NO_IME_ENV=1` — 日本語入力まわりの環境変数の自動設定を止める
- `ASSUME_YES=1` — 依存導入の確認を省略

## アンインストール

アプリメニューの登録とランチャーを消し、prefixを消せば完了です
（チャットデータも一緒に消えます。先にバックアップを）。

```bash
rm -f ~/.local/share/applications/line-wine.desktop ~/.local/bin/line-wine
rm -rf ~/.linewine
```

## クレジット

- ポータブルWine: [Kron4ek/Wine-Builds](https://github.com/Kron4ek/Wine-Builds)
  （wine-11.22-amd64 を SHA-256 固定で使用していまう）
