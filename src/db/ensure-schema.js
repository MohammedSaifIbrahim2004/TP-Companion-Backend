const sql = require("mssql");

/**
 * Ensures database schema exists.
 * @param {sql.ConnectionPool} pool - The SQL connection pool
 * @param {boolean} isSqlAuth - True if using SQL Authentication, false for Windows Auth
 */
async function ensureSchema(pool, isSqlAuth = true) {
  let script = '';

  if (isSqlAuth) {
    // Only create user and assign roles if SQL Authentication
    script += `
    -- ================================
    -- Ensure DB user exists (login must already exist)
    -- ================================
    IF NOT EXISTS (
        SELECT 1 FROM sys.database_principals WHERE name = N'scReceipt'
    )
    BEGIN
        CREATE USER scReceipt FOR LOGIN scReceipt;
    END;

    -- ================================
    -- Ensure roles
    -- ================================
    IF NOT EXISTS (
        SELECT 1
        FROM sys.database_role_members drm
        JOIN sys.database_principals r ON drm.role_principal_id = r.principal_id
        JOIN sys.database_principals m ON drm.member_principal_id = m.principal_id
        WHERE r.name = N'db_datareader' AND m.name = N'scReceipt'
    )
    BEGIN
        ALTER ROLE db_datareader ADD MEMBER scReceipt;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM sys.database_role_members drm
        JOIN sys.database_principals r ON drm.role_principal_id = r.principal_id
        JOIN sys.database_principals m ON drm.member_principal_id = m.principal_id
        WHERE r.name = N'db_datawriter' AND m.name = N'scReceipt'
    )
    BEGIN
        ALTER ROLE db_datawriter ADD MEMBER scReceipt;
    END;
    `;
  }

  // Table creation (run in both SQL Auth and Windows Auth)
  script += `
  -- ================================
  -- Tables
  -- ================================
  IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'TPCommissionRules')
  BEGIN
      CREATE TABLE dbo.TPCommissionRules (
          CommissionRuleId INT IDENTITY(1,1) PRIMARY KEY,
          Name NVARCHAR(100) NOT NULL,
          Active BIT NOT NULL DEFAULT 1
      );
  END;

  IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'TPCommissionRuleItems')
  BEGIN
      CREATE TABLE dbo.TPCommissionRuleItems (
          CommissionRuleItemId INT IDENTITY(1,1) PRIMARY KEY,
          CommissionRuleId INT NOT NULL,
          ItemType TINYINT NOT NULL,
          CommissionMethod TINYINT NOT NULL,
          [Percent] DECIMAL(5,2) NULL,
          SlabDefinition NVARCHAR(MAX) NULL,
          CONSTRAINT FK_TPCommissionRuleItems
              FOREIGN KEY (CommissionRuleId)
              REFERENCES dbo.TPCommissionRules (CommissionRuleId)
              ON DELETE CASCADE
      );
  END;

  IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'TPCommissionRuleItemCategories')
  BEGIN
      CREATE TABLE dbo.TPCommissionRuleItemCategories (
          CategoryId INT NOT NULL,
          CommissionRuleItemId INT NOT NULL,
          CONSTRAINT FK_TPCommissionRuleItemCategories
              FOREIGN KEY (CommissionRuleItemId)
              REFERENCES dbo.TPCommissionRuleItems (CommissionRuleItemId)
              ON DELETE CASCADE
      );
  END;

  IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'TPCommissionRuleEmployees')
  BEGIN
      CREATE TABLE dbo.TPCommissionRuleEmployees (
          CommissionRuleId INT NOT NULL,
          EmployeeId INT NOT NULL PRIMARY KEY,
          CONSTRAINT FK_TPCommissionRuleEmployees
              FOREIGN KEY (CommissionRuleId)
              REFERENCES dbo.TPCommissionRules (CommissionRuleId)
              ON DELETE CASCADE
      );
  END;

  -- ================================
-- Ensure TPCommissionRuleItems columns
-- ================================
IF COL_LENGTH('TPCommissionRuleItems', 'ApplyAllCategories') IS NULL
  ALTER TABLE dbo.TPCommissionRuleItems
  ADD ApplyAllCategories BIT NOT NULL DEFAULT 0;

IF COL_LENGTH('TPCommissionRuleItems', 'ApplyAllCompanies') IS NULL
  ALTER TABLE dbo.TPCommissionRuleItems
  ADD ApplyAllCompanies BIT NOT NULL DEFAULT 0;

IF COL_LENGTH('TPCommissionRuleItems', 'SplitType') IS NULL
  ALTER TABLE dbo.TPCommissionRuleItems
  ADD SplitType TINYINT NOT NULL DEFAULT 1;

IF COL_LENGTH('TPCommissionRuleItems', 'SplitRatio') IS NULL
  ALTER TABLE dbo.TPCommissionRuleItems
  ADD SplitRatio DECIMAL(5,2) NOT NULL DEFAULT 50;

IF COL_LENGTH('TPCommissionRuleItems', 'SplitEnabled') IS NULL
  ALTER TABLE dbo.TPCommissionRuleItems
  ADD SplitEnabled BIT NOT NULL DEFAULT 0;

IF COL_LENGTH('TPCommissionRuleItems', 'CompanyFilter') IS NULL
  ALTER TABLE dbo.TPCommissionRuleItems
  ADD CompanyFilter NVARCHAR(MAX) NULL;

  `;

  await pool.request().query(script);
}

module.exports = { ensureSchema };
