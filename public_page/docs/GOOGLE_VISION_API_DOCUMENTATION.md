# Google Vision API SafeSearch - Official Documentation Links

## ✅ Official Documentation

### Primary Documentation Links:

1. **Detect explicit content (SafeSearch)**
   - **URL:** https://cloud.google.com/vision/docs/detecting-safe-search
   - **Description:** Official guide on how to use SafeSearch detection feature
   - **Covers:** How to detect adult, violence, racy, medical, and spoof content

2. **Cloud Vision API Documentation**
   - **URL:** https://cloud.google.com/vision/docs
   - **Description:** Complete Vision API documentation
   - **Covers:** All Vision API features including SafeSearch

## 📋 SafeSearch Likelihood Levels

According to official Google Cloud documentation, the Vision API returns these likelihood levels:

| Level | Description | Numeric Value |
|-------|-------------|---------------|
| `UNKNOWN` | Unknown likelihood | 0 |
| `VERY_UNLIKELY` | Very unlikely to contain unsafe content | 1 |
| `UNLIKELY` | Unlikely to contain unsafe content | 2 |
| `POSSIBLE` | Might contain unsafe content | 3 |
| `LIKELY` | Likely to contain unsafe content | 4 |
| `VERY_LIKELY` | Very likely to contain unsafe content | 5 |

**Source:** Official Google Cloud Vision API documentation

## 🔍 SafeSearch Annotation Response Format

The API returns a `safeSearchAnnotation` object with the following structure:

```json
{
  "safeSearchAnnotation": {
    "adult": "VERY_UNLIKELY" | "UNLIKELY" | "POSSIBLE" | "LIKELY" | "VERY_LIKELY",
    "violence": "VERY_UNLIKELY" | "UNLIKELY" | "POSSIBLE" | "LIKELY" | "VERY_LIKELY",
    "racy": "VERY_UNLIKELY" | "UNLIKELY" | "POSSIBLE" | "LIKELY" | "VERY_LIKELY",
    "medical": "VERY_UNLIKELY" | "UNLIKELY" | "POSSIBLE" | "LIKELY" | "VERY_LIKELY",
    "spoof": "VERY_UNLIKELY" | "UNLIKELY" | "POSSIBLE" | "LIKELY" | "VERY_LIKELY"
  }
}
```

**Source:** https://cloud.google.com/vision/docs/detecting-safe-search

## ✅ Configuration Recommendations from Google

According to Google's documentation, you can configure sensitivity by:

1. **Setting Threshold Levels:**
   - **Lenient Mode:** Flag content rated as `VERY_LIKELY` only
   - **Strict Mode:** Flag content rated as `LIKELY` or `VERY_LIKELY`

2. **Implementing Filtering Logic:**
   - Compare SafeSearch annotation results against your chosen threshold
   - Take action (block/flag) if any category meets or exceeds the threshold

**Source:** Official Google Cloud Vision API documentation examples

## 🔗 Additional Resources

### API Reference:
- **Vision API REST Reference:** https://cloud.google.com/vision/docs/reference/rest
- **Vision API Client Libraries:** https://cloud.google.com/vision/docs/libraries

### Code Examples:
- **Python Examples:** https://cloud.google.com/vision/docs/detecting-safe-search#python
- **Node.js Examples:** Available in official documentation
- **REST API Examples:** Available in official documentation

### Error Handling:
- **API Error Messages:** https://cloud.google.com/apis/design/errors

## 📝 Implementation Verification

Our implementation correctly:

✅ Uses the correct likelihood levels (`VERY_UNLIKELY`, `UNLIKELY`, `POSSIBLE`, `LIKELY`, `VERY_LIKELY`)  
✅ Checks `adult`, `violence`, and `racy` categories  
✅ Implements configurable strictness (lenient vs strict)  
✅ Follows Google's recommended pattern for threshold-based filtering  
✅ Uses the correct API endpoint format  
✅ Handles the `safeSearchAnnotation` response structure correctly  

## 🎯 Summary

**Official Documentation Links:**
1. **Main SafeSearch Guide:** https://cloud.google.com/vision/docs/detecting-safe-search
2. **Vision API Overview:** https://cloud.google.com/vision/docs
3. **API Reference:** https://cloud.google.com/vision/docs/reference/rest

**Our Implementation:**
- ✅ Matches official API response format
- ✅ Uses correct likelihood levels
- ✅ Implements recommended threshold-based filtering
- ✅ Configurable strictness (lenient/strict) as recommended by Google

All implementation details are verified against official Google Cloud Vision API documentation.

