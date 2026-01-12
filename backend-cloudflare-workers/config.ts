// API Prompts Configuration - Centralized all prompts
export const VERTEX_AI_PROMPTS = {
  FACIAL_PRESERVATION_INSTRUCTION: 'Keep the person exactly as shown in the reference image with 100% identical facial features, bone structure, skin tone, and appearance. Remove all pimples, blemishes, and skin imperfections. Enhance skin texture with flawless, smooth, and natural appearance. 1:1 aspect ratio, 8K ultra-high detail, ultra-sharp facial features, and professional skin retouching.',

  MERGE_PROMPT_DEFAULT: `Create photorealistic composite placing the subject from [Image 1] into the scene of [Image 2]. The subject is naturally with corrected, realistic proportions, fix unnatural anatomical distortions, ensure legs are proportioned correctly and not artificially shortened by perspective, ensure hands and feet are realistically sized and shaped, avoiding any disproportionate scaling. The lighting, color temperature, contrast, and shadows on the subject perfectly match the background environment, making them look completely grounded and seamlessly integrated into the photograph. Ensure color grading and contrast are consistent between the subject and the environment for a natural look. If needed you can replace the existing outfit to match with the scene and environment, but keep each subject face and expression. Even the body propositions can be replace to ensure the photo is most realistic. Ensure the clothing fits the subjects' body shapes and proportions correctly.`,

  // Default prompt for normal face-swap preset generation
  PROMPT_GENERATION_DEFAULT: `IMPORTANT: You MUST respond with VALID JSON only. No explanations, no markdown, no code blocks, no additional text. Start your response with { and end with }.

Analyze the provided image and return a JSON object with exactly these 6 keys:
- "prompt": A detailed HDR scene description (2-3 sentences) including pose, outfit, environment, lighting, and mood. MUST include this exact text: "Replace the original face with the face from the image I will upload later. Keep the person exactly as shown in the reference image with 100% identical facial features, bone structure, skin tone, and appearance. Remove all pimples, blemishes, and skin imperfections. Enhance skin texture with flawless, smooth, and natural appearance. The final face must look exactly like the face in my uploaded image with 1:1 aspect ratio, 8K ultra-high detail, ultra-sharp facial features, and professional skin retouching."
- "style": One word (photorealistic, cinematic, artistic, etc.)
- "lighting": One word (natural, studio, dramatic, soft, etc.)
- "composition": One word (portrait, closeup, fullbody, etc.)
- "camera": One word (professional, smartphone, dslr, etc.)
- "background": One word (neutral, urban, nature, studio, etc.)

The entire response must be valid JSON only. Example: {"prompt":"A beautiful woman...","style":"photorealistic","lighting":"natural","composition":"portrait","camera":"professional","background":"neutral"}`,

  // Filter mode prompt for art style analysis (when checkbox is checked)
  PROMPT_GENERATION_FILTER: `Analyze the image the art and thematic styles and return a detailed description of its specific art styles contents. For example if its figurine, pop mart unique style, clay, disney.. to reimagine the image. Ensure the details does not specify gender to apply to any gender.`,

  // Complete filter style application instruction (includes selfie preservation)
  FILTER_STYLE_APPLICATION_INSTRUCTION: 'Maintain the exact facial features, composition, clothing of the selfie. Keeps hands, arms, legs, torso length, shoulder width, posture, and scale unchanged in the selfie, and the hair and hair colour.',

  // Default filter prompt (when prompt is not a string)
  FILTER_DEFAULT_PROMPT: 'Maintain the exact facial features, composition, clothing of the selfie. Keeps hands, arms, legs, torso length, shoulder width, posture, and scale unchanged in the selfie, and the hair and hair colour.',
};

// Image Processing Prompts Configuration
export const IMAGE_PROCESSING_PROMPTS = {
  ENHANCE: 'Beautify this portrait image by improving facial aesthetics: smooth skin texture, remove blemishes and acne, even out skin tone, subtly slim face and jawline, brighten eyes, enhance lips and eyebrows, slightly enlarge eyes if appropriate, soften or reshape nose subtly, and automatically adjust makeup. Maintain natural appearance and preserve facial structure.',

  FILTER: 'Restore and enhance this damaged photo to a hyper-realistic, ultra-detailed image, 16K DSLR quality. Fix scratches, tears, noise, and blurriness. Enhance colors to vivid, vibrant tones while keeping natural skin tones. Perfectly sharpen details in face, eyes, hair, and clothing. Add realistic lighting, shadows, and depth of field. Photoshop-level professional retouching. High dynamic range, ultra-HD, lifelike textures, cinematic finish, crisp and clean background, fully restored and enhanced version of the original photo.',
};

