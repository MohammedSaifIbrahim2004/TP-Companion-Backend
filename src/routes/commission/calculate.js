const express = require('express');
const router = express.Router();
const { sql, poolPromise } = require('../../db/sql');

/*
=====================================================
UTILITY FUNCTIONS
=====================================================
*/

// Slab commission calculator
function calculateSlabCommission(total, slabs) {
  if (!slabs || !slabs.length) return 0;
  let commission = 0;
  for (const slab of slabs) {
    const min = slab.Min ?? 0;
    const max = slab.Max ?? Infinity;
    const percent = slab.Percent ?? 0;
    if (total > min) {
      const applicable = Math.min(total, max) - min;
      commission += applicable * (percent / 100);
    }
    if (total <= max) break;
  }
  return commission;
}
// Flat / Jump slab commission calculator
function calculateFlatSlabCommission(total, slabs) {
  if (!slabs || !slabs.length) return 0;

  for (const slab of slabs) {
    const min = slab.Min ?? 0;
    const max = slab.Max ?? Infinity;
    const percent = slab.Percent ?? 0;

    if (total >= min && total <= max) {
      return total * (percent / 100);
    }
  }

  return 0;
}

// Safe JSON parse
function safeParse(json) {
  try {
    if (!json) return [];
    return JSON.parse(json);
  } catch {
    return [];
  }
}

// Resolve split percentages
function resolveSplit(item, sale) {
  const splitEnabled = Boolean(Number(item.SplitEnabled));
  const splitType = Number(item.SplitType ?? 1);
  const splitRatio = Number(item.SplitRatio ?? 50);

  if (!splitEnabled) return { stylistPercent: 100, operatorPercent: 0 };
  if (splitType === 1) return { stylistPercent: splitRatio, operatorPercent: 100 - splitRatio };
  if ([5,6].includes(sale.ItemType)) return { stylistPercent: 50, operatorPercent: 50 };
  return { stylistPercent: 100, operatorPercent: 0 };
}

