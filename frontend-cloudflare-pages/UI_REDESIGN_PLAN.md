# UI Redesign Plan - Face Swap AI Enterprise App

## Design Goals
- Enterprise-grade professional appearance
- Focus on before/after comparison (result close to source images)
- Responsive design (desktop first, mobile support)
- Remove unnecessary UI elements (step indicator, large logo)
- Modern pagination style
- Full drag-drop upload zones

---

## Desktop Layout (≥ 1200px)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Face Swap AI    Profile: [abc123] [____][Switch]  [API▼][Log]              │
├───────────────────────────────────────────┬─────────────────────────────────┤
│                                           │                                 │
│  PRESETS [All][M][F]                 [+]  │  ┌──────────────┐  ┌──────────┐│
│  ┌────────────────────────────────────┐   │  │   PRESET     │  │          ││
│  │ (entire area = drop zone)          │   │  │              │  │          ││
│  │  ┌────┬────┬────┬────┐             │   │  │   [×]        │  │  RESULT  ││
│  │  │    │    │    │    │             │   │  └──────────────┘  │          ││
│  │  ├────┼────┼────┼────┤             │   │  ┌──────────────┐  │          ││
│  │  │    │    │    │    │             │   │  │   SELFIE     │  │          ││
│  │  └────┴────┴────┴────┘             │   │  │              │  │          ││
│  └────────────────────────────────────┘   │  │   [×]        │  │          ││
│                 ◀ 1 · 2 · 3 · 4 · 5 ▶     │  └──────────────┘  │          ││
│  ─────────────────────────────────────    │                   │          ││
│  SELFIES                             [+]  │                   │          ││
│  ┌────────────────────────────────────┐   │                   │          ││
│  │ (entire area = drop zone)          │   │                   │          ││
│  │  ┌────┬────┬────┬────┐             │   │                   │          ││
│  │  │    │    │    │    │             │   │                   │          ││
│  │  └────┴────┴────┴────┘             │   │                   │          ││
│  └────────────────────────────────────┘   │                   │          ││
│                 ◀ 1 · 2 · 3 ▶             │                   └──────────┘│
│                                           │                                 │
├───────────────────────────────────────────┴─────────────────────────────────┤
│ [Face Swap*] [Enhance] [4K Upscale] [Restore] [Age:__]  [__prompt__] ○M ○F │
├─────────────────────────────────────────────────────────────────────────────┤
│ HISTORY (24)                                                                │
│ [img][img][img][img][img][img][img][img][img][img][img][img]                │
│                           ◀ 1 · 2 · 3 · 4 · 5 · 6 ▶                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Tablet Layout (768px - 1199px)

