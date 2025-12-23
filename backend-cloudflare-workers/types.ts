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
}

export interface BackgroundRequest {
  preset_image_id?: string; // Optional: Preset image ID from database (landscape scene)
  preset_image_url?: string; // Optional: Preset image URL (alternative to preset_image_id)
  selfie_id?: string; // Optional: Selfie ID from database (person with transparent background)
  selfie_image_url?: string; // Optional: Selfie image URL (alternative to selfie_id)
  profile_id: string; // Required: Profile ID for the operation
  additional_prompt?: string; // Optional: Additional instructions for merging
  custom_prompt?: string; // Optional: Custom prompt to generate background image from text (alternative to preset_image_id/preset_image_url)
  aspect_ratio?: string; // Optional: Aspect ratio for image generation (e.g., "1:1", "16:9", "9:16", etc.)
  model?: string | number; // Optional: Model parameter ("2.5" for gemini-2.5-flash-image, "3" for gemini-3-pro-image-preview). Default: "2.5"
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
}

export interface Profile {
  id: string;
  device_id?: string;
  name?: string;
  email?: string;
  avatar_url?: string;
  preferences?: string; // JSON string
  created_at: string;
  updated_at: string;
}


