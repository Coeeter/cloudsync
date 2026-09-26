# Visual direction

CloudSync should feel like a working contact sheet: the archive itself is the interface, with navigation and controls kept quiet around it.

## Tokens

- Carbon: `#0b0c0e` — page canvas.
- Graphite: `#15171b` — raised controls and directory frames.
- Slate: `#8b9099` — secondary text.
- Paper: `#f3f1eb` — primary text and strong icons.
- Cobalt: `#6f8cff` — focus, selection, and progress only.
- Signal: `#ef6a67` — destructive and failed states only.

Use **Geist Sans** for the interface and **Geist Mono** only for byte counts, upload rates, and technical paths. The grid is left-aligned and fills the viewport; the media determines card proportions rather than a repeated dashboard-card component.

```text
┌ cloudsync / artwork / 2026 ───────────── search ─ upload ┐
│  [folder: character studies] [folder: environments]      │
│  [         artwork          ] [          artwork       ]  │
│  [         artwork          ] [          artwork       ]  │
│                                                          │
│  selection / transfer state appears only when relevant   │
└──────────────────────────────────────────────────────────┘
```

Directory cards use a thin inset frame and a single folded-corner silhouette around the chosen direct-child preview. File cards let uncropped content sit on a subtly checked viewport. Motion is reserved for upload progress, viewer transitions, and confirmed structural changes. Keyboard focus is always visible and reduced-motion preferences are honored.

The first pass considered a conventional sidebar and rounded SaaS cards. Both were removed: a personal archive with one hierarchy needs breadcrumbs more than permanent navigation, and repeated panels would compete with the artwork.

