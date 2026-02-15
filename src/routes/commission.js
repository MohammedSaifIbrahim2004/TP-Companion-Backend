const express = require('express');
const router = express.Router();
const { sql, poolPromise } = require('../db/sql');




async function getMembershipCategories(ruleId, tx = null) {
  const pool = await poolPromise;
  const request = tx ? tx.request() : pool.request();

  if (ruleId) {
    request.input('ruleId', sql.Int, ruleId);
  }

  const result = await request.query(`
    SELECT DISTINCT rc.CategoryId
    FROM dbo.TPCommissionRuleItemCategories rc
    JOIN dbo.TPCommissionRuleItems i
      ON rc.CommissionRuleItemId = i.CommissionRuleItemId
    WHERE i.ItemType = 7
      ${ruleId ? 'AND i.CommissionRuleId = @ruleId' : ''}
  `);

  return result.recordset.map(r => r.CategoryId);
}
function validateServiceVsMembership(items, membershipCategories) {
  for (const item of items) {
    if (item.ItemType !== 1) continue; // only Service

    // ❌ ApplyAllCategories not allowed if membership exists
    if (item.ApplyAllCategories && membershipCategories.length) {
      throw {
        status: 400,
        message:
          'Service cannot apply to all categories when membership categories are already selected'
      };
    }

    // ❌ Explicit overlap not allowed
    const overlap = (item.CategoryFilter || []).filter(cat =>
      membershipCategories.includes(cat)
    );

    if (overlap.length) {
      throw {
        status: 400,
        message:
          'Service cannot include categories already used by membership'
      };
    }
  }
}


/*
=====================================================
GET all commission rules (active / inactive)
=====================================================
*/
router.get('/', async (req, res) => {
  try {
    const pool = await poolPromise;

    const includeInactive = req.query.includeInactive === 'true';

    const query = `
      SELECT 
        r.CommissionRuleId AS RuleId,
        r.Name,
        r.Active,
        i.CommissionRuleItemId,
        i.ItemType,
        i.CommissionMethod,
        i.[Percent],
        i.SlabDefinition,
        i.ApplyAllCategories,
        i.CompanyFilter,
        i.ApplyAllCompanies,
        i.SplitType,
        i.SplitRatio,
        i.SplitEnabled,
        e.EmployeeId,
        c.CategoryId
      FROM dbo.TPCommissionRules r
      LEFT JOIN dbo.TPCommissionRuleItems i
        ON r.CommissionRuleId = i.CommissionRuleId
      LEFT JOIN dbo.TPCommissionRuleEmployees e
        ON r.CommissionRuleId = e.CommissionRuleId
      LEFT JOIN dbo.TPCommissionRuleItemCategories c
        ON i.CommissionRuleItemId = c.CommissionRuleItemId
      ${includeInactive ? '' : 'WHERE r.Active = 1'}
      ORDER BY r.CommissionRuleId DESC
    `;

    const result = await pool.request().query(query);

    const map = {};

    for (const row of result.recordset) {
      if (!map[row.RuleId]) {
        map[row.RuleId] = {
          CommissionRuleId: row.RuleId,
          Name: row.Name,
          Active: row.Active,
          Items: [],
          EmployeeIds: []
        };
      }

      // Add items
      if (row.CommissionRuleItemId) {
        let item = map[row.RuleId].Items.find(
          it => it.CommissionRuleItemId === row.CommissionRuleItemId
        );
        if (!item) {
          item = {
            CommissionRuleItemId: row.CommissionRuleItemId,
            ItemType: row.ItemType,
            CommissionMethod: row.CommissionMethod,
            Percent: row.Percent,
            SlabDefinition: row.SlabDefinition ? JSON.parse(row.SlabDefinition) : [],
            ApplyAllCategories: row.ApplyAllCategories === 1,
            CompanyFilter: row.CompanyFilter
  ? JSON.parse(row.CompanyFilter)
  : [],

            ApplyAllCompanies: row.ApplyAllCompanies === 1,
            CategoryFilter: [],
            SplitType: row.SplitType,
            SplitRatio: row.SplitRatio,
            SplitEnabled: row.SplitEnabled
          };
          map[row.RuleId].Items.push(item);
        }

        // Add categories
        if (row.CategoryId && !item.CategoryFilter.includes(row.CategoryId)) {
          item.CategoryFilter.push(row.CategoryId);
        }
      }

      // Add global employees
      if (row.EmployeeId && !map[row.RuleId].EmployeeIds.includes(row.EmployeeId)) {
        map[row.RuleId].EmployeeIds.push(row.EmployeeId);
      }
    }

    res.json(Object.values(map));
  } catch (err) {
    console.error('GET /commission error:', err);
    res.status(500).json({ error: err.message });
  }
});

