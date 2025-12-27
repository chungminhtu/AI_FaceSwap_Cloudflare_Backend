# Vertex AI Gemini Integration Guide (2.5 & 3.x Models)

## Overview

This guide shows how to integrate Google Vertex AI Gemini models for image generation in Node.js/TypeScript projects. Covers both Gemini 2.5 Flash Image and Gemini 3 Pro Image Preview models.

## Model Support

| Model Parameter | Model Name | Location | Use Case |
|----------------|------------|----------|----------|
| `"2.5"` | `gemini-2.5-flash-image` | `us-central1` | Fast image generation |
| `"3p"` | `gemini-3-pro-image-preview` | `global` | Higher quality images |
| `"3f"` | `gemini-3-flash-preview` | `us-central1` | Text/JSON generation (structured output) |

## Authentication

### Service Account Setup
1. Create a Google Cloud Service Account
2. Download the JSON key file
3. Set environment variables:
```bash
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service@project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
GOOGLE_VERTEX_PROJECT_ID=your-project-id
```

### Access Token Generation
```typescript
import { GoogleAuth } from 'google-auth-library';

const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  },
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

const token = await auth.getClient().getAccessToken();
```

## API Endpoints

### Regional Endpoint (2.5 models)
```
https://{location}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{location}/publishers/google/models/{model}:generateContent
```

### Global Endpoint (3.x models)
```
https://aiplatform.googleapis.com/v1/projects/{projectId}/locations/global/publishers/google/models/{model}:generateContent
```

## Request Format

### Basic Text-to-Image Generation
```typescript
const requestBody = {
  contents: [{
    role: 'user',
    parts: [
      { text: 'A beautiful sunset over mountains' }
    ]
  }],
  generationConfig: {
    temperature: 1,
    maxOutputTokens: 32768,
    topP: 0.95,
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: {
      imageSize: '1K',
      personGeneration: 'ALLOW_ALL',
      imageOutputOptions: {
        mimeType: 'image/jpeg',
        compressionQuality: 100,
      },
      aspectRatio: '16:9', // See Aspect Ratio section below
    },
  },
  safetySettings: [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  ],
};
```

### Image + Text Input (Image Editing)
```typescript
const requestBody = {
  contents: [{
    role: 'user',
    parts: [
      {
        inline_data: {  // snake_case required
          mime_type: 'image/jpeg',
          data: base64ImageData,
        }
      },
      {
        text: 'Change the background to white'
      }
    ]
  }],
  // ... same generationConfig and safetySettings
};
```

### Text/JSON Response Generation (Structured Output)

For generating structured JSON responses from images (e.g., prompt generation, image analysis), use `gemini-3-flash-preview` with structured output configuration:

