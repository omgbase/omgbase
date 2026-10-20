// `FROM` sources (Dataview "Sources": folders, tags, links, `outgoing()`,
// `csv()`, combined with `and` / `or` / `-` and parentheses) → one OQX `where`
// conjunct over the row's document. Dataview's sources are expressions that
// pick pages; OQX picks rows with `where`, so every source is a predicate:
//
//   "folder"            _path.startsWith("/folder/") — or, for a note, _path == "/note.md"
//                       (a bare string is either, so both are tested)
//   #tag                _tags exists { where $it == "tag" or $it.startsWith("tag/") }
//                       (nested tags: Dataview's #tag includes #tag/sub)
//   [[note]]            pages that LINK TO note: _out_links exists { where _dst._path == "/note.md" }
//   outgoing([[note]])  pages note LINKS TO: _in_links exists { where _doc._path == "/note.md" }
//   csv("f.csv")        unsupported
//   a and b, a or b, -a and / or / not of the above
//
// On a TASK query the row is a block, and the document's attributes and
// relations are reached through the `_doc` handle (`_doc._tags`,
// `_doc._out_links`, `_doc._in_links`).

import { build, type Expr, type Where } from "@omgbase/oqx";
import type { Source } from "./ast.ts";
import { at, linkPath, type Ctx } from "./context.ts";
import { unsupported } from "./errors.ts";
import { conjoin, disjoin } from "./oqx.ts";

const lit = build.lit;
const ident = build.ident;
const member = build.member;

/** An engine name of the row's document: bare on docs, through `_doc` on a block. */
function docAttr(ctx: Ctx, name: string): Expr {
  return ctx.target === "blocks" ? member(ident("_doc"), name) : ident(name);
}

export function sourceWhere(s: Source, ctx: Ctx): Where {
  switch (s.kind) {
    case "and": return conjoin([sourceWhere(s.left, ctx), sourceWhere(s.right, ctx)])!;
    case "or": return disjoin([sourceWhere(s.left, ctx), sourceWhere(s.right, ctx)]);
    case "not": return build.not(sourceWhere(s.source, ctx));
    case "csv": throw unsupported('FROM csv("…")', "a CSV file is not an omgbase document", at(ctx, s));
    case "folder": return folderWhere(s.path, ctx);
    case "tag": return tagWhere(s.tag, ctx);
    case "link": {
      const p = linkPath(ctx, s.target, s);
      const dstPath = member(ident("_dst"), "_path");
      const test = "exact" in p ? build.binary("==", dstPath, lit(p.exact)) : build.call(dstPath, "endsWith", [lit(p.suffix)]);
      return build.op(docAttr(ctx, "_out_links"), "exists", build.subquery({ where: build.scalar(test) }));
    }
    case "outgoing": {
      const p = linkPath(ctx, s.target, s);
      const srcPath = member(ident("_doc"), "_path");
      const test = "exact" in p ? build.binary("==", srcPath, lit(p.exact)) : build.call(srcPath, "endsWith", [lit(p.suffix)]);
      return build.op(docAttr(ctx, "_in_links"), "exists", build.subquery({ where: build.scalar(test) }));
    }
  }
}

/** `FROM "x"`: the folder `x` (every nested document) or the note `x`. The
 * empty string is the whole vault. A string with an extension is one note; one
 * without is tested as both, since Dataview resolves it against the vault. */
function folderWhere(raw: string, ctx: Ctx): Where {
  const path = raw.trim().replace(/^\/+|\/+$/g, "");
  const field = docAttr(ctx, "_path");
  if (path === "") return build.scalar(lit(true));
  if (/\.[A-Za-z0-9]+$/.test(path)) return build.scalar(build.binary("==", field, lit(`/${path}`)));
  return build.or([
    build.scalar(build.call(field, "startsWith", [lit(`/${path}/`)])),
    build.scalar(build.binary("==", field, lit(`/${path}.md`))),
  ]);
}

/** `FROM #tag`: the tag itself or a nested `tag/…` (omgbase stores tags bare,
 * without `#`; `_tags` is the authored list ∪ the body's hashtags). */
export function tagWhere(tag: string, ctx: Ctx): Where {
  const bare = tag.replace(/^#/, "");
  return build.op(docAttr(ctx, "_tags"), "exists", build.subquery({
    where: build.or([
      build.scalar(build.binary("==", ident("$it"), lit(bare))),
      build.scalar(build.call(ident("$it"), "startsWith", [lit(`${bare}/`)])),
    ]),
  }));
}
