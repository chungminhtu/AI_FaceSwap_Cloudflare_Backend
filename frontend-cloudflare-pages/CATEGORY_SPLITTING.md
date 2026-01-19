# Category Splitting Implementation

## Overview
Two-level category filtering system for presets: **Parent Category** (fs/ft/Other) and **Sub-Category** (extracted from filename).

## HTML Structure

Two select boxes in the preset section:

```html
<select id="preset-parent-category-select" onchange="handlePresetParentCategoryChange(this.value)">
    <option value="All">All</option>
    <option value="fs">fs</option>
    <option value="ft">ft</option>
    <option value="Other">Other</option>
</select>

<select id="preset-category-select" onchange="handlePresetCategoryChange(this.value)">
    <option value="Other">Other</option>
</select>
```

## Splitting Functions

### 1. Parent Category Extraction

Extracts `fs`, `ft`, or `Other` from the first part of the filename:

```javascript
function extractParentCategoryFromPresetId(presetId) {
    if (!presetId) return 'Other';
    const parts = presetId.split('_');
    if (parts.length < 1) return 'Other';
    const firstPart = parts[0].toLowerCase();
    if (firstPart === 'fs' || firstPart === 'ft') {
        return firstPart;
    }
    return 'Other';
}
```

**Examples:**
- `ft_3d_mini_m1_1.json` → `ft`
- `fs_wonders_f_1.left` → `fs`
- `unknown_file.webp` → `Other`

### 2. Category Extraction

Extracts sub-category from middle parts of the filename:

```javascript
function extractCategoryFromPresetId(presetId) {
    if (!presetId) return 'Other';
    const parts = presetId.split('_');
    if (parts.length < 3) return 'Other';
    const lastPart = parts[parts.length - 1];
    const hasExtension = lastPart.includes('.');
    if (hasExtension && parts.length >= 4) {
        return parts.slice(1, parts.length - 2).join('_');
    } else if (parts.length >= 3) {
        return parts[1];
    }
    return 'Other';
}
```

**Examples:**
- `ft_3d_mini_m1_1.json` → `3d_mini` (parts 1 to length-2)
- `fs_wonders_f_1.left` → `wonders` (part 1)
- `ft_acrylic_box_f1_1.webp` → `acrylic_box` (parts 1 to length-2)

## Filtering Flow

### 3. Category Dropdown Updates

The category dropdown dynamically updates based on the selected parent category:

```javascript
function updatePresetCategoryDropdown() {
    const selectedParentCategory = galleries.preset.state.selectedParentCategory || 'All';
    
    let categories = [];
    if (selectedParentCategory === 'All') {
        categories = allCategories; // Show all categories
    } else {
        // Filter items by parent category first
        const filteredItems = galleries.preset.state.items.filter(item => {
            const parentCategory = extractParentCategoryFromPresetId(item.preset_id || item.id || '');
            return parentCategory === selectedParentCategory;
        });
        
        // Extract unique categories from filtered items
        const categorySet = new Set();
        filteredItems.forEach(item => {
            const category = extractCategoryFromPresetId(item.preset_id || item.id || '');
            if (category) categorySet.add(category);
        });
        categories = Array.from(categorySet).sort();
    }
    
    // Populate dropdown with filtered categories
    // Always includes 'Other' option
}
```

**Behavior:**
- If parent = `All`: Shows all categories from all items
- If parent = `fs`: Shows only categories from `fs_*` items
- If parent = `ft`: Shows only categories from `ft_*` items
- If parent = `Other`: Shows only categories from non-fs/ft items

### 4. Gallery Filtering

Filters are applied in sequence: Parent Category → Sub-Category:

```javascript
// Step 1: Filter by parent category (fs/ft/Other)
if (type === 'preset' && config.state.selectedParentCategory && config.state.selectedParentCategory !== 'All') {
    items = items.filter(item => {
        const parentCategory = extractParentCategoryFromPresetId(item.preset_id || item.id || '');
        return parentCategory === config.state.selectedParentCategory;
    });
}

// Step 2: Filter by sub-category
if (type === 'preset' && config.state.selectedCategory) {
    items = items.filter(item => {
        const category = extractCategoryFromPresetId(item.preset_id || item.id || '');
        return category === config.state.selectedCategory;
    });
}
```

## Event Handlers

### Parent Category Change

```javascript
function handlePresetParentCategoryChange(parentCategory) {
    galleries.preset.state.selectedParentCategory = parentCategory;
    localStorage.setItem('preset:selectedParentCategory', parentCategory);
    // Reset category to 'Other' when parent changes
    galleries.preset.state.selectedCategory = 'Other';
    localStorage.setItem('preset:selectedCategory', 'Other');
    galleries.preset.state.page = 1;
    updatePresetCategoryDropdown(); // Update category dropdown
    renderGallery('preset'); // Re-render gallery
}
```

### Category Change

```javascript
function handlePresetCategoryChange(category) {
    galleries.preset.state.selectedCategory = category;
    localStorage.setItem('preset:selectedCategory', category);
    galleries.preset.state.page = 1;
    renderGallery('preset'); // Re-render gallery
}
```

## State Management

State stored in `galleries.preset.state`:

```javascript
{
    selectedParentCategory: 'All', // 'All', 'fs', 'ft', or 'Other'
    parentCategories: ['fs', 'ft', 'Other'], // Extracted from all items
    selectedCategory: 'Other', // Current sub-category selection
    categories: ['3d_mini', 'acrylic_box', 'wonders', ...] // All sub-categories
}
```

## Persistence

Both selections are saved to `localStorage`:

- `preset:selectedParentCategory` - Persists parent category selection
- `preset:selectedCategory` - Persists sub-category selection

Loaded on page initialization in `loadGallery('preset')`.

## Complete Example

**Filename:** `ft_3d_mini_m1_1.json`

1. **Parent Category Extraction:**
   - Split: `['ft', '3d', 'mini', 'm1', '1.json']`
   - First part: `ft`
   - Result: `ft`

2. **Category Extraction:**
   - Has extension: Yes (`.json`)
   - Parts length: 5
   - Slice(1, length-2): `['3d', 'mini']`
   - Join: `3d_mini`
   - Result: `3d_mini`

3. **Filtering:**
   - User selects parent: `ft`
   - Gallery filters to show only `ft_*` items
   - Category dropdown shows: `3d_mini`, `acrylic_box`, etc. (only from `ft_*` items)
   - User selects category: `3d_mini`
   - Gallery filters to show only `ft_3d_mini_*` items
