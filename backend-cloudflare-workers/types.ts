// Environment variables come from deployments-secrets.json via deploy.js
// Only typing Cloudflare-specific bindings that need type safety
export interface Env {
  [key: string]: any; // All env vars from JSON config + dynamic bindings (including KV namespaces with dynamic names)
  RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  }; // Cloudflare built-in rate limiter
}

export interface FaceSwapRequest {
  preset_image_id?: string; // Optional: Preset image ID from database
  preset_image_url?: string; // Optional: Preset image URL (alternative to preset_image_id)
  selfie_ids?: string[]; // Optional: Array of selfie IDs from database
  selfie_image_urls?: string[]; // Optional: Array of selfie image URLs (alternative to selfie_ids)
  profile_id: string; // Required: Profile ID for the operation
  additional_prompt?: string;
  aspect_ratio?: string; // Optional: Aspect ratio for image generation (e.g., "1:1", "16:9", "9:16", etc.)
  model?: string | number; // Optional: Model parameter ("2.5" for gemini-2.5-flash-image, "3" for gemini-3-pro-image-preview). Default: "2.5"
  action?: string; // Optional: Action type to validate selfies match (e.g., "faceswap", "wedding", "4k")
  format?: string; // Optional: Preferred format for preset thumbnails ('webp', 'lottie', 'avif'). Default: 'webp'
  provider?: 'vertex' | 'wavespeed' | 'wavespeed_gemini_2_5_flash_image'; // Optional: Override IMAGE_PROVIDER config
}

export interface BackgroundRequest {
  preset_image_id?: string; // Optional: Preset image ID from database (landscape scene) or filename in remove_bg/background folder
  preset_image_url?: string; // Optional: Preset image URL (alternative to preset_image_id)
  selfie_id?: string; // Optional: Selfie ID from database (person with transparent background)
  selfie_image_url?: string; // Optional: Selfie image URL (alternative to selfie_id)
  profile_id: string; // Required: Profile ID for the operation
  custom_prompt?: string; // Optional: Custom prompt to generate background image from text (alternative to preset_image_id/preset_image_url)
  aspect_ratio?: string; // Optional: Aspect ratio for image generation (e.g., "1:1", "16:9", "9:16", etc.)
  model?: string | number; // Optional: Model parameter ("2.5" for gemini-2.5-flash-image, "3" for gemini-3-pro-image-preview). Default: "2.5"
  provider?: 'vertex' | 'wavespeed' | 'wavespeed_gemini_2_5_flash_image'; // Optional: Override IMAGE_PROVIDER config
}

export interface FaceSwapResponse {
  ResultImageUrl?: string;
  FaceSwapCount?: number;
  Success: boolean;
  Message: string;
  StatusCode: number;
  ProcessingTime?: string;
  ProcessingTimeSpan?: string;
  ProcessStartedDateTime?: string;
  Error?: string;
  Debug?: Record<string, any>;
  VertexResponse?: any;
  Prompt?: any;
  CurlCommand?: string | null;
  FullResponse?: any;
  RawResponse?: any;
  SafetyCheck?: {
    checked: boolean;
    isSafe: boolean;
    details?: {
      adult: string;
      violence: string;
      racy: string;
    };
    error?: string;
  };
}

// Tìm kiếm An toàn: Tập hợp các đặc điểm liên quan đến hình ảnh, được tính toán bằng các phương pháp thị giác máy tính
export interface SafeSearchResult {
  isSafe: boolean;
  error?: string;
  statusCode?: number; // Safety violation code (1001-1005)
  violationCategory?: string; // 'adult', 'violence', 'racy', 'medical', 'spoof'
  violationLevel?: string; // 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'
  details?: {
    adult: string; // Thể hiện khả năng nội dung dành cho người lớn của hình ảnh. Nội dung dành cho người lớn có thể bao gồm các yếu tố như khỏa thân, hình ảnh hoặc phim hoạt hình khiêu dâm, hoặc các hoạt động tình dục.
    spoof?: string; // Xác suất chế giễu. Xác suất xảy ra việc chỉnh sửa phiên bản gốc của hình ảnh để làm cho nó trông hài hước hoặc phản cảm.
    medical?: string; // Rất có thể đây là hình ảnh y tế.
    violence: string; // Hình ảnh này có khả năng chứa nội dung bạo lực. Nội dung bạo lực có thể bao gồm cái chết, thương tích nghiêm trọng hoặc tổn hại đến cá nhân hoặc nhóm cá nhân.
    racy: string; // Khả năng cao hình ảnh được yêu cầu chứa nội dung khiêu dâm. Nội dung khiêu dâm có thể bao gồm (nhưng không giới hạn) quần áo mỏng manh hoặc xuyên thấu, khỏa thân được che đậy một cách khéo léo, tư thế tục tĩu hoặc khiêu khích, hoặc cận cảnh các vùng nhạy cảm trên cơ thể.
  };
  rawResponse?: GoogleVisionResponse; // Full raw response from Vision API
  debug?: Record<string, any>;
}

