export interface Env {
  RAPIDAPI_KEY: string;
  RAPIDAPI_HOST: string;
  RAPIDAPI_ENDPOINT: string;
  GOOGLE_CLOUD_API_KEY: string;
  GOOGLE_VISION_ENDPOINT: string;
  FACESWAP_IMAGES: R2Bucket;
  DB: D1Database;
  R2_PUBLIC_URL?: string; // Optional: Custom domain or public R2 URL
}

export interface FaceSwapRequest {
  target_url: string;
  source_url: string;
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
}

export interface SafeSearchResult {
  isSafe: boolean;
  error?: string;
}

export interface GoogleVisionResponse {
  responses?: Array<{
    safeSearchAnnotation?: { adult: string; violence: string; racy: string };
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

export interface Preset {
  id: string;
  name: string;
  image_url: string;
  created_at: string;
}

export interface PresetListResponse {
  presets: Preset[];
}

export interface Result {
  id: string;
  preset_id: string;
  preset_name: string;
  result_url: string;
  created_at: string;
}

export interface ResultListResponse {
  results: Result[];
}

