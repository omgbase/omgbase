---
npm:
  "@omgbase/core": minor
crates:
  omgbase-mutate: minor
  omgbase-surface: minor
  omgbase-store: patch
---
The write surface is discoverable from the tools alone (`spec/surface` 6.8, `spec/mutate` 4.5). An agent on the minimal MCP profile can now build write effects from the tool descriptions and `query_syntax`, with no outside documentation.

- **A write chapter in `query_syntax`.** `query_syntax { section: "effects" }` covers the three verbs, every effect op with its required and optional keys, every target form, what `into` admits, every `at` form, the fields of `set` / `unset`, `expect`, the queries that find the ids a write needs, and one working example per op. The card (`query_syntax {}`) points at it. The chapter is pinned to the vocabulary block of `spec/mutate` and to the key table the shape check itself reads, and both engines run its examples.
- **`apply` and `plan` descriptions.** Both show a `create` with frontmatter and an insert after a nested block, and both end by naming the write chapter. The `set content` example says the document must already exist. That example used to target a path the examples corpus does not have, so its recorded result was `doc_missing`; a published example that is refused now fails the suite.
- **Errors that teach.** Every shape error about an effect carries `data.valid_keys`, the keys the object at fault takes. Near misses carry the corrected call in `data.fix`: `content` (and `body`, `text`, `raw`, `value`, `source`) for `markdown` on a `create` or an `insert`, and `after: <id>` / `before: <id>` written as a key for `at: { after: <id> }` on an `insert` or a block `move`. `doc_missing` on a `set` of `content` carries the `create` it meant. An `at` anchor that is a block but not a child of `into` is `target_missing { anchor, parent }`, naming the real parent, with `into` corrected in the fix.
- **`plan` takes `reason`.** It is returned on the Plan (outside the digest) and remembered with it, so `execute { plan_id }` commits under it unless `execute` gives its own; the plan form reads the Plan's `reason` member.
- **A nested anchor under a document `into` resolves on its own.** `{ into: "/a.md", at: { after: X } }` lands right after X at any depth, lowering to the same op as `{ into: <X's parent>, at: { after: X } }`, which stays valid. A block or section `into` still requires the anchor to be one of its children. One behavior changed with it: a block `move` into a document whose anchor is a block of another document is now refused, where it used to follow the anchor while its summary named the `into`.
- **Fixed: a write beneath a task no longer strips the parent's checkbox.** Inserting into a task's nested list, or editing a nested item, rebuilt `- [ ] parent` as `- parent`. The rebuilt item keeps its own checkbox.