```typescript
const requestBody = {
  contents: [{
    role: 'user',
    parts: [
      {
        text: 'Analyze the provided image and return a detailed description...'
      },
      {
        inline_data: {
          mime_type: 'image/jpeg',
          data: base64ImageData,
        }
      }
    ]
  }],
  generationConfig: {
    temperature: 0.1,
    topK: 1,
    topP: 1,
    maxOutputTokens: 2048,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed HDR scene description...',
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
      },
      required: ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'],
    },
  },
  safetySettings: [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  ],
};

// Make request
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
  },
  body: JSON.stringify(requestBody),
});

const data = await response.json();

// Extract JSON from text response
const parts = data.candidates?.[0]?.content?.parts || [];
let jsonResult: any = null;

for (const part of parts) {
  if (part.text) {
    try {
      // Try parsing JSON directly
      jsonResult = JSON.parse(part.text);
      break;
    } catch (e) {
      // Handle markdown code blocks if JSON is wrapped
      let jsonText = part.text;
      
      // Extract from ```json ... ``` blocks
      if (jsonText.includes('```json')) {
        const jsonMatch = jsonText.match(/```json\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
          jsonText = jsonMatch[1];
        }
      } else if (jsonText.includes('```')) {
        // Extract from ``` ... ``` blocks
        const jsonMatch = jsonText.match(/```\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
          jsonText = jsonMatch[1];
        }
      }
      
      try {
        jsonResult = JSON.parse(jsonText);
        break;
      } catch (parseError) {
        // Continue to next part if parsing fails
      }
    }
  }
}

if (!jsonResult) {
  throw new Error('No valid JSON response from Vertex AI API');
}

// Validate required keys
const requiredKeys = ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'];
const missingKeys = requiredKeys.filter(key => !jsonResult[key] || jsonResult[key] === '');

if (missingKeys.length > 0) {
  throw new Error(`Missing required keys: ${missingKeys.join(', ')}`);
}

// Use jsonResult
console.log(jsonResult.prompt);
console.log(jsonResult.style);
```

**Key Points:**
- Use `gemini-3-flash-preview` model (text-only, no image generation)
- Set `responseMimeType: 'application/json'` for structured output
- Define `responseSchema` to enforce JSON structure
- Extract JSON from `part.text` in response
- Handle markdown code blocks (```json ... ```) if present
- Validate required keys after parsing

## Aspect Ratio Support

### Supported Aspect Ratios
```typescript
const SUPPORTED_RATIOS = [
  '1:1',   // Square
  '3:2',   // Landscape
  '2:3',   // Portrait
  '3:4',   // Standard portrait
  '4:3',   // Standard landscape
  '4:5',   // Slim portrait
  '5:4',   // Slim landscape
  '9:16',  // Vertical (TikTok)
  '16:9',  // Horizontal (YouTube)
  '21:9',  // Ultra-wide
];
```

### Aspect Ratio Processing Logic

```typescript
function normalizeAspectRatio(aspectRatio?: string): string {
  // If undefined/null, use "original" to let Vertex API determine from input image
  if (!aspectRatio) {
    return 'original';
  }

  // Check if ratio is supported
  if (SUPPORTED_RATIOS.includes(aspectRatio)) {
    return aspectRatio;
  }

  // Default fallback
  return '3:4'; // or your preferred default
}

// For endpoints that take an input image, calculate closest supported ratio
async function resolveAspectRatioForImage(
  aspectRatio: string | undefined,
  imageUrl: string
): Promise<string> {
  if (!aspectRatio || aspectRatio === 'original') {
    // Fetch image and calculate dimensions
    const dimensions = await getImageDimensions(imageUrl);
    const closestRatio = getClosestAspectRatio(
      dimensions.width,
      dimensions.height,
      SUPPORTED_RATIOS
    );
    return closestRatio;
  }

  return normalizeAspectRatio(aspectRatio);
}
```

### Aspect Ratio in Request Body
```typescript
const normalizedRatio = normalizeAspectRatio(userInputRatio);

const requestBody = {
  // ...
  generationConfig: {
    // ...
    imageConfig: {
      // ...
      aspectRatio: normalizedRatio, // "1:1", "16:9", "3:4", etc.
    },
  },
};
```

## Complete Integration Example

```typescript
import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';

interface VertexAIConfig {
  projectId: string;
  location: string; // 'us-central1' or 'global'
  model: string;
}

class VertexAIClient {
  private auth: GoogleAuth;
  private config: VertexAIConfig;

  constructor(config: VertexAIConfig) {
    this.config = config;
    this.auth = new GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!,
      },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  private getEndpoint(): string {
    if (this.config.location === 'global') {
      return `https://aiplatform.googleapis.com/v1/projects/${this.config.projectId}/locations/global/publishers/google/models/${this.config.model}:generateContent`;
    }
    return `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/${this.config.projectId}/locations/${this.config.location}/publishers/google/models/${this.config.model}:generateContent`;
  }

  async generateImage(
    prompt: string,
    options: {
      aspectRatio?: string;
      referenceImageBase64?: string;
    } = {}
  ): Promise<string> {
    const token = await this.auth.getClient().getAccessToken();

    const parts: any[] = [];
    if (options.referenceImageBase64) {
      parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: options.referenceImageBase64,
        }
      });
    }
    parts.push({ text: prompt });

    const normalizedRatio = options.aspectRatio || '1:1';

    const requestBody = {
      contents: [{
        role: 'user',
        parts,
      }],
      generationConfig: {
        temperature: 1,
        maxOutputTokens: 32768,
        topP: 0.95,
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          imageSize: '1K',
          personGeneration: 'ALLOW_ALL',
          imageOutputOptions: {
            mimeType: 'image/jpeg',
            compressionQuality: 100,
          },
          aspectRatio: normalizedRatio,
        },
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      ],
    };

    const response = await axios.post(this.getEndpoint(), requestBody, {
      headers: {
        'Authorization': `Bearer ${token.token}`,
        'Content-Type': 'application/json',
      },
    });

    // Extract image data
    const candidates = response.data.candidates;
    if (!candidates?.length) {
      throw new Error('No candidates returned');
    }

    const parts = candidates[0].content?.parts || [];
    for (const part of parts) {
      if (part.inline_data?.data) {
        return part.inline_data.data;
      }
      if (part.inlineData?.data) {
        return part.inlineData.data;
      }
    }

    throw new Error('No image data in response');
  }
}

