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
├── xnavi/                          ← Positioning core project (known instant-lock / pointer chain / self-healing, unified for both emulators)
├── xnavi-gui/                      ← Desktop navigator TOTKNavi-GUI (Wails project)
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

Pair it with the local positioning service `TOTKNavi.exe` (built from `xnavi/`, reads coordinates from Ryujinx / Eden emulator memory, default port 8766) and the online map shows your in-game position in real time: player dot + movement trail + golden guide line to the target + distance readout, with automatic layer following and auto-clear on arrival.

**TOTKNavi-GUI** (desktop positioning navigator, Wails build): instant lock on startup (known fast path), four sidebar pages — Live Positioning (coordinates / layer / lock-source status card), Navigation Target (two-way sync with the map, clearable), Save Progress (20 collection categories), Settings. Click "Start Positioning" and the map opens automatically and follows the player.

**Notes** (full version in the package's `README.md`):
- **Extract to a pure-English path** — a path containing Chinese characters will prevent the program from running (user-confirmed)
- Start the emulator and enter the game (standing on the overworld map) before clicking "Start Positioning"
- The program only reads emulator memory: no injection, no game modification. If your antivirus flags it, add an exception.

> The navigator is a **separate product line** (`totknavi-vX.Y.Z` prefix in Releases); its version does not follow the map's. Phone mirroring needs the local offline map package (`totkmap-vX.Y.Z.zip`) extracted next to `TOTKnavi.exe`.

## Core Features

| Feature | Description |
|---|---|
| Three-layer map | Sky / Surface / Depths one-tap switching, each with its own markers, location names, and tiles; layer buttons on the left can lock the current layer |
| HD tiles | In-game contour-style terrain tiles, per-layer format (WebP q80), sharp even at 1:1 pixel zoom |
| Multi-layer overlay | Position / collectibles / equipment / places / monsters — five categories freely combinable, select-all / clear-all in one tap |
| Official location names | 1,312 official Chinese location names printed directly on the map (objmap Location coordinates), layered show/hide by zoom, automatic anti-overlap |
| Save sync | Upload TOTK `progress.sav` to read real collection progress (Skyview Towers, shrines, Lightroots, Dragon Tears, Koroks, Bubbuls, etc.); parsing is fully local; built-in save-sync help (emulator / game version, save location, loading tech) |
| Completion panel | After loading a save, completion counts are shown in four groups — Exploration / Quests / Collection / Subjugation — in a compact two-column layout, including 6 boss subjugation categories; click to expand / collapse |
| Bilingual UI | Switch interface language in the settings panel; shrines / Skyview Towers / Lightroots / Koroks show official English names, while long guides stay Chinese |
| Group select-all | Each category group title on the left has a one-tap "select / clear" button for all categories in that group, remembered per layer |
| Material collection | 110 materials, 44,279 farming spots (Surface / Depths / Sky full coverage); check to show on the map; supercluster aggregation + count badges, per-point display at z7 zoom, each material spot is clickable |
| Material detail card | 256×256 HD icon + usage tags (upgrade material / cooking ingredient / strengthening material) + navigate / collect / mark-done buttons; auto-targets the next uncollected spot after collecting |
| Material performance | Aggregation radius adjusts dynamically with zoom (100% = 96px → 800% = 128px) + move debounce; 12,000+ Depths spots stay smooth while dragging |
| Dragon paths | Four dragons' flight routes as an independent layer, **data taken directly from the game's official ROMFS routes** (precise bezier curves + real flight altitudes): Light Dragon (low / high-altitude dual big loops + 2 link tracks + Great Sky Island branch, ~33km) / Dinraal (14.3km) / Farosh (8.6km) / Naydra (10.4km). Entry at the end of the "Locations" group in the sidebar under "Dragon Paths"; click to show / hide, works across layers; **solid = track within the current layer domain, dashed = the other layer domain** (viewing the Depths segment from Surface uses dashed), arrows along the path indicate flight direction |
| Search & locate | Search by shrine / location name / task / item name, Enter to jump and center-zoom; independent search in the Materials tab |
| Completion markers | Click a marker for details, mark as done, progress saved locally |
| Custom markers | Add named personal markers anywhere on the map |
| URL deep links | `?actor=<item name>` jumps straight to material farming spots, `?q=<keyword>` auto-searches |
| Mobile support | Panels auto-collapse on narrow screens, touch zoom & pan, detail cards become bottom drawers |

## Data Content

- **Exploration & collectibles**: 120 shrines, 15 Skyview Towers, 12 Dragon Tears, 742 Koroks, 98 carry-Koroks, 191 treasure chests, 147 Bubbuls, 1 schematic stone slab
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
| **Web map** (main product) | `totkmap-vX.Y.Z` | **v2.6.0** | Bilingual UI + five map interaction upgrades; online version <https://totk.yalin.site> follows along |
| **Navigator TOTKNavi** | `totknavi-vX.Y.Z` | **v3.0.0** | Cross-scene persistent slot positioning, zero re-scan on warp / shrine, 1.5s lock |

See [CHANGELOG.md](CHANGELOG.md) for details.