// Get operator ID for a sale
async function getOperatorId(saleId) {
  const pool = await poolPromise; 
  const result = await pool.request()
    .input('saleId', sql.Int, saleId)
    .query(`SELECT DISTINCT OperatorId FROM dbo.transacs WHERE SaleID = @saleId`);
  return result.recordset.length ? result.recordset[0].OperatorId : null;
}
/*
=====================================================
POST /calculate
=====================================================
*/
router.post('/', async (req, res) => {
  const operatorCache = new Map();
  const operatorNameCache = new Map();

  const { fromDate, toDate, itemType, employeeId } = req.body;
  if (!fromDate || !toDate) return res.status(400).json({ message: 'fromDate and toDate are required' });

  const itemTypes = Array.isArray(itemType)
    ? itemType.map(Number)
    : itemType ? [Number(itemType)] : [];

  try {
    const pool = await poolPromise;


    /*
    ============================================
    LOAD ACTIVE COMMISSION RULES + ITEMS + EMPLOYEES + CATEGORIES
    ============================================
    */
    const rulesResult = await pool.request().query(`
      SELECT 
        r.CommissionRuleId, r.Name, r.Active,
        i.CommissionRuleItemId, i.ItemType, i.CommissionMethod, i.[Percent], i.SlabDefinition,
        i.ApplyAllCategories, i.ApplyAllCompanies, i.SplitType, i.SplitRatio, i.SplitEnabled,
        e.EmployeeId AS RuleEmployeeId,
        c.CategoryId AS ItemCategoryId
      FROM dbo.TPCommissionRules r
      LEFT JOIN dbo.TPCommissionRuleItems i ON r.CommissionRuleId = i.CommissionRuleId
      LEFT JOIN dbo.TPCommissionRuleEmployees e ON r.CommissionRuleId = e.CommissionRuleId
      LEFT JOIN dbo.TPCommissionRuleItemCategories c ON i.CommissionRuleItemId = c.CommissionRuleItemId
      WHERE r.Active = 1
      ORDER BY r.CommissionRuleId, i.CommissionRuleItemId
    `);

    // Map rules
    const ruleMap = {};
    for (const row of rulesResult.recordset) {
      if (!ruleMap[row.CommissionRuleId]) {
        ruleMap[row.CommissionRuleId] = {
          CommissionRuleId: row.CommissionRuleId,
          Name: row.Name,
          Items: [],
          EmployeeIds: []
        };
      }

      const rule = ruleMap[row.CommissionRuleId];

      // Global employees
      if (row.RuleEmployeeId && !rule.EmployeeIds.includes(row.RuleEmployeeId)) {
        rule.EmployeeIds.push(row.RuleEmployeeId);
      }

      // Items
      if (row.CommissionRuleItemId) {
        let item = rule.Items.find(it => it.CommissionRuleItemId === row.CommissionRuleItemId);
        if (!item) {
          item = {
            CommissionRuleItemId: row.CommissionRuleItemId,
            ItemType: row.ItemType,
            CommissionMethod: row.CommissionMethod,
            Percent: row.Percent,
            SlabDefinition: safeParse(row.SlabDefinition),
            ApplyAllCategories: row.ApplyAllCategories === 1,
            ApplyAllCompanies: row.ApplyAllCompanies === 1,
            CategoryFilter: [],
            SplitType: row.SplitType,
            SplitRatio: row.SplitRatio,
            SplitEnabled: Boolean(row.SplitEnabled)
          };
          rule.Items.push(item);
        }

        // Categories
        if (row.ItemCategoryId && !item.CategoryFilter.includes(row.ItemCategoryId)) {
          item.CategoryFilter.push(row.ItemCategoryId);
        }
      }
    }

    const rules = Object.values(ruleMap);

    /*
    ============================================
    LOAD SALES DATA (ALL ITEM TYPES)
    ============================================
    */
    const sales = [];

    // Services (1), Retail (2), Sundry (3), Gift (5), Series (6)
    const itemTypeQueries = [
      { type: 1, query: `
        SELECT h.HistoryID, h.SaleID, CONVERT(varchar(10), t.Date, 23) AS TransactionDate,
               h.StylistIdNumber AS EmployeeId,
               ISNULL(e.FirstName,'') AS FirstName, ISNULL(e.LastName,'') AS LastName,
               SUM(CAST(h.Amount - h.Tax AS MONEY)) AS TotalExTax,
               s.Category AS CategoryId, c.Name AS ItemName,
               1 AS ItemType
        FROM dbo.historys h
        JOIN dbo.transacs t ON h.SaleID = t.SaleID
        LEFT JOIN dbo.employs e ON e.IdNumber = h.StylistIdNumber
        LEFT JOIN dbo.services s ON s.IdNumber = h.Service
        LEFT JOIN dbo.category c ON c.[Id Number] = s.Category
        WHERE h.Date >= @fromDate AND h.Date < DATEADD(DAY,1,@toDate)
          AND h.ItemType = 1 AND h.Amount > 0
          AND ISNULL(t.VoidStatusCode,0) = 0
          AND ISNULL(h.TransactionType,1) <> 2
          AND ISNULL(h.IsPaidBySeriesRedemption,0) = 0
          AND (@employeeId IS NULL OR h.StylistIdNumber = @employeeId)
        GROUP BY h.HistoryID, h.SaleID, t.Date, h.StylistIdNumber, e.FirstName, e.LastName, s.Category, c.Name
      `},
      { type: 2, query: `
        SELECT 
          h.HistoryID,
          h.SaleID,
          CONVERT(varchar(10), t.Date, 23) AS TransactionDate,
          h.StylistIdNumber AS EmployeeId,
          ISNULL(e.FirstName,'') AS FirstName,
          ISNULL(e.LastName,'') AS LastName,
          CAST(SUM(h.Amount - h.Tax) AS MONEY) AS TotalExTax,
          p.CompanyId AS CompanyId,
          c.Name AS ItemName,
          2 AS ItemType
      FROM dbo.historys h
      JOIN dbo.transacs t ON h.SaleID = t.SaleID
      JOIN dbo.Sale s ON s.SaleID = h.SaleID           -- join Sale table
      JOIN dbo.products p ON h.Service = p.IdNumber    -- historys.Service = product Id
      JOIN dbo.companys c ON p.CompanyId = c.IdNumber
      LEFT JOIN dbo.employs e ON h.StylistIdNumber = e.IdNumber
      WHERE h.Date >= @fromDate 
        AND h.Date < DATEADD(DAY,1,@toDate)
        AND h.ItemType = 2
        AND h.Amount > 0
        AND ISNULL(t.VoidStatusCode,0) = 0
        AND ISNULL(h.TransactionType,1) <> 2
        AND ISNULL(h.IsPaidBySeriesRedemption,0) = 0
        AND (@employeeId IS NULL OR h.StylistIdNumber = @employeeId)
      GROUP BY 
          h.HistoryID,
          h.SaleID,
          t.Date,
          h.StylistIdNumber,
          e.FirstName,
          e.LastName,
          p.CompanyId,
          c.Name

      `},
      { type: 3, query: `
        SELECT h.HistoryID, h.SaleID, CONVERT(varchar(10), h.Date, 23) AS TransactionDate,
               h.StylistIdNumber AS EmployeeId,
               ISNULL(e.FirstName,'') AS FirstName, ISNULL(e.LastName,'') AS LastName,
               CAST(ROUND(h.Amount - h.Tax,2) AS MONEY) AS TotalExTax,
               'Sundry' AS ItemName, 3 AS ItemType
        FROM dbo.historys h
        JOIN dbo.transacs t ON h.SaleID = t.SaleID
        JOIN dbo.employs e ON h.StylistIdNumber = e.IdNumber
        WHERE h.ItemType = 3 AND h.Amount > 0
          AND h.Date >= @fromDate AND h.Date < DATEADD(DAY,1,@toDate)
          AND ISNULL(t.VoidStatusCode,0) = 0
          AND ISNULL(h.TransactionType,1) <> 2
          AND ISNULL(h.IsPaidBySeriesRedemption,0) = 0
          AND (@employeeId IS NULL OR h.StylistIdNumber = @employeeId)
      `},
      { type: 5, query: `
        SELECT h.HistoryID, h.SaleID, CONVERT(varchar(10), h.Date, 23) AS TransactionDate,
               h.StylistIdNumber AS EmployeeId,
               ISNULL(e.FirstName,'') AS FirstName, ISNULL(e.LastName,'') AS LastName,
               CAST(ROUND(h.Amount - h.Tax,2) AS MONEY) AS TotalExTax,
               'Gift Certificate' AS ItemName, 5 AS ItemType
        FROM dbo.historys h
        JOIN dbo.transacs t ON h.SaleID = t.SaleID
        JOIN dbo.employs e ON h.StylistIdNumber = e.IdNumber
        WHERE h.ItemType = 5 AND h.Amount > 0
          AND h.Date >= @fromDate AND h.Date < DATEADD(DAY,1,@toDate)
          AND ISNULL(t.VoidStatusCode,0) = 0
          AND ISNULL(h.TransactionType,1) <> 2
          AND ISNULL(h.IsPaidBySeriesRedemption,0) = 0
          AND (@employeeId IS NULL OR h.StylistIdNumber = @employeeId)
      `},
      { type: 6, query: `
        SELECT h.HistoryID, h.SaleID, CONVERT(varchar(10), h.Date, 23) AS TransactionDate,
               h.StylistIdNumber AS EmployeeId,
               ISNULL(e.FirstName,'') AS FirstName, ISNULL(e.LastName,'') AS LastName,
               CAST(ROUND(h.Amount - h.Tax,2) AS MONEY) AS TotalExTax,
               'Series Package' AS ItemName, 6 AS ItemType
        FROM dbo.historys h
        JOIN dbo.transacs t ON h.SaleID = t.SaleID
        JOIN dbo.employs e ON h.StylistIdNumber = e.IdNumber
        WHERE h.ItemType = 6 AND h.Amount > 0
          AND h.Date >= @fromDate AND h.Date < DATEADD(DAY,1,@toDate)
          AND ISNULL(t.VoidStatusCode,0) = 0
          AND ISNULL(h.TransactionType,1) <> 2
          AND ISNULL(h.IsPaidBySeriesRedemption,0) = 0
          AND (@employeeId IS NULL OR h.StylistIdNumber = @employeeId)
      `},
      { type: 7, query: `
      SELECT h.HistoryID, h.SaleID, CONVERT(varchar(10), t.Date, 23) AS TransactionDate,
            h.StylistIdNumber AS EmployeeId,
            ISNULL(e.FirstName,'') AS FirstName, ISNULL(e.LastName,'') AS LastName,
            SUM(CAST(h.Amount - h.Tax AS MONEY)) AS TotalExTax,
            s.Category AS CategoryId, c.Name AS ItemName,
            7 AS ItemType
      FROM dbo.historys h
      JOIN dbo.transacs t ON h.SaleID = t.SaleID
      LEFT JOIN dbo.employs e ON e.IdNumber = h.StylistIdNumber
      LEFT JOIN dbo.services s ON s.IdNumber = h.Service
      LEFT JOIN dbo.category c ON c.[Id Number] = s.Category
      WHERE h.Date >= @fromDate AND h.Date < DATEADD(DAY,1,@toDate)
        AND h.ItemType = 1 AND h.Amount > 0
        AND ISNULL(t.VoidStatusCode,0) = 0
        AND ISNULL(h.TransactionType,1) <> 2
        AND ISNULL(h.IsPaidBySeriesRedemption,0) = 0
        AND (@employeeId IS NULL OR h.StylistIdNumber = @employeeId)
      GROUP BY h.HistoryID, h.SaleID, t.Date, h.StylistIdNumber, e.FirstName, e.LastName, s.Category, c.Name
    `},
    {
  type: 8,
  query: `
    SELECT h.HistoryID, h.SaleID, CONVERT(varchar(10), t.Date, 23) AS TransactionDate,
           h.StylistIdNumber AS EmployeeId,
           ISNULL(e.FirstName,'') AS FirstName, ISNULL(e.LastName,'') AS LastName,
           SUM(CAST(h.Amount - h.Tax AS MONEY)) AS TotalExTax,
           s.Category AS CategoryId, c.Name AS ItemName,
           8 AS ItemType
    FROM dbo.historys h
    JOIN dbo.transacs t ON h.SaleID = t.SaleID
    LEFT JOIN dbo.employs e ON e.IdNumber = h.StylistIdNumber
    LEFT JOIN dbo.services s ON s.IdNumber = h.Service
    LEFT JOIN dbo.category c ON c.[Id Number] = s.Category
    WHERE h.Date >= @fromDate AND h.Date < DATEADD(DAY,1,@toDate)
      AND h.ItemType = 1
      AND h.Amount > 0
      AND ISNULL(t.VoidStatusCode,0) = 0
      AND ISNULL(h.TransactionType,1) <> 2
      AND ISNULL(h.IsPaidBySeriesRedemption,0) = 0
      AND (@employeeId IS NULL OR h.StylistIdNumber = @employeeId)
    GROUP BY h.HistoryID, h.SaleID, t.Date, h.StylistIdNumber,
             e.FirstName, e.LastName, s.Category, c.Name
  `
}

    ];

    
    for (const q of itemTypeQueries) {
      if (!itemTypes.length || itemTypes.includes(q.type)) {
        const r = await pool.request()
          .input('fromDate', sql.DateTime, fromDate)
          .input('toDate', sql.DateTime, toDate)
          .input('employeeId', sql.Int, employeeId || null)
          .query(q.query);
        sales.push(...r.recordset);
      }
    }
    const serviceDerivedCategorySet = new Set(
  rules.flatMap(rule =>
    rule.Items
      .filter(i => [7, 8].includes(i.ItemType)) // Memberships + Promotions
      .flatMap(i => i.CategoryFilter)
  )
);




   /*
============================================
CALCULATE COMMISSIONS (INTEGER SAFE VERSION)
WITH OPERATOR SUPPORT (LIKE OLD VERSION)
============================================
*/

const transactions = [];
const slabBuckets = {};

const operatorCache = new Map();
const operatorNameCache = new Map();

// ---------- HELPERS ----------

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

// --------------------------------------------------
// FIRST PASS — METHOD 1 + SLAB BUCKET COLLECTION
// --------------------------------------------------

for (const sale of sales) {

  const originalEmployeeId = sale.EmployeeId;
  const originalEmployeeName = `${sale.FirstName} ${sale.LastName}`;

  const saleCents = toCents(sale.TotalExTax);
    let included = false;  // ✅ add this at the top of the sale loop

  for (const rule of rules) {
    for (const item of rule.Items) {

      if (item.ItemType !== sale.ItemType) continue;

      if (!item.ApplyAllCategories) {
    if (!item.CategoryFilter.includes(sale.CategoryId)) {
      continue;
    }
  }

      if (
        rule.EmployeeIds.length &&
        !rule.EmployeeIds.includes(sale.EmployeeId)
      ) continue;

      if (
        sale.ItemType === 1 &&
        !item.ApplyAllCategories &&
        item.CategoryFilter.length &&
       !item.CategoryFilter.includes(Number(sale.CategoryId))
      ) continue;

      if (
        sale.ItemType === 2 &&
        !item.ApplyAllCompanies &&
        item.CategoryFilter.length &&
        !item.CategoryFilter.includes(sale.CompanyId)
      ) continue;
       // ✅ mark as included if any rule/item matches
      included = true;

      // ==================================================
      // METHOD 1 — FLAT %
      // ==================================================
      if (item.CommissionMethod === 1) {

        const percentBp = Math.round(item.Percent * 100);
        const baseCommissionCents =
          Math.round((saleCents * percentBp) / 10000);

        const { stylistPercent, operatorPercent } =
          resolveSplit(item, sale);

        const stylistBp = Math.round(stylistPercent * 100);
        const operatorBp = Math.round(operatorPercent * 100);

        const stylistCents =
          Math.round((baseCommissionCents * stylistBp) / 10000);

        const operatorCents =
          Math.round((baseCommissionCents * operatorBp) / 10000);

        // ---------------- STYLIST ----------------
        if (stylistCents > 0) {
          transactions.push({
            SaleID: sale.SaleID,
            OriginalEmployeeId: originalEmployeeId,
            OriginalEmployeeName: originalEmployeeName,
            EmployeeId: sale.EmployeeId,
            EmployeeName: originalEmployeeName,
            Role: 'Stylist',
            IsSplitChild: false,
            ItemType: sale.ItemType,
            ItemName: sale.ItemName,
            TotalSalesExTax: fromCents(saleCents),
            CommissionAmount: fromCents(stylistCents),
            CommissionMethod: 1,
            CommissionPercent: item.Percent,
            CommissionSlabs: null,
            CommissionRuleId: rule.CommissionRuleId,
            RuleName: rule.Name,
            TransactionDate: sale.TransactionDate,
            SplitInfo: `Stylist ${stylistPercent}%`
          });
        }

        // ---------------- OPERATOR ----------------
        if (operatorCents > 0) {

          let operatorId = operatorCache.get(sale.SaleID);

          if (operatorId === undefined) {
            operatorId = await getOperatorId(sale.SaleID);
            operatorCache.set(sale.SaleID, operatorId);
          }

          if (operatorId) {

            let operatorName = operatorNameCache.get(operatorId);

            if (operatorName === undefined) {
              const op = await pool.request()
                .input('id', sql.Int, operatorId)
                .query(`
                  SELECT FirstName, LastName
                  FROM dbo.employs
                  WHERE IdNumber = @id
                `);

              operatorName = op.recordset.length
                ? `${op.recordset[0].FirstName} ${op.recordset[0].LastName}`
                : null;

              operatorNameCache.set(operatorId, operatorName);
            }

            if (operatorName) {
              transactions.push({
                SaleID: sale.SaleID,
                OriginalEmployeeId: originalEmployeeId,
                OriginalEmployeeName: originalEmployeeName,
                EmployeeId: operatorId,
                EmployeeName: operatorName,
                Role: 'Operator',
                IsSplitChild: true,
                ItemType: sale.ItemType,
                ItemName: sale.ItemName,
                TotalSalesExTax: 0,
                CommissionAmount: fromCents(operatorCents),
                CommissionMethod: 1,
                CommissionPercent: item.Percent,
                CommissionSlabs: null,
                CommissionRuleId: rule.CommissionRuleId,
                RuleName: rule.Name,
                TransactionDate: sale.TransactionDate,
                SplitInfo: `Operator ${operatorPercent}%`
              });
            }
          }
        }
      }

      // ==================================================
      // METHOD 2 & 3 — SLAB AGGREGATION
      // ==================================================
      else if ([2, 3].includes(item.CommissionMethod)) {

        const bucketKey =
          `${sale.EmployeeId}_${rule.CommissionRuleId}_${item.CommissionRuleItemId}`;

        if (!slabBuckets[bucketKey]) {
          slabBuckets[bucketKey] = {
            Rule: rule,
            Item: item,
            Sales: [],
            TotalCents: 0
          };
        }

        slabBuckets[bucketKey].Sales.push({
          ...sale,
          SaleCents: saleCents
        });

        slabBuckets[bucketKey].TotalCents += saleCents;
      }
    }
    
  }
  // if (!included) {
  //   console.log('SALE SKIPPED:', sale);
  // }
}
 

// =========================================================
// SECOND PASS — PROCESS SLABS
// =========================================================

for (const bucketKey in slabBuckets) {

  const bucket = slabBuckets[bucketKey];
  const { Item, Rule, Sales, TotalCents } = bucket;

  if (TotalCents <= 0) continue;

  const totalMoney = fromCents(TotalCents);

  let slabCommissionMoney = 0;

  if (Item.CommissionMethod === 2)
    slabCommissionMoney =
      calculateSlabCommission(totalMoney, Item.SlabDefinition);

  if (Item.CommissionMethod === 3)
    slabCommissionMoney =
      calculateFlatSlabCommission(totalMoney, Item.SlabDefinition);

  const slabCommissionCents = toCents(slabCommissionMoney);
  if (slabCommissionCents <= 0) continue;

  let distributedCents = 0;

  for (let i = 0; i < Sales.length; i++) {

    const sale = Sales[i];
    const isLast = i === Sales.length - 1;

    const originalEmployeeId = sale.EmployeeId;
    const originalEmployeeName = `${sale.FirstName} ${sale.LastName}`;

    let lineCommissionCents;

    if (!isLast) {
      lineCommissionCents =
        Math.round((sale.SaleCents * slabCommissionCents) / TotalCents);
      distributedCents += lineCommissionCents;
    } else {
      lineCommissionCents =
        slabCommissionCents - distributedCents;
    }

    const { stylistPercent, operatorPercent } =
      resolveSplit(Item, sale);

    const stylistBp = Math.round(stylistPercent * 100);

    const stylistCents =
      Math.round((lineCommissionCents * stylistBp) / 10000);

    const operatorCents =
      lineCommissionCents - stylistCents;

    // ---------------- STYLIST ----------------
    if (stylistCents > 0) {
      transactions.push({
        SaleID: sale.SaleID,
        OriginalEmployeeId: originalEmployeeId,
        OriginalEmployeeName: originalEmployeeName,
        EmployeeId: sale.EmployeeId,
        EmployeeName: originalEmployeeName,
        Role: 'Stylist',
        IsSplitChild: false,
        ItemType: sale.ItemType,
        ItemName: sale.ItemName,
        TotalSalesExTax: fromCents(sale.SaleCents),
        CommissionAmount: fromCents(stylistCents),
        CommissionMethod: Item.CommissionMethod,
        CommissionPercent: Item.Percent,
        CommissionSlabs: Item.SlabDefinition,
        CommissionRuleId: Rule.CommissionRuleId,
        RuleName: Rule.Name,
        TransactionDate: sale.TransactionDate,
        SplitInfo: `Stylist ${stylistPercent}%`
      });
    }

    // ---------------- OPERATOR ----------------
    if (operatorCents > 0) {

      let operatorId = operatorCache.get(sale.SaleID);

      if (operatorId === undefined) {
        operatorId = await getOperatorId(sale.SaleID);
        operatorCache.set(sale.SaleID, operatorId);
      }

      if (operatorId) {

        let operatorName = operatorNameCache.get(operatorId);

        if (operatorName === undefined) {
          const op = await pool.request()
            .input('id', sql.Int, operatorId)
            .query(`
              SELECT FirstName, LastName
              FROM dbo.employs
              WHERE IdNumber = @id
            `);

          operatorName = op.recordset.length
            ? `${op.recordset[0].FirstName} ${op.recordset[0].LastName}`
            : null;

          operatorNameCache.set(operatorId, operatorName);
        }

        if (operatorName) {
          transactions.push({
            SaleID: sale.SaleID,
            OriginalEmployeeId: originalEmployeeId,
            OriginalEmployeeName: originalEmployeeName,
            EmployeeId: operatorId,
            EmployeeName: operatorName,
            Role: 'Operator',
            IsSplitChild: true,
            ItemType: sale.ItemType,
            ItemName: sale.ItemName,
            TotalSalesExTax: 0,
            CommissionAmount: fromCents(operatorCents),
            CommissionMethod: Item.CommissionMethod,
            CommissionPercent: Item.Percent,
            CommissionSlabs: Item.SlabDefinition,
            CommissionRuleId: Rule.CommissionRuleId,
            RuleName: Rule.Name,
            TransactionDate: sale.TransactionDate,
            SplitInfo: `Operator ${operatorPercent}%`
          });
        }
      }
    }
  }
  
}
    /*
    ============================================
    SUMMARY
    ============================================
    */
    const summaryMap = {};
    for (const t of transactions) {
      if (t.Role !== 'Stylist') continue;
      if (!summaryMap[t.EmployeeId]) {
        summaryMap[t.EmployeeId] = {
          EmployeeId: t.EmployeeId,
          EmployeeName: t.EmployeeName,
          TotalSalesExTax: 0,
          TotalCommission: 0
        };
      }
      summaryMap[t.EmployeeId].TotalSalesExTax += t.TotalSalesExTax;
      summaryMap[t.EmployeeId].TotalCommission += t.CommissionAmount;
    }
    // DEBUG: check stylist total sales



    res.json({
      summary: Object.values(summaryMap),
      transactions
    });

  } catch (err) {
    console.error('CALCULATE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
