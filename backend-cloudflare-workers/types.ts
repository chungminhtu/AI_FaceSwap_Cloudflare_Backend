export interface Env {
  RAPIDAPI_KEY: string;
  RAPIDAPI_HOST: string;
  RAPIDAPI_ENDPOINT: string;
  GOOGLE_VISION_API_KEY: string;
  GOOGLE_VERTEX_PROJECT_ID: string;
  GOOGLE_VERTEX_LOCATION: string;
  GOOGLE_VISION_ENDPOINT: string;
  R2_BUCKET_BINDING?: string; // Dynamic R2 bucket binding name (defaults to bucket name)
  D1_DATABASE_BINDING?: string; // Dynamic D1 database binding name (defaults to database name)
  [key: string]: any; // Allow dynamic bindings for R2 buckets and D1 databases
  NANO_BANANA_API_URL?: string;
  NANO_BANANA_API_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string; // Optional: Service account email for OAuth token generation
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string; // Optional: Service account private key for OAuth token generation
  R2_ACCOUNT_ID?: string; // Optional: Cloudflare account ID for auto URL generation (e.g., 32 hex characters)
  CF_ACCOUNT_ID?: string; // Alias for R2_ACCOUNT_ID
  ACCOUNT_ID?: string; // Fallback alias
  R2_BUCKET_NAME?: string; // Optional override for the R2 bucket name used to build public URLs
  CUSTOM_DOMAIN?: string; // Custom domain for R2 public URLs (e.g., https://resources.d.shotpix.app)
  WORKER_CUSTOM_DOMAIN?: string; // Custom domain for Worker API (e.g., https://api.d.shotpix.app)
  WAVESPEED_API_KEY?: string; // WaveSpeed.ai API key
  DISABLE_SAFE_SEARCH?: string; // Optional: Set to 'true' to disable safe search validation
  SAFETY_STRICTNESS?: string; // Optional: 'strict' (blocks LIKELY+VERY_LIKELY) or 'lenient' (blocks only VERY_LIKELY). Default: 'lenient'
  ENABLE_DEBUG_RESPONSE?: string; // Optional: Set to 'true' to enable debug payloads in responses, 'false' to disable. Default: disabled (when not set or null)
  RESULT_MAX_HISTORY?: string; // Optional: Maximum number of result history entries per user. Default: 10
  SELFIE_MAX_FACESWAP?: string; // Optional: Maximum number of faceswap selfies to keep per user. Default: 5
  SELFIE_MAX_OTHER?: string; // Optional: Maximum number of non-faceswap selfies (all other actions combined) to keep per user. Default: 1
  ALLOWED_ORIGINS?: string; // Optional: Comma-separated list of allowed CORS origins. Default: '*' (allows all)
  RATE_LIMIT_KV?: KVNamespace; // Optional: KV namespace for rate limiting
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

