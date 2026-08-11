-- ============================================
-- MySQL Schema: Road Condition Monitoring DSS
-- Municipality of Jimenez, Misamis Occidental
-- ============================================

CREATE DATABASE IF NOT EXISTS road_condition_dss
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE road_condition_dss;

-- ============================================
-- Users
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  passwordHash VARCHAR(255) NOT NULL,
  fullName VARCHAR(255) NOT NULL,
  firstName VARCHAR(100),
  lastName VARCHAR(100),
  mobileNumber VARCHAR(20),
  phone VARCHAR(20),
  address VARCHAR(255),
  profilePhotoUri VARCHAR(500),
  pushToken VARCHAR(255),
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============================================
-- Reports
-- ============================================
CREATE TABLE IF NOT EXISTS reports (
  id VARCHAR(36) PRIMARY KEY,
  citizenId VARCHAR(36) NOT NULL,
  citizenName VARCHAR(255) NOT NULL,
  conditionType VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  photoUri VARCHAR(500) NOT NULL,
  photoCapturedAt DATETIME NOT NULL,
  capturedLatitude DECIMAL(10, 7) NOT NULL,
  capturedLongitude DECIMAL(10, 7) NOT NULL,
  locationAccuracyMeters DECIMAL(8, 2) NOT NULL,
  reportLatitude DECIMAL(10, 7) NOT NULL,
  reportLongitude DECIMAL(10, 7) NOT NULL,
  selectedBarangay VARCHAR(100) NOT NULL,
  createdAt DATETIME NOT NULL,
  updatedAt DATETIME NOT NULL,
  submittedAt DATETIME NOT NULL,
  reportStatus ENUM('Pending Validation', 'Verified', 'Resolved', 'Disputed') NOT NULL DEFAULT 'Pending Validation',
  syncStatus VARCHAR(20) NOT NULL DEFAULT 'synced',
  locationEvidenceStatus VARCHAR(50) NOT NULL,
  communityAgreeCount INT DEFAULT 0,
  communityDisagreeCount INT DEFAULT 0,
  communityValidationScore DECIMAL(4, 3) DEFAULT 0.000,
  locationValidationScore DECIMAL(4, 3) DEFAULT 0.000,
  reportReliabilityScore DECIMAL(4, 3) DEFAULT 0.000,
  advisoryText TEXT,
  resolvedAt DATETIME,
  FOREIGN KEY (citizenId) REFERENCES users(id),
  INDEX idx_status (reportStatus),
  INDEX idx_barangay (selectedBarangay),
  INDEX idx_location (reportLatitude, reportLongitude)
) ENGINE=InnoDB;

-- ============================================
-- Community Votes
-- ============================================
CREATE TABLE IF NOT EXISTS community_votes (
  id VARCHAR(36) PRIMARY KEY,
  reportId VARCHAR(36) NOT NULL,
  citizenId VARCHAR(36) NOT NULL,
  voteType ENUM('agree', 'disagree') NOT NULL,
  votedAt DATETIME NOT NULL,
  FOREIGN KEY (reportId) REFERENCES reports(id) ON DELETE CASCADE,
  FOREIGN KEY (citizenId) REFERENCES users(id),
  UNIQUE KEY unique_vote (reportId, citizenId)
) ENGINE=InnoDB;

-- ============================================
-- Advisories
-- ============================================
CREATE TABLE IF NOT EXISTS advisories (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  location VARCHAR(255) NOT NULL,
  selectedBarangay VARCHAR(100),
  message TEXT NOT NULL,
  issuedAt DATETIME NOT NULL,
  active TINYINT(1) DEFAULT 1
) ENGINE=InnoDB;