// Vertex AI Configuration - Centralized all Vertex AI settings
export const VERTEX_AI_CONFIG = {
  // Authentication
  AUTH: {
    SCOPES: ['https://www.googleapis.com/auth/cloud-platform'],
    REQUIRED_ENV_VARS: [
      'GOOGLE_SERVICE_ACCOUNT_EMAIL',
      'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
      'GOOGLE_VERTEX_PROJECT_ID'
    ],
  },

  // Locations and Endpoints
  LOCATIONS: {
    DEFAULT: 'us-central1',
    SUPPORTED: ['us-central1', 'us-east1', 'us-west1', 'europe-west1', 'asia-southeast1', 'global'],
    // Model-specific preferred locations
    MODEL_LOCATIONS: {
      'gemini-2.5-flash-image': 'us-central1',
      'gemini-3-pro-image-preview': 'global',
      'gemini-3-flash-preview': 'us-central1',
    },
  },

  // API Endpoints
  ENDPOINTS: {
    REGIONAL: (location: string, projectId: string, model: string) =>
      `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`,
    GLOBAL: (projectId: string, model: string) =>
      `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model}:generateContent`,
  },

  // Model Configuration
  MODELS: {
    IMAGE_GENERATION: 'gemini-2.5-flash-image',
    PROMPT_GENERATION: 'gemini-3-flash-preview',
    MAPPING: {
      '2.5': 'gemini-2.5-flash-image',
      '3p': 'gemini-3-pro-image-preview',
      '3f': 'gemini-3-flash-preview',
      // Legacy support
      '3': 'gemini-3-pro-image-preview',
    },
    DEFAULT: '2.5',
  },

  // API Generation Configuration
  IMAGE_GENERATION: {
    temperature: 1,
    maxOutputTokens: 32768,
    topP: 0.95,
    responseModalities: ['TEXT', 'IMAGE'] as const,
    imageConfig: {
      imageSize: '1K' as const,
      personGeneration: 'ALLOW_ALL' as const,
      imageOutputOptions: {
        mimeType: 'image/jpeg',
        compressionQuality: 100,
      },
    },
  },

  PROMPT_GENERATION: {
    temperature: 0.1,
    topK: 1,
    topP: 1,
    maxOutputTokens: 2048,
    responseMimeType: 'application/json' as const,
    responseSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed HDR scene description including character pose, outfit, environment, atmosphere, visual mood, and face-swap rule',
        },
        style: {
          type: 'string',
          description: 'Visual style description',
        },
        lighting: {
          type: 'string',
          description: 'HDR lighting description',
        },
        composition: {
          type: 'string',
          description: 'Composition details',
        },
        camera: {
          type: 'string',
          description: 'Camera settings and lens information',
        },
        background: {
          type: 'string',
          description: 'Background environment description',
        },
        art_style: {
          type: 'object',
          description: 'Art style metadata for face-swap reimagining',
          properties: {
            type: { type: 'string', description: 'Detected or specified art style type' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'Style-specific keywords' },
            face_swap_instruction: { type: 'string', description: 'Style-specific face preservation instruction' },
          },
        },
      },
      required: ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'],
    },
  },

  // Safety Settings - Only block HIGH confidence, allow NEGLIGIBLE, LOW, and MEDIUM
  SAFETY_SETTINGS: [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' as const },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' as const },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' as const },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' as const },
  ],

  // Safety violation status codes (2000+)
  SAFETY_STATUS_CODES: {
    HATE_SPEECH: 2000,
    HARASSMENT: 2001,
    SEXUALLY_EXPLICIT: 2002,
    DANGEROUS_CONTENT: 2003,
    UNKNOWN_ERROR: 3000, // Safety violation detected but specific category cannot be determined
  },

  // Harm category mapping
  HARM_CATEGORY_MAP: {
    'HARM_CATEGORY_HATE_SPEECH': 2000,
    'HARM_CATEGORY_HARASSMENT': 2001,
    'HARM_CATEGORY_SEXUALLY_EXPLICIT': 2002,
    'HARM_CATEGORY_DANGEROUS_CONTENT': 2003,
  },
};

