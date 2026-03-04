# 3-4. Profile & Truy vấn Dữ liệu

## 3. Quản lý Profile

### 3.1. POST `/profiles` - Tạo profile

**Mục đích:** Tạo profile mới.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**

**Minimal (chỉ cần device_id):**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "device_id": "device_1765774126587_yaq0uh6rvz"
  }'
```

**Full request:**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "userID": "user_external_123",
    "name": "John Doe",
    "email": "john@example.com",
    "avatar_url": "https://example.com/avatar.jpg",
    "preferences": "{\"theme\":\"dark\",\"language\":\"vi\"}"
  }'
```

**Với preferences dạng object:**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "name": "John Doe",
    "email": "john@example.com",
    "avatar_url": "https://example.com/avatar.jpg",
    "preferences": {
      "theme": "dark",
      "language": "vi"
    }
  }'
```

**Hoặc gửi device_id qua header:**
```bash
curl -X POST https://api.d.shotpix.app/profiles \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -H "x-device-id: device_1765774126587_yaq0uh6rvz" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com"
  }'
```

**Request Parameters:**
- `device_id` (string, optional): ID thiết bị. Có thể gửi trong body hoặc header `x-device-id`. Nếu không có, sẽ là `null`.
- `userID` hoặc `user_id` (string, optional): **User ID bên ngoài** dùng để tìm kiếm profile. Đây là ID từ hệ thống của bạn (ví dụ: Firebase UID, Auth0 ID, v.v.). Có thể dùng để tìm profile sau này.
- `id` (string, optional): ID profile nội bộ. Nếu không có, hệ thống tự tạo bằng `nanoid(16)`.
- `name` (string, optional): tên profile.
- `email` (string, optional): email.
- `avatar_url` (string, optional): URL avatar.
- `preferences` (string hoặc object, optional): preferences dạng JSON string hoặc object. Nếu là object, hệ thống tự động chuyển thành JSON string trước khi lưu vào D1 database (vì D1 không hỗ trợ JSON object trực tiếp).

**Lưu ý về ID:**
- `id` (profile_id): ID nội bộ của profile, tự động tạo nếu không cung cấp.
- `user_id`: ID từ hệ thống bên ngoài (Firebase, Auth0, v.v.), dùng để liên kết với user của bạn.
- `device_id`: ID thiết bị, dùng để theo dõi user chưa đăng nhập.

**Response:**
```json
{
  "data": {
    "id": "uYNgRR70Ry9OFuMV",
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "user_id": "user_external_123",
    "created_at": "2025-12-15T04:48:47.676Z",
    "updated_at": "2025-12-15T04:48:47.676Z"
  },
  "status": "success",
  "message": "Profile created successfully",
  "code": 200,
  "debug": {
    "profileId": "uYNgRR70Ry9OFuMV",
    "deviceId": "device_1765774126587_yaq0uh6rvz",
    "userId": "user_external_123"
  }
}
```

---

### 3.2. GET `/profiles/{id}` - Lấy profile

**Mục đích:** Lấy thông tin profile theo Profile ID, Device ID, hoặc User ID.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Path Parameters:**
- `id` (string, required): Có thể là **Profile ID**, **Device ID**, hoặc **User ID**. API sẽ tìm theo thứ tự: profile_id → device_id → user_id.

**Request:**
```bash
# Tìm bằng Profile ID
curl https://api.d.shotpix.app/profiles/uYNgRR70Ry9OFuMV \
  -H "X-API-Key: your_api_key_here"

# Tìm bằng Device ID
curl https://api.d.shotpix.app/profiles/device_1765774126587_yaq0uh6rvz \
  -H "X-API-Key: your_api_key_here"

# Tìm bằng User ID (từ hệ thống bên ngoài)
curl https://api.d.shotpix.app/profiles/user_external_123 \
  -H "X-API-Key: your_api_key_here"