/*
=====================================================
GET categories
=====================================================
*/

router.get('/categories', async (req, res) => {
  try {
    const pool = await poolPromise;

    const itemType = parseInt(req.query.itemType, 10);
    let ruleId = parseInt(req.query.ruleId, 10);
    if (isNaN(ruleId)) ruleId = null;

    if (isNaN(itemType)) {
      return res.status(400).json({ message: 'Invalid itemType' });
    }

    const exclude = req.query.exclude
      ? req.query.exclude
          .split(',')
          .map(c => parseInt(c, 10))
          .filter(c => !isNaN(c))
      : [];

    // 🔹 Step 1A: Categories used by OTHER membership + promotion rules
// Determine which itemTypes to exclude based on current itemType
let excludeItemTypes = [];

if (itemType === 1) {
  excludeItemTypes = [7, 8];
}
else if (itemType === 7) {
  excludeItemTypes = [1, 8];
}
else if (itemType === 8) {
  excludeItemTypes = [1, 7];
}

let otherMpResult = { recordset: [] };

if (excludeItemTypes.length) {
  otherMpResult = await pool.request()
    .input('ruleId', sql.Int, ruleId)
    .query(`
      SELECT DISTINCT c.[Id Number] AS Id, c.Name
      FROM dbo.category c
      JOIN dbo.TPCommissionRuleItemCategories rc
        ON rc.CategoryId = c.[Id Number]
      JOIN dbo.TPCommissionRuleItems i
        ON rc.CommissionRuleItemId = i.CommissionRuleItemId
      WHERE i.ItemType IN (${excludeItemTypes.join(',')})
        AND (@ruleId IS NULL OR i.CommissionRuleId <> @ruleId)
    `);
}
// 🔹 Step 1B: Categories used by THIS rule (edit mode)
let currentRuleResult = { recordset: [] };

if (ruleId) {
  currentRuleResult = await pool.request()
    .input('ruleId', sql.Int, ruleId)
    .input('itemType', sql.Int, itemType)
    .query(`
      SELECT DISTINCT c.[Id Number] AS Id, c.Name
      FROM dbo.category c
      JOIN dbo.TPCommissionRuleItemCategories rc
        ON rc.CategoryId = c.[Id Number]
      JOIN dbo.TPCommissionRuleItems i
        ON rc.CommissionRuleItemId = i.CommissionRuleItemId
      WHERE i.CommissionRuleId = @ruleId
        AND i.ItemType = @itemType
    `);
}

// 🔹 Merge both
const mpMap = new Map();

[...otherMpResult.recordset, ...currentRuleResult.recordset]
  .forEach(c => {
    mpMap.set(c.Id, c);
  });
  const currentRuleCategories = currentRuleResult.recordset;
const currentRuleCategoryIds = currentRuleCategories.map(c => c.Id);

const mpCategories = Array.from(mpMap.values());

    // 🔹 Step 2: If Membership or Promotion → ONLY return previously used categories
    if (itemType === 7 || itemType === 8) {

  const allCategoriesResult = await pool.request().query(`
    SELECT [Id Number] AS Id, Name
    FROM dbo.category
    ORDER BY Name
  `);

  const blockedCategoryIds = mpCategories.map(c => c.Id);

  let availableCategories = allCategoriesResult.recordset.filter(c =>
    !blockedCategoryIds.includes(c.Id) ||
    currentRuleCategoryIds.includes(c.Id) // allow edit mode categories
  );

  if (exclude.length) {
    availableCategories = availableCategories.filter(c =>
    !exclude.includes(c.Id)
 );
  }

  return res.json(
    availableCategories.map(r => ({
      value: r.Id,
      label: r.Name
    }))
  );
}

   // 🔹 Step 3: For Services → return all categories EXCEPT MP categories
// BUT keep categories already used in this rule (edit mode safe)

const allCategoriesResult = await pool.request().query(`
  SELECT [Id Number] AS Id, Name
  FROM dbo.category
  ORDER BY Name
`);

const mpCategoryIds = mpCategories.map(c => c.Id);

const currentRuleCategoryIdsAll = currentRuleResult.recordset.map(c => c.Id);

// For services
let availableCategories = allCategoriesResult.recordset.filter(c =>
    !mpCategoryIds.includes(c.Id) ||
    currentRuleCategoryIdsAll.includes(c.Id) // allow all current rule categories
);

if (exclude.length) {
 availableCategories = availableCategories.filter(c =>
    !exclude.includes(c.Id)
  );
}

res.json(
  availableCategories.map(r => ({
    value: r.Id,
    label: r.Name
  }))
);
  } catch (err) {
    console.error('GET /categories error:', err);
    res.status(500).json({ error: err.message });
  }
});


