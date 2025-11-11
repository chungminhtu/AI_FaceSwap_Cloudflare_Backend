export interface Env {
  RAPIDAPI_KEY: string;
  GOOGLE_CLOUD_API_KEY: string;
  GOOGLE_CLOUD_PROJECT_ID?: string;
  RAPIDAPI_HOST?: string;
  RAPIDAPI_ENDPOINT?: string;
  GOOGLE_VISION_ENDPOINT?: string;
}

export interface FaceSwapRequest {
  TargetImageUrl: string;
  SourceImageUrl: string;
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

