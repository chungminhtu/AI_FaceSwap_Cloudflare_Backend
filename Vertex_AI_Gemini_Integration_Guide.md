# Vertex AI Gemini Integration Guide (2.5 & 3.x Models)

## Overview

This guide shows how to integrate Google Vertex AI Gemini models for image generation in Node.js/TypeScript projects. Covers both Gemini 2.5 Flash Image and Gemini 3 Pro Image Preview models.

## Model Support

| Model Parameter | Model Name | Location | Use Case |
|----------------|------------|----------|----------|
| `"2.5"` | `gemini-2.5-flash-image` | `us-central1` | Fast image generation |
| `"3p"` | `gemini-3-pro-image-preview` | `global` | Higher quality images |
| `"3f"` | `gemini-3-flash-preview` | `us-central1` | Text-only generation |

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

This guide covers the core integration patterns. Adjust parameters based on your specific use case.
