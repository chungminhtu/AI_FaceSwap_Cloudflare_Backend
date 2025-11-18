export interface Env {
  RAPIDAPI_KEY: string;
  RAPIDAPI_HOST: string;
  RAPIDAPI_ENDPOINT: string;
  GOOGLE_CLOUD_API_KEY: string;
  GOOGLE_VISION_ENDPOINT: string;
  FACESWAP_IMAGES: R2Bucket;
  DB: D1Database;
  R2_PUBLIC_URL?: string; // Optional: Custom domain or public R2 URL
  DISABLE_SAFE_SEARCH?: string; // Optional: Set to 'true' to disable safe search validation
  SAFETY_STRICTNESS?: string; // Optional: 'strict' (blocks LIKELY+VERY_LIKELY) or 'lenient' (blocks only VERY_LIKELY). Default: 'lenient'
}

export interface FaceSwapRequest {
  target_url: string;
  source_url: string;
  selfie_id?: string;
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
}

export interface UploadUrlResponse {
  uploadUrl: string;
  publicUrl: string;
}

export interface PresetCollection {
  id: string;
  name: string;
  images: PresetImage[];
  created_at: string;
}

export interface PresetImage {
  id: string;
  collection_id: string;
  image_url: string;
  created_at: string;
}

export interface PresetListResponse {
  preset_collections: PresetCollection[];
}

export interface Result {
  id: string;
  preset_collection_id: string;
  preset_image_id: string;
  preset_name: string;
  result_url: string;
  created_at: string;
}

export interface ResultListResponse {
  results: Result[];
}

