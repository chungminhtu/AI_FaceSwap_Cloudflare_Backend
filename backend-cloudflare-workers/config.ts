// API Prompts Configuration - Centralized all prompts
export const VERTEX_AI_PROMPTS = {
  // Face preservation instruction - specifically for face-swap operations (requires human faces)
  // This is appended to face-swap prompts to ensure facial identity is preserved
  FACIAL_PRESERVATION_INSTRUCTION: 'Keep the person exactly as shown in the reference image with 100% identical facial features, bone structure, skin tone, and appearance. Remove all pimples, blemishes, and skin imperfections. Enhance skin texture with flawless, smooth, and natural appearance. 8K ultra-high detail, ultra-sharp facial features, and professional skin retouching.',

  // Content safety instruction - appended to ALL image generation prompts
  // Works for any image type (people, objects, landscapes, etc.)
  // Blocks illegal/harmful content, allows all normal content
  CONTENT_SAFETY_INSTRUCTION: `CONTENT SAFETY POLICY:

MUST BLOCK (illegal/harmful):
- CSAM: Any sexual or sexualized content involving minors (under 18)
- Explicit nudity: Exposed genitals, exposed nipples (including through see-through clothing/wet fabric)
- Sexual acts: Intercourse, oral sex, masturbation, or any explicit sexual activity
- Extreme violence: Gore, torture, mutilation, graphic injury
- Non-consensual imagery: Revenge porn, deepfakes for harassment

ALWAYS ALLOW (legal/appropriate):
- Children in normal contexts: Family photos, school photos, birthday parties, beach/pool in appropriate swimwear
- Adults in swimwear/lingerie: Bikinis, underwear, revealing clothing (without exposed genitals/nipples)
- All non-human subjects: Objects, products, animals, pets, landscapes, food, art, architecture
- Fashion/fitness: Athletic wear, yoga poses, dance, modeling
- Artistic content: Paintings, sculptures, illustrations, digital art
- Old/damaged photos: Vintage photos, historical images for restoration`,

  // Merge/composite prompt - works for any subject type
  MERGE_PROMPT_DEFAULT: `Create photorealistic composite placing the subject from [Image 1] into the scene of [Image 2]. Seamlessly integrate the subject with corrected, realistic proportions. The lighting, color temperature, contrast, and shadows on the subject perfectly match the background environment, making them look completely grounded and naturally integrated into the photograph. Ensure color grading and contrast are consistent between the subject and the environment for a natural look. For people: preserve facial features and expressions, adjust clothing if needed to match the scene. For objects/animals: preserve key characteristics and scale appropriately. Ensure the final composite looks like a natural, unedited photograph.`,

  // Default prompt for face-swap preset generation - analyzes preset images to generate prompts
  // This is specifically for face-swap operations where a user's face will be swapped onto a preset image
  PROMPT_GENERATION_DEFAULT: `Analyze the provided image and return a detailed description of its contents, pose, clothing, environment, HDR lighting, style, and composition in a strict JSON format. Generate a JSON object with the following keys: "prompt", "style", "lighting", "composition", "camera", and "background". For the "prompt" key, write a detailed HDR scene description based on the target image, including the character's pose, outfit, environment, atmosphere, and visual mood. In the "prompt" field, also include this exact face-swap rule: "Replace the original face with the face from the image I will upload later. Keep the person exactly as shown in the reference image with 100% identical facial features, bone structure, skin tone, and appearance. Remove all pimples, blemishes, and skin imperfections. Enhance skin texture with flawless, smooth, and natural appearance. The final face must look exactly like the face in my uploaded image with 8K ultra-high detail, ultra-sharp facial features, and professional skin retouching. Do not alter the facial structure, identity, age, or ethnicity, and preserve all distinctive facial features. Makeup, lighting, and color grading may be adjusted only to match the HDR visual look of the target scene." The generated prompt must be fully compliant with content policies. The JSON should fully describe the image and follow the specified structure, without any extra commentary or text outside the JSON.`,

  // Filter mode prompt for art style analysis (when checkbox is checked)
  PROMPT_GENERATION_FILTER: `Analyze the image the art and thematic styles and return a detailed description of its specific art styles contents. For example if its figurine, pop mart unique style, clay, disney.. to reimagine the image. Ensure the details does not specify gender to apply to any gender.`,
};

