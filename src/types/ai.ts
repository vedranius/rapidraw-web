export interface PromptAiConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutSecs?: number;
}

export interface PromptAiStatus {
  available: boolean;
  model: string | null;
  url: string;
  provider: string;
  configured: boolean;
  models: string[];
  detail: string | null;
}

export interface StyleProfileLut {
  name: string;
  path: string;
  isBuiltIn: boolean;
  intensity: number;
}

export interface StyleProfile {
  id: string;
  name: string;
  detectTags: string[];
  subject?: string | null;
  adjustments: Record<string, unknown>;
  lut?: StyleProfileLut | null;
  intensity: number;
  builtIn: boolean;
  description?: string | null;
}

export interface StyleMatch {
  path: string;
  profileId: string;
  profileName: string;
  score: number;
  matchedTags: string[];
}

export interface SceneAnalysis {
  scene: string;
  subject: string;
  hasPerson: boolean;
  confidence: number;
  reasons: string[];
}

export interface StyleCandidate {
  profile: StyleProfile;
  score: number;
  matchedTags: string[];
  reason: string;
  kind: 'recommended' | 'color' | 'film' | 'monochrome' | string;
}

export interface StyleSuggestion {
  path: string;
  scene: SceneAnalysis;
  candidates: StyleCandidate[];
}

export interface StyleAssignment {
  path: string;
  profileId: string;
}

export interface ProfileUsage {
  profileId: string;
  profileName: string;
  count: number;
}

export interface AutoStyleSummary {
  applied: number;
  skipped: string[];
  byProfile: ProfileUsage[];
}

export interface SidecarSnapshot {
  sidecarPath: string;
  contents: string | null;
}
