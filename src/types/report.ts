/**
 * Report Types
 * Mirrors the RN app's types/report.ts with backend-specific score fields.
 */

export type RoadConditionType =
  | 'Pothole'
  | 'Alligator Cracks'
  | 'Raveling'
  | 'Longitudinal Cracks'
  | 'Transverse Cracks'
  // Legacy types preserved for existing database records:
  | 'Damaged Road Pavement'
  | 'Road crack'
  | 'Damaged pavement';

export type ReportStatus =
  | 'Pending Validation'
  | 'Verified'
  | 'Under Review'
  | 'Resolved'
  | 'Closed';

export type SyncStatus = 'synced';

export type LocationEvidenceStatus = 'Captured' | 'Permission Denied' | 'Failed';

export type VoteType = 'agree' | 'disagree';

export type SeverityLevel = 'FAIR' | 'POOR' | 'BAD';

export interface RoadReport {
  id: string;
  citizenId: string;
  citizenName: string;
  conditionType: RoadConditionType;
  severityLevel?: SeverityLevel;
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

  // Repair Verification Fields
  repairAgreeCount?: number;
  repairDisagreeCount?: number;
  userRepairVote?: VoteType | null;

  // Backend-specific DSS scores
  locationValidationScore: number;
  reportReliabilityScore: number;

  advisoryText: string | null;
  resolvedAt: string | null;
  resolutionPhotoUri?: string | null;
  resolvedByCitizenId?: string | null;
  userVote?: VoteType | null;
  userSeverityVote?: SeverityLevel | null;

  // Read-only empirical metrics fields
  onsiteAgreeCount?: number;
  onsiteDisagreeCount?: number;
  voteCounts?: {
    agreeCount: number;
    disagreeCount: number;
    onsiteAgreeCount: number;
    onsiteDisagreeCount: number;
  };
  votes?: Array<{
    id: string;
    citizenId: string;
    voteType: VoteType;
    severityLevel?: SeverityLevel | null;
    distanceMeters?: number | null;
    votedAt: string;
  }>;
}

export interface CommunityVote {
  id: string;
  reportId: string;
  citizenId: string;
  voteType: VoteType;
  severityLevel?: SeverityLevel | null;
  votedAt: string;
  distanceMeters?: number | null;
}

export interface RoadAdvisory {
  id: string;
  title: string;
  location: string;
  selectedBarangay?: string;
  severityLevel?: SeverityLevel | null;
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