// WaveSpeed Face Swap Prompts Configuration
export const WAVESPEED_PROMPTS = {
  // Single mode: 1 selfie + 1 preset
  // image1 = selfie, image2 = preset
  FACESWAP_SINGLE: `Image 2 is a finished photo of a person.

Analyze the facial proportions and hair of the person in Image 2 to resemble Image 1, while keeping the same skin, lighting, and overall appearance.

Do not change the body, head size, or pose. 

Ensure the skin overall of the body (hands, legs, neck, shoulder,..) should match with the skin face to make it realistic.`,

  // Couple mode: 2 selfies + 1 preset
  // image1 = selfie1 (Subject_1_Identity), image2 = selfie2 (Subject_2_Identity), image3 = preset (placeholder people)
  FACESWAP_COUPLE: `Image 3 is a finished image containing two people.

Make very slight adjustments to the facial structure of each person in Image 3, inspired by the general facial characteristics of Subject_1_Identity and Subject_2_Identity.

Preserve the original facial expression and emotional tone of each person in Image 3.

Analyze the race and facial proportions (such as eyes, mouth, hair, hairstyles, color) of Subject_1_Identity and Subject_2_Identity, and use this analysis to resemble final image.

Ensure the skin overall of the body (hands, fingers legs, neck, shoulder,..) should match with the face to make it most realistic in finished photo.

Do not add or remove people.`,

  // Background merge mode: 1 selfie + 1 background/preset
  // image1 = selfie (person with or without transparent background), image2 = background scene
  MERGE_PROMPT_DEFAULT: `Seamlessly place the person from Image 1 into the scene from Image 2. Integrate the person naturally with proper scale, perspective, and positioning. Match lighting, shadows, color temperature, and contrast perfectly with the background environment. Ensure realistic compositing with proper edge blending, ambient occlusion, and environmental reflections. The person should look naturally grounded in the scene as if photographed together.`,
};

// Image Processing Prompts Configuration
export const IMAGE_PROCESSING_PROMPTS = {
  // Enhancement prompt - works for any image (people, objects, landscapes, products, etc.)
  ENHANCE: 'Professional image enhancement. Improve overall sharpness and clarity with a natural, realistic look. Correct exposure, contrast, white balance, and lighting with controlled, natural colors. Remove noise, blur, artifacts, and imperfections. Preserve original composition and identity. If the image contains a person, do not add or enhance wrinkles, pores, or harsh skin texture; gently smooth skin and remove minor blemishes without makeup or artificial effects. For non-people images, enhance textures and detail naturally. Output clean, high-quality results with balanced detail and no oversaturation.',

  // Beauty prompt - specifically for face/portrait beautification (requires human face)
  BEAUTY: 'Beautify the portrait with natural facial retouching. Smooth skin gently, remove blemishes and acne, even out skin tone, and reduce harsh wrinkles while preserving realistic texture. Brighten eyes subtly and improve facial clarity. If the subject is female, apply light, natural makeup enhancement to lips, eyebrows, and overall complexion, keeping it soft and realistic. If the subject is male, do not apply makeup; focus only on clean skin retouching and natural enhancement. Maintain original facial structure, proportions, and identity. Output high-quality, professional portrait retouching with a clean, natural appearance and no exaggerated beauty effects.',

  // Restoration prompt - for old/damaged photos, black and white to color conversion
  RESTORE: 'Restore this old or damaged photo. If the image is black and white or sepia, colorize it with realistic, natural colors appropriate for the era and subject matter. Fix all damage including scratches, tears, fading, stains, creases, and degradation. Remove noise, dust, and artifacts. Enhance clarity and sharpness while preserving the original composition. Restore faded areas and improve overall quality. Output a fully restored, colorized (if applicable), high-quality version of the original photo.',
  // AGING: Removed - now uses prompt_json from preset (like /filter endpoint)
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
      'gemini-2.0-flash-lite': 'us-central1',
      'gemini-2.5-flash-image': 'us-central1',
      'gemini-2.5-flash-lite': 'us-central1',
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
    SAFETY_CHECK: 'gemini-2.0-flash-lite',
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
          description: 'Detailed HDR scene description including subject, environment, atmosphere, visual mood, and preservation instructions',
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
          description: 'Art style metadata for image transformation',
          properties: {
            type: { type: 'string', description: 'Detected or specified art style type' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'Style-specific keywords' },
            face_swap_instruction: { type: 'string', description: 'Style-specific subject preservation instruction' },
          },
        },
      },
      required: ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'],
    },
  },

  // Safety Pre-Check Configuration (Gemini 2.5 Flash Lite)
  // Used to validate images before processing with filter, beauty, enhance
  // Simply sends image through Vertex AI and lets built-in safety filters block unsafe content
  SAFETY_CHECK: {
    temperature: 0,
    maxOutputTokens: 64,
    topP: 1,
  },

  // Enable/disable safety pre-check (set to false to disable)
  SAFETY_CHECK_ENABLED: false,

  // Safety settings for pre-check (block only HIGH, allow MEDIUM and below)
  SAFETY_CHECK_SETTINGS: [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' as const },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' as const },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' as const },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' as const },
  ],

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
          description: 'Detailed HDR scene description including subject, environment, atmosphere, visual mood, and preservation instructions',
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
          description: 'Art style metadata for image transformation',
          properties: {
            type: { type: 'string', description: 'Detected or specified art style type' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'Style-specific keywords' },
            face_swap_instruction: { type: 'string', description: 'Style-specific subject preservation instruction' },
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
  WAVESPEED_UPSCALER: 'https://api.wavespeed.ai/api/v1/wavespeed-ai/image-upscaler',
  WAVESPEED_TEXT_TO_IMAGE: 'https://api.wavespeed.ai/api/v1/wavespeed-ai/flux-2-dev/text-to-image',
  WAVESPEED_RESULT: (requestId: string) => `https://api.wavespeed.ai/api/v1/predictions/${requestId}/result`,
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
