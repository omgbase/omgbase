---
type: cue
intent: /attn/intents/read-mutus-liber.md
trigger: query
status: active
---

# Something new has your attention

Fires when a new active intent appears — when the membership set of the query below gains an id:

```oqx
select path from docs where type == "intent" and status == "active" and path.startsWith("/attn/intents/")
```

Does the new thing belong to the Opus, or is it the garden calling? Plate IV is still open on the bench.
