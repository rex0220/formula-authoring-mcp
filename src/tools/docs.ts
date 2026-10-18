/**
 * fml_docs（手順と資料。print-craft MCP の実装案 5.1 ②、5.5）: 作業フォルダーを使わない（互換表の判定も通さない）。読み取りだけ、文章だけ。
 * 説明に利用者の言葉（計算式プラグイン、計算式、自動計算、集計）と「最初に呼ぶ」を書く（print-craft の試作 0-4: あいまいな依頼でも結び付いた）
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { DOCS, indexText, search, sectionKeys, sectionOf, sectionText } from "../docs.ts";
import { failure } from "../result.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerDocs(server: McpServer, _ctx: ServerContext): void {
  server.registerTool(
    "fml_docs",
    {
      title: "計算式プラグインの設定づくりの手順と資料",
      description:
        "kintone の計算式プラグイン（rex0220 formula）で、項目の計算式・自動計算・集計（テーブルの合計、小計、分類ごとの集計、行番号、転記、ユーザー情報）の設定を作る・直す・解説するとき、最初に呼ぶ。手順と資料（読み取りだけ）。" +
        "引数なしで目次（作業の順・決まり・章の一覧）、section でその章、query で資料から探す（関数名、やりたいことの言葉。大きい資料は全部を読まない）。「計算式プラグインの設定」「kintone の計算式を作りたい」「集計したい」と言われたらまずこれ",
      inputSchema: z
        .object({
          section: z.string().min(1).max(60).optional().describe("章の名前（目次の section。例 howto-new、patterns、function-list）"),
          query: z.string().min(1).max(100).optional().describe("探す言葉（関数名、やりたいこと。例 SUMIF、小計）。section と一緒ならその章だけから")
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => {
      if (DOCS.sections.length === 0) return failure("failed", "DocsMissing", "資料が埋め込まれていない（ビルドの誤り）");
      if (input.section !== undefined && !sectionOf(input.section)) {
        return failure("invalid", "UnknownSection", `知らない section: ${input.section}。使える名前: ${sectionKeys().join("、")}`);
      }
      if (input.query !== undefined) {
        const r = search(input.query, input.section);
        if (r.count === 0) return text(`「${input.query}」に合う節は無い${input.section ? `（section: ${input.section}）` : ""}。目次は引数なしの fml_docs`);
        return text(`「${input.query}」に合う節 ${r.count} 件${r.truncated ? "（上限で打ち切った。言葉を絞る）" : ""}:\n\n${r.text}`);
      }
      if (input.section !== undefined) return text(sectionText(sectionOf(input.section)!));
      return text(indexText());
    }
  );
}
