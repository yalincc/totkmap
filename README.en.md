# TOTKmap · The Legend of Zelda: Tears of the Kingdom Interactive Map

A Simplified Chinese interactive map for *The Legend of Zelda: Tears of the Kingdom*, featuring Sky / Surface / Depths layer switching, multi-layer overlay, completion tracking, material farming spot lookup, and real-time player navigation.

[中文](README.md) | **English**

> **Two independent product lines, released separately**:
> the **map** (this line, `totkmap-vX.Y.Z`) and the **navigator TOTKNavi** (`totknavi-vX.Y.Z`) are distinguished by prefix in Releases and can be combined freely.

## Quick Start

| Way | How |
|---|---|
| **Online** | Open <https://totk.yalin.site/> |
| **Local / offline** | Download the map package `TOTKmap-vX.Y.Z.zip` ([Releases](https://github.com/yalincc/totkmap/releases), `totkmap-` prefix), extract, then open `app/index.html`. Tiles / icons / data are all local — works offline |
| **Self-hosted** | Drop the whole `app/` folder at the root of any static server (Nginx / EdgeOne Pages / GitHub Pages, etc.), pointing the site root at the contents of `app/`. A static server (e.g. VS Code Live Server, `python -m http.server`) is recommended for faster tile loading |

> Progress, custom markers, and layer selections are auto-saved in browser local storage — nothing is lost when you close the page.

## Repository Layout

> **What goes into the repo**: web source code & data artifacts, positioning service source, and manual task archives. Data pipeline tools, process data, backups, and release packages are NOT tracked (see "Not tracked" below); reproducible artifacts are already baked into `app/`.

```
TOTKmap/
├── app/                            ← Web map (the only folder you need to download / deploy)
│   ├── index.html                  ← Entry page
│   ├── sw.js                       ← Offline cache (Service Worker)
│   ├── assets/                     ← Icons, material images
│   ├── css/  js/  data/            ← Styles, logic, map data (task cards / flows / data artifacts)
│   ├── vendor/                     ← Third-party libs (Leaflet, etc.)
│   └── tiles_obj/                  ← Three-layer map tiles (Sky / Surface / Depths)
├── tasks/manual/                   ← Manual task archives (YAML, source of task card data, merged into app/data/task-plan.js at build time)
├── totknavi/                       ← Positioning core project (known instant-lock / pointer chain / self-healing, unified for both emulators)
├── totknavi-gui/                   ← Desktop navigator TOTKNavi-GUI (Wails project)
├── README.md                       ← This file (Chinese)
├── README.en.md                    ← English version of this file
├── CHANGELOG.md                    ← Version history
└── .gitignore                      ← Repository boundary definition
```

**Not tracked** (kept locally; process artifacts or rebuildable):
- `tools/` — data pipeline / tile & task build scripts (generated artifacts are baked into `app/`)
- Main / Story / Shrine / Mini challenge revision data, `data-proofing/` — task proofing process data (card data already merged into `app/data/task-plan.js`)
- `archive/`, `tasks/manual-backup-*/`, `report/` — historical docs (including the retired live-series engines), pre-import backups, temporary reports
- `release/`, `certs/` — TOTKNavi desktop release packages & certificates (distributed separately at release time)

**Download guide** (two separate lines, combine as needed):
- Map only → download **`totkmap-vX.Y.Z.zip`** from Releases (or just use the online version)
- Desktop real-time navigation → also download **`totknavi-vX.Y.Z.zip`**, then place the map package's `app/` next to `TOTKnavi.exe`
- Version-independent: a new map with an old navigator, or an old map with a new navigator, both work fine

## Real-Time Player Navigation (Optional)

Pair it with the local positioning service `TOTKNavi.exe` (built from `totknavi/`, reads coordinates from Ryujinx / Eden emulator memory, default port 8766) and the online map shows your in-game position in real time: player dot + movement trail + golden guide line to the target + distance readout, with automatic layer following and auto-clear on arrival.

**TOTKNavi-GUI** (desktop positioning navigator, Wails build): instant lock on startup (known fast path), four sidebar pages — Live Positioning (coordinates / layer / lock-source status card), Navigation Target (two-way sync with the map, clearable), Save Progress (20 collection categories), Settings. Click "Start Positioning" and the map opens automatically and follows the player.

**Notes** (full version in the package's `README.md`):
- **Extract to a pure-English path** — a path containing Chinese characters will prevent the program from running (user-confirmed)
- Start the emulator and enter the game (standing on the overworld map) before clicking "Start Positioning"
- The program only reads emulator memory: no injection, no game modification. If your antivirus flags it, add an exception.

> The navigator is a **separate product line** (`totknavi-vX.Y.Z` prefix in Releases); its version does not follow the map's. Phone mirroring needs the local offline map package (`totkmap-vX.Y.Z.zip`) extracted next to `TOTKnavi.exe`.

## Core Features

One-line summary per capability; full details in [docs/FEATURES.md](docs/FEATURES.md) (Chinese).

| Feature | Description |
|---|---|
| Three-layer map | Sky / Surface / Depths one-tap switching, each with its own markers, names and tiles |
| HD tiles | In-game contour-style terrain, sharp even at 1:1 pixel zoom |
| Multi-layer overlay | Five categories freely combinable, select-all / clear-all per group |
| Official location names | 1,312 official names printed on the map, layered by zoom |
| Dragon paths | Four official ROMFS routes; solid = current layer, dashed = other layer |
| Official overworld chests | 1,334 official chests, layered display with toggle and progress |
| Save sync | Local parsing of `progress.sav`, 21 progress categories refreshed live |
| Completion panel | Exploration / Quests / Collection / Subjugation in four groups, with progress badges |
| Bilingual UI | One-tap language switch; markers show official English names |
| Material collection | 110 materials, 44,279 spots, clustered with count badges |
| Material detail card | HD icon + usage tags + navigate / collect / mark-done buttons |
| Search & locate | By shrine / place / quest / item name, Enter to jump and center |
| Completion & custom markers | Mark any spot done, or drop your own named marker |
| URL deep links | `?actor=` jumps to farming spots, `?q=` auto-searches |
| Mobile support | Panels auto-collapse, touch zoom & pan, cards become bottom drawers |

## Data Content

- **Exploration & collectibles**: 120 shrines, 15 Skyview Towers, 12 Dragon Tears, 742 Koroks, 98 carry-Koroks, 147 Bubbuls, 1 schematic stone slab, 1,334 official overworld chests
- **Places**: 10 villages, 17 stables, 4 Great Fairy Fountains, 14 Goddess Statues, 4 Ancient Tech Labs, 1 temple, 36 chasm entrances, 189 cave entrances, 58 wells, 63 cooking pots
- **Material farming spots**: 6 categories (plants / mushrooms / fruits / insects / fish / ore), 110 materials, 44,279 spots
- **Location names**: 1,312 official Chinese location names (including duplicate names with multiple coordinates, e.g. segmented rivers / mountain ranges)

## Known Limitations

- Regions are approximate attributions based on official region centers; some boundary points may deviate
- Some material spots come from community data; obscure items may keep their English names
- z7 tiles are not in the repo (EdgeOne file-count limit); max zoom to z7 size is served by z6 tiles at 2× scale (sharpness equivalent to z6)

## Versions

The two product lines are **released independently**, distinguished by prefix in [Releases](https://github.com/yalincc/totkmap/releases):

| Product line | Releases prefix | Current | Notes |
|---|---|---|---|
| **Web map** (main product) | `totkmap-vX.Y.Z` | **v2.7.0** | 1,334 official overworld chests + automatic save progress sync; online version <https://totk.yalin.site> follows along |
| **Navigator TOTKNavi** | `totknavi-vX.Y.Z` | **v3.0.1** | Cross-scene persistent slot positioning, zero re-scan on warp / shrine, 1.5s lock |

See [CHANGELOG.md](CHANGELOG.md) for details.
