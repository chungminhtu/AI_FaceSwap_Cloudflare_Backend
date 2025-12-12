// Environment variables come from deployments-secrets.json via deploy.js
// Only typing Cloudflare-specific bindings that need type safety
export interface Env {
  [key: string]: any; // All env vars from JSON config + dynamic bindings
  RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  }; // Cloudflare built-in rate limiter
  PROMPT_CACHE_KV?: KVNamespace; // KV namespace for prompt_json caching
}

export interface FaceSwapRequest {
  preset_image_id?: string; // Optional: Preset image ID from database
  preset_image_url?: string; // Optional: Preset image URL (alternative to preset_image_id)
  selfie_ids?: string[]; // Optional: Array of selfie IDs from database
  selfie_image_urls?: string[]; // Optional: Array of selfie image URLs (alternative to selfie_ids)
  profile_id: string; // Required: Profile ID for the operation
  additional_prompt?: string;
  character_gender?: 'male' | 'female';
  aspect_ratio?: string; // Optional: Aspect ratio for image generation (e.g., "1:1", "16:9", "9:16", etc.)
  model?: string | number; // Optional: Model parameter ("2.5" for gemini-2.5-flash-image, "3" for gemini-3-pro-image-preview). Default: "2.5"
}

export interface RemoveBackgroundRequest {
  preset_image_id?: string; // Optional: Preset image ID from database (landscape scene)
  preset_image_url?: string; // Optional: Preset image URL (alternative to preset_image_id)
  selfie_id?: string; // Optional: Selfie ID from database (person with transparent background)
  selfie_image_url?: string; // Optional: Selfie image URL (alternative to selfie_id)
  profile_id: string; // Required: Profile ID for the operation
  additional_prompt?: string; // Optional: Additional instructions for merging
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

export interface SafeSearchResult {
  isSafe: boolean;
  error?: string;
  statusCode?: number; // Safety violation code (1001-1005)
  violationCategory?: string; // 'adult', 'violence', 'racy', 'medical', 'spoof'
  violationLevel?: string; // 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'
  details?: {
    adult: string;
    spoof?: string;
    medical?: string;
    violence: string;
    racy: string;
  };
  rawResponse?: GoogleVisionResponse; // Full raw response from Vision API
  debug?: Record<string, any>;
}

export interface GenericApiResponse<T> {
  data?: T;
  status: string;
  message?: string;
  code: number;
}

export interface GoogleVisionResponse {
  responses?: Array<{
    safeSearchAnnotation?: {
      adult: string;
      spoof?: string;
      medical?: string;
      violence: string;
      racy: string;
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
  gender?: 'male' | 'female'; // Optional: Gender classification for the asset
}

export interface UploadUrlResponse {
  data: {
    results: Array<{
      id: string;
      url: string;
      filename: string;
    }>;
    count: number;
    successful: number;
    failed: number;
  };
  status: 'success' | 'error';
  message: string;
  code: number;
  debug?: {
    vertex?: Array<{
      hasPrompt?: boolean;
      prompt_json?: any;
      vertex_info?: any;
    }>;
  };
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

export interface PresetImage {
  id: string;
  preset_url: string; // Full URL (assembled from stored key)
  thumbnail_url?: string; // Thumbnail URL (reconstructed from thumbnail_r2 R2 key)
  created_at: string;
}

export interface Selfie {
  id: string;
  selfie_url: string; // Full URL (assembled from stored key in database)
  profile_id: string;
  action?: string | null; // Action type (e.g., "faceswap", "default", etc.)
  created_at: string;
}

export interface PresetListResponse {
  presets: PresetImage[];
}

export interface SelfieListResponse {
  selfies: Selfie[];
}

export interface ProfileListResponse {
  profiles: Profile[];
}

export interface Result {
  id: string; // INTEGER from database, returned as string
  result_url: string; // Full URL (assembled from stored key)
  profile_id: string;
  created_at: string;
}

export interface ResultListResponse {
  results: Result[];
}