/*
=====================================================
GET companies
=====================================================
*/
router.get('/companies', async (req, res) => {
  try {
    const pool = await poolPromise;

    const ruleId = req.query.ruleId
      ? Number(req.query.ruleId)
      : null;

    const result = await pool.request()
      .input('ruleId', sql.Int, ruleId)
      .query(`
        SELECT c.IdNumber AS Id, c.Name
        FROM dbo.companys c
        WHERE ISNULL(c.Active, 0) = 1
        AND (
          @ruleId IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM dbo.TPCommissionRuleItems cri
            WHERE cri.CompanyFilter IS NOT NULL
              AND cri.CommissionRuleId <> @ruleId
              AND (
                cri.CompanyFilter = '[' + CAST(c.IdNumber AS NVARCHAR) + ']'
                OR cri.CompanyFilter LIKE '%[' + CAST(c.IdNumber AS NVARCHAR) + ',%'
                OR cri.CompanyFilter LIKE '%,' + CAST(c.IdNumber AS NVARCHAR) + ',%'
                OR cri.CompanyFilter LIKE '%,' + CAST(c.IdNumber AS NVARCHAR) + ']%'
              )
          )
        )
        ORDER BY c.Name
      `);

    res.json(result.recordset.map(r => ({
      value: r.Id,
      label: r.Name
    })));
  } catch (err) {
    console.error('companies error', err);
    res.status(500).json({ error: err.message });
  }
});
/*
=====================================================
GET employees (exclude already-used employees)
=====================================================
*/
router.get('/employee', async (req, res) => {
  try {
    const pool = await poolPromise;

    const ruleId = req.query.ruleId
      ? parseInt(req.query.ruleId, 10)
      : null;

    const mode = req.query.mode; // 👈 NEW

    const request = pool.request();
    request.input('ruleId', sql.Int, ruleId);

    // 🔥 FILTER MODE → return ALL active employees
    const query = mode === 'filter'
      ? `
        SELECT 
          e.IdNumber AS Id,
          e.FirstName + ' ' + e.LastName AS Name
        FROM dbo.employs e
        WHERE e.Active = 1
        ORDER BY e.FirstName, e.LastName
      `
      : `
        SELECT 
          e.IdNumber AS Id,
          e.FirstName + ' ' + e.LastName AS Name
        FROM dbo.employs e
        WHERE e.Active = 1
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.TPCommissionRuleEmployees re
            WHERE re.EmployeeId = e.IdNumber
              AND (@ruleId IS NULL OR re.CommissionRuleId <> @ruleId)
          )
        ORDER BY e.FirstName, e.LastName
      `;

    const result = await request.query(query);

    res.json(
      result.recordset.map(r => ({
        value: r.Id,
        label: r.Name
      }))
    );
  } catch (err) {
    console.error('Failed to load employees:', err);
    res.status(500).json({ error: err.message });
  }
});

