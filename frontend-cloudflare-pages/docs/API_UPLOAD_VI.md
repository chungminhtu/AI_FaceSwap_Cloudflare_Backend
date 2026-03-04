# 1. Upload & Quản lý File

## 1.1. POST `/upload-url` (type=selfie) - Upload selfie

**Mục đích:** Tải ảnh selfie trực tiếp lên server và lưu vào database. Endpoint này được sử dụng bởi mobile app để upload selfie.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true` (chỉ áp dụng cho `type=selfie`).

**Request:**

**Upload single selfie với action:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "X-API-Key: your_api_key_here" \
  -F "files=@/path/to/selfie.jpg" \
  -F "type=selfie" \
  -F "profile_id=profile_1234567890" \
  -F "action=faceswap" \
  -F "dimensions=1024x768"
```

**Upload multiple selfies với dimensions array:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "X-API-Key: your_api_key_here" \
  -F "files=@/path/to/selfie1.jpg" \
  -F "files=@/path/to/selfie2.jpg" \
  -F "type=selfie" \
  -F "profile_id=profile_1234567890" \
  -F "action=faceswap" \
  -F 'dimensions=["1024x768", "800x600"]'
```

**JSON với image_urls và dimensions array:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "image_urls": ["https://example.com/selfie1.jpg", "https://example.com/selfie2.jpg"],
    "type": "selfie",
    "profile_id": "profile_1234567890",
    "action": "faceswap",
    "dimensions": ["1024x768", "800x600"]
  }'
```

**Request Parameters:**
- `files` (file[], required nếu dùng multipart): Mảng file ảnh selfie cần upload (hỗ trợ nhiều file).
- `image_url` hoặc `image_urls` (string/string[], required nếu dùng JSON): URL ảnh selfie trực tiếp.
- `type` (string, required): Loại upload. Các giá trị hỗ trợ:
  - `"selfie"`: Upload ảnh selfie cho mobile app.
  - `"mask"`: Upload ảnh mask (đen trắng) cho API `/remove-object`. Mask được lưu vào R2 folder `mask/`, action tự động đặt là `remove_object`.
  - `"preset"`: Upload preset (backend only, không cần API key).
- `profile_id` (string, required): ID profile người dùng.
- `action` (string, chỉ áp dụng cho `type=selfie`): Loại action của selfie. Nếu không truyền, mặc định là `"faceswap"`. Các giá trị hỗ trợ:
  - `"faceswap"`: Tối đa 8 ảnh (có thể cấu hình), tự động xóa ảnh cũ khi upload ảnh mới (giữ lại số ảnh mới nhất theo giới hạn). **Không kiểm tra Vision API.**
  - `"filter"`: Tối đa 5 ảnh (có thể cấu hình), tự động xóa ảnh cũ khi upload ảnh mới. **Không kiểm tra Vision API.**
  - `"wedding"`: Tối đa 2 ảnh, tự động xóa ảnh cũ khi upload ảnh mới (giữ lại 1 ảnh mới nhất). **Không kiểm tra Vision API.**
  - `"4k"` hoặc `"4K"`: Tối đa 1 ảnh, tự động xóa ảnh cũ khi upload ảnh mới. **Ảnh sẽ được kiểm tra bằng Vision API trước khi lưu vào database.**
  - `"remove_object"`: Dùng cho ảnh gốc cần xóa vật thể. Không giới hạn số lượng, tự động xóa sau khi API xử lý xong.
  - `"expression"`: Dùng cho ảnh cần thay đổi biểu cảm. Không giới hạn số lượng, tự động xóa sau khi API xử lý xong.
  - Các action khác (`"enhance"`, `"beauty"`, `"restore"`, `"aging"`, ...): Không giới hạn số lượng, tự động xóa sau khi API xử lý xong. **Không kiểm tra Vision API.**
- `dimensions` (string | string[], optional): Kích thước ảnh selfie theo định dạng `"widthxheight"` (ví dụ: `"1024x768"`). Được sử dụng để truyền kích thước ảnh gốc cho WaveSpeed API khi thực hiện face swap, giúp giữ nguyên tỷ lệ và kích thước ảnh đầu ra. Nếu không cung cấp, WaveSpeed API sẽ tự động xác định kích thước từ ảnh đầu vào.
  - **Cho single file**: Có thể truyền string đơn: `"1024x768"`
  - **Cho multiple files**: Truyền JSON array cùng thứ tự với files: `["1024x768", "800x600", null]` (null cho file không xác định được kích thước)

