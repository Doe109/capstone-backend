/**
 * Report Types
 * Mirrors the RN app's types/report.ts with backend-specific score fields.
 */

export type RoadConditionType =
  | 'Pothole'
  | 'Road crack'
  | 'Damaged pavement'
  | 'Surface deterioration'
  | 'Uneven road surface';

export type ReportStatus =
  | 'Pending Validation'
  | 'Verified'
  | 'Resolved'
  | 'Disputed';

export type SyncStatus = 'synced';

export type LocationEvidenceStatus = 'Captured' | 'Permission Denied' | 'Failed';

export type VoteType = 'agree' | 'disagree';

export interface RoadReport {
  id: string;
  citizenId: string;
  citizenName: string;
  conditionType: RoadConditionType;
  description: string;
  photoUri: string;
  photoCapturedAt: string;
  capturedLatitude: number;
  capturedLongitude: number;
  locationAccuracyMeters: number;
  reportLatitude: number;
  reportLongitude: number;
  selectedBarangay: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string;
  reportStatus: ReportStatus;
  syncStatus: SyncStatus;
  locationEvidenceStatus: LocationEvidenceStatus;

  // Community Validation (CV) Data Model Fields
  communityAgreeCount: number;
  communityDisagreeCount: number;
  communityValidationScore: number;

  // Aliases for the RN app's newer naming
  confirmCount: number;
  disputeCount: number;

  // Backend-specific DSS scores
  locationValidationScore: number;
  reportReliabilityScore: number;

  advisoryText: string | null;
  resolvedAt: string | null;
}

export interface CommunityVote {
  id: string;
  reportId: string;
  citizenId: string;
  voteType: VoteType;
  votedAt: string;
}

export interface RoadAdvisory {
  id: string;
  title: string;
  location: string;
  selectedBarangay?: string;
  message: string;
  issuedAt: string;
  active: boolean;
}

export interface CitizenDashboardStats {
  totalReports: number;
  pendingValidation: number;
  verified: number;
  savedOffline: number;
}

export interface ResolutionResult {
  success: boolean;
  isFixed: boolean;
  reportStatus: ReportStatus;
  resolvedAt?: string;
  message: string;
  report: RoadReport;
}