/*
=====================================================
GET single commission rule by ID
=====================================================
*/
router.get('/:id', async (req, res) => {
  const idNum = parseInt(req.params.id, 10);
  if (isNaN(idNum)) return res.status(400).json({ message: 'Invalid commission rule ID' });

  try {
    const pool = await poolPromise;

    const result = await pool.request()
      .input('id', sql.Int, idNum)
      .query(`
        SELECT 
          r.CommissionRuleId AS RuleId,
          r.Name,
          r.Active,
          i.CommissionRuleItemId,
          i.ItemType,
          i.CommissionMethod,
          i.[Percent],
          i.SlabDefinition,
          i.ApplyAllCategories,
          i.CompanyFilter,
          i.ApplyAllCompanies,
          i.SplitType,
          i.SplitRatio,
          i.SplitEnabled,
          e.EmployeeId,
          c.CategoryId
        FROM dbo.TPCommissionRules r
        LEFT JOIN dbo.TPCommissionRuleItems i
          ON r.CommissionRuleId = i.CommissionRuleId
        LEFT JOIN dbo.TPCommissionRuleEmployees e
          ON r.CommissionRuleId = e.CommissionRuleId
        LEFT JOIN dbo.TPCommissionRuleItemCategories c
          ON i.CommissionRuleItemId = c.CommissionRuleItemId
        WHERE r.CommissionRuleId = @id
      `);

    if (!result.recordset.length) return res.status(404).json({ message: 'Commission rule not found' });

    const rule = {
      CommissionRuleId: result.recordset[0].RuleId,
      Name: result.recordset[0].Name,
      Active: result.recordset[0].Active,
      Items: [],
      EmployeeIds: []
    };

    for (const row of result.recordset) {
      // Items
      if (row.CommissionRuleItemId) {
        let item = rule.Items.find(it => it.CommissionRuleItemId === row.CommissionRuleItemId);
        if (!item) {
          item = {
            CommissionRuleItemId: row.CommissionRuleItemId,
            ItemType: row.ItemType,
            CommissionMethod: row.CommissionMethod,
            Percent: row.Percent,
            SlabDefinition: row.SlabDefinition ? JSON.parse(row.SlabDefinition) : [],
            ApplyAllCategories: row.ApplyAllCategories === 1,
            CompanyFilter: row.CompanyFilter
  ? JSON.parse(row.CompanyFilter)
  : [],

            ApplyAllCompanies: row.ApplyAllCompanies === 1,
            CategoryFilter: [],
            SplitType: row.SplitType,
            SplitRatio: row.SplitRatio,
            SplitEnabled: row.SplitEnabled
          };
          rule.Items.push(item);
        }

        if (row.CategoryId && !item.CategoryFilter.includes(row.CategoryId)) {
          item.CategoryFilter.push(row.CategoryId);
        }
      }

      // Employees
      if (row.EmployeeId && !rule.EmployeeIds.includes(row.EmployeeId)) {
        rule.EmployeeIds.push(row.EmployeeId);
      }
    }

    res.json(rule);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/*
=====================================================
CREATE new commission rule
=====================================================
*/
router.post('/', async (req, res) => {
  const { Name, Active = 1, Items = [], EmployeeIds = [] } = req.body;

  if (!Name || !Items.length || !EmployeeIds.length) {
    return res.status(400).json({
      message: 'Rule name, at least one item, and at least one employee are required'
    });
  }

  try {
    const pool = await poolPromise;

    // Insert rule
    const ruleResult = await pool.request()
      .input('Name', sql.NVarChar(100), Name)
      .input('Active', sql.Bit, Active)
      .query(`
        INSERT INTO dbo.TPCommissionRules (Name, Active)
        VALUES (@Name, @Active);
        SELECT SCOPE_IDENTITY() AS CommissionRuleId;
      `);
    const ruleId = ruleResult.recordset[0].CommissionRuleId;
    // STEP A: collect membership items from payload
const membershipItems = Items.filter(i => i.ItemType === 7);

// STEP B: collect categories from payload membership items
const membershipCategoryIds = membershipItems.flatMap(
  i => i.CategoryFilter || []
);

// STEP C: validate Service items against payload membership
const dbMembershipCategories = await getMembershipCategories(ruleId);

const allMembershipCategories = [
  ...new Set([...dbMembershipCategories, ...membershipCategoryIds])
];

validateServiceVsMembership(Items, allMembershipCategories);
// STEP X: collect promotion items & categories
const promotionItems = Items.filter(i => i.ItemType === 8);
const promotionCategoryIds = promotionItems.flatMap(i => i.CategoryFilter || []);

// Merge membership + promotion categories
const blockedCategories = [...new Set([...allMembershipCategories, ...promotionCategoryIds])];

// STEP Y: Handle ApplyAllCategories for services
const allCategoryIds = (await pool.request().query(`
  SELECT [Id Number] AS Id FROM dbo.category
`)).recordset.map(r => r.Id);

for (const item of Items) {
  if (item.ItemType === 1 && item.ApplyAllCategories) { // Service
    // Remove categories used by membership & promotion
    const availableCategories = allCategoryIds.filter(
      catId => !blockedCategories.includes(catId)
    );
    // Assign these to the service item
    item.CategoryFilter = availableCategories;
  }
}



    // Insert employees (global)
    for (const empId of EmployeeIds) {
      await pool.request()
        .input('CommissionRuleId', sql.Int, ruleId)
        .input('EmployeeId', sql.Int, empId)
        .query(`
          INSERT INTO dbo.TPCommissionRuleEmployees (CommissionRuleId, EmployeeId)
          VALUES (@CommissionRuleId, @EmployeeId)
        `);
    }

    // Insert items
    for (const item of Items) {
      const applyAllCategories = Boolean(item.ApplyAllCategories);
      const applyAllCompanies = Boolean(item.ApplyAllCompanies);

      const categoryFilter = applyAllCategories ? [] : item.CategoryFilter || [];
      const companyFilter = applyAllCompanies ? [] : item.CompanyFilter || [];

      const itemResult = await pool.request()
        .input('CommissionRuleId', sql.Int, ruleId)
        .input('ItemType', sql.TinyInt, item.ItemType)
        .input('CommissionMethod', sql.TinyInt, item.CommissionMethod)
        .input('Percent', sql.Decimal(5,2), item.Percent ?? null)
        .input(
  'SlabDefinition',
  sql.NVarChar(sql.MAX),
  [2, 3].includes(item.CommissionMethod)
    ? JSON.stringify(item.SlabDefinition || [])
    : null
)

        .input('ApplyAllCategories', sql.Bit, applyAllCategories)
        .input(
  'CompanyFilter',
  sql.NVarChar(sql.MAX),
  companyFilter.length ? JSON.stringify(companyFilter) : null
)
        .input('ApplyAllCompanies', sql.Bit, applyAllCompanies)
        .input('SplitType', sql.TinyInt, item.SplitType ?? 1)
        .input('SplitRatio', sql.Decimal(5,2), item.SplitRatio ?? 50)
        .input('SplitEnabled', sql.Bit, item.SplitEnabled ? 1 : 0)
        .query(`
          INSERT INTO dbo.TPCommissionRuleItems
          (CommissionRuleId, ItemType, CommissionMethod, [Percent], SlabDefinition, ApplyAllCategories, CompanyFilter, ApplyAllCompanies, SplitType, SplitRatio, SplitEnabled)
          VALUES (@CommissionRuleId, @ItemType, @CommissionMethod, @Percent, @SlabDefinition, @ApplyAllCategories, @CompanyFilter, @ApplyAllCompanies, @SplitType, @SplitRatio, @SplitEnabled);
          SELECT SCOPE_IDENTITY() AS CommissionRuleItemId;
        `);

      const itemId = itemResult.recordset[0].CommissionRuleItemId;

      // Insert categories
      for (const catId of categoryFilter) {
        await pool.request()
          .input('CommissionRuleItemId', sql.Int, itemId)
          .input('CategoryId', sql.Int, catId)
          .query(`
            INSERT INTO dbo.TPCommissionRuleItemCategories (CommissionRuleItemId, CategoryId)
            VALUES (@CommissionRuleItemId, @CategoryId)
          `);
      }
    }

    res.status(201).json({ CommissionRuleId: ruleId });
  } catch (err) {
  console.error(err);

  if (err.status) {
    return res.status(err.status).json({ message: err.message });
  }

  res.status(500).json({ error: err.message });
}

});

/*
=====================================================
UPDATE commission rule
=====================================================
*/
router.put('/:id', async (req, res) => {
  const idNum = parseInt(req.params.id, 10);
  if (isNaN(idNum)) return res.status(400).json({ message: 'Invalid commission rule ID' });

  const { Name, Active = 1, Items = [], EmployeeIds = [] } = req.body;

  if (!Name || !Items.length || !EmployeeIds.length) {
    return res.status(400).json({ message: 'Rule name, at least one item, and at least one employee are required' });
  }

  try {
    const pool = await poolPromise;
    // STEP A: get membership categories already in DB
const dbMembershipCategories = await getMembershipCategories(idNum);

// STEP B: get membership categories from incoming payload
const payloadMembershipCategories = Items
  .filter(i => i.ItemType === 7)
  .flatMap(i => i.CategoryFilter || []);

// STEP C: merge both (DB + payload)
const allMembershipCategories = [
  ...new Set([...dbMembershipCategories, ...payloadMembershipCategories])
];

// STEP D: validate Service items
validateServiceVsMembership(Items, allMembershipCategories);

// STEP X: collect promotion items & categories
const promotionItems = Items.filter(i => i.ItemType === 8);
const promotionCategoryIds = promotionItems.flatMap(i => i.CategoryFilter || []);

// Merge membership + promotion categories
const blockedCategories = [...new Set([...allMembershipCategories, ...promotionCategoryIds])];

// STEP Y: Handle ApplyAllCategories for services
const allCategoryIds = (await pool.request().query(`
  SELECT [Id Number] AS Id FROM dbo.category
`)).recordset.map(r => r.Id);

for (const item of Items) {
  if (item.ItemType === 1 && item.ApplyAllCategories) { // Service
    // Remove categories used by membership & promotion
    const availableCategories = allCategoryIds.filter(
      catId => !blockedCategories.includes(catId)
    );
    // Assign these to the service item
    item.CategoryFilter = availableCategories;
  }
}


    // Update rule
    await pool.request()
      .input('id', sql.Int, idNum)
      .input('Name', sql.NVarChar(100), Name)
      .input('Active', sql.Bit, Active)
      .query(`
        UPDATE dbo.TPCommissionRules
        SET Name = @Name, Active = @Active
        WHERE CommissionRuleId = @id
      `);

    // Delete old employees & items
    await pool.request()
      .input('id', sql.Int, idNum)
      .query(`DELETE FROM dbo.TPCommissionRuleEmployees WHERE CommissionRuleId = @id`);
    await pool.request()
      .input('id', sql.Int, idNum)
      .query(`DELETE FROM dbo.TPCommissionRuleItemCategories WHERE CommissionRuleItemId IN (SELECT CommissionRuleItemId FROM dbo.TPCommissionRuleItems WHERE CommissionRuleId = @id)`);
    await pool.request()
      .input('id', sql.Int, idNum)
      .query(`DELETE FROM dbo.TPCommissionRuleItems WHERE CommissionRuleId = @id`);

    // Insert employees
    for (const empId of EmployeeIds) {
      await pool.request()
        .input('CommissionRuleId', sql.Int, idNum)
        .input('EmployeeId', sql.Int, empId)
        .query(`
          INSERT INTO dbo.TPCommissionRuleEmployees (CommissionRuleId, EmployeeId)
          VALUES (@CommissionRuleId, @EmployeeId)
        `);
    }

    // Insert items
    for (const item of Items) {
      const applyAllCategories = Boolean(item.ApplyAllCategories);
      const applyAllCompanies = Boolean(item.ApplyAllCompanies);

      const categoryFilter = applyAllCategories ? [] : item.CategoryFilter || [];
      const companyFilter = applyAllCompanies ? [] : item.CompanyFilter || [];

      const itemResult = await pool.request()
        .input('CommissionRuleId', sql.Int, idNum)
        .input('ItemType', sql.TinyInt, item.ItemType)
        .input('CommissionMethod', sql.TinyInt, item.CommissionMethod)
        .input('Percent', sql.Decimal(5,2), item.Percent ?? null)
        .input(
  'SlabDefinition',
  sql.NVarChar(sql.MAX),
  [2, 3].includes(item.CommissionMethod)
    ? JSON.stringify(item.SlabDefinition || [])
    : null
)

        .input('ApplyAllCategories', sql.Bit, applyAllCategories)
        .input(
  'CompanyFilter',
  sql.NVarChar(sql.MAX),
  companyFilter.length ? JSON.stringify(companyFilter) : null
)
        .input('ApplyAllCompanies', sql.Bit, applyAllCompanies)
        .input('SplitType', sql.TinyInt, item.SplitType ?? 1)
        .input('SplitRatio', sql.Decimal(5,2), item.SplitRatio ?? 50)
        .input('SplitEnabled', sql.Bit, item.SplitEnabled ? 1 : 0)
        .query(`
          INSERT INTO dbo.TPCommissionRuleItems
          (CommissionRuleId, ItemType, CommissionMethod, [Percent], SlabDefinition, ApplyAllCategories, CompanyFilter,ApplyAllCompanies, SplitType, SplitRatio, SplitEnabled)
          VALUES (@CommissionRuleId, @ItemType, @CommissionMethod, @Percent, @SlabDefinition, @ApplyAllCategories, @CompanyFilter, @ApplyAllCompanies, @SplitType, @SplitRatio, @SplitEnabled);
          SELECT SCOPE_IDENTITY() AS CommissionRuleItemId;
        `);

      const itemId = itemResult.recordset[0].CommissionRuleItemId;

      // Insert categories
      for (const catId of categoryFilter) {
        await pool.request()
          .input('CommissionRuleItemId', sql.Int, itemId)
          .input('CategoryId', sql.Int, catId)
          .query(`
            INSERT INTO dbo.TPCommissionRuleItemCategories (CommissionRuleItemId, CategoryId)
            VALUES (@CommissionRuleItemId, @CategoryId)
          `);
      }
    }

    res.json({ message: 'Rule updated' });
  } catch (err) {
  console.error(err);

  if (err.status) {
    return res.status(err.status).json({ message: err.message });
  }

  res.status(500).json({ error: err.message });
}

});

/*
=====================================================
SOFT DELETE (Deactivate)
=====================================================
*/
router.delete('/:id', async (req, res) => {
  const idNum = parseInt(req.params.id, 10);
  if (isNaN(idNum)) return res.status(400).json({ message: 'Invalid commission rule ID' });

  try {
    const pool = await poolPromise;
    await pool.request()
      .input('id', sql.Int, idNum)
      .query(`
        UPDATE dbo.TPCommissionRules
        SET Active = 0
        WHERE CommissionRuleId = @id
      `);

    res.json({ message: 'Commission rule deactivated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/*
=====================================================
RESTORE
=====================================================
*/
router.put('/:id/restore', async (req, res) => {
  const idNum = parseInt(req.params.id, 10);
  if (isNaN(idNum)) return res.status(400).json({ message: 'Invalid commission rule ID' });

  try {
    const pool = await poolPromise;
    await pool.request()
      .input('id', sql.Int, idNum)
      .query(`
        UPDATE dbo.TPCommissionRules
        SET Active = 1
        WHERE CommissionRuleId = @id
      `);

    res.json({ message: 'Commission rule restored' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/*
=====================================================
HARD DELETE (only if inactive)
=====================================================
*/
router.delete('/:id/hard', async (req, res) => {
  const idNum = parseInt(req.params.id, 10);
  if (isNaN(idNum)) return res.status(400).json({ message: 'Invalid commission rule ID' });

  try {
    const pool = await poolPromise;

    const check = await pool.request()
      .input('id', sql.Int, idNum)
      .query(`
        SELECT Active
        FROM dbo.TPCommissionRules
        WHERE CommissionRuleId = @id
      `);

    if (!check.recordset.length) return res.status(404).json({ message: 'Rule not found' });

    if (check.recordset[0].Active === 1) {
      return res.status(400).json({ message: 'Deactivate rule before hard delete' });
    }

    await pool.request()
      .input('id', sql.Int, idNum)
      .query(`
        DELETE FROM dbo.TPCommissionRules
        WHERE CommissionRuleId = @id
      `);

    res.json({ message: 'Commission rule permanently deleted' });
  } catch (err) {
    console.error('HARD DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