```
┌─────────────────────────────────────────────────────────────────┐
│ Face Swap AI    Profile: [abc123] [____][Switch]  [API▼][Log] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  PRESETS [All][M][F]                                       [+]  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  ┌─────┬─────┬─────┬─────┬─────┬─────┐                    │  │
│  │  │     │     │     │     │     │     │                    │  │
│  │  └─────┴─────┴─────┴─────┴─────┴─────┘                    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                       ◀ 1 · 2 · 3 · 4 ▶                         │
│  SELFIES                                                   [+]  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  ┌─────┬─────┬─────┬─────┬─────┬─────┐                    │  │
│  │  │     │     │     │     │     │     │                    │  │
│  │  └─────┴─────┴─────┴─────┴─────┴─────┘                    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                       ◀ 1 · 2 ▶                                 │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│  │   PRESET     │  │                                          │ │
│  │   [×]        │  │                                          │ │
│  └──────────────┘  │            RESULT                        │ │
│  ┌──────────────┐  │                                          │ │
│  │   SELFIE     │  │                                          │ │
│  │   [×]        │  │                                          │ │
│  └──────────────┘  └──────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ [Face Swap*] [Enhance] [4K] [Restore] [Age:__] [prompt] ○M ○F │
├─────────────────────────────────────────────────────────────────┤
│ HISTORY (24)                                                    │
│ [img][img][img][img][img][img][img][img]                        │
│                       ◀ 1 · 2 · 3 ▶                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Mobile Layout (< 768px)

```
┌───────────────────────────────────┐
│ Face Swap AI        [API▼] [Log] │
│ Profile: [abc123] [____][Switch] │
├───────────────────────────────────┤
│ PRESETS [All][M][F]          [+] │
│ ┌─────────────────────────────┐  │
│ │ ┌─────┬─────┬─────┬─────┐   │  │
│ │ │     │     │     │     │   │  │
│ │ └─────┴─────┴─────┴─────┘   │  │
│ └─────────────────────────────┘  │
│         ◀ 1 · 2 · 3 ▶            │
├───────────────────────────────────┤
│ SELFIES                      [+] │
│ ┌─────────────────────────────┐  │
│ │ ┌─────┬─────┬─────┬─────┐   │  │
│ │ │     │     │     │     │   │  │
│ │ └─────┴─────┴─────┴─────┘   │  │
│ └─────────────────────────────┘  │
│         ◀ 1 · 2 ▶                │
├───────────────────────────────────┤
│ ┌───────────┐  ┌───────────┐     │
│ │  PRESET   │  │  SELFIE   │     │
│ │    [×]    │  │    [×]    │     │
│ └───────────┘  └───────────┘     │
│         ↓                        │
│ ┌─────────────────────────────┐  │
│ │          RESULT             │  │
│ │                             │  │
│ └─────────────────────────────┘  │
├───────────────────────────────────┤
│ [Face Swap] [Enhance] [4K]       │
│ [Restore] [Age:__]              │
│ [__prompt__] ○M ○F               │
├───────────────────────────────────┤
│ HISTORY (24)                     │
│ [img][img][img][img]             │
│       ◀ 1 · 2 · 3 ▶              │
└───────────────────────────────────┘
```

---

## API Log Panel (Slide-out, All Breakpoints)

```
┌─ API LOG ───────────────────────────────────────────────────────────────────┐
│ [Clear]                                                           [× Close] │
├─────────────────────────────────────────────────────────────────────────────┤
│ ▼ POST /faceswap - 200 OK - 1240ms                                          │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ {                                                                     │   │
│ │   "success": true,                                                    │   │
│ │   "data": {                                                           │   │
│ │     "id": "res_abc123",                                               │   │
│ │     "resultImageUrl": "https://r2.example.com/result.jpg",            │   │
│ │     "processing_time_ms": 1240                                        │   │
│ │   }                                                                   │   │
│ │ }                                                                     │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────┤
│ ▼ POST /enhance - 200 OK - 890ms                                            │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ { "success": true, "data": { ... } }                                  │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────┤
│ ▼ DELETE /results/abc123 - 200 OK - 120ms                                   │
│ ┌───────────────────────────────────────────────────────────────────────┐   │
│ │ { "success": true, "deleted": "abc123" }                              │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Components Specification

### 1. Header Bar
| Element | Description |
|---------|-------------|
| Logo | "Face Swap AI" - simple text, no icon, smaller font |
| Profile | ID display + input + Switch button (inline) |
| API Dropdown | Provider selector (compact) |
| Log Toggle | Button to show/hide log panel |

**Removed:**
- Large title with gradient
- API Documentation link
- Step indicator (1→2→3→4)

---

### 2. Galleries Panel (Left Side)

#### Presets Section
| Element | Description |
|---------|-------------|
| Title | "PRESETS" with gender filter buttons [All][M][F] inline |
| Upload | Small [+] icon button (top right) |
| Drop Zone | Entire gallery area accepts drag-drop |
| Grid | 4 columns, responsive |
| Pagination | Modern dots: ◀ 1 · 2 · 3 ▶ (centered, bottom) |

#### Selfies Section
| Element | Description |
|---------|-------------|
| Title | "SELFIES" with [+] upload button inline |
| Drop Zone | Entire gallery area accepts drag-drop |
| Grid | 4 columns, responsive |
| Pagination | Modern dots: ◀ 1 · 2 · 3 ▶ (centered, bottom) |

---

### 3. Comparison Panel (Right Side)

**Layout:** Two-column grid layout
- **Left Column (narrower):** PRESET and SELFIE stacked vertically
- **Right Column (wider):** RESULT taking full height

| Element | Height | Description |
|---------|--------|-------------|
| Preset Preview | 200px | Selected preset with [×] clear button (left column, top) |
| Selfie Preview | 200px | Selected selfie with [×] clear button (left column, bottom) |
| Result Preview | Full height | Generated result (right column, spans combined height of preset + selfie) |

**Layout Details:**
- Grid: `grid-template-columns: 1fr 1.5fr` (left column narrower, right column wider)
- PRESET and SELFIE: Fixed height 200px each, stacked in left column
- RESULT: Full height on right, matches combined height of PRESET + SELFIE
- No visual connectors (removed + and ↓ symbols)