**Response (Success 200):**
```json
{
  "data": {
    "results": [
      {
        "id": "selfie_1234567890_xyz789",
        "url": "https://resources.d.shotpix.app/faceswap-images/selfie/example.jpg",
        "filename": "example.jpg"
      }
    ],
    "count": 1,
    "successful": 1,
    "failed": 0
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200
}
```

**Response (Error - Vision API Blocked):**
Khi ảnh selfie không vượt qua kiểm tra an toàn của Vision API, endpoint sẽ trả về error code tương ứng với loại vi phạm:

```json
{
  "data": null,
  "status": "error",
  "message": "Upload failed",
  "code": 1001
}
```

**Lưu ý quan trọng:**
- **Vision API Error Codes (1001-1005):** Chỉ selfie uploads với `action="4k"` hoặc `action="4K"` mới được quét bởi Vision API trước khi lưu vào database. Các action khác (như `"faceswap"`, `"wedding"`, `"default"`, v.v.) **không** được kiểm tra bằng Vision API. Xem chi tiết error codes tại [Vision API Safety Error Codes](API_TONG_QUAN_VI.md#vision-api-safety-error-codes-1001-1005).
- **Vertex AI Error Codes (2001-2004):** Được trả về khi Vertex AI Gemini safety filters chặn generated image. Áp dụng cho các endpoints: `/faceswap`, `/background`, `/enhance`, `/beauty`, `/filter`, `/restore`, `/aging`. Xem chi tiết error codes tại [Vertex AI Safety Error Codes](API_TONG_QUAN_VI.md#vertex-ai-safety-error-codes-2001-2004).
- Chặn `POSSIBLE`, `LIKELY`, và `VERY_LIKELY` violations
- Nếu ảnh không an toàn, file sẽ bị xóa khỏi R2 storage và trả về error code tương ứng
- Error code được trả về trong trường `code` của response
- **Giới hạn số lượng selfie:** Mỗi action có giới hạn riêng và tự động xóa ảnh cũ khi vượt quá giới hạn:
  - `faceswap`: Tối đa 8 ảnh (có thể cấu hình qua `SELFIE_MAX_FACESWAP`)
  - `wedding`: Tối đa 2 ảnh (cấu hình qua `SELFIE_MAX_WEDDING`)
  - `4k`/`4K`: Tối đa 1 ảnh (cấu hình qua `SELFIE_MAX_4K`)
  - Các action khác: Tối đa 1 ảnh (cấu hình qua `SELFIE_MAX_OTHER`)

---

## 1.1b. POST `/upload-url` (type=mask) - Upload mask image

**Mục đích:** Tải ảnh mask lên server để sử dụng với API `/remove-object`. Mask image là ảnh đen trắng, vùng trắng chỉ định vật thể cần xóa.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "X-API-Key: your_api_key_here" \
  -F "files=@/path/to/mask.png" \
  -F "type=mask" \
  -F "profile_id=profile_1234567890"
```

**Request Parameters:**
- `files` (file[], required nếu dùng multipart): File ảnh mask.
- `type` (string, required): Phải là `"mask"`.
- `profile_id` (string, required): ID profile người dùng.

**Response (Success 200):**
```json
{
  "data": {
    "results": [
      {
        "id": "mask_abc123",
        "url": "https://resources.d.shotpix.app/faceswap-images/mask/mask_abc123.png",
        "filename": "mask_abc123.png"
      }
    ],
    "count": 1,
    "successful": 1,
    "failed": 0
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200
}
```

**Lưu ý:**
- Mask được lưu vào R2 folder `mask/`
- Trong database, mask được lưu vào bảng `selfies` với `action = 'remove_object'`
- Mask sẽ tự động bị xóa sau khi API `/remove-object` xử lý xong
- Không áp dụng giới hạn số lượng (không có limit enforcement)

---

## 1.2. POST `/upload-url` (type=preset) - Upload preset (backend only)

**Mục đích:** Tải ảnh preset trực tiếp lên server và lưu vào database với xử lý tự động (Vision scan, Vertex prompt generation). Endpoint này chỉ được sử dụng bởi backend, không cần test trên mobile.

**Authentication:** Không yêu cầu API key.

**Request:**

**Multipart/form-data:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -F "files=@/path/to/image1.jpg" \
  -F "files=@/path/to/image2.jpg" \
  -F "type=preset" \
  -F "profile_id=profile_1234567890" \
  -F "enableVertexPrompt=true"
```

**JSON với image_url:**
```bash
curl -X POST https://api.d.shotpix.app/upload-url \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://example.com/image.jpg",
    "type": "preset",
    "profile_id": "profile_1234567890",
    "enableVertexPrompt": true
  }'
```

**Request Parameters:**
- `files` (file[], required nếu dùng multipart): Mảng file ảnh preset cần upload (hỗ trợ nhiều file).
- `image_url` hoặc `image_urls` (string/string[], required nếu dùng JSON): URL ảnh preset trực tiếp.
- `type` (string, required): Phải là `"preset"` cho backend upload.
- `profile_id` (string, required): ID profile người dùng.
- `enableVertexPrompt` (boolean/string, optional): `true` hoặc `"true"` để bật tạo prompt Vertex khi upload preset. Sử dụng Vertex AI để phân tích ảnh và tạo prompt_json tự động.
- `art_style` (string, optional): Filter art style cho prompt generation. Giá trị: `auto` (mặc định), `photorealistic`, `figurine`, `popmart`, `clay`, `disney`, `anime`, `chibi`, `watercolor`, `oil_painting`, `sketch`, `comic`, `pixel_art`, `cyberpunk`, `fantasy`, `vintage`, `minimalist`, `ghibli`, `lego`, `cartoon`.

**Response:**
```json
{
  "data": {
    "results": [
      {
        "id": "preset_1234567890_abc123",
        "url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
        "filename": "example.jpg"
      }
    ],
    "count": 1,
    "successful": 1,
    "failed": 0
  },
  "status": "success",
  "message": "Processing successful",
  "code": 200,
  "debug": {
    "vertex": [
      {
        "hasPrompt": true,
        "prompt_json": {
          "prompt": "...",
          "style": "...",
          "lighting": "..."
        },
        "vertex_info": {
          "success": true,
          "promptKeys": ["prompt", "style", "lighting"],
          "debug": {
            "endpoint": "https://.../generateContent",
            "status": 200,
            "responseTimeMs": 4200
          }
        }
      }
    ],
    "filesProcessed": 1,
    "resultsCount": 1
  }
}
```

---

## 1.3. POST `/upload-thumbnails` - Upload thumbnails (backend only)

**Mục đích:** Tải lên thumbnails (WebP và Lottie JSON) và tự động tạo presets. Hỗ trợ upload file zip chứa tất cả assets hoặc upload từng file riêng lẻ. Mỗi file sẽ trở thành một preset với filename làm preset_id. Vertex AI sẽ tự động phân tích ảnh WebP từ thư mục preset và tạo prompt_json metadata.

**Authentication:** Không yêu cầu API key.

**Upload individual files:**
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/preset/fs_wonder_f_3.png" \
  -F "path_preset_fs_wonder_f_3.png=preset/" \
  -F "files=@/path/to/lottie_1x/fs_wonder_f_3.json" \
  -F "path_lottie_1x_fs_wonder_f_3.json=lottie_1x/" \
  -F "files=@/path/to/lottie_avif_2x/fs_wonder_f_3.json" \
  -F "path_lottie_avif_2x_fs_wonder_f_3.json=lottie_avif_2x/" \
  -F "art_style=auto"
```

**Upload with Art Style Filter (e.g., Pop Mart style):**
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/preset/popmart_figure.png" \
  -F "path_popmart_figure.png=preset/" \
  -F "art_style=popmart"
```

**Upload zip file containing all assets:**
```bash
curl -X POST https://api.d.shotpix.app/upload-thumbnails \
  -F "files=@/path/to/thumbnails.zip" \
  -F "art_style=disney"
```

**Supported Art Styles:**

| Style | Description |
|-------|-------------|
| `auto` | Auto-detect style (default) |
| `photorealistic` | Real photography |
| `figurine` | 3D figurine/toy |
| `popmart` | Pop Mart blind box |
| `clay` | Clay/plasticine animation |
| `disney` | Disney/Pixar 3D animation |
| `anime` | Japanese anime/manga |
| `chibi` | Chibi/super-deformed |
| `watercolor` | Watercolor painting |
| `oil_painting` | Classical oil painting |
| `sketch` | Pencil/charcoal sketch |
| `comic` | Western comic book |
| `pixel_art` | Retro pixel art |
| `cyberpunk` | Cyberpunk/neon futuristic |
| `fantasy` | Fantasy/magical illustration |
| `vintage` | Vintage/retro photography |
| `minimalist` | Minimalist/flat design |
| `ghibli` | Studio Ghibli animation |
| `lego` | LEGO minifigure |
| `cartoon` | General cartoon |

**Cấu trúc thư mục:**
```
├── preset/
│   ├── fs_wonder_f_3.png    # Files here get Vertex AI prompt generation
│   └── fs_wonder_m_2.png
├── lottie_1x/
│   ├── fs_wonder_f_3.json   # Thumbnails at 1x resolution
│   └── fs_wonder_m_2.json
├── lottie_1.5x/
│   ├── fs_wonder_f_3.json   # Thumbnails at 1.5x resolution
│   └── fs_wonder_m_2.json
├── lottie_2x/
│   ├── fs_wonder_f_3.json   # Thumbnails at 2x resolution
│   └── fs_wonder_m_2.json
├── lottie_avif_1x/
│   ├── fs_wonder_f_3.json   # AVIF thumbnails at 1x resolution
│   └── fs_wonder_m_2.json
└── [other resolution folders...]
```

**Quy tắc đặt tên file:**
- Format: `[preset_id].[png|webp|json]`
- Ví dụ: `fs_wonder_f_3.png`, `fs_wonder_m_2.webp`, `fireworks_animation.json`
- Tên file (không bao gồm extension) sẽ trở thành `preset_id`
- Vertex AI chỉ phân tích file ảnh từ thư mục "preset" để tạo `prompt_json` metadata
- File từ các thư mục resolution khác (lottie_*, lottie_avif_*) là thumbnails, KHÔNG được gửi đến Vertex AI

**Tính năng Vertex AI:**
- Tự động gọi Vertex AI Gemini để phân tích file ảnh từ thư mục "preset"
- Sử dụng `Promise.all` để xử lý batch upload và tạo prompt song song
- `prompt_json` được lưu trong R2 custom metadata của preset files
- Thumbnails được lưu ở nhiều resolution (1x, 1.5x, 2x, 3x, 4x) trong database
- Chỉ áp dụng cho file ảnh từ thư mục "preset", bỏ qua thumbnails

**Response:**
```json
{
  "data": {
    "total": 3,
    "successful": 3,
    "failed": 0,
    "thumbnails_processed": 3,
    "results": [
      {
        "filename": "fs_wonder_f_3.png",
        "success": true,
        "type": "preset",
        "preset_id": "fs_wonder_f_3",
        "url": "https://resources.d.shotpix.app/presets/fs_wonder_f_3.png",
        "hasPrompt": true,
        "prompt_json": {
          "scene": "wonder woman portrait",
          "style": "heroic",
          "mood": "confident",
          "colors": ["red", "blue", "gold"]
        },
        "vertex_info": {
          "success": true,
          "promptKeys": ["scene", "style", "mood", "colors"]
        },
        "metadata": {
          "format": "webp"
        }
      },
      {
        "filename": "fs_wonder_f_3.json",
        "success": true,
        "type": "thumbnail",
        "preset_id": "fs_wonder_f_3",
        "url": "https://resources.d.shotpix.app/lottie_1x/fs_wonder_f_3.json",
        "hasPrompt": false,
        "vertex_info": {
          "success": false
        },
        "metadata": {
          "format": "lottie",
          "resolution": "1x"
        }
      },
      {
        "filename": "fs_wonder_f_3.json",
        "success": true,
        "type": "thumbnail",
        "preset_id": "fs_wonder_f_3",
        "url": "https://resources.d.shotpix.app/lottie_avif_2x/fs_wonder_f_3.json",
        "hasPrompt": false,
        "vertex_info": {
          "success": false
        },
        "metadata": {
          "format": "lottie",
          "resolution": "2x"
        }
      }
    ]
  },
  "status": "success",
  "message": "Processed 3 of 3 files",
  "code": 200,
  "debug": {
    "filesProcessed": 3,
    "resultsCount": 3
  }
}
```

---