// Usage examples:

// Text-to-image generation
const client25 = new VertexAIClient({
  projectId: 'your-project',
  location: 'us-central1',
  model: 'gemini-2.5-flash-image'
});

const imageBase64 = await client25.generateImage(
  'A futuristic city at sunset',
  { aspectRatio: '16:9' }
);

// Image editing
const client3p = new VertexAIClient({
  projectId: 'your-project',
  location: 'global',
  model: 'gemini-3-pro-image-preview'
});

const editedImage = await client3p.generateImage(
  'Change the background to pure white',
  {
    aspectRatio: '1:1',
    referenceImageBase64: existingImageBase64
  }
);

// Text/JSON generation (prompt analysis)
async function generatePromptFromImage(
  imageBase64: string,
  analysisPrompt: string
): Promise<any> {
  const client3f = new VertexAIClient({
    projectId: 'your-project',
    location: 'us-central1',
    model: 'gemini-3-flash-preview'
  });

  const token = await client3f['auth'].getClient().getAccessToken();
  const endpoint = client3f['getEndpoint']();

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: analysisPrompt },
        {
          inline_data: {
            mime_type: 'image/jpeg',
            data: imageBase64,
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      topK: 1,
      topP: 1,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed scene description' },
          style: { type: 'string', description: 'Visual style' },
          lighting: { type: 'string', description: 'Lighting description' },
          composition: { type: 'string', description: 'Composition details' },
          camera: { type: 'string', description: 'Camera settings' },
          background: { type: 'string', description: 'Background description' },
        },
        required: ['prompt', 'style', 'lighting', 'composition', 'camera', 'background'],
      },
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  const response = await axios.post(endpoint, requestBody, {
    headers: {
      'Authorization': `Bearer ${token.token}`,
      'Content-Type': 'application/json',
    },
  });

  // Extract JSON from text response
  const parts = response.data.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.text) {
      try {
        return JSON.parse(part.text);
      } catch (e) {
        // Handle markdown code blocks
        let jsonText = part.text;
        if (jsonText.includes('```json')) {
          const match = jsonText.match(/```json\s*(\{[\s\S]*?\})\s*```/);
          if (match) jsonText = match[1];
        } else if (jsonText.includes('```')) {
          const match = jsonText.match(/```\s*(\{[\s\S]*?\})\s*```/);
          if (match) jsonText = match[1];
        }
        return JSON.parse(jsonText);
      }
    }
  }
  throw new Error('No JSON response found');
}

// Usage
const promptJson = await generatePromptFromImage(
  imageBase64,
  'Analyze this image and describe the scene, style, and composition...'
);
console.log(promptJson.prompt);
```

## Error Handling

### Safety Violations
```typescript
// Check for blocked content
const candidates = response.data.candidates;
if (candidates?.[0]?.finishReason === 'SAFETY' ||
    candidates?.[0]?.finishReason === 'IMAGE_SAFETY') {
  throw new Error('Content blocked by safety filters');
}
```

### Common Error Codes
- **400**: Invalid request format
- **403**: Permission denied
- **404**: Model not found (check location/model availability)
- **422**: Content blocked (safety violation)
- **500**: Internal server error

## Environment Variables

```bash
# Required
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service@project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
GOOGLE_VERTEX_PROJECT_ID=your-project-id

# Optional
GOOGLE_VERTEX_LOCATION=us-central1  # Default location
```

## Cost Estimates

- **Gemini 2.5 Flash Image**: ~$0.039 per image ($30 per million tokens)
- **Gemini 3 Pro Image Preview**: Higher cost, better quality

## Troubleshooting

### 404 Errors
1. Check if model exists in your location
2. Use `global` location for 3.x models
3. Use `us-central1` for 2.5 models

### Permission Errors
1. Verify service account has Vertex AI permissions
2. Check project ID is correct
3. Ensure API is enabled in Google Cloud Console

### Image Quality Issues
1. Use higher quality models (3.x series)
2. Adjust prompts for better results
3. Try different aspect ratios

### JSON Parsing Issues
1. Always check for markdown code blocks (```json ... ```) in response
2. Validate required keys after parsing
3. Use `responseMimeType: 'application/json'` for structured output
4. Ensure `responseSchema` matches your expected structure
5. Handle both `part.text` and wrapped JSON formats

This guide covers the core integration patterns. Adjust parameters based on your specific use case.