```

**Response:**
```json
{
  "data": {
    "id": "uYNgRR70Ry9OFuMV",
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "user_id": "user_external_123",
    "name": "John Doe",
    "email": "john@example.com",
    "avatar_url": "https://example.com/avatar.jpg",
    "preferences": "{\"theme\":\"dark\",\"language\":\"vi\"}",
    "created_at": "2025-12-15T04:48:47.676Z",
    "updated_at": "2025-12-15T04:48:47.676Z"
  },
  "status": "success",
  "message": "Profile retrieved successfully",
  "code": 200
}
```

**Lưu ý:** Cả ba cách tìm (bằng Profile ID, Device ID, hoặc User ID) đều trả về cùng một profile với đầy đủ thông tin.

---

### 3.3. PUT `/profiles/{id}` - Cập nhật profile

**Mục đích:** Cập nhật thông tin profile.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl -X PUT https://api.d.shotpix.app/profiles/profile_1234567890 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "John Doe Updated",
    "email": "john.updated@example.com",
    "avatar_url": "https://example.com/new-avatar.jpg",
    "preferences": {
      "theme": "light",
      "language": "en"
    }
  }'
```

**Request Parameters:**
- `name` (string, optional): tên profile.
- `email` (string, optional): email.
- `avatar_url` (string, optional): URL avatar.
- `preferences` (string hoặc object, optional): preferences dạng JSON string hoặc object. Nếu là object, hệ thống tự động chuyển thành JSON string trước khi lưu vào D1 database (vì D1 không hỗ trợ JSON object trực tiếp).

**Lưu ý:** ID profile phải được cung cấp trong URL path (`/profiles/{id}`), không cần gửi trong body.

**Response:**
```json
{
  "data": {
    "id": "uYNgRR70Ry9OFuMV",
    "device_id": "device_1765774126587_yaq0uh6rvz",
    "user_id": "user_external_123",
    "name": "John Doe Updated",
    "email": "john.updated@example.com",
    "avatar_url": "https://example.com/new-avatar.jpg",
    "preferences": "{\"theme\":\"light\",\"language\":\"en\"}",
    "created_at": "2025-12-15T04:48:47.676Z",
    "updated_at": "2025-12-15T05:00:00.000Z"
  },
  "status": "success",
  "message": "Profile updated successfully",
  "code": 200
}
```

---

### 3.4. GET `/profiles` - Liệt kê profiles

**Mục đích:** Liệt kê tất cả profiles (dùng cho admin/debugging).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/profiles
```

**Response:**
```json
{
  "data": {
    "profiles": [
      {
        "id": "uYNgRR70Ry9OFuMV",
        "device_id": "device_1765774126587_yaq0uh6rvz",
        "user_id": "user_external_123",
        "name": "John Doe",
        "email": "john@example.com",
        "avatar_url": "https://example.com/avatar.jpg",
        "preferences": "{\"theme\":\"dark\",\"language\":\"vi\"}",
        "created_at": "2025-12-15T04:48:47.676Z",
        "updated_at": "2025-12-15T04:48:47.676Z"
      }
    ]
  },
  "status": "success",
  "message": "Profiles retrieved successfully",
  "code": 200
}
```

---

## 4. Truy vấn Dữ liệu

### 4.1. GET `/presets` - Liệt kê presets

**Mục đích:** Trả về danh sách preset trong database.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/presets
curl https://api.d.shotpix.app/presets?include_thumbnails=true
```

**Query Parameters:**
- `include_thumbnails` (optional): `true` để bao gồm cả presets có thumbnail. Mặc định chỉ trả về presets không có thumbnail.

**Response:**
```json
{
  "data": {
    "presets": [
      {
        "id": "preset_1234567890_abc123",
        "preset_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
        "image_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
        "hasPrompt": true,
        "prompt_json": null,
        "thumbnail_url": "https://resources.d.shotpix.app/webp_1x/face-swap/wedding_both_1.webp",
        "thumbnail_format": "webp",
        "thumbnail_resolution": "1x",
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "status": "success",
  "message": "Presets retrieved successfully",
  "code": 200,
  "debug": {
    "count": 1
  }
}
```