// Tìm kiếm An toàn: Tập hợp các đặc điểm liên quan đến hình ảnh, được tính toán bằng các phương pháp thị giác máy tính
export interface GoogleVisionResponse {
  responses?: Array<{
    safeSearchAnnotation?: {
      adult: string; // Thể hiện khả năng nội dung dành cho người lớn của hình ảnh. Nội dung dành cho người lớn có thể bao gồm các yếu tố như khỏa thân, hình ảnh hoặc phim hoạt hình khiêu dâm, hoặc các hoạt động tình dục.
      spoof?: string; // Xác suất chế giễu. Xác suất xảy ra việc chỉnh sửa phiên bản gốc của hình ảnh để làm cho nó trông hài hước hoặc phản cảm.
      medical?: string; // Rất có thể đây là hình ảnh y tế.
      violence: string; // Hình ảnh này có khả năng chứa nội dung bạo lực. Nội dung bạo lực có thể bao gồm cái chết, thương tích nghiêm trọng hoặc tổn hại đến cá nhân hoặc nhóm cá nhân.
      racy: string; // Khả năng cao hình ảnh được yêu cầu chứa nội dung khiêu dâm. Nội dung khiêu dâm có thể bao gồm (nhưng không giới hạn) quần áo mỏng manh hoặc xuyên thấu, khỏa thân được che đậy một cách khéo léo, tư thế tục tĩu hoặc khiêu khích, hoặc cận cảnh các vùng nhạy cảm trên cơ thể.
    };
    error?: { message: string };
  }>;
}

export interface UploadUrlRequest {
  filename: string;
  type: 'preset' | 'selfie';
  profile_id: string; // Required: Profile ID for the upload
  presetName?: string; // Optional: Name for preset collection
  enableVertexPrompt?: boolean; // Optional: Generate Vertex AI prompt automatically
  is_filter_mode?: boolean; // Optional: Use art style filter prompt instead of default face-swap prompt
}

export interface ThumbnailUploadRequest {
  files: File[] | FormData;
  is_filter_mode?: boolean; // Optional: Use art style filter prompt for presets in this batch
}

export interface ProcessThumbnailsRequest {
  uploadId: string;
  files: Array<{
    uploadKey: string;
    processPath: string;
    filename: string;
  }>;
  is_filter_mode?: boolean; // Optional: Use art style filter prompt for presets in this batch
}

export interface PromptJson {
  prompt: string;
  style: string;
  lighting: string;
  composition: string;
  camera: string;
  background: string;
}

export interface Profile {
  id: string;
  device_id?: string;
  user_id?: string; // External user ID for searching
  name?: string;
  email?: string;
  avatar_url?: string;
  preferences?: string; // JSON string
  created_at: string;
  updated_at: string;
}

// ============================================================
// Payment & Credit System Types
// ============================================================

export interface Product {
  sku: string;
  type: 'consumable' | 'subscription';
  credits: number;
  points_per_cycle: number;
  name: string;
  description: string;
  price_micros: number;
  currency: string;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export interface Payment {
  id: string;
  profile_id: string;
  sku: string;
  order_id: string;
  purchase_token: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED';
  credits_granted: number;
  amount_micros: number;
  currency: string;
  platform: string;
  raw_response: string | null;
  created_at: number;
  updated_at: number;
}

export interface Subscription {
  id: string;
  profile_id: string;
  sku: string;
  purchase_token: string;
  points_per_cycle: number;
  status: 'ACTIVE' | 'GRACE' | 'ON_HOLD' | 'CANCELLED' | 'EXPIRED' | 'PAUSED';
  auto_renewing: number;
  started_at: number;
  expires_at: number;
  last_reset_at: number;
  cycle_count_used: number;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DepositRequest {
  profile_id: string;
  sku: string;
  purchase_token: string;
  order_id: string;
}

export interface SubscriptionVerifyRequest {
  profile_id: string;
  sku: string;
  purchase_token: string;
}

export interface BalanceResponse {
  sub_point_remaining: number;
  consumable_point_remaining: number;
  total_available: number;
  subscription_status: 'ACTIVE' | 'GRACE' | 'ON_HOLD' | 'CANCELLED' | 'EXPIRED' | 'PAUSED' | 'NONE';
  total_credits_purchased: number;
  total_credits_spent: number;
}

// FCM Device Token for push notifications
export interface DeviceToken {
  token: string;
  profile_id: string;
  platform: 'android' | 'ios';
  app_version?: string;
  updated_at: number;
}

// Register device request
export interface DeviceRegisterRequest {
  profile_id: string;
  platform: 'android' | 'ios';
  token: string;
  app_version?: string;
}

// Silent push request (internal/admin)
export interface SilentPushRequest {
  profile_id: string;
  data: Record<string, string>;
  exclude_token?: string;  // Optional: exclude current device
}

// FCM send result
export interface FcmSendResult {
  token: string;
  platform: string;
  success: boolean;
  error?: string;
  should_remove?: boolean;  // True if token is invalid (NOT_REGISTERED)
}


