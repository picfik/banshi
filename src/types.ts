export type SyncStatus = {
  status: "success" | "failed" | "syncing" | "not_configured";
  message: string;
  updatedAt: string | null;
};

export type Analysis = {
  summary: string;
  keyFacts: string[];
  checks: string[];
  nextSteps: string[];
  cautions: string[];
  humanVerification: string[];
  disclaimer: string;
  generatedAt: string;
};

export type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  objectKey: string;
  uploadedAt: string;
  uploadedBy: string;
  syncStatus: SyncStatus["status"];
  syncMessage: string;
  analysis: Analysis | null;
};

export type ProcurementStep = {
  id: string;
  templateId: string;
  title: string;
  guidance: string;
  status: "pending" | "completed";
  note: string;
  completedAt: string | null;
  completedBy: string | null;
  attachments: Attachment[];
};

export type ProcurementMode = {
  id: string;
  title: string;
  steps: Array<{ id: string; title: string; guidance: string }>;
};

export type HandlingPath = {
  id: string;
  title: string;
  procurement: boolean;
};

export type Step = {
  id: string;
  title: string;
  guidance: string;
  requiresReview?: boolean;
  stageId: string;
  stageTitle: string;
  status: "pending" | "completed";
  note: string;
  completedAt: string | null;
  completedBy: string | null;
  attachments: Attachment[];
  humanReview: {
    decision: "approved" | "returned";
    comment: string;
    reviewer: string;
    reviewedAt: string;
  } | null;
  procurementSteps?: ProcurementStep[];
};

export type CaseRecord = {
  id: string;
  title: string;
  description: string;
  source: string;
  isImportant?: boolean;
  isOnHold?: boolean;
  handlingPath: string | null;
  createdAt: string;
  updatedAt: string;
  steps: Step[];
};

export type Stage = {
  id: string;
  title: string;
  steps: Array<{ id: string; title: string; guidance: string; requiresReview?: boolean }>;
};

