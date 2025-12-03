export interface Env {
  RAPIDAPI_KEY: string;
  RAPIDAPI_HOST: string;
  RAPIDAPI_ENDPOINT: string;
  GOOGLE_VISION_API_KEY: string;
  GOOGLE_VERTEX_PROJECT_ID: string;
  GOOGLE_VERTEX_LOCATION: string;
  GOOGLE_VISION_ENDPOINT: string;
  FACESWAP_IMAGES: R2Bucket;
  DB: D1Database;
  NANO_BANANA_API_URL?: string;
  NANO_BANANA_API_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string; // Optional: Service account email for OAuth token generation
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string; // Optional: Service account private key for OAuth token generation
  R2_ACCOUNT_ID?: string; // Optional: Cloudflare account ID for auto URL generation (e.g., 32 hex characters)
  CF_ACCOUNT_ID?: string; // Alias for R2_ACCOUNT_ID
  ACCOUNT_ID?: string; // Fallback alias
  R2_BUCKET_NAME?: string; // Optional override for the R2 bucket name used to build public URLs
  DISABLE_SAFE_SEARCH?: string; // Optional: Set to 'true' to disable safe search validation
  SAFETY_STRICTNESS?: string; // Optional: 'strict' (blocks LIKELY+VERY_LIKELY) or 'lenient' (blocks only VERY_LIKELY). Default: 'lenient'
}

export interface FaceSwapRequest {
  target_url: string;
  source_url: string;
  selfie_id?: string;
  profile_id: string; // Required: Profile ID for the operation
  mode?: 'rapidapi' | 'vertex'; // Optional: Face swap mode
  additional_prompt?: string;
  character_gender?: 'male' | 'female';
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
  uploadUrl: string;
  publicUrl: string;
}

export interface Profile {
  id: string;
  name?: string;
  email?: string;
  avatar_url?: string;
  preferences?: string; // JSON string
  created_at: string;
  updated_at: string;
}

export interface PresetImage {
  id: string;
  image_url: string;
  filename: string;
  preset_name?: string;
  prompt_json?: string;
  gender?: 'male' | 'female'; // Optional gender classification
  created_at: string;
}

export interface Selfie {
  id: string;
  image_url: string;
  filename: string;
  gender?: 'male' | 'female'; // Optional gender classification
  profile_id: string;
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
  id: string;
  selfie_id: string;
  preset_id: string;
  preset_name: string;
  result_url: string;
  profile_id: string;
  created_at: string;
}

export interface ResultListResponse {
  results: Result[];
}

