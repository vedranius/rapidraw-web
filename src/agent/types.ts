import type { Adjustments } from '../utils/adjustments';

export type AgentToolCategory =
  'inspect' | 'tone' | 'colour' | 'detail' | 'geometry' | 'mask' | 'ai' | 'operations' | 'library' | 'app';

export interface AgentToolDefinition {
  id: string;
  label: string;
  category: AgentToolCategory;
  description: string;
  params: string;
  examples?: string[];
  requiresImage?: boolean;
  destructive?: boolean;
}

export interface AgentStep {
  tool: string;
  params: Record<string, unknown>;
  note?: string;
}

export interface AgentPlanResponse {
  summary: string;
  steps: AgentStep[];
  planner: string;
  rejected: string[];
}

export interface AgentStepResult {
  tool: string;
  ok: boolean;
  message: string;
  data?: unknown;
  startedAt: number;
  finishedAt: number;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  allowedTools: string[];
  content: string;
  builtIn: boolean;
}

export interface AgentHistogramStats {
  median: number;
  p05: number;
  p95: number;
  shadowClip: number;
  highlightClip: number;
  meanSaturation: number;
  tone: 'underexposed' | 'low-key' | 'balanced' | 'high-key' | 'overexposed' | 'unknown';
  warning?: string;
}

export interface AgentContext {
  selectedPath: string | null;
  selectedPaths: string[];
  image: {
    width: number;
    height: number;
    isRaw: boolean;
    exif: Record<string, unknown>;
  } | null;
  adjustments: Partial<Adjustments> | null;
  histogram: AgentHistogramStats | null;
  app: {
    language?: string;
    theme?: string;
    provider?: string;
    aiModel?: string | null;
  };
}

export interface AgentExecutionHooks {
  targetPaths: string[];
  selectImage(path: string): void;
  refreshLibrary(): Promise<void>;
  reloadAdjustments(paths: string[]): Promise<void>;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: number;
  plan?: AgentPlanResponse;
  results?: AgentStepResult[];
  planner?: 'ai' | 'local';
  error?: string;
}