---

### 4.2. GET `/presets/{id}` - Lấy preset theo ID

**Mục đích:** Lấy thông tin chi tiết của một preset theo ID (bao gồm `prompt_json`).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/presets/preset_1234567890_abc123
```

**Response:**
```json
{
  "data": {
    "id": "preset_1234567890_abc123",
    "preset_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
    "image_url": "https://resources.d.shotpix.app/faceswap-images/preset/example.jpg",
    "hasPrompt": true,
    "prompt_json": {
      "prompt": "...",
      "style": "...",
      "lighting": "..."
    },
    "thumbnail_url": "https://resources.d.shotpix.app/webp_1x/face-swap/wedding_both_1.webp",
    "thumbnail_format": "webp",
    "thumbnail_resolution": "1x",
    "created_at": "2024-01-01T00:00:00.000Z"
  },
  "status": "success",
  "message": "Preset retrieved successfully",
  "code": 200,
  "debug": {
    "presetId": "preset_1234567890_abc123",
    "hasPrompt": true
  }
}
```

---

### 4.3. DELETE `/presets/{id}` - Xóa preset

**Mục đích:** Xóa preset khỏi D1 và R2.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl -X DELETE https://api.d.shotpix.app/presets/preset_1234567890_abc123
```

**Response:**
```json
{
  "data": null,
  "status": "success",
  "message": "Preset deleted successfully",
  "code": 200
}
```

---

### 4.4. GET `/selfies` - Liệt kê selfies

**Mục đích:** Trả về tối đa 50 selfie gần nhất của một profile. Endpoint này được sử dụng bởi mobile app để lấy danh sách selfies đã upload.

**Authentication:** Không yêu cầu API key (có thể được bật trong tương lai).

**Request:**
```bash
curl https://api.d.shotpix.app/selfies?profile_id=profile_1234567890
```

**Query Parameters:**
- `profile_id` (required): ID profile.
- `limit` (optional): Số lượng selfies tối đa trả về (1-50). Mặc định: 50.

**Response:**
```json
{
  "data": {
    "selfies": [
      {
        "id": "selfie_1234567890_xyz789",
        "selfie_url": "https://resources.d.shotpix.app/faceswap-images/selfie/example.jpg",
        "action": "faceswap",
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "status": "success",
  "message": "Selfies retrieved successfully",
  "code": 200
}
```

---

### 4.5. DELETE `/selfies/{id}` - Xóa selfie

