# 5. Hệ thống & Cấu hình

## 5.1. GET `/config` - Lấy config

**Mục đích:** Lấy cấu hình public của Worker (custom domains).

**Authentication:** Không yêu cầu API key.

**Request:**
```bash
curl https://api.d.shotpix.app/config
```

**Response:**
```json
{
  "data": {
    "backendDomain": "https://api.d.shotpix.app",
    "r2Domain": "https://resources.d.shotpix.app",
    "kvCache": {
      "available": true,
      "test": "success",
      "details": {
        "bindingName": "PROMPT_CACHE_KV",
        "envKeys": ["PROMPT_CACHE_KV_BINDING_NAME", "..."]
      }
    }
  },
  "status": "success",
  "message": "Config retrieved successfully",
  "code": 200
}
```

---

## 5.2. OPTIONS `/*` - CORS preflight requests

**Mục đích:** Xử lý CORS preflight requests cho tất cả các endpoints. Tự động được gọi bởi trình duyệt khi thực hiện cross-origin requests.

**Authentication:** Không yêu cầu API key.

**Response:**

Trả về HTTP 204 (No Content) với các headers CORS:
- `Access-Control-Allow-Origin`: Cho phép tất cả origins
- `Access-Control-Allow-Methods`: GET, POST, PUT, DELETE, OPTIONS
- `Access-Control-Allow-Headers`: Content-Type, Authorization, X-API-Key, và các headers khác
- `Access-Control-Max-Age`: 86400 (24 giờ)

Endpoint `/upload-proxy/*` có hỗ trợ thêm method PUT trong CORS headers.

---
