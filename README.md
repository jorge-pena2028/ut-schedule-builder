# UT Schedule Builder

A Chrome extension that generates every possible conflict-free class schedule for University of Texas at Austin students.

## How It Works

1. **Select a department** from the full dropdown of UT fields of study
2. **Pick your courses** from the complete course catalog
3. **Fetch sections** — the extension pulls all available sections (times, professors, rooms) directly from UT Direct using your logged-in session
4. **Filter by professor** — toggle which professors you want for each course
5. **Set preferences** — buffer time between classes, blockout periods
6. **Generate** — see every valid schedule combination on a visual weekly calendar

## Features

- **Searchable dropdowns** for departments and courses, pulled from the UT course catalog
- **Professor filtering** per course — only include sections taught by professors you select
- **Adjustable buffer** between classes (0-30 minutes)
- **Blockout times** — keep lunch, work, or other times free
- **Visual weekly calendar** with color-coded course blocks
- **Arrow key navigation** between generated schedules
- **Backtracking algorithm** that efficiently generates all valid combinations
- **100% local** — no data ever leaves your browser, no external servers

## Architecture

```
extension/
├── manifest.json          # Chrome extension config (Manifest V3)
├── background.js          # Service worker — fetches data from UT Direct & catalog
├── popup.html             # Extension popup structure
├── popup.js               # UI logic, schedule generation algorithm
├── popup.css              # Styling
├── privacy-policy.html    # Privacy policy for Chrome Web Store
└── icons/                 # Extension icons
```

### Schedule Generation Algorithm

The core algorithm uses **backtracking with pruning** to generate all valid schedules:

- Courses are sorted by fewest available sections first (maximizes early pruning)
- For each course, each section is tested against already-chosen sections
- Conflict detection considers day overlap, time overlap, and configurable buffer
- Blockout periods are treated as pre-occupied time slots
- A section is skipped entirely if it conflicts, pruning all downstream combinations

For a typical load (5 courses x 4 sections each = 1,024 max combinations), generation completes in under 10ms.

### Data Sources

- **UT Direct** (`utdirect.utexas.edu`) — authenticated course schedule with section times, professors, rooms, and availability
- **UT Course Catalog** (`catalog.utexas.edu`) — public course listings via the CourseLeaf FOSE API for complete department course numbers and titles

### Security

- All HTML from external sources is escaped via a dedicated `esc()` helper before DOM insertion (XSS prevention)
- No unnecessary permissions — only `storage` and specific host paths
- Sender validation on all message handlers
- CSS selector injection prevented via `CSS.escape()`
- Content Security Policy enforced
- No cookies permission — session cookies are sent automatically via `credentials: 'include'`
- No data transmitted to third parties

## Installation

### From Chrome Web Store
*(Coming soon)*

### From Source (Developer Mode)
1. Clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `extension/` folder
5. Log in to [UT Direct](https://utdirect.utexas.edu/apps/registrar/course_schedule/20269/)
6. Click the extension icon and start building your schedule

### From Source Zip (Developer Mode)
1. Download zip
2. Extract zip on computer
3. Open `chrome://extensions/` in Chrome
4. Enable **Developer mode** (top-right toggle)
5. Click **Load unpacked** and select the `extension/` folder you unzipped
6. Log in to [UT Direct](https://utdirect.utexas.edu/apps/registrar/course_schedule/20269/)
7. Click the extension icon and start building your schedule

## Requirements

- Google Chrome browser
- UT Austin student account (UT EID) for fetching section data
- Active login session on UT Direct

## Privacy

This extension processes all data locally in your browser. It does not collect, store, or transmit any personal information. See [Privacy Policy](extension/privacy-policy.html) for details.

## License

MIT