**Mục đích:** Xóa selfie khỏi D1 và R2.

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl -X DELETE https://api.d.shotpix.app/selfies/selfie_1234567890_xyz789
```

**Response:**
```json
{
  "data": null,
  "status": "success",
  "message": "Selfie deleted successfully",
  "code": 200,
  "debug": {
    "selfieId": "selfie_1234567890_xyz789",
    "r2Deleted": true,
    "r2Error": null
  }
}
```

---

### 4.6. GET `/results` - Liệt kê results

**Mục đích:** Trả về tối đa 50 kết quả generated images (face swap, background, enhance, beauty, filter, restore, aging, upscaler4k) gần nhất. Endpoint này được sử dụng bởi mobile app để lấy danh sách các ảnh đã được tạo.

**Authentication:** Không yêu cầu API key (có thể được bật trong tương lai).

**Request:**
```bash
curl https://api.d.shotpix.app/results
curl https://api.d.shotpix.app/results?profile_id=profile_1234567890
```

**Query Parameters:**
- `profile_id` (optional): ID profile để lọc kết quả.
- `limit` (optional): Số lượng results tối đa trả về (1-50). Mặc định: 50.

**Response:**
```json
{
  "data": [
    {
      "id": "result_1234567890_abc123",
      "result_url": "https://resources.d.shotpix.app/faceswap-images/results/result_123.jpg",
      "action": "faceswap",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ],
  "status": "success",
  "message": "Results retrieved successfully",
  "code": 200
}
```

**Response:** `data` là mảng phẳng (flat array) các result. Mỗi item:
- `id`: ID duy nhất của result
- `result_url`: URL public của ảnh kết quả
- `action`: Tên API đã tạo ra result này. Giá trị: `faceswap`, `background`, `enhance`, `beauty`, `filter`, `restore`, `aging`, `upscaler4k`, `remove_object`, `expression`, `expand`, `replace_object`, `remove_text`, `hair_style`. Lưu ý: dùng underscore `_` (không phải hyphen `-`). Có thể null.
- `created_at`: Thời gian tạo (ISO 8601)

---

### 4.7. DELETE `/results/{id}` - Xóa result

**Mục đích:** Xóa kết quả khỏi D1 và R2.

**Authentication:** Yêu cầu API key khi `ENABLE_MOBILE_API_KEY_AUTH=true`.

**Request:**
```bash
curl -X DELETE https://api.d.shotpix.app/results/result_1234567890_abc123
```

**Response:**
```json
{
  "data": null,
  "status": "success",
  "message": "Result deleted successfully",
  "code": 200,
  "debug": {
    "resultId": "result_1234567890_abc123",
    "databaseDeleted": 1,
    "r2Deleted": true,
    "r2Key": "results/result_123.jpg",
    "r2Error": null
  }
}
```

---

### 4.8. GET `/thumbnails` - Liệt kê thumbnails

**Mục đích:** Lấy danh sách thumbnails từ database. Trả về tất cả presets có thumbnail (bất kỳ cột thumbnail nào không null).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/thumbnails
```

**Query Parameters:**
- Không có query parameters. Endpoint trả về tất cả presets có thumbnail.

**Lưu ý:** Endpoint này query từ bảng `presets` với điều kiện `thumbnail_r2` không null và không rỗng. Dữ liệu thumbnail được lưu dưới dạng JSON object trong trường `thumbnail_r2`.

**Response:**
```json
{
  "data": {
    "thumbnails": [
      {
        "id": "fs_wonder_f_3",
        "ext": "png",
        "thumbnail_r2": "{\"webp_1x\":\"webp_1x/fs_wonder_f_3.webp\",\"lottie_1x\":\"lottie_1x/fs_wonder_f_3.json\",\"lottie_avif_2x\":\"lottie_avif_2x/fs_wonder_f_3.json\"}",
        "thumbnail_url": "https://resources.d.shotpix.app/webp_1x/fs_wonder_f_3.webp",
        "thumbnail_url_1x": "https://resources.d.shotpix.app/webp_1x/fs_wonder_f_3.webp",
        "thumbnail_url_1_5x": null,
        "thumbnail_url_2x": null,
        "thumbnail_url_3x": null,
        "thumbnail_url_4x": null,
        "created_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "status": "success",
  "message": "Thumbnails retrieved successfully",
  "code": 200
}
```

**Lưu ý:** Response trả về tất cả các cột thumbnail resolution (1x, 1.5x, 2x, 3x) từ database. `thumbnail_url` là alias của `thumbnail_url_1x` cho backward compatibility.

---

### 4.9. GET `/thumbnails/{id}/preset` - Lấy preset_id từ thumbnail_id

**Mục đích:** Lấy preset_id từ thumbnail_id (dùng cho mobile app).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/thumbnails/preset_1234567890_abc123/preset
```

**Response:**
```json
{
  "data": {
    "preset_id": "preset_1234567890_abc123"
  },
  "status": "success",
  "message": "Preset ID retrieved successfully",
  "code": 200
}
```

---

### 4.10. Thumbnail URL Rules - Quy tắc URL Thumbnail

**Mục đích:** Tài liệu chi tiết về cấu trúc URL và quy tắc đặt tên cho thumbnails trong hệ thống.

**Cấu trúc URL Thumbnail:**

Thumbnails được lưu trữ trong R2 bucket với cấu trúc path như sau:

```
preset_thumb/{folderType}_{resolution}/{presetId}.{ext}
```

**Format URL đầy đủ:**

```
https://resources.d.shotpix.app/{bucket-name}/preset_thumb/{folderType}_{resolution}/{presetId}.{ext}
```

**Ví dụ:**

```
https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json
https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/lottie_avif_2x/fs_wonder_f_3.json
https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/webp_4x/preset_1234567890_abc123.webp
```

**Folder Types (Loại thư mục):**

| Folder Type | Mô tả | Extension | Content Type |
|-------------|-------|-----------|--------------|
| `webp` | WebP image format | `.webp` | `image/webp` |
| `lottie` | Lottie animation JSON | `.json` | `application/json` |
| `lottie_avif` | Lottie animation với AVIF optimization | `.json` | `application/json` |

**Resolutions (Độ phân giải):**

| Resolution | Mô tả | Use Case |
|------------|-------|----------|
| `1x` | Base resolution | Standard displays |
| `1.5x` | 1.5x resolution | Retina displays (1.5x) |
| `2x` | 2x resolution | Retina displays (2x) |
| `3x` | 3x resolution | High-DPI displays (3x) |
| `4x` | 4x resolution | Ultra high-DPI displays (4x) |

**Folder Naming Convention (Quy tắc đặt tên thư mục):**

Format: `{folderType}_{resolution}`

**Tất cả các folder types và resolutions được hỗ trợ:**

- `webp_1x`, `webp_1.5x`, `webp_2x`, `webp_3x`, `webp_4x`
- `lottie_1x`, `lottie_1.5x`, `lottie_2x`, `lottie_3x`, `lottie_4x`
- `lottie_avif_1x`, `lottie_avif_1.5x`, `lottie_avif_2x`, `lottie_avif_3x`, `lottie_avif_4x`

**Tổng cộng: 15 folder types × resolutions**

**File Naming Convention (Quy tắc đặt tên file):**

Format: `{presetId}.{ext}`

- `presetId`: ID của preset (ví dụ: `fs_frosted_window_portrait_f_4`, `preset_1234567890_abc123`)
- `ext`: Extension dựa trên folder type:
  - `webp` → `.webp`
  - `lottie` → `.json`
  - `lottie_avif` → `.json`

**Ví dụ file names:**

- `fs_frosted_window_portrait_f_4.json` (lottie thumbnail)
- `fs_wonder_f_3.webp` (webp thumbnail)
- `preset_1234567890_abc123.json` (lottie_avif thumbnail)

**Database Storage (Lưu trữ trong Database):**

Thumbnails được lưu trong bảng `presets` với trường `thumbnail_r2` dạng JSON:

```json
{
  "webp_1x": "preset_thumb/webp_1x/fs_frosted_window_portrait_f_4.webp",
  "webp_1.5x": "preset_thumb/webp_1.5x/fs_frosted_window_portrait_f_4.webp",
  "webp_2x": "preset_thumb/webp_2x/fs_frosted_window_portrait_f_4.webp",
  "webp_3x": "preset_thumb/webp_3x/fs_frosted_window_portrait_f_4.webp",
  "webp_4x": "preset_thumb/webp_4x/fs_frosted_window_portrait_f_4.webp",
  "lottie_1x": "preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json",
  "lottie_1.5x": "preset_thumb/lottie_1.5x/fs_frosted_window_portrait_f_4.json",
  "lottie_2x": "preset_thumb/lottie_2x/fs_frosted_window_portrait_f_4.json",
  "lottie_3x": "preset_thumb/lottie_3x/fs_frosted_window_portrait_f_4.json",
  "lottie_4x": "preset_thumb/lottie_4x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_1x": "preset_thumb/lottie_avif_1x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_1.5x": "preset_thumb/lottie_avif_1.5x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_2x": "preset_thumb/lottie_avif_2x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_3x": "preset_thumb/lottie_avif_3x/fs_frosted_window_portrait_f_4.json",
  "lottie_avif_4x": "preset_thumb/lottie_avif_4x/fs_frosted_window_portrait_f_4.json"
}
```

**Key trong JSON = `{folderType}_{resolution}`**
**Value trong JSON = R2 key (full path từ root)**

**Cách xây dựng URL từ R2 key:**

1. Lấy R2 key từ database: `preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json`
2. Kết hợp với R2 public domain: `https://resources.d.shotpix.app/{bucket-name}/{r2Key}`
3. Kết quả: `https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json`

**Lưu ý quan trọng:**

1. **Không có duplicate folders:** URL không bao giờ có dạng `preset_thumb/lottie_1x/lottie_1x/` (folder name bị lặp). Format đúng là `preset_thumb/lottie_1x/{presetId}.json`.

2. **Preset ID extraction:** Preset ID được extract từ filename (basename), không bao gồm path. Ví dụ:
   - File: `lottie_1x/fs_frosted_window_portrait_f_4.json`
   - Preset ID: `fs_frosted_window_portrait_f_4` (không phải `lottie_1x/fs_frosted_window_portrait_f_4`)

3. **Bucket name:** Bucket name khác nhau theo environment:
   - Development: `faceswap-images-office-dev`
   - Production: `faceswap-images-office-prod`
   - Default: `faceswap-images-office`

4. **R2 Public Domain:** Luôn sử dụng `https://resources.d.shotpix.app` cho public URLs.

5. **Cache Control:** Tất cả thumbnails có cache control header: `public, max-age=31536000, immutable` (1 năm).

**Ví dụ sử dụng trong code:**

**JavaScript/TypeScript:**
```javascript
// Lấy thumbnail URL từ database response
const preset = {
  id: "fs_frosted_window_portrait_f_4",
  thumbnail_r2: '{"lottie_1x":"preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json"}'
};

const thumbnailData = JSON.parse(preset.thumbnail_r2);
const r2Key = thumbnailData['lottie_1x']; // "preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json"
const bucketName = "faceswap-images-office-dev";
const publicUrl = `https://resources.d.shotpix.app/${bucketName}/${r2Key}`;
// Result: https://resources.d.shotpix.app/faceswap-images-office-dev/preset_thumb/lottie_1x/fs_frosted_window_portrait_f_4.json
```

**Mobile App (Swift/Kotlin):**
```swift
// Swift example
let thumbnailData = try JSONDecoder().decode([String: String].self, from: preset.thumbnailR2.data(using: .utf8)!)
if let r2Key = thumbnailData["lottie_1x"] {
    let bucketName = "faceswap-images-office-dev"
    let publicUrl = "https://resources.d.shotpix.app/\(bucketName)/\(r2Key)"
    // Use publicUrl to load thumbnail
}
```

**Best Practices:**

1. **Fallback resolution:** Luôn có fallback khi resolution không tồn tại:
   ```javascript
   const thumbnailUrl =
     thumbnailData['lottie_4x'] ||
     thumbnailData['lottie_3x'] ||
     thumbnailData['lottie_2x'] ||
     thumbnailData['lottie_1x'] ||
     thumbnailData['webp_4x'] ||
     thumbnailData['webp_1x'];
   ```

2. **Format preference:** Ưu tiên format theo thứ tự:
   - Lottie AVIF (tối ưu nhất cho animation)
   - Lottie (standard animation)
   - WebP (static image fallback)

3. **Resolution selection:** Chọn resolution dựa trên device pixel ratio:
   - 1x devices: `1x` hoặc `1.5x`
   - 2x devices (Retina): `2x` hoặc `3x`
   - 3x+ devices (Super Retina): `3x` hoặc `4x`

4. **Error handling:** Luôn kiểm tra URL tồn tại trước khi sử dụng:
   ```javascript
   if (thumbnailUrl && thumbnailUrl.startsWith('https://')) {
     // Safe to use
   }
   ```

---