// Keep backward compatibility
export const API_PROMPTS = VERTEX_AI_PROMPTS;

export const API_CONFIG = {
  IMAGE_GENERATION: {
    temperature: 1,
    maxOutputTokens: 32768,
    topP: 0.95,
    responseModalities: ['TEXT', 'IMAGE'] as const,
    imageConfig: {
      imageSize: '1K' as const,
      personGeneration: 'ALLOW_ALL' as const,
      imageOutputOptions: {
        mimeType: 'image/jpeg',
        compressionQuality: 100,
      },
    },
  },
  
  PROMPT_GENERATION: {
    temperature: 0.1,
    topK: 1,
    topP: 1,
    maxOutputTokens: 2048,
    responseMimeType: 'application/json' as const,
    responseSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed HDR scene description including character pose, outfit, environment, atmosphere, visual mood, and face-swap rule',
        },
        style: {
          type: 'string',
          description: 'Visual style description',
        },
        lighting: {
          type: 'string',
          description: 'HDR lighting description',
        },
        composition: {
          type: 'string',
          description: 'Composition details',
        },
        camera: {
          type: 'string',
          description: 'Camera settings and lens information',
        },
        background: {
          type: 'string',
          description: 'Background environment description',
        },
        art_style: {
          type: 'object',
          description: 'Art style metadata for face-swap reimagining',
          properties: {
            type: { type: 'string', description: 'Detected or specified art style type' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'Style-specific keywords' },
            face_swap_instruction: { type: 'string', description: 'Style-specific face preservation instruction' },
          },
        },
      },
      required: ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'],
    },
  },
};

export const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' as const },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' as const },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' as const },
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' as const },
];

export const MODEL_CONFIG = {
  IMAGE_GENERATION_MODEL: 'gemini-2.5-flash-image',
  PROMPT_GENERATION_MODEL: 'gemini-3-flash-preview',
  MODEL_MAPPING: {
    '2.5': 'gemini-2.5-flash-image',
    '3p': 'gemini-3-pro-image-preview',
    '3f': 'gemini-3-flash-preview',
  },
  DEFAULT_MODEL: '2.5',
};

export const ASPECT_RATIO_CONFIG = {
  SUPPORTED: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  DEFAULT: '3:4',
};

export const API_ENDPOINTS = {
  WAVESPEED_UPSCALER: 'https://api.wavespeed.ai/api/v3/wavespeed-ai/image-upscaler',
  WAVESPEED_RESULT: (requestId: string) => `https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`,
  OAUTH_TOKEN: 'https://oauth2.googleapis.com/token',
};

export const TIMEOUT_CONFIG = {
  DEFAULT_REQUEST: 25000,  // 25s - Cloudflare Workers have 30s limit
  OAUTH_TOKEN: 10000,      // 10s - OAuth should be fast
  IMAGE_FETCH: 15000,      // 15s - R2/CDN fetches should be quick
  VERTEX_AI: 60000,        // 60s - Vertex AI prompt generation (allow 20-50+ second responses)
  POLLING: {
    MAX_ATTEMPTS: 20,
    FIRST_DELAY: 8000,
    SECOND_THIRD_DELAY: 4000,
    SUBSEQUENT_DELAY: 2000,
  },
};

export const CACHE_CONFIG = {
  TOKEN_CACHE_SIZE: 50,
  TOKEN_EXPIRY_BUFFER: 3300,
  TOKEN_VALIDITY: 3600,
  R2_CACHE_CONTROL: 'public, max-age=31536000, immutable',
  PROMPT_CACHE_TTL: 31536000, // 1 year in seconds (365 days)
};

export const DEFAULT_VALUES = {
  ASPECT_RATIO: '3:4',
  MODEL: '2.5',
  IMAGE_MIME_TYPE: 'image/jpeg',
  RESULT_EXT: 'jpg',
  UPSCALER_EXT: 'png',
  UPSCALER_MIME_TYPE: 'image/png',
  UPSCALER_TARGET_RESOLUTION: '4k',
  UPSCALER_OUTPUT_FORMAT: 'jpeg',
};
