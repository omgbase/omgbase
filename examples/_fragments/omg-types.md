# Value types for verbatim omgbase transcripts

Shared recital **types** for omgbase's run-to-run values, pulled into every
bootstrap with an `include`. Each `type:` entry is a regex fragment; each
`bind: { type: … }` is a bind-*by-type*, which turns every distinct substring of
that shape in a transcript into its own anonymous identity.

That is what lets the tutorials read verbatim: a stand-in like `d_9f4k2qa`
matches whatever id the CLI actually mints, and a value that recurs (an id reused
in a later command) stays consistent — with no `{{…}}` tokens and no
per-document lists of ids.

- `doc_id` / `block_id` / `node_id` — document / block / node ids (`d_…`, `b_…`, `n_…`)
- `ts` — an ISO-8601 timestamp (millisecond precision, `Z`)
- `tmp_path` — a `mktemp` working-directory path
- `dur` — a short relative duration like `0s` (the `omg ls` "… ago" column)
- `cursor` — an opaque keyset pagination token (base64; embeds a per-ingest id).
  Anchored on its `Wy…` (`["…`) prefix so binding it by type can't swallow other
  words.

<!-- recital type:
doc_id: "d_[a-z0-9]{7}"
block_id: "b_[a-z0-9]{7}"
node_id: "n_[0-9a-f]{12}"
ts: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z"
tmp_path: "/[^\\s]*/tmp\\.[^\\s]+"
dur: "[0-9]+s"
cursor: "Wy[A-Za-z0-9+/=]{10,}"
-->

<!-- recital bind: { type: doc_id } -->
<!-- recital bind: { type: block_id } -->
<!-- recital bind: { type: node_id } -->
<!-- recital bind: { type: ts } -->
<!-- recital bind: { type: tmp_path } -->
<!-- recital bind: { type: dur } -->
<!-- recital bind: { type: cursor } -->