**Empty States:**
- Preset: "Select from presets"
- Selfie: "Select from selfies"
- Result: "Result will appear here"

---

### 4. Action Bar

| Element | Type | Notes |
|---------|------|-------|
| Face Swap | Primary button | Requires preset + selfie |
| Enhance | Button | Requires selfie only |
| 4K Upscale | Button | Requires selfie only |
| Restore | Button | Requires selfie only |
| Age | Input + Button | Number input + button |
| Prompt | Text input | Optional prompt |
| Gender | Radio | ○M ○F |

**Button States:**
- Face Swap: Disabled until both preset AND selfie selected
- Others: Disabled until selfie selected

---

### 5. History Section

| Element | Description |
|---------|-------------|
| Title | "HISTORY" with count (24) |
| Grid | Horizontal, auto-fill columns |
| Items | Clickable (opens lightbox), delete button on hover |
| Pagination | Modern dots: ◀ 1 · 2 · 3 · 4 ▶ (centered) |

---

### 6. Log Panel (Slide-out)

| Element | Description |
|---------|-------------|
| Position | Fixed right side, slides in/out |
| Width | 400px desktop, 100% mobile |
| Header | "API LOG" + Clear + Close buttons |
| Content | Scrollable list of API calls |
| Entry | Method, URL, status, duration, full JSON |

---

## CSS Variables (Light Theme)

```css
/* Light Theme - Professional AI App */
--bg-primary: #FDFBFF;
--bg-secondary: #F7F2FF;
--bg-tertiary: #EFE7FF;
--bg-card-gradient: linear-gradient(135deg, #FFFFFF 0%, #F4E9FF 100%);
--accent: #F82387;          /* Pink - Modern, Creative */
--accent-hover: #FF5D9A;
--accent-strong: #B215FF;
--accent-secondary: #12B0FF; /* Blue - Technology */
--text-primary: #0B0B2E;
--text-secondary: #3A345C;
--text-muted: #7B7695;
--border: rgba(131, 94, 255, 0.3);
--success: #2BC990;
--danger: #FF4D6D;
```

### Color Palette Rationale
- **Light Background**: Clean, professional, reduces eye strain for extended use
- **Pink Accent**: Modern, creative, engaging - ideal for AI/creative apps
- **Blue Secondary**: Used for technology indicators and secondary actions
- **High Contrast Text**: Ensures readability on light backgrounds

---

## Implementation Checklist

### Phase 1: Structure
- [x] Remove step indicator
- [x] Simplify header (smaller logo, inline profile, compact height)
- [x] Create two-column layout (galleries | comparison)
- [x] Add action bar below comparison

### Phase 2: Galleries
- [x] Refactor preset gallery with drop zone
- [x] Refactor selfie gallery with drop zone
- [x] Modern dot pagination component (◀ 1 · 2 · 3 ▶)
- [x] Small [+] upload buttons in header

### Phase 3: Comparison Panel
- [x] Two-column grid layout (left: preset+selfie, right: result)
- [x] Preset preview box (200px height, left column top)
- [x] Selfie preview box (200px height, left column bottom)
- [x] Result preview box (full height, right column)
- [x] Removed visual connectors (no + or ↓ symbols)

### Phase 4: Action Bar
- [x] Horizontal button layout
- [x] Inline prompt input
- [x] Inline gender radios (○M ○F)
- [x] Button state management

### Phase 5: History
- [x] Full-width grid
- [x] Modern dot pagination (◀ 1 · 2 · 3 · 4 ▶)
- [x] Lightbox integration

### Phase 6: Log Panel
- [x] Slide-out animation
- [x] Full JSON display
- [x] Mobile responsive

### Phase 7: Responsive
- [x] Tablet breakpoint (768-1199px) - maintains two-column comparison layout
- [x] Mobile breakpoint (<768px) - stacks comparison vertically
- [x] Touch-friendly targets

---

## Files to Modify

1. `/frontend-cloudflare-pages/index.html` - Complete rewrite of HTML structure and CSS

---

## Preserved Features

- Access gate (password protection)
- Profile management (ID, switch)
- Preset gallery (gender filter, upload, pagination)
- Selfie gallery (upload, pagination)
- All 5 action buttons (Face Swap, Enhance, 4K, Restore, Aging)
- Prompt input
- Gender selection
- API provider dropdown
- Results/History gallery with pagination
- Lightbox for viewing results
- API log panel (toggle, clear, full JSON)
- Loading overlay
- Toast notifications
- All existing JavaScript functionality
